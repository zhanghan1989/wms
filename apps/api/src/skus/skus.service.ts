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

@Injectable()
export class SkusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private buildListWhere(q?: string): Prisma.SkuWhereInput {
    const where: Prisma.SkuWhereInput = {};
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

    return {
      fileName: SKU_EXPORT_FILE_NAME,
      content: XLSX.write(workbook, {
        type: 'buffer',
        bookType: 'xlsx',
      }) as Buffer,
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
    editRequestCount: number;
    fileName: string | null;
  }> {
    const rows = this.parseImportRows(fileBuffer);
    let summary: {
      totalRows: number;
      createdCount: number;
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

          const existingSkuByCode = new Map(existingSkus.map((item) => [item.sku, item]));
          const rowsToCreate = rows.filter((row) => !existingSkuByCode.has(row.sku));
          const editRequestData: Prisma.ProductEditRequestCreateManyInput[] = [];

          for (const row of rows) {
            const existing = existingSkuByCode.get(row.sku);
            if (!existing) {
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
                shop: row.shop ?? null,
                remark: row.remark ?? null,
                status: 1,
              })),
            });

            const createdSkus = await tx.sku.findMany({
              where: {
                sku: {
                  in: rowsToCreate.map((row) => row.sku),
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

          if (editRequestData.length > 0) {
            await tx.productEditRequest.createMany({
              data: editRequestData,
            });
          }

          return {
            totalRows: rows.length,
            createdCount: rowsToCreate.length,
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
    const exists = await this.prisma.sku.findUnique({ where: { sku: payload.sku } });
    if (exists) {
      throw new BadRequestException('SKU already exists');
    }
    await this.ensureMasterProductExists(this.prisma, payload.productId ?? null);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.sku.create({
        data: payload,
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
    const [sku, operator] = await Promise.all([
      this.prisma.sku.findUnique({ where: { id } }),
      this.prisma.user.findUnique({
        where: { id: operatorId },
        select: {
          role: true,
          status: true,
        },
      }),
    ]);
    const isSystemAdmin =
      String(operator?.role ?? '') === 'system_admin' && Number(operator?.status ?? 0) === 1;
    if (!isSystemAdmin) {
      throw new ForbiddenException('Only system administrators can delete SKUs');
    }
    if (!sku) {
      throw new NotFoundException('SKU not found');
    }
    const blockingRelations = await this.getSkuDeleteBlockingRelations(id);
    if (blockingRelations.length > 0) {
      const details = blockingRelations.map((item) => `${item.label}${item.count}条`).join('、');
      throw new BadRequestException(`无法删除 SKU：存在${details}关联记录，请先处理后再删除`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.sku.delete({ where: { id } });
      await this.auditService.create({
        db: tx,
        entityType: 'sku',
        entityId: id,
        action: AuditAction.delete,
        eventType: AuditEventType.SKU_DELETED,
        beforeData: sku as unknown as Record<string, unknown>,
        afterData: null,
        operatorId,
        requestId,
      });
    });
    return { success: true };
  }

  private async getSkuDeleteBlockingRelations(skuId: bigint): Promise<Array<{ label: string; count: number }>> {
    const [
      itemCodeCount,
      inventoryCount,
      outboundItemCount,
      stocktakeRecordCount,
      stockMovementCount,
      adjustItemCount,
      fbaReplenishmentCount,
      productEditRequestCount,
    ] = await Promise.all([
      this.prisma.itemCode.count({ where: { skuId } }),
      this.prisma.inventoryBoxSku.count({ where: { skuId } }),
      this.prisma.outboundOrderItem.count({ where: { skuId } }),
      this.prisma.stocktakeRecord.count({ where: { skuId } }),
      this.prisma.stockMovement.count({ where: { skuId } }),
      this.prisma.inventoryAdjustOrderItem.count({ where: { skuId } }),
      this.prisma.fbaReplenishment.count({ where: { skuId } }),
      this.prisma.productEditRequest.count({ where: { skuId } }),
    ]);

    return [
      { label: '条码', count: itemCodeCount },
      { label: '箱内库存', count: inventoryCount },
      { label: '出库明细', count: outboundItemCount },
      { label: '盘点记录', count: stocktakeRecordCount },
      { label: '库存流水', count: stockMovementCount },
      { label: '库存调整明细', count: adjustItemCount },
      { label: 'FBA补货', count: fbaReplenishmentCount },
      { label: '编辑申请', count: productEditRequestCount },
    ].filter((item) => item.count > 0);
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
      if (seenSkuRows.has(sku)) {
        errors.push(
          `Row ${rowNo} duplicated SKU: ${sku} (first seen at row ${seenSkuRows.get(sku)})`,
        );
        return;
      }
      seenSkuRows.set(sku, rowNo);

      const importRow: ImportSkuRow = {
        productId: this.pickField(normalized, ['productId', 'productid', '产品ID', '产品Id']),
        sku,
        rbSku: this.pickField(normalized, ['rbSku', 'rbsku', 'rb sku', 'rb_sku', 'rbcode', 'rb']),
        asin: this.pickField(normalized, ['asin']),
        fnsku: this.pickField(normalized, ['fnsku']),
        fbmSku: this.pickField(normalized, ['fbmsku', 'fbm sku', 'fbm_sku', 'fbm', 'fbmcode']),
        shop: this.pickField(normalized, ['shop', '店铺']),
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
      return new BadRequestException('Excel 中存在重复 SKU，或数据库里已有相同唯一值');
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
