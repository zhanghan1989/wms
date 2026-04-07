import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { normalizeBoxCode } from '../common/box-code';
import { APP_TIMEZONE, getZonedDateParts } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMasterProductFbaReplenishmentDto } from './dto/create-master-product-fba-replenishment.dto';
import { CreateMasterProductOutboundOneDto } from './dto/create-master-product-outbound-one.dto';
import { ManualAdjustMasterProductBoxDto } from './dto/manual-adjust-master-product-box.dto';

type MasterProductListResult = {
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

const CREATE_CHUNK_SIZE = 1000;
const UPDATE_CHUNK_SIZE = 200;

const MASTER_PRODUCT_COLUMN_ALIASES = {
  productId: ['productId', 'product id', '产品ID', '产品Id', '产品id'],
  productName: ['productName', 'product name', '产品名称'],
  productType: ['productType', 'product type', '产品类型'],
  bagBrand: ['bagBrand', 'bag brand', '包包品牌', '品牌'],
  color: ['color', '颜色'],
  bagName: ['bagName', 'bag name', '包名'],
  bagType: ['bagType', 'bag type', '包型'],
  zipperStyle: ['zipperStyle', 'zipper style', '拉链款式'],
  style: ['style', '款式'],
  pattern: ['pattern', '花纹', '图案'],
  buckleType: ['buckleType', 'buckle type', '扣子类型'],
  matchingBagType: ['matchingBagType', 'matching bag type', '对应包型', '匹配包型'],
  length: ['length', '长度'],
  width: ['width', '宽度'],
  patternType: ['patternType', 'pattern type', '花纹类型'],
  size: ['size', '尺寸'],
  stockQty: ['stockQty', 'stock qty', '在库数', '库存', '库存数'],
} as const;

@Injectable()
export class MasterProductsService {
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
    const where: Prisma.MasterProductWhereInput | undefined = keyword
      ? {
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
        }
      : undefined;

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

  async importExcel(
    fileBuffer: Buffer,
    originalName?: string,
  ): Promise<{
    fileName: string | null;
    totalRows: number;
    importedCount: number;
    createdCount: number;
    updatedCount: number;
  }> {
    const rows = this.parseImportRows(fileBuffer);
    if (!rows.length) {
      throw new BadRequestException('Excel 中没有可导入的产品主表数据');
    }

    const existingIds = await this.loadExistingProductIds(rows.map((row) => row.productId));
    const createRows: MasterProductImportRow[] = [];
    const updateRows: MasterProductImportRow[] = [];

    rows.forEach((row) => {
      if (existingIds.has(row.productId)) {
        updateRows.push(row);
        return;
      }
      createRows.push(row);
    });

    for (const chunk of this.chunkRows(createRows, CREATE_CHUNK_SIZE)) {
      await this.prisma.masterProduct.createMany({
        data: chunk.map((row) => this.toCreateInput(row)),
        skipDuplicates: true,
      });
    }

    for (const chunk of this.chunkRows(updateRows, UPDATE_CHUNK_SIZE)) {
      await this.prisma.$transaction(
        chunk.map((row) =>
          this.prisma.masterProduct.update({
            where: { productId: row.productId },
            data: this.toUpdateInput(row),
          }),
        ),
      );
    }

    return {
      fileName: originalName ?? null,
      totalRows: rows.length,
      importedCount: rows.length,
      createdCount: createRows.length,
      updatedCount: updateRows.length,
    };
  }

  async detail(productIdRaw: string): Promise<unknown> {
    const productId = String(productIdRaw || '').trim();
    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }

    const product = await this.prisma.masterProduct.findUnique({
      where: { productId },
    });
    if (!product) {
      throw new NotFoundException('未找到产品主表记录');
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
        throw new NotFoundException('未找到产品主表记录');
      }
      if (!box) {
        throw new NotFoundException('未找到箱号');
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
    const skuId = BigInt(payload.skuId);
    const requestedQty = Math.trunc(Number(payload.qty));
    const remark = String(payload.remark || '').trim() || 'FBA补货';

    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }
    if (!boxCode) {
      throw new BadRequestException('箱号不能为空');
    }
    if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
      throw new BadRequestException('申请数量必须为正整数');
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
        throw new NotFoundException('主表产品不存在');
      }
      if (!sku) {
        throw new NotFoundException('SKU不存在');
      }
      if (String(sku.productId || '').trim() !== productId) {
        throw new ConflictException('所选SKU不属于当前主表产品');
      }
      if (!String(sku.fnsku || '').trim()) {
        throw new BadRequestException('该SKU缺少FNSKU，无法发起FBA补货');
      }
      if (!String(sku.shop || '').trim()) {
        throw new BadRequestException('该SKU缺少所属店铺，无法发起FBA补货');
      }
      if (!box) {
        throw new NotFoundException('箱号不存在');
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
          throw new ConflictException('相同SKU已有FBA补货申请，请处理后再重新申请');
        }
        const activeQty = this.getActiveFbaReservedQty(existingActiveSku);
        throw new ConflictException(
          `本SKU已发起FBA申请${activeQty}件（申请单号：${existingActiveSku.requestNo}）`,
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
    const skuId = BigInt(payload.skuId);
    const remark = String(payload.remark || '').trim() || '快速出库1件';

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
        throw new NotFoundException('主表产品不存在');
      }
      if (!sku) {
        throw new NotFoundException('SKU不存在');
      }
      if (String(sku.productId || '').trim() !== productId) {
        throw new ConflictException('所选SKU不属于当前主表产品');
      }
      if (!box) {
        throw new NotFoundException('箱号不存在');
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
      throw new BadRequestException('无法解析 Excel 文件');
    }

    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new BadRequestException('Excel 中没有工作表');
    }

    const sheet = workbook.Sheets[firstSheet];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (!rawRows.length) {
      throw new BadRequestException('Excel 中没有数据');
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
        errors.push(`第 ${rowNo} 行缺少产品ID`);
        return;
      }

      let stockQty: number | null;
      try {
        stockQty = this.toNullableInt(
          this.pickField(normalized, MASTER_PRODUCT_COLUMN_ALIASES.stockQty),
        );
      } catch (error) {
        errors.push(
          error instanceof Error ? `第 ${rowNo} 行${error.message}` : `第 ${rowNo} 行库存数格式无效`,
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
      throw new BadRequestException(errors.slice(0, 10).join('；'));
    }

    return Array.from(resultByProductId.values());
  }

  private async loadExistingProductIds(productIds: string[]): Promise<Set<string>> {
    const result = new Set<string>();
    for (const chunk of this.chunkRows(Array.from(new Set(productIds)), CREATE_CHUNK_SIZE)) {
      const rows = await this.prisma.masterProduct.findMany({
        where: { productId: { in: chunk } },
        select: { productId: true },
      });
      rows.forEach((row) => result.add(row.productId));
    }
    return result;
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

  private toUpdateInput(row: MasterProductImportRow): Prisma.MasterProductUpdateInput {
    const data: Prisma.MasterProductUpdateInput = {
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
      status: 1,
    };

    if (row.stockQty !== null) {
      data.stockQty = row.stockQty;
    }

    return data;
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
      .replace(/[（(]/g, '(')
      .replace(/[）)]/g, ')')
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

  private toNullableText(value: string): string | null {
    const text = String(value || '').trim();
    return text ? text : null;
  }

  private toNullableInt(value: string): number | null {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) {
      throw new BadRequestException(`库存数不是有效数字: ${text}`);
    }
    return Math.trunc(numeric);
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
    throw new ConflictException('FBA补货申请单号生成失败，请稍后重试');
  }

  private chunkRows<T>(rows: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < rows.length; index += size) {
      result.push(rows.slice(index, index + size));
    }
    return result;
  }
}
