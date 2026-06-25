import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { AuditAction, MasterProductSyncStatus, Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { normalizeBoxCode } from '../common/box-code';
import { APP_TIMEZONE, getZonedDateParts } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMasterProductFbaReplenishmentDto } from './dto/create-master-product-fba-replenishment.dto';
import { CreateMasterProductOutboundOneDto } from './dto/create-master-product-outbound-one.dto';
import { ExportMasterProductsDto } from './dto/export-master-products.dto';
import { ManualAdjustMasterProductBoxDto } from './dto/manual-adjust-master-product-box.dto';
import { UpdateMasterProductPrintSettingsDto } from './dto/update-master-product-print-settings.dto';

type MasterProductListResult = {
  items: unknown[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

type AvailableStockExportResult = {
  exportedAt: string;
  total: number;
  rows: Array<{
    productId: string;
    productName: string | null;
    stockQty: number;
  }>;
};

type MasterProductSyncRecordListResult = {
  items: unknown[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

type MasterProductImportRow = {
  productId: string;
  productName: string | null;
  productType: string | null;
  bagBrand: string | null;
  color: string | null;
  bagName: string | null;
  bagType: string | null;
  zipperStyle: string | null;
  style: string | null;
  pattern: string | null;
  buckleType: string | null;
  matchingBagType: string | null;
  length: string | null;
  width: string | null;
  patternType: string | null;
  size: string | null;
  yamatoPrinterName: string | null;
  stockQty: number | null;
};

type ImportedMasterProductField = Exclude<keyof MasterProductImportRow, 'productId'>;

type ParsedMasterProductImport = {
  rows: MasterProductImportRow[];
  presentFields: Set<ImportedMasterProductField>;
};

type MasterProductExportFile = {
  fileName: string;
  content: Buffer;
  totalRows: number;
};

type XiyaExternalProductRow = {
  id: string | number;
  name?: string | null;
  product_type?: string | null;
  properties?: Array<{
    property_name?: string | null;
    property_value?: string | null;
  }> | null;
  updated_at?: string | null;
};

type MasterProductSyncOperationType = 'bulk_upload' | 'manual_sync' | 'scheduled_sync';

type MasterProductSyncContext = {
  operationType: MasterProductSyncOperationType;
  operatorId?: bigint | null;
  operatorName?: string | null;
  sourceFileName?: string | null;
};

type MasterProductExportFilterKey =
  | 'productType'
  | 'bagBrand'
  | 'color'
  | 'bagType'
  | 'zipperStyle'
  | 'buckleType'
  | 'matchingBagType'
  | 'patternType'
  | 'size';

const CREATE_CHUNK_SIZE = 1000;
const UPDATE_CHUNK_SIZE = 200;
const MASTER_PRODUCT_TEMPLATE_FILE = '产品列表.xlsx';
const XIYA_EXPORT_URL = 'http://103.236.55.93/api/external/products';
const XIYA_EXPORT_API_KEY = 'xiya-export-4HHGJWBDGg29yp8W8TK3QRQ3m1A';
const XIYA_COMPANY_NAME = 'XYJG';
const XIYA_SUCCESS_CODES = new Set([0, 200]);
const MASTER_PRODUCT_SYNC_CRON = '0 0 0 * * 1';

const MASTER_PRODUCT_EXPORT_COLUMNS: Array<[keyof MasterProductImportRow, string]> = [
  ['productId', '产品ID'],
  ['productName', '产品名称'],
  ['productType', '产品类型'],
  ['bagBrand', '包包品牌'],
  ['color', '颜色'],
  ['bagName', '包名'],
  ['bagType', '包型'],
  ['zipperStyle', '拉链款式'],
  ['style', '款式'],
  ['pattern', '花纹'],
  ['buckleType', '扣子类型'],
  ['matchingBagType', '对应包型'],
  ['length', '长度'],
  ['width', '宽度'],
  ['patternType', '花纹类型'],
  ['size', '尺寸'],
  ['yamatoPrinterName', 'Yamato打印机'],
  ['stockQty', '在库数'],
];

const MASTER_PRODUCT_EXPORT_SELECT_FIELDS: MasterProductExportFilterKey[] = [
  'productType',
  'bagBrand',
  'color',
  'bagType',
  'zipperStyle',
  'buckleType',
  'matchingBagType',
  'patternType',
  'size',
];

const MASTER_PRODUCT_COLUMN_ALIASES = {
  productId: ['productId', 'product id', '产品ID', '产品id'],
  productName: ['productName', 'product name', '产品名称'],
  productType: ['productType', 'product type', '产品类型', '产品种类'],
  bagBrand: ['bagBrand', 'bag brand', '包包品牌', '品牌'],
  color: ['color', '颜色'],
  bagName: ['bagName', 'bag name', '包名'],
  bagType: ['bagType', 'bag type', '包型'],
  zipperStyle: ['zipperStyle', 'zipper style', '拉链款式'],
  style: ['style', '款式'],
  pattern: ['pattern', '花纹', '图案'],
  buckleType: ['buckleType', 'buckle type', '扣子类型'],
  matchingBagType: ['matchingBagType', 'matching bag type', '对应包型', '配包包型'],
  length: ['length', '长度'],
  width: ['width', '宽度'],
  patternType: ['patternType', 'pattern type', '花纹类型'],
  size: ['size', '尺寸'],
  yamatoPrinterName: ['yamatoPrinterName', 'yamato printer', 'Yamato打印机', '打印机', '打印机名称'],
  stockQty: ['stockQty', 'stock qty', '在库数', '库存数'],
} as const;

const MASTER_PRODUCT_IMPORT_FIELDS: ImportedMasterProductField[] = [
  'productName',
  'productType',
  'bagBrand',
  'color',
  'bagName',
  'bagType',
  'zipperStyle',
  'style',
  'pattern',
  'buckleType',
  'matchingBagType',
  'length',
  'width',
  'patternType',
  'size',
  'yamatoPrinterName',
];

const XIYA_SYNC_UPDATE_FIELDS = new Set<ImportedMasterProductField>(
  MASTER_PRODUCT_IMPORT_FIELDS.filter((field) => field !== 'yamatoPrinterName' && field !== 'stockQty'),
);

@Injectable()
export class MasterProductsService {
  private readonly logger = new Logger(MasterProductsService.name);
  private xiyaSyncStarting = false;
  private masterProductSyncRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    pageRaw?: string | number,
    pageSizeRaw?: string | number,
    keywordRaw?: string,
  ): Promise<MasterProductListResult> {
    const page = this.normalizePositiveInt(pageRaw, 1);
    const pageSize = Math.min(this.normalizePositiveInt(pageSizeRaw, 30), 100);
    const skip = (page - 1) * pageSize;
    const keyword = String(keywordRaw ?? '').trim();
    const where = this.buildMasterProductWhere({ keyword });

    const rows = await this.prisma.masterProduct.findMany({
      where,
      orderBy: [{ stockQty: 'desc' }, { productId: 'desc' }, { id: 'desc' }],
      skip,
      take: pageSize + 1,
    });

    return {
      items: rows.slice(0, pageSize),
      page,
      pageSize,
      hasMore: rows.length > pageSize,
    };
  }

  async exportAvailableStockForThirdParty(): Promise<AvailableStockExportResult> {
    const rows = await this.prisma.masterProduct.findMany({
      where: {
        stockQty: { gt: 0 },
      },
      select: {
        productId: true,
        productName: true,
        stockQty: true,
      },
      orderBy: [{ stockQty: 'desc' }, { productId: 'asc' }, { id: 'asc' }],
    });

    return {
      exportedAt: new Date().toISOString(),
      total: rows.length,
      rows: rows.map((row) => ({
        productId: row.productId,
        productName: row.productName,
        stockQty: Number(row.stockQty ?? 0),
      })),
    };
  }

  async listSyncRecords(
    pageRaw?: string | number,
    pageSizeRaw?: string | number,
  ): Promise<MasterProductSyncRecordListResult> {
    const page = this.normalizePositiveInt(pageRaw, 1);
    const pageSize = Math.min(this.normalizePositiveInt(pageSizeRaw, 30), 100);
    const skip = (page - 1) * pageSize;

    const rows = await this.prisma.masterProductSyncRecord.findMany({
      orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
      skip,
      take: pageSize + 1,
      include: {
        operator: {
          select: {
            username: true,
          },
        },
      },
    });

    return {
      items: rows.slice(0, pageSize).map((row) => ({
        id: row.id.toString(),
        operationType: row.operationType,
        status: row.status,
        executedAt: row.executedAt.toISOString(),
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
        operatorName: row.operatorName ?? row.operator?.username ?? null,
        fetchedCount: Number(row.fetchedCount ?? 0),
        createdCount: Number(row.createdCount ?? 0),
        updatedCount: Number(row.updatedCount ?? 0),
        errorMessage: row.errorMessage ?? null,
      })),
      page,
      pageSize,
      hasMore: rows.length > pageSize,
    };
  }

  @Cron(MASTER_PRODUCT_SYNC_CRON, {
    name: 'weekly-master-product-sync-from-xiya',
    timeZone: APP_TIMEZONE,
  })
  async runScheduledMasterProductSync(): Promise<void> {
    try {
      await this.triggerXiyaSync(undefined, {
        operationType: 'scheduled_sync',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`master product scheduled sync failed: ${message}`);
    }
  }

  async triggerXiyaSync(
    daysRaw?: string | number,
    context?: MasterProductSyncContext,
  ): Promise<{
    recordId: string;
    status: MasterProductSyncStatus;
    message: string;
    days: number;
  }> {
    const days = Math.min(this.normalizePositiveInt(daysRaw, 10), 365);

    if (this.xiyaSyncStarting || this.masterProductSyncRunning) {
      throw new ConflictException('当前已有产品主表同步任务正在启动，请稍后再试');
    }

    this.xiyaSyncStarting = true;
    try {
      await this.failLingeringRunningSyncRecords();
      const recordId = await this.createSyncRecord({
        operationType: context?.operationType ?? 'manual_sync',
        operatorId: context?.operatorId,
        operatorName: context?.operatorName ?? null,
        sourceFileName: context?.sourceFileName ?? null,
        status: MasterProductSyncStatus.running,
        fetchedCount: 0,
        createdCount: 0,
        updatedCount: 0,
      });

      this.masterProductSyncRunning = true;
      setTimeout(() => {
        void this.runXiyaSyncJob(recordId, days);
      }, 0);

      return {
        recordId: recordId.toString(),
        status: MasterProductSyncStatus.running,
        message: `已启动同步任务，正在拉取最近 ${days} 天更新的产品主表数据`,
        days,
      };
    } finally {
      this.xiyaSyncStarting = false;
    }
  }
  async exportExcel(filters: ExportMasterProductsDto): Promise<MasterProductExportFile> {
    const where = this.buildMasterProductWhere(filters);
    const rows = await this.prisma.masterProduct.findMany({
      where,
      orderBy: [{ stockQty: 'desc' }, { productId: 'asc' }, { id: 'asc' }],
    });

    const worksheet = XLSX.utils.json_to_sheet(
      rows.map((row) => {
        const record: Record<string, string | number> = {};
        MASTER_PRODUCT_EXPORT_COLUMNS.forEach(([field, label]) => {
          if (field === 'stockQty') {
            record[label] = Number(row[field] ?? 0);
            return;
          }
          record[label] = String(row[field] ?? '');
        });
        return record;
      }),
    );
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '产品主表');
    const content = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const parts = getZonedDateParts(new Date(), APP_TIMEZONE);
    const fileName = `产品主表分类下载_${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}.xlsx`;

    return {
      fileName,
      content,
      totalRows: rows.length,
    };
  }

  async exportOverseasWarehouseStockExcel(): Promise<MasterProductExportFile> {
    const rows = await this.prisma.masterProduct.findMany({
      where: {
        stockQty: { gt: 0 },
      },
      select: {
        productId: true,
        productName: true,
        stockQty: true,
      },
      orderBy: [{ stockQty: 'desc' }, { productId: 'asc' }, { id: 'asc' }],
    });

    const worksheet = XLSX.utils.json_to_sheet(
      rows.map((row) => ({
        产品ID: row.productId,
        产品名称: row.productName ?? '',
        在库数: Number(row.stockQty ?? 0),
      })),
    );
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '海外仓库存');
    const content = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const parts = getZonedDateParts(new Date(), APP_TIMEZONE);
    const fileName = `海外仓库存下载-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}.xlsx`;

    return {
      fileName,
      content,
      totalRows: rows.length,
    };
  }

  async getUploadTemplate(): Promise<{ fileName: string; content: Buffer }> {
    const cwd = process.cwd();
    const candidates = [
      join(cwd, 'docs', MASTER_PRODUCT_TEMPLATE_FILE),
      join(cwd, '..', '..', 'docs', MASTER_PRODUCT_TEMPLATE_FILE),
    ];

    for (const templatePath of candidates) {
      try {
        const content = await readFile(templatePath);
        return {
          fileName: MASTER_PRODUCT_TEMPLATE_FILE,
          content,
        };
      } catch {
        // try next path
      }
    }

    throw new NotFoundException(`未找到模板文件：${MASTER_PRODUCT_TEMPLATE_FILE}`);
  }

  async getExportFilterOptions(): Promise<Record<MasterProductExportFilterKey, string[]>> {
    const entries = await Promise.all(
      MASTER_PRODUCT_EXPORT_SELECT_FIELDS.map(async (field) => {
        const rows = await this.prisma.masterProduct.findMany({
          where: {
            [field]: {
              not: null,
            },
          } as Prisma.MasterProductWhereInput,
          select: {
            [field]: true,
          } as Prisma.MasterProductSelect,
        });

        const values = Array.from(
          new Set(
            rows
              .map((row) => String(row[field] ?? '').trim())
              .filter((value) => Boolean(value)),
          ),
        ).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));

        return [field, values] as const;
      }),
    );

    return Object.fromEntries(entries) as Record<MasterProductExportFilterKey, string[]>;
  }

  async importExcel(
    fileBuffer: Buffer,
    originalName?: string,
    context?: MasterProductSyncContext,
  ): Promise<{
    fileName: string | null;
    totalRows: number;
    importedCount: number;
    createdCount: number;
    updatedCount: number;
  }> {
    if (this.xiyaSyncStarting || this.masterProductSyncRunning) {
      throw new ConflictException('当前已有产品主表同步或导入任务正在执行，请稍后再试');
    }
    this.masterProductSyncRunning = true;
    let recordId: bigint | null = null;

    try {
      await this.failLingeringRunningSyncRecords();
      recordId = await this.createSyncRecord({
        operationType: context?.operationType ?? 'bulk_upload',
        operatorId: context?.operatorId,
        operatorName: context?.operatorName ?? null,
        sourceFileName: context?.sourceFileName ?? originalName ?? null,
        status: MasterProductSyncStatus.running,
        fetchedCount: 0,
        createdCount: 0,
        updatedCount: 0,
      });

      const parsedImport = this.parseImportRows(fileBuffer);
      const parsedRows = parsedImport.rows;
      if (!parsedRows.length) {
        throw new BadRequestException('Excel 中没有可导入的产品主表数据');
      }

      const importResult = await this.upsertImportRows(parsedRows, parsedImport.presentFields);
      await this.finishSyncRecord(recordId, {
        status: MasterProductSyncStatus.success,
        fetchedCount: parsedRows.length,
        createdCount: importResult.createdCount,
        updatedCount: importResult.updatedCount,
      });

      return {
        fileName: originalName ?? null,
        totalRows: parsedRows.length,
        importedCount: parsedRows.length,
        createdCount: importResult.createdCount,
        updatedCount: importResult.updatedCount,
      };
    } catch (error) {
      if (recordId) {
        await this.finishSyncRecord(recordId, {
          status: MasterProductSyncStatus.failed,
          errorMessage: this.toSafeSyncErrorMessage(error),
        });
      }
      throw error;
    } finally {
      this.masterProductSyncRunning = false;
    }
  }
  private async runXiyaSyncJob(recordId: bigint, days: number): Promise<void> {
    try {
      const result = await this.performXiyaSync(days);
      await this.finishSyncRecord(recordId, {
        status: MasterProductSyncStatus.success,
        fetchedCount: result.totalRows,
        createdCount: result.createdCount,
        updatedCount: result.updatedCount,
      });
    } catch (error) {
      await this.finishSyncRecord(recordId, {
        status: MasterProductSyncStatus.failed,
        errorMessage: this.toSafeSyncErrorMessage(error),
      });
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`master product sync job failed: ${message}`);
    } finally {
      this.masterProductSyncRunning = false;
    }
  }

  private async performXiyaSync(days: number): Promise<{
    totalRows: number;
    importedCount: number;
    createdCount: number;
    updatedCount: number;
    days: number;
  }> {
    const rows = await this.fetchXiyaImportRows(days);
    if (!rows.length) {
      return {
        totalRows: 0,
        importedCount: 0,
        createdCount: 0,
        updatedCount: 0,
        days,
      };
    }

    const result = await this.upsertImportRows(rows, XIYA_SYNC_UPDATE_FIELDS);
    return {
      totalRows: rows.length,
      importedCount: rows.length,
      createdCount: result.createdCount,
      updatedCount: result.updatedCount,
      days,
    };
  }

  private async failLingeringRunningSyncRecords(): Promise<void> {
    await this.prisma.masterProductSyncRecord.updateMany({
      where: {
        status: MasterProductSyncStatus.running,
      },
      data: {
        status: MasterProductSyncStatus.failed,
        finishedAt: new Date(),
        errorMessage: 'interrupted by process restart before a new sync/import run',
      },
    });
  }

  async detail(productIdRaw: string): Promise<unknown> {
    const productId = String(productIdRaw || '').trim();
    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }

    const [product, skus, currentProductBoxRows] = await Promise.all([
      this.prisma.masterProduct.findUnique({
        where: { productId },
      }),
      this.prisma.sku.findMany({
        where: {
          productId,
          status: 1,
        },
        select: {
          id: true,
          productId: true,
          sku: true,
          asin: true,
          fnsku: true,
          fbmSku: true,
          rbSku: true,
          shop: true,
        },
        orderBy: [{ sku: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.masterProductBoxInventory.findMany({
        where: {
          productId,
          qty: { gt: 0 },
        },
        select: {
          boxId: true,
        },
      }),
    ]);
    if (!product) {
      throw new NotFoundException('未找到产品主表信息');
    }

    const relatedBoxIds = Array.from(
      new Set(
        currentProductBoxRows
          .map((row) => Number(row.boxId))
          .filter((boxId) => Number.isInteger(boxId) && boxId > 0),
      ),
    );

    const relatedBoxInventoryRows = relatedBoxIds.length
      ? await this.prisma.masterProductBoxInventory.findMany({
          where: {
            boxId: { in: relatedBoxIds },
            qty: { gt: 0 },
          },
          select: {
            productId: true,
            qty: true,
            updatedAt: true,
            box: {
              select: {
                id: true,
                boxCode: true,
                shelf: {
                  select: {
                    shelfCode: true,
                    name: true,
                  },
                },
              },
            },
            product: {
              select: {
                productId: true,
                productName: true,
                stockQty: true,
              },
            },
          },
        })
      : [];

    const skuItems = skus.map((item) => ({
      id: item.id.toString(),
      sku: item.sku,
      asin: item.asin,
      fnsku: item.fnsku,
      fbmSku: item.fbmSku,
      rbSku: item.rbSku,
      shop: item.shop,
    }));

    const boxMap = new Map<
      number,
      {
        boxId: string;
        boxCode: string;
        shelfCode: string | null;
        shelfName: string | null;
        qty: number;
        updatedAt: Date;
        items: Array<{
          productId: string;
          productName: string | null;
          stockQty: number;
          qty: number;
          isCurrentProduct: boolean;
        }>;
      }
    >();

    for (const row of relatedBoxInventoryRows) {
      const boxId = Number(row.box.id);
      const current = boxMap.get(boxId);
      const itemQty = Number(row.qty ?? 0);
      const item = {
        productId: row.product?.productId ?? row.productId,
        productName: row.product?.productName ?? null,
        stockQty: Number(row.product?.stockQty ?? 0),
        qty: itemQty,
        isCurrentProduct: row.productId === productId,
      };

      if (current) {
        current.items.push(item);
        if (item.isCurrentProduct) {
          current.qty = itemQty;
          current.updatedAt = row.updatedAt;
        }
        continue;
      }

      boxMap.set(boxId, {
        boxId: row.box.id.toString(),
        boxCode: row.box.boxCode,
        shelfCode: row.box.shelf?.shelfCode ?? null,
        shelfName: row.box.shelf?.name ?? null,
        qty: item.isCurrentProduct ? itemQty : 0,
        updatedAt: row.updatedAt,
        items: [item],
      });
    }

    const boxes = Array.from(boxMap.values())
      .map((box) => ({
        ...box,
        items: box.items.sort((a, b) => {
          if (a.isCurrentProduct !== b.isCurrentProduct) {
            return a.isCurrentProduct ? -1 : 1;
          }
          return String(a.productId).localeCompare(String(b.productId), 'en', { numeric: true });
        }),
      }))
      .sort((a, b) => {
        const shelfCompare = String(a.shelfCode || '').localeCompare(
          String(b.shelfCode || ''),
          'zh-Hans-CN',
        );
        if (shelfCompare !== 0) {
          return shelfCompare;
        }
        return String(a.boxCode || '').localeCompare(String(b.boxCode || ''), 'en', {
          numeric: true,
        });
      });

    return {
      product,
      skus: skuItems,
      boxes,
    };
  }

  async updatePrintSettings(
    productIdRaw: string,
    payload: UpdateMasterProductPrintSettingsDto,
  ): Promise<unknown> {
    const productId = String(productIdRaw || '').trim();
    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }

    const yamatoPrinterName = this.toNullableText(String(payload?.yamatoPrinterName ?? ''));
    const product = await this.prisma.masterProduct.update({
      where: { productId },
      data: {
        yamatoPrinterName,
      },
    });

    return {
      productId: product.productId,
      yamatoPrinterName: product.yamatoPrinterName ?? null,
    };
  }

  async manualAdjustBoxInventory(
    productIdRaw: string,
    payload: ManualAdjustMasterProductBoxDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const productId = String(productIdRaw || '').trim();
    const boxCode = String(payload.boxCode || '').trim();
    const qtyDelta = Math.trunc(Number(payload.qtyDelta));
    const reason = String(payload.reason || '').trim() || null;

    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }
    if (!boxCode) {
      throw new BadRequestException('箱号不能为空');
    }
    if (!Number.isInteger(qtyDelta) || qtyDelta <= 0) {
      throw new BadRequestException('数量必须是大于 0 的整数');
    }

    return this.prisma.$transaction(async (tx) => {
      const [product, box] = await Promise.all([
        tx.masterProduct.findUnique({
          where: { productId },
          select: {
            id: true,
            productId: true,
            stockQty: true,
          },
        }),
        tx.box.findUnique({
          where: { boxCode },
          select: {
            id: true,
            boxCode: true,
            shelf: {
              select: {
                shelfCode: true,
                name: true,
              },
            },
          },
        }),
      ]);

      if (!product) {
        throw new NotFoundException('未找到产品主表信息');
      }
      if (!box) {
        throw new NotFoundException('未找到箱号信息');
      }

      const currentInventory = await tx.masterProductBoxInventory.findUnique({
        where: {
          boxId_productId: {
            boxId: box.id,
            productId,
          },
        },
      });

      const beforeQty = Number(currentInventory?.qty ?? 0);
      const afterQty = beforeQty + qtyDelta;

      await tx.masterProductBoxInventory.upsert({
        where: {
          boxId_productId: {
            boxId: box.id,
            productId,
          },
        },
        update: {
          qty: afterQty,
        },
        create: {
          boxId: box.id,
          productId,
          qty: afterQty,
        },
      });

      const totalQty = await this.recalculateMasterProductStockQty(tx, productId);

      await this.auditService.create({
        db: tx,
        entityType: 'box',
        entityId: box.id,
        action: AuditAction.update,
        eventType: AuditEventType.BOX_STOCK_INCREASED,
        beforeData: {
          scope: 'master_product',
          productId,
          qty: beforeQty,
        },
        afterData: {
          scope: 'master_product',
          productId,
          qty: afterQty,
          qtyDelta,
        },
        operatorId,
        requestId,
        remark: reason ?? `master product inbound ${productId}`,
      });

      await this.auditService.create({
        db: tx,
        entityType: 'master_product',
        entityId: product.id,
        action: AuditAction.update,
        eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
        beforeData: {
          productId,
          stockQty: Number(product.stockQty ?? 0),
        },
        afterData: {
          productId,
          stockQty: totalQty,
          boxCode: box.boxCode,
          qtyDelta,
        },
        operatorId,
        requestId,
        remark: reason ?? `master product inbound ${productId}`,
      });

      return {
        productId,
        boxCode: box.boxCode,
        qtyDelta,
        boxQty: afterQty,
        stockQty: totalQty,
      };
    });
  }

  async createFbaReplenishment(
    productIdRaw: string,
    payload: CreateMasterProductFbaReplenishmentDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const productId = String(productIdRaw || '').trim();
    const boxCode = normalizeBoxCode(payload.boxCode);
    const skuId = BigInt(payload.skuId ?? 0);
    const requestedQty = Math.trunc(Number(payload.qty));
    const remark = String(payload.remark || '').trim() || 'FBA补货';

    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }
    if (!boxCode) {
      throw new BadRequestException('箱号不能为空');
    }
    if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
      throw new BadRequestException('申请数量必须是大于 0 的整数');
    }

    return this.prisma.$transaction(async (tx) => {
      const [product, sku, box] = await Promise.all([
        tx.masterProduct.findUnique({
          where: { productId },
          select: {
            id: true,
            productId: true,
            stockQty: true,
          },
        }),
        tx.sku.findFirst({
          where: {
            id: skuId,
            status: 1,
          },
          select: {
            id: true,
            sku: true,
            productId: true,
            fnsku: true,
            shop: true,
          },
        }),
        tx.box.findUnique({
          where: { boxCode },
          select: {
            id: true,
            boxCode: true,
            shelf: {
              select: {
                shelfCode: true,
              },
            },
          },
        }),
      ]);

      if (!product) {
        throw new NotFoundException('未找到产品主表信息');
      }
      if (!sku) {
        throw new NotFoundException('未找到SKU信息');
      }
      if (String(sku.productId || '').trim() !== productId) {
        throw new ConflictException('所选SKU不属于当前主表产品');
      }
      if (!String(sku.fnsku || '').trim()) {
        throw new BadRequestException('该SKU缺少FNSKU，无法创建FBA补货');
      }
      if (!String(sku.shop || '').trim()) {
        throw new BadRequestException('该SKU缺少所属店铺，无法创建FBA补货');
      }
      if (!box) {
        throw new NotFoundException('未找到箱号信息');
      }

      const boxInventory = await tx.masterProductBoxInventory.findUnique({
        where: {
          boxId_productId: {
            boxId: box.id,
            productId,
          },
        },
        select: {
          qty: true,
        },
      });
      const currentQty = Number(boxInventory?.qty ?? 0);
      if (currentQty <= 0) {
        throw new ConflictException('当前箱号下该主表产品无可用库存，无法创建FBA补货申请');
      }

      const existingActiveSku = await tx.fbaReplenishment.findFirst({
        where: {
          skuId: sku.id,
          status: {
            in: ['pending_confirm', 'pending_outbound'],
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        select: {
          requestNo: true,
          status: true,
          boxId: true,
          requestedQty: true,
          actualQty: true,
        },
      });
      if (existingActiveSku) {
        if (existingActiveSku.boxId !== box.id) {
          throw new ConflictException('该SKU已有其他箱号的FBA补货申请，请先处理后再申请');
        }
        const activeQty = this.getActiveFbaReservedQty(existingActiveSku);
        throw new ConflictException(
          `本SKU已有待处理FBA补货申请 ${activeQty} 件，请求单号（${existingActiveSku.requestNo}）`,
        );
      }

      const activeProductRows = await tx.fbaReplenishment.findMany({
        where: {
          boxId: box.id,
          status: {
            in: ['pending_confirm', 'pending_outbound'],
          },
          sku: {
            productId,
          },
        },
        select: {
          status: true,
          requestedQty: true,
          actualQty: true,
        },
      });
      const reservedQty = activeProductRows.reduce(
        (sum, row) => sum + this.getActiveFbaReservedQty(row),
        0,
      );
      const availableQty = currentQty - reservedQty;
      if (requestedQty > availableQty) {
        throw new ConflictException(`申请数量不能大于当前箱号该主表产品可用数量（${availableQty}）`);
      }

      const requestNo = await this.generateFbaRequestNo(tx);
      const created = await tx.fbaReplenishment.create({
        data: {
          requestNo,
          status: 'pending_confirm',
          skuId: sku.id,
          boxId: box.id,
          requestedQty,
          actualQty: null,
          remark,
          createdBy: operatorId,
        },
        include: {
          sku: {
            select: {
              id: true,
              sku: true,
            },
          },
          box: {
            select: {
              id: true,
              boxCode: true,
              shelf: {
                select: {
                  shelfCode: true,
                },
              },
            },
          },
          creator: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'fba_replenishment',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.INVENTORY_ADJUST_CREATED,
        beforeData: null,
        afterData: {
          requestNo: created.requestNo,
          status: created.status,
          skuId: created.skuId.toString(),
          boxId: created.boxId.toString(),
          productId,
          requestedQty: created.requestedQty,
        },
        operatorId,
        requestId,
      });

      return {
        id: created.id.toString(),
        requestNo: created.requestNo,
        status: created.status,
        sku: {
          id: created.sku.id.toString(),
          sku: created.sku.sku,
        },
        box: {
          id: created.box.id.toString(),
          boxCode: created.box.boxCode,
          shelfCode: created.box.shelf?.shelfCode ?? null,
        },
        requestedQty: created.requestedQty,
        actualQty: created.actualQty,
        expressNo: created.expressNo,
        remark: created.remark,
        creator: created.creator
          ? {
              id: created.creator.id.toString(),
              username: created.creator.username,
            }
          : null,
        createdAt: created.createdAt,
      };
    });
  }

  async outboundOne(
    productIdRaw: string,
    payload: CreateMasterProductOutboundOneDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const productId = String(productIdRaw || '').trim();
    const boxCode = normalizeBoxCode(payload.boxCode);
    const skuId = BigInt(payload.skuId ?? 0);
    const remark = String(payload.remark || '').trim() || '主商品库存入库';

    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }
    if (!boxCode) {
      throw new BadRequestException('箱号不能为空');
    }

    return this.prisma.$transaction(async (tx) => {
      const [product, sku, box] = await Promise.all([
        tx.masterProduct.findUnique({
          where: { productId },
          select: {
            id: true,
            productId: true,
            stockQty: true,
          },
        }),
        tx.sku.findFirst({
          where: {
            id: skuId,
            status: 1,
          },
          select: {
            id: true,
            sku: true,
            productId: true,
          },
        }),
        tx.box.findUnique({
          where: { boxCode },
          select: {
            id: true,
            boxCode: true,
          },
        }),
      ]);

      if (!product) {
        throw new NotFoundException('未找到产品主表信息');
      }
      if (!sku) {
        throw new NotFoundException('未找到SKU信息');
      }
      if (String(sku.productId || '').trim() !== productId) {
        throw new ConflictException('所选SKU不属于当前主表产品');
      }
      if (!box) {
        throw new NotFoundException('未找到箱号信息');
      }

      const currentInventory = await tx.masterProductBoxInventory.findUnique({
        where: {
          boxId_productId: {
            boxId: box.id,
            productId,
          },
        },
      });
      const beforeQty = Number(currentInventory?.qty ?? 0);
      if (beforeQty <= 0) {
        throw new ConflictException('当前箱号下该主表产品无可用库存，无法出库');
      }

      const afterQty = beforeQty - 1;
      await tx.masterProductBoxInventory.update({
        where: {
          boxId_productId: {
            boxId: box.id,
            productId,
          },
        },
        data: {
          qty: afterQty,
        },
      });

      const totalQty = await this.recalculateMasterProductStockQty(tx, productId);

      await this.auditService.create({
        db: tx,
        entityType: 'box',
        entityId: box.id,
        action: AuditAction.update,
        eventType: AuditEventType.BOX_STOCK_OUTBOUND,
        beforeData: {
          scope: 'master_product',
          productId,
          skuId: sku.id.toString(),
          qty: beforeQty,
        },
        afterData: {
          scope: 'master_product',
          productId,
          skuId: sku.id.toString(),
          qty: afterQty,
          qtyDelta: -1,
        },
        operatorId,
        requestId,
        remark: remark ?? `master product outbound one ${productId}`,
      });

      await this.auditService.create({
        db: tx,
        entityType: 'master_product',
        entityId: product.id,
        action: AuditAction.update,
        eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
        beforeData: {
          productId,
          skuId: sku.id.toString(),
          stockQty: Number(product.stockQty ?? 0),
        },
        afterData: {
          productId,
          skuId: sku.id.toString(),
          stockQty: totalQty,
          boxCode: box.boxCode,
          qtyDelta: -1,
        },
        operatorId,
        requestId,
        remark: remark ?? `master product outbound one ${productId}`,
      });

      return {
        productId,
        skuId: sku.id.toString(),
        boxCode: box.boxCode,
        qtyDelta: -1,
        boxQty: afterQty,
        stockQty: totalQty,
      };
    });
  }

  async outboundOneByProduct(
    productIdRaw: string,
    payload: CreateMasterProductOutboundOneDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const productId = String(productIdRaw || '').trim();
    const boxCode = normalizeBoxCode(payload.boxCode);
    const remark = String(payload.remark || '').trim() || '主商品库存出库';

    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }
    if (!boxCode) {
      throw new BadRequestException('箱号不能为空');
    }

    return this.prisma.$transaction(async (tx) => {
      const [product, box] = await Promise.all([
        tx.masterProduct.findUnique({
          where: { productId },
          select: {
            id: true,
            productId: true,
            stockQty: true,
          },
        }),
        tx.box.findUnique({
          where: { boxCode },
          select: {
            id: true,
            boxCode: true,
          },
        }),
      ]);

      if (!product) {
        throw new NotFoundException('未找到产品主表信息');
      }
      if (!box) {
        throw new NotFoundException('未找到箱号信息');
      }

      const currentInventory = await tx.masterProductBoxInventory.findUnique({
        where: {
          boxId_productId: {
            boxId: box.id,
            productId,
          },
        },
      });
      const beforeQty = Number(currentInventory?.qty ?? 0);
      if (beforeQty <= 0) {
        throw new ConflictException('当前箱号下该主表产品无可用库存，无法出库');
      }

      const afterQty = beforeQty - 1;
      await tx.masterProductBoxInventory.update({
        where: {
          boxId_productId: {
            boxId: box.id,
            productId,
          },
        },
        data: {
          qty: afterQty,
        },
      });

      const totalQty = await this.recalculateMasterProductStockQty(tx, productId);

      await this.auditService.create({
        db: tx,
        entityType: 'box',
        entityId: box.id,
        action: AuditAction.update,
        eventType: AuditEventType.BOX_STOCK_OUTBOUND,
        beforeData: {
          scope: 'master_product',
          productId,
          qty: beforeQty,
        },
        afterData: {
          scope: 'master_product',
          productId,
          qty: afterQty,
          qtyDelta: -1,
        },
        operatorId,
        requestId,
        remark: remark ?? `master product outbound one ${productId}`,
      });

      await this.auditService.create({
        db: tx,
        entityType: 'master_product',
        entityId: product.id,
        action: AuditAction.update,
        eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
        beforeData: {
          productId,
          stockQty: Number(product.stockQty ?? 0),
        },
        afterData: {
          productId,
          stockQty: totalQty,
          boxCode: box.boxCode,
          qtyDelta: -1,
        },
        operatorId,
        requestId,
        remark: remark ?? `master product outbound one ${productId}`,
      });

      return {
        productId,
        boxCode: box.boxCode,
        qtyDelta: -1,
        boxQty: afterQty,
        stockQty: totalQty,
      };
    });
  }

  private async recalculateMasterProductStockQty(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<number> {
    const aggregate = await tx.masterProductBoxInventory.aggregate({
      where: {
        productId,
        qty: { gt: 0 },
      },
      _sum: {
        qty: true,
      },
    });
    const totalQty = Number(aggregate._sum.qty ?? 0);

    await tx.masterProduct.update({
      where: { productId },
      data: {
        stockQty: totalQty,
      },
    });

    return totalQty;
  }

  private parseImportRows(fileBuffer: Buffer): ParsedMasterProductImport {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    } catch {
      throw new BadRequestException('无法解析 Excel 文件');
    }

    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new BadRequestException('Excel 中未找到可读取的工作表');
    }

    const sheet = workbook.Sheets[firstSheet];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (!rawRows.length) {
      throw new BadRequestException('Excel 中没有数据');
    }

    const presentFields = this.resolvePresentImportFields(rawRows);
    const resultByProductId = new Map<string, MasterProductImportRow>();
    const errors: string[] = [];

    rawRows.forEach((rawRow, idx) => {
      const rowNo = idx + 2;
      const normalized: Record<string, string> = {};
      Object.entries(rawRow).forEach(([key, value]) => {
        normalized[this.normalizeHeader(key)] = String(value ?? '').trim();
      });

      const productId = this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.productId);
      if (!productId) {
        errors.push(`第 ${rowNo} 行缺少产品ID`);
        return;
      }

      resultByProductId.set(productId, {
        productId,
        productName: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.productName),
        ),
        productType: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.productType),
        ),
        bagBrand: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.bagBrand),
        ),
        color: this.toNullableText(this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.color)),
        bagName: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.bagName),
        ),
        bagType: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.bagType),
        ),
        zipperStyle: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.zipperStyle),
        ),
        style: this.toNullableText(this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.style)),
        pattern: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.pattern),
        ),
        buckleType: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.buckleType),
        ),
        matchingBagType: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.matchingBagType),
        ),
        length: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.length),
        ),
        width: this.toNullableText(this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.width)),
        patternType: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.patternType),
        ),
        size: this.toNullableText(this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.size)),
        yamatoPrinterName: this.toNullableText(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.yamatoPrinterName),
        ),
        stockQty: null,
      });
    });

    if (errors.length) {
      throw new BadRequestException(errors.slice(0, 10).join('；'));
    }

    return {
      rows: Array.from(resultByProductId.values()),
      presentFields,
    };
  }

  private async fetchXiyaImportRows(days: number): Promise<MasterProductImportRow[]> {
    const url = new URL(XIYA_EXPORT_URL);
    url.searchParams.set('company_name', XIYA_COMPANY_NAME);
    url.searchParams.set('apiKey', XIYA_EXPORT_API_KEY);
    url.searchParams.set('days', String(days));

    let payload: unknown;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': XIYA_EXPORT_API_KEY,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
      throw new InternalServerErrorException(`汐雅产品接口请求失败：HTTP ${response.status}`);
      }
      payload = await response.json();
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof InternalServerErrorException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `汐雅产品接口请求失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }

    const rows = this.extractXiyaRows(payload);
    return this.mapXiyaRowsToImportRows(rows);
  }

  private extractXiyaRows(payload: unknown): XiyaExternalProductRow[] {
    if (!payload || typeof payload !== 'object') {
      throw new InternalServerErrorException('汐雅产品接口返回格式无效');
    }

    const root = payload as Record<string, unknown>;
    if (!XIYA_SUCCESS_CODES.has(Number(root.code))) {
      throw new InternalServerErrorException(`汐雅产品接口返回失败：${String(root.message ?? '未知错误')}`);
    }
    const data = root.data;
    if (!data || typeof data !== 'object') {
      throw new InternalServerErrorException('汐雅产品接口缺少 data 字段');
    }

    const rows = (data as Record<string, unknown>).rows;
    if (!Array.isArray(rows)) {
      throw new InternalServerErrorException('汐雅产品接口缺少 rows 数据');
    }

    return rows as XiyaExternalProductRow[];
  }

  private mapXiyaRowsToImportRows(rows: XiyaExternalProductRow[]): MasterProductImportRow[] {
    const resultByProductId = new Map<string, MasterProductImportRow>();
    const errors: string[] = [];

    rows.forEach((rawRow, index) => {
      const productId = String(rawRow?.id ?? '').trim();
      if (!productId) {
        errors.push(`第 ${index + 1} 条缺少产品ID`);
        return;
      }

      const properties = new Map<string, string>();
      if (Array.isArray(rawRow?.properties)) {
        rawRow.properties.forEach((item) => {
          const key = this.normalizeHeader(item?.property_name);
          const value = String(item?.property_value ?? '').trim();
          if (key && value) {
            properties.set(key, value);
          }
        });
      }

      const pickProperty = (aliases: readonly string[]): string =>
        this.pickField(Object.fromEntries(properties.entries()), aliases);

      resultByProductId.set(productId, {
        productId,
        productName: this.toNullableText(String(rawRow?.name ?? '')),
        productType: this.toNullableText(String(rawRow?.product_type ?? '')),
        bagBrand: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.bagBrand)),
        color: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.color)),
        bagName: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.bagName)),
        bagType: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.bagType)),
        zipperStyle: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.zipperStyle)),
        style: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.style)),
        pattern: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.pattern)),
        buckleType: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.buckleType)),
        matchingBagType: this.toNullableText(
          pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.matchingBagType),
        ),
        length: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.length)),
        width: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.width)),
        patternType: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.patternType)),
        size: this.toNullableText(pickProperty(MASTER_PRODUCT_COLUMN_ALIASES.size)),
        yamatoPrinterName: null,
        stockQty: null,
      });
    });

    if (errors.length) {
      throw new BadRequestException(errors.slice(0, 10).join('；'));
    }

    return Array.from(resultByProductId.values());
  }

  private async upsertImportRows(
    rows: MasterProductImportRow[],
    presentFields: Set<ImportedMasterProductField>,
  ): Promise<{ createdCount: number; updatedCount: number }> {
    const existingRows = await this.loadExistingMasterProducts(rows.map((row) => row.productId));
    const createRows: MasterProductImportRow[] = [];
    const updateRows: MasterProductImportRow[] = [];

    rows.forEach((row) => {
      const existingRow = existingRows.get(row.productId);
      if (existingRow && this.hasMasterProductChanges(existingRow, row, presentFields)) {
        updateRows.push(row);
        return;
      }
      if (existingRow) {
        return;
      }
      createRows.push(row);
    });

    let createdCount = 0;
    for (const chunk of this.chunkRows(createRows, CREATE_CHUNK_SIZE)) {
      const result = await this.prisma.masterProduct.createMany({
        data: chunk.map((row) => this.toCreateInput(row)),
        skipDuplicates: true,
      });
      createdCount += Number(result.count ?? 0);
    }

    await this.updateExistingMasterProducts(updateRows, presentFields);

    return {
      createdCount,
      updatedCount: updateRows.length,
    };
  }

  private async updateExistingMasterProducts(
    rows: MasterProductImportRow[],
    presentFields: Set<ImportedMasterProductField>,
  ): Promise<void> {
    for (const chunk of this.chunkRows(rows, UPDATE_CHUNK_SIZE)) {
      const assignments: Prisma.Sql[] = [];
      const addAssignment = (
        field: ImportedMasterProductField,
        column: string,
        selector: (row: MasterProductImportRow) => string | number | null,
      ): void => {
        if (presentFields.has(field)) {
          assignments.push(this.buildCaseUpdateSql(column, chunk, selector));
        }
      };

      addAssignment('productName', 'product_name', (row) => row.productName);
      addAssignment('productType', 'product_type', (row) => row.productType);
      addAssignment('bagBrand', 'bag_brand', (row) => row.bagBrand);
      addAssignment('color', 'color', (row) => row.color);
      addAssignment('bagName', 'bag_name', (row) => row.bagName);
      addAssignment('bagType', 'bag_type', (row) => row.bagType);
      addAssignment('zipperStyle', 'zipper_style', (row) => row.zipperStyle);
      addAssignment('style', 'style', (row) => row.style);
      addAssignment('pattern', 'pattern', (row) => row.pattern);
      addAssignment('buckleType', 'buckle_type', (row) => row.buckleType);
      addAssignment('matchingBagType', 'matching_bag_type', (row) => row.matchingBagType);
      addAssignment('length', 'length', (row) => row.length);
      addAssignment('width', 'width', (row) => row.width);
      addAssignment('patternType', 'pattern_type', (row) => row.patternType);
      addAssignment('size', 'size', (row) => row.size);
      addAssignment('yamatoPrinterName', 'yamato_printer_name', (row) => row.yamatoPrinterName);

      assignments.push(Prisma.sql`status = 1`);
      assignments.push(Prisma.sql`updated_at = CURRENT_TIMESTAMP(3)`);

      await this.prisma.$executeRaw(
        Prisma.sql`
          UPDATE master_products
          SET ${Prisma.join(assignments, ", ")}
          WHERE product_id IN (${Prisma.join(chunk.map((row) => row.productId))})
        `,
      );
    }
  }

  private buildCaseUpdateSql(
    column: string,
    rows: MasterProductImportRow[],
    selector: (row: MasterProductImportRow) => string | number | null,
  ): Prisma.Sql {
    const columnSql = Prisma.raw(column);
    const clauses = rows.map((row) => Prisma.sql`WHEN ${row.productId} THEN ${selector(row)}`);
    return Prisma.sql`${columnSql} = CASE product_id ${Prisma.join(clauses, " ")} ELSE ${columnSql} END`;
  }
  private async createSyncRecord(payload: {
    operationType: MasterProductSyncOperationType;
    operatorId?: bigint | null;
    operatorName?: string | null;
    sourceFileName?: string | null;
    status: MasterProductSyncStatus;
    fetchedCount: number;
    createdCount: number;
    updatedCount: number;
  }): Promise<bigint> {
    const record = await this.prisma.masterProductSyncRecord.create({
      data: {
        operationType: payload.operationType,
        executedBy: payload.operatorId ?? null,
        operatorName: payload.operatorName ?? null,
        sourceFileName: payload.sourceFileName ?? null,
        status: payload.status,
        fetchedCount: payload.fetchedCount,
        createdCount: payload.createdCount,
        updatedCount: payload.updatedCount,
      },
    });
    return record.id;
  }

  private async finishSyncRecord(
    id: bigint,
    payload: {
      status: MasterProductSyncStatus;
      fetchedCount?: number;
      createdCount?: number;
      updatedCount?: number;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    await this.prisma.masterProductSyncRecord.update({
      where: { id },
      data: {
        status: payload.status,
        fetchedCount: payload.fetchedCount,
        createdCount: payload.createdCount,
        updatedCount: payload.updatedCount,
        errorMessage: payload.errorMessage ?? null,
        finishedAt: new Date(),
      },
    });
  }

  private toSafeSyncErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return String(message || 'unknown error').slice(0, 255);
  }

  private async loadExistingMasterProducts(
    productIds: string[],
  ): Promise<Map<string, MasterProductImportRow>> {
    const result = new Map<string, MasterProductImportRow>();
    for (const chunk of this.chunkRows(Array.from(new Set(productIds)), CREATE_CHUNK_SIZE)) {
      const rows = await this.prisma.masterProduct.findMany({
        where: { productId: { in: chunk } },
        select: {
          productId: true,
          productName: true,
          productType: true,
          bagBrand: true,
          color: true,
          bagName: true,
          bagType: true,
          zipperStyle: true,
          style: true,
          pattern: true,
          buckleType: true,
          matchingBagType: true,
          length: true,
          width: true,
          patternType: true,
          size: true,
          yamatoPrinterName: true,
          stockQty: true,
        },
      });
      rows.forEach((row) =>
        result.set(row.productId, {
          productId: row.productId,
          productName: row.productName,
          productType: row.productType,
          bagBrand: row.bagBrand,
          color: row.color,
          bagName: row.bagName,
          bagType: row.bagType,
          zipperStyle: row.zipperStyle,
          style: row.style,
          pattern: row.pattern,
          buckleType: row.buckleType,
          matchingBagType: row.matchingBagType,
          length: row.length,
          width: row.width,
          patternType: row.patternType,
          size: row.size,
          yamatoPrinterName: row.yamatoPrinterName,
          stockQty: Number(row.stockQty ?? 0),
        }),
      );
    }
    return result;
  }

  private hasMasterProductChanges(
    existingRow: MasterProductImportRow,
    nextRow: MasterProductImportRow,
    presentFields: Set<ImportedMasterProductField>,
  ): boolean {
    const comparableFields: ImportedMasterProductField[] = [
      'productName',
      'productType',
      'bagBrand',
      'color',
      'bagName',
      'bagType',
      'zipperStyle',
      'style',
      'pattern',
      'buckleType',
      'matchingBagType',
      'length',
      'width',
      'patternType',
      'size',
      'yamatoPrinterName',
    ];
    if (
      comparableFields.some(
        (field) => presentFields.has(field) && existingRow[field] !== nextRow[field],
      )
    ) {
      return true;
    }
    return false;
  }

  private toCreateInput(row: MasterProductImportRow): Prisma.MasterProductCreateManyInput {
    return {
      productId: row.productId,
      productName: row.productName,
      productType: row.productType,
      bagBrand: row.bagBrand,
      color: row.color,
      bagName: row.bagName,
      bagType: row.bagType,
      zipperStyle: row.zipperStyle,
      style: row.style,
      pattern: row.pattern,
      buckleType: row.buckleType,
      matchingBagType: row.matchingBagType,
      length: row.length,
      width: row.width,
      patternType: row.patternType,
      size: row.size,
      yamatoPrinterName: row.yamatoPrinterName,
      stockQty: 0,
      status: 1,
    };
  }



  private normalizePositiveInt(value: string | number | undefined, fallback: number): number {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      return fallback;
    }
    return numeric;
  }

  private normalizeHeader(value: unknown): string {
    return String(value ?? '')
      .trim()
      .replace(/[繝ｻ繝ｻ]/g, '(')
      .replace(/[繝ｻ繝ｻ]/g, ')')
      .replace(/[\s_-]+/g, '')
      .toLowerCase();
  }

  private resolvePresentImportFields(
    rawRows: Array<Record<string, unknown>>,
  ): Set<ImportedMasterProductField> {
    const normalizedHeaders = new Set<string>();
    rawRows.forEach((row) => {
      Object.keys(row).forEach((key) => {
        normalizedHeaders.add(this.normalizeHeader(key));
      });
    });

    const presentFields = new Set<ImportedMasterProductField>();
    MASTER_PRODUCT_IMPORT_FIELDS.forEach((field) => {
      const aliases = MASTER_PRODUCT_COLUMN_ALIASES[field];
      if (aliases.some((alias) => normalizedHeaders.has(this.normalizeHeader(alias)))) {
        presentFields.add(field);
      }
    });

    return presentFields;
  }

  private pickField(normalized: Record<string, string>, keys: readonly string[]): string {
    for (const key of keys) {
      const value = String(normalized[this.normalizeHeader(key)] ?? '').trim();
      if (value) {
        return value;
      }
    }
    return '';
  }

  private toNullableText(value: string): string | null {
    const text = String(value || '').trim();
    return text ? text : null;
  }

  private getActiveFbaReservedQty(row: {
    status: string;
    requestedQty: number;
    actualQty: number | null;
  }): number {
    return row.status === 'pending_outbound'
      ? Number(row.actualQty ?? row.requestedQty ?? 0)
      : Number(row.requestedQty ?? 0);
  }

  private formatFbaRequestNo(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `FBA-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
  }

  private async generateFbaRequestNo(tx: Prisma.TransactionClient): Promise<string> {
    let candidate = new Date();
    for (let index = 0; index < 5; index += 1) {
      const requestNo = this.formatFbaRequestNo(candidate);
      const exists = await tx.fbaReplenishment.findUnique({
        where: { requestNo },
        select: { id: true },
      });
      if (!exists) {
        return requestNo;
      }
      candidate = new Date(candidate.getTime() + 1000);
    }
    throw new ConflictException('生成FBA补货申请单号失败，请稍后重试');
  }

  private chunkRows<T>(rows: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < rows.length; index += size) {
      result.push(rows.slice(index, index + size));
    }
    return result;
  }

  private buildMasterProductWhere(
    filters: Partial<ExportMasterProductsDto>,
  ): Prisma.MasterProductWhereInput | undefined {
    const keyword = String(filters.keyword ?? '').trim();
    const conditions: Prisma.MasterProductWhereInput[] = [];

    if (keyword) {
      conditions.push({
        OR: [
          { productId: { contains: keyword } },
          { productName: { contains: keyword } },
          { productType: { contains: keyword } },
          { bagBrand: { contains: keyword } },
          {
            skus: {
              some: {
                status: 1,
                OR: [
                  { sku: { contains: keyword } },
                  { asin: { contains: keyword } },
                  { fnsku: { contains: keyword } },
                  { fbmSku: { contains: keyword } },
                  { rbSku: { contains: keyword } },
                ],
              },
            },
          },
        ],
      });
    }

    this.pushContainsFilter(conditions, 'productId', filters.productId);
    this.pushContainsFilter(conditions, 'productName', filters.productName);
    this.pushContainsFilter(conditions, 'productType', filters.productType);
    this.pushContainsFilter(conditions, 'bagBrand', filters.bagBrand);
    this.pushContainsFilter(conditions, 'color', filters.color);
    this.pushContainsFilter(conditions, 'bagName', filters.bagName);
    this.pushContainsFilter(conditions, 'bagType', filters.bagType);
    this.pushContainsFilter(conditions, 'zipperStyle', filters.zipperStyle);
    this.pushContainsFilter(conditions, 'style', filters.style);
    this.pushContainsFilter(conditions, 'pattern', filters.pattern);
    this.pushContainsFilter(conditions, 'buckleType', filters.buckleType);
    this.pushContainsFilter(conditions, 'matchingBagType', filters.matchingBagType);
    this.pushContainsFilter(conditions, 'length', filters.length);
    this.pushContainsFilter(conditions, 'width', filters.width);
    this.pushContainsFilter(conditions, 'patternType', filters.patternType);
    this.pushContainsFilter(conditions, 'size', filters.size);

    const stockQtyFilter: Prisma.IntFilter = {};
    if (Number.isInteger(filters.stockQtyMin)) {
      stockQtyFilter.gte = Number(filters.stockQtyMin);
    }
    if (Number.isInteger(filters.stockQtyMax)) {
      stockQtyFilter.lte = Number(filters.stockQtyMax);
    }
    if (Object.keys(stockQtyFilter).length) {
      conditions.push({ stockQty: stockQtyFilter });
    }

    if (!conditions.length) {
      return undefined;
    }
    if (conditions.length === 1) {
      return conditions[0];
    }
    return { AND: conditions };
  }

  private pushContainsFilter(
    conditions: Prisma.MasterProductWhereInput[],
    field: keyof Prisma.MasterProductWhereInput,
    rawValue: string | undefined,
  ): void {
    const value = String(rawValue ?? '').trim();
    if (!value) {
      return;
    }
    const isSelectField = MASTER_PRODUCT_EXPORT_SELECT_FIELDS.includes(
      field as MasterProductExportFilterKey,
    );
    conditions.push(
      {
        [field]: isSelectField
          ? {
              equals: value,
            }
          : {
              contains: value,
            },
      } as Prisma.MasterProductWhereInput,
    );
  }
}
