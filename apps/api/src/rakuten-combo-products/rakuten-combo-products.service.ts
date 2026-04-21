import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRakutenComboProductDto } from './dto/create-rakuten-combo-product.dto';

const MAX_COMBO_ITEM_COUNT = 10;
const COMBO_UPLOAD_TEMPLATE_FILE = '乐天组合产品上传模板.xlsx';

type NormalizedComboPayload = {
  comboName: string;
  productIds: string[];
};

@Injectable()
export class RakutenComboProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(pageRaw?: string, pageSizeRaw?: string, keywordRaw?: string): Promise<unknown> {
    const page = this.parsePositiveInt(pageRaw, 1, 1, 100000);
    const pageSize = this.parsePositiveInt(pageSizeRaw, 30, 1, 100);
    const keyword = String(keywordRaw ?? '').trim();
    const where: Prisma.RakutenComboProductWhereInput = keyword
      ? {
          OR: [
            { comboName: { contains: keyword } },
            { items: { some: { productId: { contains: keyword } } } },
            { items: { some: { product: { productName: { contains: keyword } } } } },
          ],
        }
      : {};

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.rakutenComboProduct.count({ where }),
      this.prisma.rakutenComboProduct.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          items: {
            orderBy: { position: 'asc' },
            include: {
              product: {
                select: {
                  productId: true,
                  productName: true,
                },
              },
            },
          },
        },
      }),
    ]);

    return {
      items: rows.map((row) => this.serializeCombo(row)),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  async create(payload: CreateRakutenComboProductDto): Promise<unknown> {
    const normalized = await this.normalizePayload(payload);
    const existing = await this.prisma.rakutenComboProduct.findUnique({
      where: { comboName: normalized.comboName },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('组合名已存在');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const combo = await tx.rakutenComboProduct.create({
        data: {
          comboName: normalized.comboName,
          items: {
            create: normalized.productIds.map((productId, index) => ({
              productId,
              position: index + 1,
            })),
          },
        },
      });
      return tx.rakutenComboProduct.findUnique({
        where: { id: combo.id },
        include: {
          items: {
            orderBy: { position: 'asc' },
            include: {
              product: {
                select: {
                  productId: true,
                  productName: true,
                },
              },
            },
          },
        },
      });
    });
    return this.serializeCombo(created);
  }

  getUploadTemplate(): { fileName: string; content: Buffer } {
    const headers = ['组合名', ...Array.from({ length: MAX_COMBO_ITEM_COUNT }, (_, idx) => `产品ID${idx + 1}`)];
    const rows = [
      headers,
      ['示例组合A', '8736', '1088'],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '乐天组合产品');
    return {
      fileName: COMBO_UPLOAD_TEMPLATE_FILE,
      content: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    };
  }

  async importExcel(fileBuffer: Buffer, sourceFileName?: string): Promise<unknown> {
    const rows = this.parseImportRows(fileBuffer);
    await this.assertProductsExist([...new Set(rows.flatMap((row) => row.productIds))]);
    let createdCount = 0;
    let updatedCount = 0;

    for (const row of rows) {
      const existing = await this.prisma.rakutenComboProduct.findUnique({
        where: { comboName: row.comboName },
        select: { id: true },
      });
      await this.prisma.$transaction(async (tx) => {
        if (existing) {
          await tx.rakutenComboProductItem.deleteMany({
            where: { comboId: existing.id },
          });
          await tx.rakutenComboProduct.update({
            where: { id: existing.id },
            data: {
              items: {
                create: row.productIds.map((productId, index) => ({
                  productId,
                  position: index + 1,
                })),
              },
            },
          });
          updatedCount += 1;
          return;
        }
        await tx.rakutenComboProduct.create({
          data: {
            comboName: row.comboName,
            items: {
              create: row.productIds.map((productId, index) => ({
                productId,
                position: index + 1,
              })),
            },
          },
        });
        createdCount += 1;
      });
    }

    return {
      importedCount: rows.length,
      createdCount,
      updatedCount,
      sourceFileName: sourceFileName ?? null,
    };
  }

  private async normalizePayload(payload: { comboName?: unknown; productIds?: unknown }): Promise<NormalizedComboPayload> {
    const comboName = String(payload.comboName ?? '').trim();
    if (!comboName) {
      throw new BadRequestException('组合名不能为空');
    }
    if (comboName.length > 255) {
      throw new BadRequestException('组合名不能超过 255 个字符');
    }
    const productIds = this.normalizeProductIds(payload.productIds);
    await this.assertProductsExist(productIds);
    return {
      comboName,
      productIds,
    };
  }

  private normalizeProductIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException('请至少添加 1 个产品');
    }
    const productIds = value.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!productIds.length) {
      throw new BadRequestException('请至少添加 1 个产品');
    }
    if (productIds.length > MAX_COMBO_ITEM_COUNT) {
      throw new BadRequestException(`组合产品最多添加 ${MAX_COMBO_ITEM_COUNT} 个产品`);
    }
    const seen = new Set<string>();
    const duplicate = productIds.find((productId) => {
      if (seen.has(productId)) {
        return true;
      }
      seen.add(productId);
      return false;
    });
    if (duplicate) {
      throw new BadRequestException(`产品ID ${duplicate} 重复添加`);
    }
    return productIds;
  }

  private async assertProductsExist(productIds: string[]): Promise<void> {
    const products = await this.prisma.masterProduct.findMany({
      where: {
        productId: {
          in: productIds,
        },
      },
      select: {
        productId: true,
      },
    });
    const existing = new Set(products.map((item) => item.productId));
    const missing = productIds.filter((productId) => !existing.has(productId));
    if (missing.length) {
      throw new BadRequestException(`主表产品不存在：${missing.join('、')}`);
    }
  }

  private parseImportRows(fileBuffer: Buffer): NormalizedComboPayload[] {
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

    const rows: NormalizedComboPayload[] = [];
    const errors: string[] = [];
    rawRows.forEach((rawRow, idx) => {
      const rowNo = idx + 2;
      const normalized: Record<string, string> = {};
      Object.entries(rawRow).forEach(([key, value]) => {
        normalized[this.normalizeHeader(key)] = String(value ?? '').trim();
      });
      const comboName = this.pickField(normalized, ['组合名', '组合产品名', '组合名称', 'comboname', 'combo']);
      const productIds = Array.from({ length: MAX_COMBO_ITEM_COUNT }, (_, productIndex) =>
        this.pickField(normalized, [
          `产品id${productIndex + 1}`,
          `产品ID${productIndex + 1}`,
          `productid${productIndex + 1}`,
          `product${productIndex + 1}`,
        ]),
      ).filter(Boolean);
      try {
        rows.push({
          comboName,
          productIds: this.normalizeProductIds(productIds),
        });
      } catch (error) {
        errors.push(`第 ${rowNo} 行：${error instanceof Error ? error.message : '格式错误'}`);
        return;
      }
      if (!comboName) {
        errors.push(`第 ${rowNo} 行：组合名不能为空`);
      } else if (comboName.length > 255) {
        errors.push(`第 ${rowNo} 行：组合名不能超过 255 个字符`);
      }
    });
    if (errors.length) {
      throw new BadRequestException(errors.slice(0, 20).join('；'));
    }
    const comboNames = new Set<string>();
    const duplicateCombo = rows.find((row) => {
      if (comboNames.has(row.comboName)) {
        return true;
      }
      comboNames.add(row.comboName);
      return false;
    });
    if (duplicateCombo) {
      throw new BadRequestException(`Excel 中组合名重复：${duplicateCombo.comboName}`);
    }
    return rows;
  }

  private serializeCombo(combo: any): unknown {
    if (!combo) {
      return null;
    }
    return {
      id: combo.id,
      comboName: combo.comboName,
      itemCount: Array.isArray(combo.items) ? combo.items.length : 0,
      createdAt: combo.createdAt,
      updatedAt: combo.updatedAt,
      items: Array.isArray(combo.items)
        ? combo.items.map((item: any) => ({
            id: item.id,
            position: item.position,
            productId: item.productId,
            productName: item.product?.productName ?? null,
          }))
        : [],
    };
  }

  private normalizeHeader(value: string): string {
    return String(value ?? '')
      .trim()
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  private pickField(row: Record<string, string>, aliases: string[]): string {
    for (const alias of aliases) {
      const key = this.normalizeHeader(alias);
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        return String(row[key] ?? '').trim();
      }
    }
    return '';
  }

  private parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      return fallback;
    }
    return Math.min(Math.max(parsed, min), max);
  }
}
