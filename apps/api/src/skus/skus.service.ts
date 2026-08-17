import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { readFile } from 'fs/promises';
import { AuditAction, Prisma, ProductEditRequestStatus } from '@prisma/client';
import { join } from 'path';
import JSZip = require('jszip');
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { normalizeNullableText, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSkuDto } from './dto/create-sku.dto';
import { UpdateSkuDto } from './dto/update-sku.dto';

type ImportSkuRow = {
  productId: string | null;
  sku: string;
  rbSku: string | null;
  asin: string | null;
  fnsku: string | null;
  fbmSku: string | null;
  shop: string | null;
  remark: string | null;
};

type ProductSnapshot = {
  productId: string | null;
  sku: string | null;
  rbSku: string | null;
  asin: string | null;
  fnsku: string | null;
  fbmSku: string | null;
  shop: string | null;
  remark: string | null;
};

type SkuExportFile = {
  fileName: string;
  content: Buffer;
};

const SNAPSHOT_FIELDS: Array<keyof ProductSnapshot> = [
  'productId',
  'sku',
  'rbSku',
  'asin',
  'fnsku',
  'fbmSku',
  'shop',
  'remark',
];
const SKU_UPLOAD_TEMPLATE_FILE = '批量上传SKU.xlsx';

const IMPORT_FIELD_LIMITS: Record<keyof ImportSkuRow, number> = {
  productId: 128,
  sku: 128,
  rbSku: 128,
  asin: 32,
  fnsku: 32,
  fbmSku: 128,
  shop: 128,
  remark: 255,
};

const IMPORT_FIELD_LABELS: Record<keyof ImportSkuRow, string> = {
  productId: '产品ID',
  sku: 'SKU',
  rbSku: 'rbSKU',
  asin: 'ASIN',
  fnsku: 'FNSKU',
  fbmSku: 'FBMSKU',
  shop: '店铺',
  remark: '备注',
};

const BULK_SKU_IMPORT_TRANSACTION_TIMEOUT_MS = 120000;
const BULK_SKU_IMPORT_TRANSACTION_MAX_WAIT_MS = 10000;
const SKU_EXPORT_FILE_NAME = '系统所有产品SKU.xlsx';
const UNMATCHED_SKU_EXPORT_FILE_NAME = '未匹配产品ID的SKU.xlsx';
const SKU_BULK_DELETE_TEMPLATE_FILE_NAME = '批量删除SKU模板.xlsx';
const AMAZON_RB_LINK_STOCK_TEMPLATE_FILE = 'amazon-rb-stock-template.xlsm';
const AMAZON_RB_LINK_STOCK_TEMPLATE_SHEET_PATH = 'xl/worksheets/sheet5.xml';
const AMAZON_RB_LINK_STOCK_DATA_START_ROW = 7;
const AMAZON_RB_LINK_STOCK_FULFILLMENT_CHANNEL = '出品者出荷（デフォルト）';

