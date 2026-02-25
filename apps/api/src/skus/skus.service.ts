import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, Prisma, ProductEditRequestStatus } from '@prisma/client';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSkuDto } from './dto/create-sku.dto';
import { UpdateSkuDto } from './dto/update-sku.dto';

type ImportSkuRow = {
  sku: string;
  erpSku: string | null;
  asin: string | null;
  fnsku: string | null;
  fbmSku: string | null;
  model: string | null;
  brand: string | null;
  type: string | null;
  color: string | null;
  shop: string | null;
  remark: string | null;
};

type ProductSnapshot = {
  sku: string | null;
  erpSku: string | null;
  asin: string | null;
  fnsku: string | null;
  fbmSku: string | null;
  model: string | null;
  brand: string | null;
  type: string | null;
  color: string | null;
  shop: string | null;
  remark: string | null;
};

const SNAPSHOT_FIELDS: Array<keyof ProductSnapshot> = [
  'sku',
  'erpSku',
  'asin',
  'fnsku',
  'fbmSku',
  'model',
  'brand',
  'type',
  'color',
  'shop',
  'remark',
];
const ERP_SKU_FIELD: keyof ProductSnapshot = 'erpSku';

@Injectable()
export class SkusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(q?: string): Promise<unknown[]> {
    const where: Prisma.SkuWhereInput = {};
    if (q) {
      where.OR = [
        { sku: { contains: q } },
        { erpSku: { contains: q } },
        { asin: { contains: q } },
        { fnsku: { contains: q } },
        { fbmSku: { contains: q } },
      ];
    }
    return this.prisma.sku.findMany({
      where,
      orderBy: { id: 'desc' },
    });
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

