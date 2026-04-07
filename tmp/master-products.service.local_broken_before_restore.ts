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

type MasterProductListResult = {
  items: unknown[];
  page: number;
  pageSize: number;
  hasMore: boolean;
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
  stockQty: number | null;
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
const MASTER_PRODUCT_TEMPLATE_FILE = '????.xlsx';
const XIYA_EXPORT_URL = 'http://103.236.55.93/api/external/products';
const XIYA_EXPORT_API_KEY = 'xiya-export-4HHGJWBDGg29yp8W8TK3QRQ3m1A';
const MASTER_PRODUCT_SYNC_CRON = '0 0 0 * * 1';

const MASTER_PRODUCT_EXPORT_COLUMNS: Array<[keyof MasterProductImportRow, string]> = [
  ['productId', '??ID'],
  ['productName', '????'],
  ['productType', '????'],
  ['bagBrand', '????'],
  ['color', '??'],
  ['bagName', '??'],
  ['bagType', '??'],
  ['zipperStyle', '????'],
  ['style', '??'],
  ['pattern', '??'],
  ['buckleType', '????'],
  ['matchingBagType', '????'],
  ['length', '??'],
  ['width', '??'],
  ['patternType', '????'],
  ['size', '??'],
  ['stockQty', '???'],
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
  productId: ['productId', 'product id', '??ID', '??id'],
  productName: ['productName', 'product name', '????'],
  productType: ['productType', 'product type', '????', '????'],
  bagBrand: ['bagBrand', 'bag brand', '????', '??'],
  color: ['color', '??'],
  bagName: ['bagName', 'bag name', '??'],
  bagType: ['bagType', 'bag type', '??'],
  zipperStyle: ['zipperStyle', 'zipper style', '????'],
  style: ['style', '??'],
  pattern: ['pattern', '??', '??'],
  buckleType: ['buckleType', 'buckle type', '????'],
  matchingBagType: ['matchingBagType', 'matching bag type', '????', '??????'],
  length: ['length', '??'],
  width: ['width', '??'],
  patternType: ['patternType', 'pattern type', '????'],
  size: ['size', '??'],
  stockQty: ['stockQty', 'stock qty', '???', '???'],
} as const;

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
      throw new ConflictException('\u5f53\u524d\u5df2\u6709\u4ea7\u54c1\u4e3b\u8868\u540c\u6b65\u4efb\u52a1\u6b63\u5728\u542f\u52a8\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5');
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
        message: `\u5df2\u542f\u52a8\u540c\u6b65\u4efb\u52a1\uff0c\u6b63\u5728\u62c9\u53d6\u6700\u8fd1 ${days} \u5929\u66f4\u65b0\u7684\u4ea7\u54c1\u4e3b\u8868\u6570\u636e`,
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
    XLSX.utils.book_append_sheet(workbook, worksheet, '????');
    const content = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const parts = getZonedDateParts(new Date(), APP_TIMEZONE);
    const fileName = `??????_${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}.xlsx`;

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

    throw new NotFoundException(`譛ｪ謇ｾ蛻ｰ讓｡譚ｿ譁・ｻｶ・・{MASTER_PRODUCT_TEMPLATE_FILE}`);
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
          distinct: [field],
          orderBy: {
            [field]: 'asc',
          } as Prisma.MasterProductOrderByWithRelationInput,
        });

        const values = rows
          .map((row) => String(row[field] ?? '').trim())
          .filter((value) => Boolean(value));

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
      throw new ConflictException('\u5f53\u524d\u5df2\u6709\u4ea7\u54c1\u4e3b\u8868\u540c\u6b65\u6216\u5bfc\u5165\u4efb\u52a1\u6b63\u5728\u6267\u884c\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5');
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

      const parsedRows = this.parseImportRows(fileBuffer);
      if (!parsedRows.length) {
        throw new BadRequestException('Excel \u4e2d\u6ca1\u6709\u53ef\u5bfc\u5165\u7684\u4ea7\u54c1\u4e3b\u8868\u6570\u636e');
      }

      const importResult = await this.upsertImportRows(parsedRows);
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
  async syncFromXiya(
    daysRaw?: string | number,
    _context?: MasterProductSyncContext,
  ): Promise<{
    totalRows: number;
    importedCount: number;
    createdCount: number;
    updatedCount: number;
    days: number;
  }> {
    const days = Math.min(this.normalizePositiveInt(daysRaw, 10), 365);
    return this.performXiyaSync(days);
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

    const result = await this.upsertImportRows(rows);
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
      throw new BadRequestException('莠ｧ蜩！D荳崎・荳ｺ遨ｺ');
    }

    const product = await this.prisma.masterProduct.findUnique({
      where: { productId },
    });
    if (!product) {
      throw new NotFoundException('譛ｪ謇ｾ蛻ｰ莠ｧ蜩∽ｸｻ陦ｨ菫｡諱ｯ');
    }

    const skus = await this.prisma.sku.findMany({
      where: { productId },
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
    });

    const currentProductBoxRows = await this.prisma.masterProductBoxInventory.findMany({
      where: {
        productId,
        qty: { gt: 0 },
      },
      select: {
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
      },
    });

    const relatedBoxIds = Array.from(
      new Set(
        currentProductBoxRows
          .map((row) => Number(row.box.id))
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
      throw new BadRequestException('莠ｧ蜩！D荳崎・荳ｺ遨ｺ');
    }
    if (!boxCode) {
      throw new BadRequestException('邂ｱ蜿ｷ荳崎・荳ｺ遨ｺ');
    }
    if (!Number.isInteger(qtyDelta) || qtyDelta <= 0) {
      throw new BadRequestException('謨ｰ驥丞ｿ・｡ｻ譏ｯ螟ｧ莠・0 逧・紛謨ｰ');
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
        throw new NotFoundException('譛ｪ謇ｾ蛻ｰ莠ｧ蜩∽ｸｻ陦ｨ菫｡諱ｯ');
      }
      if (!box) {
        throw new NotFoundException('譛ｪ謇ｾ蛻ｰ莠ｧ蜩∽ｸｻ陦ｨ菫｡諱ｯ');
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
    const remark = String(payload.remark || '').trim() || 'FBA??';

    if (!productId) {
      throw new BadRequestException('??ID????');
    }
    if (!boxCode) {
      throw new BadRequestException('??????');
    }
    if (!skuId || skuId <= 0n) {
      throw new BadRequestException('??SKU????');
    }
    if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
      throw new BadRequestException('??????????');
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
        tx.sku.findUnique({
          where: { id: skuId },
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
        throw new NotFoundException('?????????');
      }
      if (!sku) {
        throw new NotFoundException('?????SKU');
      }
      if (String(sku.productId || '').trim() !== productId) {
        throw new ConflictException('??SKU?????????');
      }
      if (!String(sku.fnsku || '').trim()) {
        throw new BadRequestException('??SKU??FNSKU?????FBA??');
      }
      if (!String(sku.shop || '').trim()) {
        throw new BadRequestException('??SKU???????????FBA??');
      }
      if (!box) {
        throw new NotFoundException('???????');
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
        throw new ConflictException('?????????????????FBA????');
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
          throw new ConflictException('?SKU?????FBA????????????');
        }
        const activeQty = this.getActiveFbaReservedQty(existingActiveSku);
        throw new ConflictException(
          `?SKU?? ${activeQty} ????FBA??????? ${existingActiveSku.requestNo}`,
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
        throw new ConflictException(`?????????????????????${availableQty}?`);
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
    const remark = String(payload.remark || '').trim() || '????1?';

    if (!productId) {
      throw new BadRequestException('??ID????');
    }
    if (!boxCode) {
      throw new BadRequestException('??????');
    }
    if (!skuId || skuId <= 0n) {
      throw new BadRequestException('??SKU????');
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
        tx.sku.findUnique({
          where: { id: skuId },
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
        throw new NotFoundException('?????????');
      }
      if (!sku) {
        throw new NotFoundException('?????SKU');
      }
      if (String(sku.productId || '').trim() !== productId) {
        throw new ConflictException('??SKU?????????');
      }
      if (!box) {
        throw new NotFoundException('???????');
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
        throw new ConflictException('?????????????????');
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
    });
  }

  async outboundOneByProduct(
    });
  async outboundOneByProduct(
    productIdRaw: string,
    payload: CreateMasterProductOutboundOneDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const productId = String(productIdRaw || '').trim();
    const boxCode = normalizeBoxCode(payload.boxCode);
    const remark = String(payload.remark || '').trim() || '????1?';

    if (!productId) {
      throw new BadRequestException('??ID????');
    }
    if (!boxCode) {
      throw new BadRequestException('??????');
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
        throw new NotFoundException('?????????');
      }
      if (!box) {
        throw new NotFoundException('???????');
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
        throw new ConflictException('?????????????????');
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
    });
  }
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

  private parseImportRows(fileBuffer: Buffer): MasterProductImportRow[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    } catch {
      throw new BadRequestException('???? Excel ??');
    }

    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new BadRequestException('Excel ??????');
    }

    const sheet = workbook.Sheets[firstSheet];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (!rawRows.length) {
      throw new BadRequestException('Excel ?????');
    }

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
        errors.push(`? ${rowNo} ?????ID`);
        return;
      }

      let stockQty: number | null;
      try {
        stockQty = this.toNullableInt(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.stockQty),
        );
      } catch (error) {
        errors.push(
          error instanceof Error ? `? ${rowNo} ??${error.message}` : `? ${rowNo} ????????`,
        );
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
        stockQty,
      });
    });

    if (errors.length) {
      throw new BadRequestException(errors.slice(0, 10).join('?'));
    }

    return Array.from(resultByProductId.values());
  }

  private async fetchXiyaImportRows(days: number): Promise<MasterProductImportRow[]> {
    const url = `${XIYA_EXPORT_URL}?apiKey=${encodeURIComponent(XIYA_EXPORT_API_KEY)}&days=${encodeURIComponent(
      String(days),
    )}`;

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
        throw new InternalServerErrorException(`???????????HTTP ${response.status}`);
      }
      payload = await response.json();
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof InternalServerErrorException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `???????????${error instanceof Error ? error.message : '????'}`,
      );
    }

    const rows = this.extractXiyaRows(payload);
    return this.mapXiyaRowsToImportRows(rows);
  }

  private extractXiyaRows(payload: unknown): XiyaExternalProductRow[] {
    if (!payload || typeof payload !== 'object') {
      throw new InternalServerErrorException('?????????????');
    }

    const root = payload as Record<string, unknown>;
    const data = root.data;
    if (!data || typeof data !== 'object') {
      throw new InternalServerErrorException('?????????? data ??');
    }

    const rows = (data as Record<string, unknown>).rows;
    if (!Array.isArray(rows)) {
      throw new InternalServerErrorException('?????????? rows ??');
    }

    return rows as XiyaExternalProductRow[];
  }

  private mapXiyaRowsToImportRows(rows: XiyaExternalProductRow[]): MasterProductImportRow[] {
    const resultByProductId = new Map<string, MasterProductImportRow>();
    const errors: string[] = [];

    rows.forEach((rawRow, index) => {
      const productId = String(rawRow?.id ?? '').trim();
      if (!productId) {
        errors.push(`? ${index + 1} ???????ID`);
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
        stockQty: null,
      });
    if (errors.length) {
      throw new BadRequestException(errors.slice(0, 10).join('?'));
    }

    return Array.from(resultByProductId.values());
  }
    return Array.from(resultByProductId.values());
  }

  private async upsertImportRows(
    rows: MasterProductImportRow[],
  ): Promise<{ createdCount: number; updatedCount: number }> {
    const existingRows = await this.loadExistingMasterProducts(rows.map((row) => row.productId));
    const createRows: MasterProductImportRow[] = [];
    const updateRows: MasterProductImportRow[] = [];

    rows.forEach((row) => {
      const existingRow = existingRows.get(row.productId);
      if (existingRow && this.hasMasterProductChanges(existingRow, row)) {
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

    await this.updateExistingMasterProducts(updateRows);

    return {
      createdCount,
      updatedCount: updateRows.length,
    };
  }

  private async updateExistingMasterProducts(rows: MasterProductImportRow[]): Promise<void> {
    for (const chunk of this.chunkRows(rows, UPDATE_CHUNK_SIZE)) {
      const assignments: Prisma.Sql[] = [
        this.buildCaseUpdateSql('product_name', chunk, (row) => row.productName),
        this.buildCaseUpdateSql('product_type', chunk, (row) => row.productType),
        this.buildCaseUpdateSql('bag_brand', chunk, (row) => row.bagBrand),
        this.buildCaseUpdateSql('color', chunk, (row) => row.color),
        this.buildCaseUpdateSql('bag_name', chunk, (row) => row.bagName),
        this.buildCaseUpdateSql('bag_type', chunk, (row) => row.bagType),
        this.buildCaseUpdateSql('zipper_style', chunk, (row) => row.zipperStyle),
        this.buildCaseUpdateSql('style', chunk, (row) => row.style),
        this.buildCaseUpdateSql('pattern', chunk, (row) => row.pattern),
        this.buildCaseUpdateSql('buckle_type', chunk, (row) => row.buckleType),
        this.buildCaseUpdateSql('matching_bag_type', chunk, (row) => row.matchingBagType),
        this.buildCaseUpdateSql('length', chunk, (row) => row.length),
        this.buildCaseUpdateSql('width', chunk, (row) => row.width),
        this.buildCaseUpdateSql('pattern_type', chunk, (row) => row.patternType),
        this.buildCaseUpdateSql('size', chunk, (row) => row.size),
        Prisma.sql`status = 1`,
      ];

      const stockRows = chunk.filter((row) => row.stockQty !== null);
      if (stockRows.length) {
        assignments.push(this.buildCaseUpdateSql('stock_qty', stockRows, (row) => row.stockQty));
      }
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
          stockQty: Number(row.stockQty ?? 0),
        }),
      );
    }
    return result;
  }

  private hasMasterProductChanges(
    existingRow: MasterProductImportRow,
    nextRow: MasterProductImportRow,
  ): boolean {
    const comparableFields: Array<keyof MasterProductImportRow> = [
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
    ];
    if (comparableFields.some((field) => existingRow[field] !== nextRow[field])) {
      return true;
    }
    if (nextRow.stockQty !== null && Number(existingRow.stockQty ?? 0) !== nextRow.stockQty) {
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
      stockQty: row.stockQty ?? 0,
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
      .replace(/[・・]/g, '(')
      .replace(/[・・]/g, ')')
      .replace(/[\s_-]+/g, '')
      .toLowerCase();
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
  private toNullableInt(value: string): number | null {
    const text = String(value || '').trim();
    if (!text) {
      return null;
  private toNullableInt(value: string): number | null {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) {
      throw new BadRequestException(`?????????${text}`);
    }
    return Math.trunc(numeric);
  }
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
    throw new ConflictException('FBA陦･雍ｧ逕ｳ隸ｷ蜊募捷逕滓・螟ｱ雍･・瑚ｯｷ遞榊錘驥崎ｯ・);
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