@Injectable()
export class SkusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private buildListWhere(q?: string): Prisma.SkuWhereInput {
    const where: Prisma.SkuWhereInput = { status: 1 };
    if (q) {
      where.OR = [
        { productId: { contains: q } },
        { sku: { contains: q } },
        { rbSku: { contains: q } },
        { asin: { contains: q } },
        { fnsku: { contains: q } },
        { fbmSku: { contains: q } },
        { shop: { contains: q } },
        { remark: { contains: q } },
        {
          masterProduct: {
            productName: { contains: q },
          },
        },
      ];
    }
    return where;
  }

  async list(q?: string): Promise<unknown[]> {
    const where = this.buildListWhere(q);
    const rows = await this.prisma.sku.findMany({
      where,
      include: {
        masterProduct: {
          select: {
            productName: true,
          },
        },
      },
      orderBy: [{ id: 'desc' }],
    });
    return rows.map((row) => ({
      ...row,
      productName: row.masterProduct?.productName ?? null,
    }));
  }

  async listPage(
    q?: string,
    page = 1,
    pageSize = 30,
  ): Promise<{ items: unknown[]; page: number; pageSize: number; hasMore: boolean }> {
    const normalizedPage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const normalizedPageSize =
      Number.isFinite(pageSize) && pageSize > 0 ? Math.min(Math.floor(pageSize), 100) : 30;
    const where = this.buildListWhere(q);
    const rows = await this.prisma.sku.findMany({
      where,
      include: {
        masterProduct: {
          select: {
            productName: true,
          },
        },
      },
      orderBy: [{ id: 'desc' }],
      skip: (normalizedPage - 1) * normalizedPageSize,
      take: normalizedPageSize + 1,
    });
    const hasMore = rows.length > normalizedPageSize;
    const items = rows.slice(0, normalizedPageSize).map((row) => ({
      ...row,
      productName: row.masterProduct?.productName ?? null,
    }));
    return {
      items,
      page: normalizedPage,
      pageSize: normalizedPageSize,
      hasMore,
    };
  }

  async getUploadTemplate(): Promise<{ fileName: string; content: Buffer }> {
    const cwd = process.cwd();
    const candidates = [
      join(cwd, 'docs', SKU_UPLOAD_TEMPLATE_FILE),
      join(cwd, '..', '..', 'docs', SKU_UPLOAD_TEMPLATE_FILE),
    ];

    for (const templatePath of candidates) {
      try {
        const content = await readFile(templatePath);
        return {
          fileName: SKU_UPLOAD_TEMPLATE_FILE,
          content,
        };
      } catch {
        // try next candidate
      }
    }

    throw new NotFoundException(`找不到模板文件：${SKU_UPLOAD_TEMPLATE_FILE}`);
  }

  async exportExcel(): Promise<SkuExportFile> {
    const rows = await this.prisma.sku.findMany({
      where: {
        status: 1,
      },
      include: {
        masterProduct: {
          select: {
            productName: true,
            stockQty: true,
          },
        },
      },
      orderBy: [{ productId: 'asc' }, { sku: 'asc' }, { id: 'asc' }],
    });

    return {
      fileName: SKU_EXPORT_FILE_NAME,
      content: this.buildSkuExportWorkbook(rows),
    };
  }

  async exportUnmatchedExcel(): Promise<SkuExportFile> {
    const rows = await this.prisma.sku.findMany({
      include: {
        masterProduct: {
          select: {
            productName: true,
            stockQty: true,
          },
        },
      },
      where: {
        status: 1,
        OR: [{ productId: null }, { productId: '' }, { masterProduct: null }],
      },
      orderBy: [{ productId: 'asc' }, { sku: 'asc' }, { id: 'asc' }],
    });

    return {
      fileName: UNMATCHED_SKU_EXPORT_FILE_NAME,
      content: this.buildSkuExportWorkbook(rows),
    };
  }

  async exportAmazonRbLinkStockExcel(): Promise<SkuExportFile> {
    const rows = await this.prisma.sku.findMany({
      where: {
        status: 1,
        rbSku: {
          not: null,
        },
        productId: {
          not: null,
        },
        masterProduct: {
          is: {
            status: 1,
          },
        },
      },
      include: {
        masterProduct: {
          select: {
            stockQty: true,
          },
        },
      },
      orderBy: [{ rbSku: 'asc' }, { productId: 'asc' }, { id: 'asc' }],
    });

    const bodyRows = rows
      .map((row) => ({
        rbSku: this.normalizeAmazonSellerSku(row.rbSku),
        stockQty: Number(row.masterProduct?.stockQty ?? 0),
      }))
      .filter((row) => row.rbSku.length > 0);
    const template = await this.readAmazonRbLinkStockTemplate();

    return {
      fileName: `亚马逊更新价格和数量模板-${this.formatDateTimeForFileName(new Date())}.xlsm`,
      content: await this.populateAmazonRbLinkStockTemplate(template, bodyRows),
    };
  }

  private async readAmazonRbLinkStockTemplate(): Promise<Buffer> {
    const cwd = process.cwd();
    const candidates = [
      join(cwd, 'docs', AMAZON_RB_LINK_STOCK_TEMPLATE_FILE),
      join(cwd, '..', '..', 'docs', AMAZON_RB_LINK_STOCK_TEMPLATE_FILE),
    ];

    for (const templatePath of candidates) {
      try {
        return await readFile(templatePath);
      } catch {
        // try next candidate
      }
    }

    throw new NotFoundException(`找不到模板文件：${AMAZON_RB_LINK_STOCK_TEMPLATE_FILE}`);
  }

  private async populateAmazonRbLinkStockTemplate(
    template: Buffer,
    rows: Array<{ rbSku: string; stockQty: number }>,
  ): Promise<Buffer> {
    const archive = await JSZip.loadAsync(template);
    const worksheet = archive.file(AMAZON_RB_LINK_STOCK_TEMPLATE_SHEET_PATH);
    if (!worksheet) {
      throw new UnprocessableEntityException('亚马逊库存模板缺少テンプレート工作表');
    }

    const worksheetXml = await worksheet.async('string');
    const sheetDataMatch = worksheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
    const fixedRowsMatch = sheetDataMatch?.[1].match(
      /^([\s\S]*?<row\b[^>]*\br="6"[^>]*>[\s\S]*?<\/row>)/,
    );
    if (!sheetDataMatch || !fixedRowsMatch) {
      throw new UnprocessableEntityException('亚马逊库存模板结构不正确');
    }

    const dataRowsXml = rows
      .map((row, index) => {
        const rowNumber = AMAZON_RB_LINK_STOCK_DATA_START_ROW + index;
        const sku = this.escapeXmlText(row.rbSku);
        const fulfillmentChannel = this.escapeXmlText(AMAZON_RB_LINK_STOCK_FULFILLMENT_CHANNEL);
        const stockQty = Number.isFinite(row.stockQty) ? Math.trunc(row.stockQty) : 0;
        return (
          `<row r="${rowNumber}" spans="1:3" ht="12.75">` +
          `<c r="A${rowNumber}" s="26" t="inlineStr"><is><t>${sku}</t></is></c>` +
          `<c r="B${rowNumber}" s="26" t="inlineStr"><is><t>${fulfillmentChannel}</t></is></c>` +
          `<c r="C${rowNumber}" s="32"><v>${stockQty}</v></c>` +
          '</row>'
        );
      })
      .join('');
    const lastRow = Math.max(6, AMAZON_RB_LINK_STOCK_DATA_START_ROW + rows.length - 1);
    const populatedWorksheetXml = worksheetXml
      .replace(/<dimension ref="[^"]+"\s*\/>/, `<dimension ref="A1:AF${lastRow}"/>`)
      .replace(
        /<sheetData>[\s\S]*?<\/sheetData>/,
        `<sheetData>${fixedRowsMatch[1]}${dataRowsXml}</sheetData>`,
      );
    archive.file(AMAZON_RB_LINK_STOCK_TEMPLATE_SHEET_PATH, populatedWorksheetXml);

    return archive.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }

  private escapeXmlText(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private normalizeAmazonSellerSku(value: unknown): string {
    // A tab or line break inside a TSV cell creates extra Amazon records/columns.
    // Join wrapped SKU fragments so values such as "rb-item\n-23" remain one SKU.
    return String(value ?? '').replace(/[\t\r\n]+/g, '').trim();
  }

  async getBulkDeleteTemplate(): Promise<SkuExportFile> {
    const worksheet = XLSX.utils.aoa_to_sheet([['SKU']]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '批量删除SKU');
    return {
      fileName: SKU_BULK_DELETE_TEMPLATE_FILE_NAME,
      content: XLSX.write(workbook, {
        type: 'buffer',
        bookType: 'xlsx',
      }) as Buffer,
    };
  }

  async importBulkDeleteExcel(
    fileBuffer: Buffer,
    originalName: string | undefined,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ totalRows: number; deletedCount: number; fileName: string | null }> {
    await this.assertSystemAdminCanDeleteSkus(operatorId);
    const skuCodes = this.parseBulkDeleteSkuCodes(fileBuffer);
    const skus = await this.prisma.sku.findMany({
      where: {
        sku: {
          in: skuCodes,
        },
      },
      orderBy: [{ sku: 'asc' }, { id: 'asc' }],
    });
    const skuByCode = new Map(skus.map((sku) => [sku.sku, sku]));
    const missingCodes = skuCodes.filter((sku) => !skuByCode.has(sku));
    if (missingCodes.length > 0) {
      throw new BadRequestException(`以下SKU不存在，不能删除：${missingCodes.join('、')}`);
    }

    const activeSkus = skus.filter((sku) => Number(sku.status ?? 0) === 1);

    await this.prisma.$transaction(async (tx) => {
      if (activeSkus.length > 0) {
        await tx.sku.updateMany({
          where: {
            id: {
              in: activeSkus.map((sku) => sku.id),
            },
          },
          data: {
            status: 0,
          },
        });
        await this.auditService.createMany(
          activeSkus.map((sku) => ({
            db: tx,
            entityType: 'sku',
            entityId: sku.id,
            action: AuditAction.delete,
            eventType: AuditEventType.SKU_DISABLED,
            beforeData: sku as unknown as Record<string, unknown>,
            afterData: { ...(sku as unknown as Record<string, unknown>), status: 0 },
            operatorId,
            requestId,
          })),
        );
      }
    });

    return {
      totalRows: skuCodes.length,
      deletedCount: activeSkus.length,
      fileName: originalName ?? null,
    };
  }

  async importExcel(
    fileBuffer: Buffer,
    originalName: string | undefined,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{
    totalRows: number;
    createdCount: number;
    restoredCount: number;
    editRequestCount: number;
    fileName: string | null;
  }> {
    const rows = this.parseImportRows(fileBuffer);
    let summary: {
      totalRows: number;
      createdCount: number;
      restoredCount: number;
      editRequestCount: number;
    };

    try {
      const productIds = Array.from(
        new Set(rows.map((row) => this.normalizeNullableString(row.productId)).filter(Boolean)),
      ) as string[];
      const skuCodes = rows.map((row) => row.sku);

      summary = await this.prisma.$transaction(
        async (tx) => {
          const [existingSkus, masterProducts] = await Promise.all([
            tx.sku.findMany({
              where: {
                sku: {
                  in: skuCodes,
                },
              },
              select: {
                id: true,
                productId: true,
                sku: true,
                rbSku: true,
                asin: true,
                fnsku: true,
                fbmSku: true,
                shop: true,
                remark: true,
                status: true,
              },
            }),
            productIds.length
              ? tx.masterProduct.findMany({
                  where: {
                    productId: {
                      in: productIds,
                    },
                  },
                  select: {
                    productId: true,
                  },
                })
              : Promise.resolve([]),
          ]);

          const masterProductIdSet = new Set(masterProducts.map((item) => item.productId));
          const missingProductIds = productIds.filter((productId) => !masterProductIdSet.has(productId));
          if (missingProductIds.length > 0) {
            const preview = missingProductIds.slice(0, 20).join(', ');
            const suffix = missingProductIds.length > 20 ? ' 等' : '';
            throw new BadRequestException(`主商品ID不存在：${preview}${suffix}`);
          }

          const existingSkuByCodeAndShop = new Map(
            existingSkus.map((item) => [this.buildSkuShopKey(item.sku, item.shop), item]),
          );
          const rowsToCreate = rows.filter(
            (row) => !existingSkuByCodeAndShop.has(this.buildSkuShopKey(row.sku, row.shop)),
          );
          const rowsToRestore = rows.filter((row) => {
            const existing = existingSkuByCodeAndShop.get(this.buildSkuShopKey(row.sku, row.shop));
            return Boolean(existing && Number(existing.status ?? 0) !== 1);
          });
          const editRequestData: Prisma.ProductEditRequestCreateManyInput[] = [];

          for (const row of rows) {
            const existing = existingSkuByCodeAndShop.get(this.buildSkuShopKey(row.sku, row.shop));
            if (!existing) {
              continue;
            }
            if (Number(existing.status ?? 0) !== 1) {
              continue;
            }

            const beforeData = this.buildSnapshotFromSku(existing);
            const afterData = this.buildAfterSnapshot(beforeData, row);
            const changedFields = SNAPSHOT_FIELDS.filter(
              (field) => beforeData[field] !== afterData[field],
            );
            if (!changedFields.length) {
              continue;
            }

            editRequestData.push({
              skuId: existing.id,
              status: ProductEditRequestStatus.pending,
              beforeData: beforeData as unknown as Prisma.InputJsonValue,
              afterData: afterData as unknown as Prisma.InputJsonValue,
              changedFields: changedFields as unknown as Prisma.InputJsonValue,
              createdBy: operatorId,
            });
          }

          if (rowsToCreate.length > 0) {
            await tx.sku.createMany({
              data: rowsToCreate.map((row) => ({
                productId: row.productId ?? null,
                sku: row.sku,
                rbSku: row.rbSku ?? null,
                asin: row.asin ?? null,
                fnsku: row.fnsku ?? null,
                fbmSku: row.fbmSku ?? null,
                shop: this.normalizeShopValue(row.shop),
                remark: row.remark ?? null,
                status: 1,
              })),
            });

            const createdSkus = await tx.sku.findMany({
              where: {
                OR: rowsToCreate.map((row) => ({
                  sku: row.sku,
                  shop: this.normalizeShopValue(row.shop),
                })),
              },
              select: {
                id: true,
                productId: true,
                sku: true,
                rbSku: true,
                asin: true,
                fnsku: true,
                fbmSku: true,
                shop: true,
                remark: true,
                status: true,
              },
            });

            await this.auditService.createMany(
              createdSkus.map((created) => ({
                db: tx,
                entityType: 'sku',
                entityId: created.id,
                action: AuditAction.create,
                eventType: AuditEventType.SKU_CREATED,
                beforeData: null,
                afterData: created as unknown as Record<string, unknown>,
                operatorId,
                requestId,
              })),
            );
          }

          if (rowsToRestore.length > 0) {
            for (const row of rowsToRestore) {
              const existing = existingSkuByCodeAndShop.get(this.buildSkuShopKey(row.sku, row.shop));
              if (!existing) {
                continue;
              }
              const restored = await tx.sku.update({
                where: { id: existing.id },
                data: {
                  productId: row.productId ?? null,
                  rbSku: row.rbSku ?? null,
                  asin: row.asin ?? null,
                  fnsku: row.fnsku ?? null,
                  fbmSku: row.fbmSku ?? null,
                  shop: this.normalizeShopValue(row.shop),
                  remark: row.remark ?? null,
                  status: 1,
                },
              });
              await this.auditService.create({
                db: tx,
                entityType: 'sku',
                entityId: restored.id,
                action: AuditAction.update,
                eventType: AuditEventType.SKU_FIELD_UPDATED,
                beforeData: existing as unknown as Record<string, unknown>,
                afterData: restored as unknown as Record<string, unknown>,
                operatorId,
                requestId,
              });
            }
          }

          if (editRequestData.length > 0) {
            await tx.productEditRequest.createMany({
              data: editRequestData,
            });
          }

          return {
            totalRows: rows.length,
            createdCount: rowsToCreate.length,
            restoredCount: rowsToRestore.length,
            editRequestCount: editRequestData.length,
          };
        },
        {
          maxWait: BULK_SKU_IMPORT_TRANSACTION_MAX_WAIT_MS,
          timeout: BULK_SKU_IMPORT_TRANSACTION_TIMEOUT_MS,
        },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw this.buildImportDatabaseError(error);
      }
      if (
        error instanceof Prisma.PrismaClientUnknownRequestError ||
        error instanceof Prisma.PrismaClientValidationError
      ) {
        throw new BadRequestException(
          `SKU 导入失败（${this.extractImportRuntimeErrorMessage(error)}）`,
        );
      }
      throw error;
    }

    return {
      ...summary,
      fileName: originalName ?? null,
    };
  }

  async create(
    payload: CreateSkuDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const normalizedPayload = {
      ...payload,
      shop: this.normalizeShopValue(payload.shop),
    };
    const exists = await this.prisma.sku.findFirst({
      where: {
        sku: normalizedPayload.sku,
        shop: normalizedPayload.shop,
      },
    });
    if (exists) {
      if (Number(exists.status ?? 0) !== 1) {
        await this.ensureMasterProductExists(this.prisma, normalizedPayload.productId ?? null);
        return this.prisma.$transaction(async (tx) => {
          const restored = await tx.sku.update({
            where: { id: exists.id },
            data: {
              ...normalizedPayload,
              status: 1,
            },
          });
          await this.auditService.create({
            db: tx,
            entityType: 'sku',
            entityId: restored.id,
            action: AuditAction.update,
            eventType: AuditEventType.SKU_FIELD_UPDATED,
            beforeData: exists as unknown as Record<string, unknown>,
            afterData: restored as unknown as Record<string, unknown>,
            operatorId,
            requestId,
          });
          return restored;
        });
      }
      throw new BadRequestException('SKU与所属店铺组合已存在');
    }
    await this.ensureMasterProductExists(this.prisma, normalizedPayload.productId ?? null);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.sku.create({
        data: normalizedPayload,
      });
      await this.auditService.create({
        db: tx,
        entityType: 'sku',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.SKU_CREATED,
        beforeData: null,
        afterData: created as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return created;
    });
  }

  async update(
    idParam: string,
    payload: UpdateSkuDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    void idParam;
    void payload;
    void operatorId;
    void requestId;
    throw new BadRequestException(
      'Direct SKU update is disabled. Submit a product edit request instead.',
    );
  }

  async remove(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'skuId');
    await this.assertSystemAdminCanDeleteSkus(operatorId);
    const sku = await this.prisma.sku.findUnique({ where: { id } });
    if (!sku) {
      throw new NotFoundException('SKU not found');
    }
    if (Number(sku.status ?? 0) !== 1) {
      return { success: true };
    }
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.sku.update({
        where: { id },
        data: { status: 0 },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'sku',
        entityId: id,
        action: AuditAction.delete,
        eventType: AuditEventType.SKU_DISABLED,
        beforeData: sku as unknown as Record<string, unknown>,
        afterData: updated as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
    });
    return { success: true };
  }

  private async assertSystemAdminCanDeleteSkus(operatorId: bigint): Promise<void> {
    const operator = await this.prisma.user.findUnique({
      where: { id: operatorId },
      select: {
        role: true,
        status: true,
      },
    });
    const isSystemAdmin =
      String(operator?.role ?? '') === 'system_admin' && Number(operator?.status ?? 0) === 1;
    if (!isSystemAdmin) {
      throw new ForbiddenException('Only system administrators can delete SKUs');
    }
  }

  private parseImportRows(fileBuffer: Buffer): ImportSkuRow[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    } catch {
      throw new BadRequestException('Invalid Excel file');
    }

    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new BadRequestException('No worksheet found in Excel');
    }
    const sheet = workbook.Sheets[firstSheet];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (rows.length === 0) {
      throw new BadRequestException('No data found in Excel');
    }

    const errors: string[] = [];
    const result: ImportSkuRow[] = [];
    const seenSkuRows = new Map<string, number>();

    rows.forEach((rawRow, idx) => {
      const rowNo = idx + 2;
      const normalized: Record<string, string> = {};
      Object.entries(rawRow).forEach(([key, value]) => {
        normalized[this.normalizeHeader(key)] = String(value ?? '').trim();
      });

      const sku = this.pickField(normalized, [
        'sku',
        'skufba',
        'sku(fba编码)',
        'sku（fba编码）',
        'fba编码',
      ]);
      if (!sku) {
        errors.push(`Row ${rowNo} is missing SKU`);
        return;
      }
      const shop = this.pickField(normalized, ['shop', '店铺']);
      const skuShopKey = this.buildSkuShopKey(sku, shop);
      if (seenSkuRows.has(skuShopKey)) {
        errors.push(
          `Row ${rowNo} duplicated SKU + 店铺: ${sku} (first seen at row ${seenSkuRows.get(skuShopKey)})`,
        );
        return;
      }
      seenSkuRows.set(skuShopKey, rowNo);

      const importRow: ImportSkuRow = {
        productId: this.pickField(normalized, ['productId', 'productid', '产品ID', '产品Id']),
        sku,
        rbSku: this.pickField(normalized, [
          'rbSku',
          'rbsku',
          'rb sku',
          'rb_sku',
          'rbcode',
          'rb编码',
          'rb編碼',
          'rb',
        ]),
        asin: this.pickField(normalized, ['asin']),
        fnsku: this.pickField(normalized, ['fnsku']),
        fbmSku: this.pickField(normalized, [
          'fbmsku',
          'fbm sku',
          'fbm_sku',
          'fbmcode',
          'fbm编码',
          'fbm編碼',
          'fbm',
        ]),
        shop,
        remark: this.pickField(normalized, ['remark', '备注']),
      };
      this.validateImportRow(importRow, rowNo, errors);
      result.push(importRow);
    });

    if (errors.length > 0) {
      throw new UnprocessableEntityException(errors.join(' | '));
    }

    return result;
  }

  private parseBulkDeleteSkuCodes(fileBuffer: Buffer): string[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    } catch {
      throw new BadRequestException('Invalid Excel file');
    }

    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new BadRequestException('No worksheet found in Excel');
    }
    const sheet = workbook.Sheets[firstSheet];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (rows.length === 0) {
      throw new BadRequestException('No data found in Excel');
    }

    const errors: string[] = [];
    const result: string[] = [];
    const seenSkuRows = new Map<string, number>();

    rows.forEach((rawRow, idx) => {
      const rowNo = idx + 2;
      const normalized: Record<string, string> = {};
      Object.entries(rawRow).forEach(([key, value]) => {
        normalized[this.normalizeHeader(key)] = String(value ?? '').trim();
      });
      const sku = this.pickField(normalized, ['sku', 'SKU']);
      if (!sku) {
        errors.push(`Row ${rowNo} is missing SKU`);
        return;
      }
      if (sku.length > IMPORT_FIELD_LIMITS.sku) {
        errors.push(`Row ${rowNo} SKU length exceeds ${IMPORT_FIELD_LIMITS.sku} characters`);
        return;
      }
      if (seenSkuRows.has(sku)) {
        errors.push(`Row ${rowNo} duplicated SKU: ${sku} (first seen at row ${seenSkuRows.get(sku)})`);
        return;
      }
      seenSkuRows.set(sku, rowNo);
      result.push(sku);
    });

    if (errors.length > 0) {
      throw new UnprocessableEntityException(errors.join(' | '));
    }
    if (!result.length) {
      throw new BadRequestException('No SKU found in Excel');
    }
    return result;
  }

  private buildSkuExportWorkbook(
    rows: Array<{
      sku: string | null;
      asin: string | null;
      fnsku: string | null;
      fbmSku: string | null;
      rbSku: string | null;
      shop: string | null;
      remark: string | null;
      productId: string | null;
      masterProduct?: {
        productName: string | null;
        stockQty: number | bigint | null;
      } | null;
    }>,
  ): Buffer {
    const sheetRows = [
      [
        'SKU',
        'ASIN',
        'FNSKU',
        'FBMSKU',
        'RBSKU',
        '所属店铺',
        '备注',
        '产品ID',
        '产品名称',
        '产品库存',
      ],
      ...rows.map((row) => [
        row.sku ?? '',
        row.asin ?? '',
        row.fnsku ?? '',
        row.fbmSku ?? '',
        row.rbSku ?? '',
        row.shop ?? '',
        row.remark ?? '',
        row.productId ?? '',
        row.masterProduct?.productName ?? '',
        Number(row.masterProduct?.stockQty ?? 0),
      ]),
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(sheetRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'SKU列表');
    return XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
  }

  private formatDateTimeForFileName(date: Date): string {
    const parts = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') {
          acc[part.type] = part.value;
        }
        return acc;
      }, {});
    return `${parts.year ?? '0000'}${parts.month ?? '00'}${parts.day ?? '00'}-${parts.hour ?? '00'}${
      parts.minute ?? '00'
    }${parts.second ?? '00'}`;
  }

  private normalizeHeader(header: string): string {
    return String(header || '')
      .replace(/[\s_\-()\[\]{}（）]/g, '')
      .toLowerCase();
  }

  private pickField(row: Record<string, string>, aliases: string[]): string | null {
    for (const alias of aliases) {
      const normalizedAlias = this.normalizeHeader(alias);
      const value = String(row[normalizedAlias] ?? '').trim();
      if (value) {
        return value;
      }
    }
    return null;
  }

  private validateImportRow(row: ImportSkuRow, rowNo: number, errors: string[]): void {
    (Object.entries(IMPORT_FIELD_LIMITS) as Array<[keyof ImportSkuRow, number]>).forEach(
      ([field, maxLength]) => {
        const value = this.normalizeNullableString(row[field]);
        if (value && value.length > maxLength) {
          errors.push(
            `Row ${rowNo} ${IMPORT_FIELD_LABELS[field]} length exceeds ${maxLength} characters`,
          );
        }
      },
    );
  }

  private buildImportDatabaseError(
    error: Prisma.PrismaClientKnownRequestError,
  ): BadRequestException {
    if (error.code === 'P2028') {
      return new BadRequestException(
        'SKU 导入执行超时。当前导入行数较多，已改为批量写入；如果仍失败，请把新提示贴给我继续定位',
      );
    }
    if (error.code === 'P2000') {
      return new BadRequestException(
        'Excel 中存在超长字段，请检查产品ID、SKU、rbSKU、ASIN、FNSKU、FBMSKU、店铺、备注长度',
      );
    }
    if (error.code === 'P2002') {
      const targetText = this.getPrismaErrorTargetText(error);
      if (
        targetText.includes('product_id') ||
        targetText.includes('skus_product_id_key')
      ) {
        return new BadRequestException(
          '当前数据库仍将 skus.product_id 设为唯一值，但现在业务已支持一个主商品关联多个 SKU。请先删除唯一索引 skus_product_id_key 后再重试导入',
        );
      }
      return new BadRequestException('Excel 中存在重复的 SKU + 店铺组合，或数据库里已有相同组合');
    }
    if (error.code === 'P2003') {
      return new BadRequestException('存在无效关联数据，请检查产品ID是否已存在于主商品表');
    }
    return new BadRequestException(`SKU 导入失败（${this.extractImportRuntimeErrorMessage(error)}）`);
  }

  private getPrismaErrorTargetText(error: Prisma.PrismaClientKnownRequestError): string {
    const target = error.meta?.target;
    if (Array.isArray(target)) {
      return target.map((item) => String(item)).join(',').toLowerCase();
    }
    return String(target ?? error.message ?? '').toLowerCase();
  }

  private extractImportRuntimeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      const summary = error.message.replace(/\s+/g, ' ').trim();
      return summary.length > 300 ? `${summary.slice(0, 300)}...` : summary;
    }
    return String(error);
  }

  private buildSnapshotFromSku(sku: {
    productId: string | null;
    sku: string;
    rbSku: string | null;
    asin: string | null;
    fnsku: string | null;
    fbmSku: string | null;
    shop: string | null;
    remark: string | null;
  }): ProductSnapshot {
    return {
      productId: this.normalizeNullableString(sku.productId),
      sku: this.normalizeNullableString(sku.sku),
      rbSku: this.normalizeNullableString(sku.rbSku),
      asin: this.normalizeNullableString(sku.asin),
      fnsku: this.normalizeNullableString(sku.fnsku),
      fbmSku: this.normalizeNullableString(sku.fbmSku),
      shop: this.normalizeNullableString(sku.shop),
      remark: this.normalizeNullableString(sku.remark),
    };
  }

  private buildAfterSnapshot(beforeData: ProductSnapshot, row: ImportSkuRow): ProductSnapshot {
    return {
      productId: this.normalizeNullableString(row.productId) ?? beforeData.productId,
      sku: this.normalizeNullableString(row.sku) ?? beforeData.sku,
      rbSku: this.normalizeNullableString(row.rbSku) ?? beforeData.rbSku,
      asin: this.normalizeNullableString(row.asin) ?? beforeData.asin,
      fnsku: this.normalizeNullableString(row.fnsku) ?? beforeData.fnsku,
      fbmSku: this.normalizeNullableString(row.fbmSku) ?? beforeData.fbmSku,
      shop: this.normalizeNullableString(row.shop) ?? beforeData.shop,
      remark: this.normalizeNullableString(row.remark) ?? beforeData.remark,
    };
  }

  private normalizeNullableString(value: unknown): string | null {
    return normalizeNullableText(value);
  }

  private normalizeShopValue(value: unknown): string {
    return normalizeNullableText(value) ?? '';
  }

  private buildSkuShopKey(sku: unknown, shop: unknown): string {
    return `${String(sku ?? '').trim()}\u0000${this.normalizeShopValue(shop)}`;
  }

  private async ensureMasterProductExists(
    db: Prisma.TransactionClient | PrismaService,
    productIdRaw: string | null,
  ): Promise<void> {
    const productId = this.normalizeNullableString(productIdRaw);
    if (!productId) {
      return;
    }
    const masterProduct = await db.masterProduct.findUnique({
      where: { productId },
      select: { id: true },
    });
    if (!masterProduct) {
      throw new BadRequestException('主商品ID不存在');
    }
  }

}
