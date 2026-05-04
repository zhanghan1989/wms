import { BadRequestException, Injectable } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { parseId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

type ReturnRecordPayload = Record<string, unknown>;

interface ParsedReturnRecordRow {
  senderName: string | null;
  carrierName: string | null;
  trackingNo: string | null;
  postalCode: string | null;
  address: string | null;
  phone: string | null;
  packageContent: string | null;
  salesSite: string | null;
  orderNo: string | null;
  productId: string | null;
  isOpenedUsed: boolean;
  canRestock: boolean;
  createdAt?: Date;
}

const RETURN_RECORD_COLUMN_ALIASES = {
  senderName: ['発送人', '发货人', '返回人', '寄件人', 'senderName'],
  carrierName: ['運送会社', '运输公司', '快递公司', 'carrierName'],
  trackingNo: ['追跡番号', '追踪号码', '运单号', '快递单号', 'trackingNo'],
  postalCode: ['郵便番号', '邮编', 'postalCode'],
  address: ['住所', '地址', 'address'],
  phone: ['電話番号', '电话', '手机号', 'phone'],
  packageContent: ['荷物', '包裹', '商品', 'packageContent'],
  salesSite: ['販売サイト', '销售平台', '销售网站', 'salesSite'],
  orderNo: ['注文番号', '订单号', 'orderNo'],
  productId: ['产品ID', '产品id', 'productId', '商品ID'],
  isOpenedUsed: ['是否已拆封使用', '已拆封使用', 'isOpenedUsed'],
  canRestock: ['是否可以再入库', '可以再入库', 'canRestock'],
  createdAt: ['作成时间', '作成時間', '创建时间', 'createdAt'],
} as const;

@Injectable()
export class ReturnRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<unknown[]> {
    const rows = await (this.prisma as any).returnRecord.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 1000,
    });
    return rows.map((row: any) => this.toListItem(row));
  }

  async create(payload: ReturnRecordPayload, userId: bigint): Promise<unknown> {
    const data = await this.buildCreateData(this.parsePayload(payload), userId, null);
    const row = await (this.prisma as any).returnRecord.create({ data });
    return this.toListItem(row);
  }

  async importExcel(
    fileBuffer: Buffer,
    originalName: string | undefined,
    userId: bigint,
  ): Promise<{ sourceFileName: string; totalRows: number; createdCount: number; rows: unknown[] }> {
    const rows = this.parseExcelRows(fileBuffer);
    if (!rows.length) {
      throw new BadRequestException('Excel中没有可导入的返品记录');
    }
    const sourceFileName = String(originalName || '返品表.xlsx').trim();
    const dataList = await Promise.all(rows.map((row) => this.buildCreateData(row, userId, sourceFileName)));
    const createdRows = await this.prisma.$transaction(
      dataList.map((data) => (this.prisma as any).returnRecord.create({ data })),
    );
    return {
      sourceFileName,
      totalRows: rows.length,
      createdCount: createdRows.length,
      rows: createdRows.map((row: any) => this.toListItem(row)),
    };
  }

  async deleteBatch(payload: { ids?: Array<string | number> }): Promise<{ deletedCount: number }> {
    const rawIds = Array.isArray(payload?.ids) ? payload.ids : [];
    const ids = Array.from(
      new Set(
        rawIds
          .map((id, index) => {
            const text = String(id ?? '').trim();
            return text ? parseId(text, `ids[${index}]`) : null;
          })
          .filter((id): id is bigint => id !== null),
      ),
    );
    if (!ids.length) {
      throw new BadRequestException('请至少选择一条返品记录');
    }

    const result = await (this.prisma as any).returnRecord.deleteMany({
      where: { id: { in: ids } },
    });
    return { deletedCount: Number(result.count ?? 0) };
  }

  private async buildCreateData(row: ParsedReturnRecordRow, userId: bigint, sourceFileName: string | null): Promise<Record<string, unknown>> {
    const productId = row.productId;
    const productName = productId ? await this.resolveProductName(productId) : null;
    return {
      senderName: row.senderName,
      carrierName: row.carrierName,
      trackingNo: row.trackingNo,
      postalCode: row.postalCode,
      address: row.address,
      phone: row.phone,
      packageContent: row.packageContent,
      salesSite: row.salesSite,
      orderNo: row.orderNo,
      productId,
      productName,
      isOpenedUsed: row.isOpenedUsed,
      canRestock: row.canRestock,
      sourceFileName,
      createdBy: userId,
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    };
  }

  private async resolveProductName(productId: string): Promise<string | null> {
    const product = await this.prisma.masterProduct.findUnique({
      where: { productId },
      select: { productName: true },
    });
    return product?.productName ?? null;
  }

  private parsePayload(payload: ReturnRecordPayload): ParsedReturnRecordRow {
    const productId = this.toNullableText(payload.productId, 128);
    return {
      senderName: this.toNullableText(payload.senderName, 255),
      carrierName: this.toNullableText(payload.carrierName, 128),
      trackingNo: this.toNullableText(payload.trackingNo, 128),
      postalCode: this.toNullableText(payload.postalCode, 32),
      address: this.toNullableText(payload.address, 5000),
      phone: this.toNullableText(payload.phone, 64),
      packageContent: this.toNullableText(payload.packageContent, 5000),
      salesSite: this.toNullableText(payload.salesSite, 128),
      orderNo: this.toNullableText(payload.orderNo, 128),
      productId,
      isOpenedUsed: this.toBoolean(payload.isOpenedUsed),
      canRestock: this.toBoolean(payload.canRestock),
    };
  }

  private parseExcelRows(fileBuffer: Buffer): ParsedReturnRecordRow[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    } catch {
      throw new BadRequestException('Excel文件格式无法识别');
    }
    const firstSheetName = workbook.SheetNames[0];
    const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
    if (!sheet) {
      throw new BadRequestException('Excel中没有工作表');
    }

    return XLSX.utils
      .sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
      .map((rawRow) => this.parseExcelRow(rawRow))
      .filter((row) =>
        [
          row.senderName,
          row.carrierName,
          row.trackingNo,
          row.postalCode,
          row.address,
          row.phone,
          row.packageContent,
          row.salesSite,
          row.orderNo,
          row.productId,
        ].some((value) => String(value ?? '').trim().length > 0),
      );
  }

  private parseExcelRow(rawRow: Record<string, unknown>): ParsedReturnRecordRow {
    const normalized = this.normalizeRowKeys(rawRow);
    const productId = this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.productId, 128);
    return {
      senderName: this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.senderName, 255),
      carrierName: this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.carrierName, 128),
      trackingNo: this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.trackingNo, 128),
      postalCode: this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.postalCode, 32),
      address: this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.address, 5000),
      phone: this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.phone, 64),
      packageContent: this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.packageContent, 5000),
      salesSite: this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.salesSite, 128),
      orderNo: this.pickText(normalized, RETURN_RECORD_COLUMN_ALIASES.orderNo, 128),
      productId,
      isOpenedUsed: this.toBoolean(this.pickRaw(normalized, RETURN_RECORD_COLUMN_ALIASES.isOpenedUsed)),
      canRestock: this.toBoolean(this.pickRaw(normalized, RETURN_RECORD_COLUMN_ALIASES.canRestock)),
      createdAt: this.toDateOrUndefined(this.pickRaw(normalized, RETURN_RECORD_COLUMN_ALIASES.createdAt)),
    };
  }

  private normalizeRowKeys(row: Record<string, unknown>): Map<string, unknown> {
    const map = new Map<string, unknown>();
    Object.entries(row).forEach(([key, value]) => {
      map.set(this.normalizeKey(key), value);
    });
    return map;
  }

  private pickRaw(map: Map<string, unknown>, aliases: readonly string[]): unknown {
    for (const alias of aliases) {
      const key = this.normalizeKey(alias);
      if (map.has(key)) return map.get(key);
    }
    return undefined;
  }

  private pickText(map: Map<string, unknown>, aliases: readonly string[], maxLength: number): string | null {
    return this.toNullableText(this.pickRaw(map, aliases), maxLength);
  }

  private normalizeKey(value: unknown): string {
    return String(value ?? '').trim().replace(/\s+/g, '').toLowerCase();
  }

  private toNullableText(value: unknown, maxLength: number): string | null {
    const text = String(value ?? '').trim();
    if (!text) return null;
    return text.slice(0, maxLength);
  }

  private toBoolean(value: unknown): boolean {
    const text = String(value ?? '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', '是', 'はい', '有', '可以', '可'].includes(text);
  }

  private toDateOrUndefined(value: unknown): Date | undefined {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'number') {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, parsed.S);
    }
    const text = String(value ?? '').trim();
    if (!text) return undefined;
    const date = new Date(text.replace(/\//g, '-'));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private toListItem(row: any): Record<string, unknown> {
    return {
      id: row.id?.toString?.() ?? String(row.id ?? ''),
      senderName: row.senderName ?? null,
      carrierName: row.carrierName ?? null,
      trackingNo: row.trackingNo ?? null,
      postalCode: row.postalCode ?? null,
      address: row.address ?? null,
      phone: row.phone ?? null,
      packageContent: row.packageContent ?? null,
      salesSite: row.salesSite ?? null,
      orderNo: row.orderNo ?? null,
      productId: row.productId ?? null,
      productName: row.productName ?? null,
      isOpenedUsed: Boolean(row.isOpenedUsed),
      canRestock: Boolean(row.canRestock),
      sourceFileName: row.sourceFileName ?? null,
      createdAt: row.createdAt?.toISOString?.() ?? null,
      updatedAt: row.updatedAt?.toISOString?.() ?? null,
    };
  }
}