    const summary = await this.prisma.$transaction(async (tx) => {
      let createdCount = 0;
      let editRequestCount = 0;

      for (const row of rows) {
        const existing = await tx.sku.findUnique({ where: { sku: row.sku } });
        if (!existing) {
          await this.createSkuInTransaction(tx, row, operatorId, requestId);
          createdCount += 1;
          continue;
        }

        const beforeData = this.buildSnapshotFromSku(existing);
        const afterData = this.buildAfterSnapshot(beforeData, row);
        const changedFields = SNAPSHOT_FIELDS.filter(
          (field) => beforeData[field] !== afterData[field],
        );
        editRequestCount += await this.createPendingEditRequests(tx, {
          skuId: existing.id,
          beforeData,
          afterData,
          changedFields,
          createdBy: operatorId,
        });
      }

      return {
        totalRows: rows.length,
        createdCount,
        editRequestCount,
      };
    });

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
      throw new BadRequestException('SKU已存在');
    }
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
    throw new BadRequestException('请通过产品管理页面提交编辑申请，不能直接修改产品数据');
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'skuId');
    const sku = await this.prisma.sku.findUnique({ where: { id } });
    if (!sku) throw new NotFoundException('SKU不存在');
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

  private parseImportRows(fileBuffer: Buffer): ImportSkuRow[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    } catch {
      throw new BadRequestException('无法读取Excel文件');
    }

    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new BadRequestException('Excel中没有工作表');
    }
    const sheet = workbook.Sheets[firstSheet];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (rows.length === 0) {
      throw new BadRequestException('Excel中没有数据');
    }

    const errors: string[] = [];
    const result: ImportSkuRow[] = [];

    rows.forEach((rawRow, idx) => {
      const rowNo = idx + 2;
      const normalized: Record<string, string> = {};
      Object.entries(rawRow).forEach(([key, value]) => {
        normalized[this.normalizeHeader(key)] = String(value ?? '').trim();
      });

      const sku = this.pickField(normalized, [
        'sku',
        'sku(fba编码)',
        'skufba编码',
        '产品sku',
        '商品sku',
      ]);
      if (!sku) {
        errors.push(`第${rowNo}行：SKU为必填字段`);
        return;
      }

      result.push({
        sku,
        erpSku: this.pickField(normalized, ['erpsku', 'erp sku', 'erp_sku', 'rb编码', 'rbcode', 'rb']),
        asin: this.pickField(normalized, ['asin']),
        fnsku: this.pickField(normalized, ['fnsku']),
        fbmSku: this.pickField(normalized, ['fbmsku', 'fbm sku', 'fbm_sku', 'fbm', 'fbm编码', 'fbmcode']),
        model: this.pickField(normalized, ['model', '型号']),
        brand: this.pickField(normalized, ['brand', '品牌', '说明1']),
        type: this.pickField(normalized, ['type', '类型', '说明2']),
        color: this.pickField(normalized, ['color', '颜色']),
        shop: this.pickField(normalized, ['shop', '店铺', '所属亚马逊店铺']),
        remark: this.pickField(normalized, ['remark', '备注']),
      });
    });

    if (errors.length > 0) {
      throw new UnprocessableEntityException(errors.join(' | '));
    }

    return result;
  }

  private normalizeHeader(header: string): string {
    return String(header || '')
      .replace(/[\s_\-()（）\[\]【】]/g, '')
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

  private buildSnapshotFromSku(sku: {
    sku: string;
    erpSku: string | null;
    asin: string | null;
    fnsku: string | null;
    fbmSku: string | null;
    model: string | null;
    brand: string | null;
    type: string | null;
    color: string | null;
    shop: string | null;
    remark: string | null;
  }): ProductSnapshot {
    return {
      sku: this.normalizeNullableString(sku.sku),
      erpSku: this.normalizeNullableString(sku.erpSku),
      asin: this.normalizeNullableString(sku.asin),
      fnsku: this.normalizeNullableString(sku.fnsku),
      fbmSku: this.normalizeNullableString(sku.fbmSku),
      model: this.normalizeNullableString(sku.model),
      brand: this.normalizeNullableString(sku.brand),
      type: this.normalizeNullableString(sku.type),
      color: this.normalizeNullableString(sku.color),
      shop: this.normalizeNullableString(sku.shop),
      remark: this.normalizeNullableString(sku.remark),
    };
  }

  private buildAfterSnapshot(beforeData: ProductSnapshot, row: ImportSkuRow): ProductSnapshot {
    return {
      sku: this.normalizeNullableString(row.sku) ?? beforeData.sku,
      erpSku: this.normalizeNullableString(row.erpSku) ?? beforeData.erpSku,
      asin: this.normalizeNullableString(row.asin) ?? beforeData.asin,
      fnsku: this.normalizeNullableString(row.fnsku) ?? beforeData.fnsku,
      fbmSku: this.normalizeNullableString(row.fbmSku) ?? beforeData.fbmSku,
      model: this.normalizeNullableString(row.model) ?? beforeData.model,
      brand: this.normalizeNullableString(row.brand) ?? beforeData.brand,
      type: this.normalizeNullableString(row.type) ?? beforeData.type,
      color: this.normalizeNullableString(row.color) ?? beforeData.color,
      shop: this.normalizeNullableString(row.shop) ?? beforeData.shop,
      remark: this.normalizeNullableString(row.remark) ?? beforeData.remark,
    };
  }

  private buildAfterSnapshotByFields(
    beforeData: ProductSnapshot,
    targetAfterData: ProductSnapshot,
    changedFields: Array<keyof ProductSnapshot>,
  ): ProductSnapshot {
    const snapshot: ProductSnapshot = { ...beforeData };
    changedFields.forEach((field) => {
      snapshot[field] = targetAfterData[field];
    });
    return snapshot;
  }

  private async createPendingEditRequests(
    tx: Prisma.TransactionClient,
    payload: {
      skuId: bigint;
      beforeData: ProductSnapshot;
      afterData: ProductSnapshot;
      changedFields: Array<keyof ProductSnapshot>;
      createdBy: bigint;
    },
  ): Promise<number> {
    const changedFields = Array.from(new Set(payload.changedFields));
    const hasErpSkuChanged = changedFields.includes(ERP_SKU_FIELD);
    const nonErpChangedFields = changedFields.filter((field) => field !== ERP_SKU_FIELD);

    if (hasErpSkuChanged && nonErpChangedFields.length > 0) {
      await tx.productEditRequest.create({
        data: {
          skuId: payload.skuId,
          status: ProductEditRequestStatus.pending,
          beforeData: payload.beforeData as unknown as object,
          afterData: this.buildAfterSnapshotByFields(
            payload.beforeData,
            payload.afterData,
            nonErpChangedFields,
          ) as unknown as object,
          changedFields: nonErpChangedFields,
          createdBy: payload.createdBy,
        },
      });
      await tx.productEditRequest.create({
        data: {
          skuId: payload.skuId,
          status: ProductEditRequestStatus.pending,
          beforeData: payload.beforeData as unknown as object,
          afterData: this.buildAfterSnapshotByFields(
            payload.beforeData,
            payload.afterData,
            [ERP_SKU_FIELD],
          ) as unknown as object,
          changedFields: [ERP_SKU_FIELD],
          createdBy: payload.createdBy,
        },
      });
      return 2;
    }

    await tx.productEditRequest.create({
      data: {
        skuId: payload.skuId,
        status: ProductEditRequestStatus.pending,
        beforeData: payload.beforeData as unknown as object,
        afterData: payload.afterData as unknown as object,
        changedFields,
        createdBy: payload.createdBy,
      },
    });
    return 1;
  }

  private normalizeNullableString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }

  private async createSkuInTransaction(
    tx: Prisma.TransactionClient,
    row: ImportSkuRow,
    operatorId: bigint,
    requestId?: string,
  ): Promise<void> {
    const created = await tx.sku.create({
      data: {
        sku: row.sku,
        erpSku: row.erpSku ?? undefined,
        asin: row.asin ?? undefined,
        fnsku: row.fnsku ?? undefined,
        fbmSku: row.fbmSku ?? undefined,
        model: row.model ?? undefined,
        brand: row.brand ?? undefined,
        type: row.type ?? undefined,
        color: row.color ?? undefined,
        shop: row.shop ?? undefined,
        remark: row.remark ?? undefined,
        status: 1,
      },
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
  }
}
