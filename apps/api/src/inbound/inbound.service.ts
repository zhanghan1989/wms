import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AuditAction,
  InboundOrderType,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { buildEquivalentBoxCodes, normalizeBoxCode } from '../common/box-code';
import { generateOrderNo, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateInboundOrderDto,
  CreateInboundOrderItemDto,
} from './dto/create-inbound-order.dto';

interface InboundLine {
  boxCode: string;
  productId: string;
  qty: number;
  sourceRowNo: number;
}

@Injectable()
export class InboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(status?: OrderStatus): Promise<unknown[]> {
    return this.prisma.inboundOrder.findMany({
      where: status ? { status } : undefined,
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        items: {
          include: {
            box: { select: { id: true, boxCode: true } },
            product: {
              select: {
                id: true,
                productId: true,
                productName: true,
                stockQty: true,
              },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'desc' },
    });
  }

  async importExcel(
    fileBuffer: Buffer,
    originalName: string | undefined,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const parsedLines = this.parseExcelLines(fileBuffer);
    const mergedLines = this.mergeLines(parsedLines);
    await this.ensureBoxesAreNew(mergedLines);
    await this.ensureProductsExist(mergedLines);
    const remark = originalName ? `import:${originalName}` : 'import-excel';
    return this.createPendingBatchOrder(mergedLines, remark, operatorId, requestId);
  }

  async create(
    payload: CreateInboundOrderDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const normalized = payload.items.map((item) => this.normalizeItem(item));
    const mergedLines = this.mergeLines(normalized);
    await this.ensureBoxesAreNew(mergedLines);
    await this.ensureProductsExist(mergedLines);
    return this.createPendingBatchOrder(
      mergedLines,
      payload.remark ?? 'manual-create',
      operatorId,
      requestId,
    );
  }

  async confirm(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    idempotent: boolean;
    changedRows: number;
  }> {
    const orderId = parseId(idParam, 'inboundOrderId');
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: bigint; status: OrderStatus }>>(
        Prisma.sql`SELECT id, status FROM inbound_orders WHERE id = ${orderId} FOR UPDATE`,
      );
      if (locked.length === 0) {
        throw new NotFoundException('入库单不存在');
      }

      if (locked[0].status === OrderStatus.confirmed) {
        return {
          orderId: orderId.toString(),
          status: OrderStatus.confirmed,
          idempotent: true,
          changedRows: 0,
        };
      }
      if (locked[0].status === OrderStatus.void) {
        throw new UnprocessableEntityException('已作废的入库单不能再确认');
      }

      const order = await tx.inboundOrder.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) throw new NotFoundException('入库单不存在');
      if (order.items.length === 0) {
        throw new UnprocessableEntityException('入库单没有明细，不能确认');
      }

      const productIds = Array.from(new Set(order.items.map((item) => item.productId)));
      const boxIds = Array.from(new Set(order.items.map((item) => item.boxId)));

      const [products, currentInventoryRows] = await Promise.all([
        tx.masterProduct.findMany({
          where: { productId: { in: productIds } },
          select: {
            id: true,
            productId: true,
            stockQty: true,
          },
        }),
        tx.masterProductBoxInventory.findMany({
          where: {
            OR: order.items.map((item) => ({
              boxId: item.boxId,
              productId: item.productId,
            })),
          },
        }),
      ]);

      const productById = new Map(products.map((item) => [item.productId, item]));
      const currentQtyMap = new Map<string, number>();
      currentInventoryRows.forEach((row) => {
        currentQtyMap.set(this.inventoryKey(row.boxId, row.productId), Number(row.qty ?? 0));
      });

      for (const item of order.items) {
        const product = productById.get(item.productId);
        if (!product) {
          throw new UnprocessableEntityException(`产品ID不存在：${item.productId}`);
        }

        const key = this.inventoryKey(item.boxId, item.productId);
        const beforeQty = currentQtyMap.get(key) ?? 0;
        const afterQty = beforeQty + item.qty;

        await tx.masterProductBoxInventory.upsert({
          where: {
            boxId_productId: {
              boxId: item.boxId,
              productId: item.productId,
            },
          },
          update: {
            qty: afterQty,
          },
          create: {
            boxId: item.boxId,
            productId: item.productId,
            qty: item.qty,
          },
        });

        currentQtyMap.set(key, afterQty);

        await this.auditService.create({
          db: tx,
          entityType: 'box',
          entityId: item.boxId,
          action: AuditAction.update,
          eventType: AuditEventType.BOX_STOCK_INCREASED,
          beforeData: {
            scope: 'master_product',
            boxId: item.boxId.toString(),
            productId: item.productId,
            qty: beforeQty,
          },
          afterData: {
            scope: 'master_product',
            boxId: item.boxId.toString(),
            productId: item.productId,
            qty: afterQty,
            qtyDelta: item.qty,
          },
          operatorId,
          requestId,
          remark: `inbound order ${order.orderNo}`,
        });
      }

      const totalQtyMap = new Map<string, number>();
      if (productIds.length > 0) {
        const totals = await tx.masterProductBoxInventory.groupBy({
          by: ['productId'],
          where: {
            productId: { in: productIds },
            qty: { gt: 0 },
          },
          _sum: { qty: true },
        });
        totals.forEach((row) => {
          totalQtyMap.set(row.productId, Number(row._sum.qty ?? 0));
        });
      }

      for (const productId of productIds) {
        const product = productById.get(productId);
        if (!product) continue;

        const totalQty = totalQtyMap.get(productId) ?? 0;
        await tx.masterProduct.update({
          where: { productId },
          data: { stockQty: totalQty },
        });
        if (totalQty > 0) {
          await tx.masterProduct.updateMany({
            where: { productId, firstStockedAt: null },
            data: { firstStockedAt: new Date() },
          });
        }

        await this.auditService.create({
          db: tx,
          entityType: 'master_product',
          entityId: product.id,
          action: AuditAction.update,
          eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
          beforeData: {
            productId,
            stockQty: Number(product.stockQty ?? 0),
            boxIds: boxIds.map((id) => id.toString()),
          },
          afterData: {
            productId,
            stockQty: totalQty,
            boxIds: boxIds.map((id) => id.toString()),
          },
          operatorId,
          requestId,
          remark: `inbound order ${order.orderNo}`,
        });
      }

      await tx.inboundOrder.update({
        where: { id: orderId },
        data: { status: OrderStatus.confirmed },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'inbound_order',
        entityId: order.id,
        action: AuditAction.update,
        eventType: AuditEventType.INBOUND_ORDER_CONFIRMED,
        beforeData: { status: order.status },
        afterData: { status: OrderStatus.confirmed },
        operatorId,
        requestId,
      });

      return {
        orderId: order.id.toString(),
        status: OrderStatus.confirmed,
        idempotent: false,
        changedRows: order.items.length,
      };
    });
  }

  async void(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    idempotent: boolean;
  }> {
    const orderId = parseId(idParam, 'inboundOrderId');
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: bigint; status: OrderStatus }>>(
        Prisma.sql`SELECT id, status FROM inbound_orders WHERE id = ${orderId} FOR UPDATE`,
      );
      if (locked.length === 0) throw new NotFoundException('入库单不存在');

      if (locked[0].status === OrderStatus.confirmed) {
        throw new UnprocessableEntityException('已确认的入库单不能作废');
      }
      if (locked[0].status === OrderStatus.void) {
        return {
          orderId: orderId.toString(),
          status: OrderStatus.void,
          idempotent: true,
        };
      }

      const before = await tx.inboundOrder.findUnique({ where: { id: orderId } });
      if (!before) throw new NotFoundException('入库单不存在');

      await tx.inboundOrder.update({
        where: { id: orderId },
        data: { status: OrderStatus.void },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'inbound_order',
        entityId: orderId,
        action: AuditAction.update,
        eventType: AuditEventType.INBOUND_ORDER_VOIDED,
        beforeData: { status: before.status },
        afterData: { status: OrderStatus.void },
        operatorId,
        requestId,
      });

      return {
        orderId: orderId.toString(),
        status: OrderStatus.void,
        idempotent: false,
      };
    });
  }

  private normalizeItem(item: CreateInboundOrderItemDto): InboundLine {
    const boxCode = normalizeBoxCode(item.boxCode);
    const productId = item.productId.trim();
    if (!boxCode || !productId) {
      throw new BadRequestException('箱号和产品ID为必填');
    }
    return {
      boxCode,
      productId,
      qty: item.qty,
      sourceRowNo: item.sourceRowNo ?? 0,
    };
  }

  private parseExcelLines(fileBuffer: Buffer): InboundLine[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    } catch {
      throw new BadRequestException('无法解析 Excel 文件');
    }
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new BadRequestException('Excel 中没有可读取的工作表');
    }
    const sheet = workbook.Sheets[firstSheet];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (rows.length === 0) {
      throw new BadRequestException('Excel 中没有数据');
    }

    const errors: string[] = [];
    const result: InboundLine[] = [];

    rows.forEach((row, idx) => {
      const rowNo = idx + 2;
      const normalized: Record<string, string> = {};
      Object.entries(row).forEach(([key, value]) => {
        normalized[this.normalizeHeader(key)] = String(value ?? '').trim();
      });

      const boxCode = normalizeBoxCode(this.pickField(normalized, ['箱号', 'box', 'boxcode']));
      const productId = this.pickField(normalized, ['产品ID', '产品id', 'productId', 'productid']);
      const qtyRaw = this.pickField(normalized, ['数量', 'qty', 'count', 'quantity']);

      if (!boxCode || !productId || !qtyRaw) {
        errors.push(`第${rowNo}行：箱号/产品ID/数量为必填`);
        return;
      }

      const qtyNumber = Number(qtyRaw);
      if (!Number.isInteger(qtyNumber) || qtyNumber <= 0) {
        errors.push(`第${rowNo}行：数量必须是大于 0 的整数`);
        return;
      }

      result.push({
        boxCode,
        productId: productId.trim(),
        qty: qtyNumber,
        sourceRowNo: rowNo,
      });
    });

    if (errors.length > 0) {
      throw new UnprocessableEntityException(`Excel 校验失败：${errors.join(' | ')}`);
    }

    return result;
  }

  private normalizeHeader(header: string): string {
    return header.replace(/\s+/g, '').toLowerCase();
  }

  private pickField(row: Record<string, string>, aliases: string[]): string | null {
    for (const alias of aliases) {
      const normalizedAlias = this.normalizeHeader(alias);
      const value = row[normalizedAlias];
      if (value) return value;
    }
    return null;
  }

  private mergeLines(lines: InboundLine[]): InboundLine[] {
    const map = new Map<string, InboundLine>();
    lines.forEach((line) => {
      const key = `${line.boxCode}||${line.productId}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...line });
        return;
      }
      existing.qty += line.qty;
      existing.sourceRowNo = existing.sourceRowNo || line.sourceRowNo;
    });
    return Array.from(map.values());
  }

  private async ensureProductsExist(lines: InboundLine[]): Promise<void> {
    const productIds = Array.from(new Set(lines.map((line) => line.productId)));
    const existingProducts = await this.prisma.masterProduct.findMany({
      where: { productId: { in: productIds } },
      select: { productId: true },
    });
    const existingProductIdSet = new Set(existingProducts.map((item) => item.productId));
    const missingProductIds = productIds.filter((productId) => !existingProductIdSet.has(productId));
    if (missingProductIds.length > 0) {
      throw new UnprocessableEntityException(`以下产品ID在系统中不存在：${missingProductIds.join(', ')}`);
    }
  }

  private async ensureBoxesAreNew(lines: InboundLine[]): Promise<void> {
    const uniqueBoxes = Array.from(new Set(lines.map((line) => line.boxCode)));
    const equivalentCodes = Array.from(new Set(uniqueBoxes.flatMap((line) => buildEquivalentBoxCodes(line))));
    const existing = await this.prisma.box.findMany({
      where: { boxCode: { in: equivalentCodes } },
      select: { boxCode: true },
    });
    if (existing.length > 0) {
      const boxCodes = Array.from(
        new Set(existing.map((item) => normalizeBoxCode(item.boxCode) || item.boxCode)),
      ).join(', ');
      throw new UnprocessableEntityException(`箱号已存在：${boxCodes}`);
    }
  }

  private async createPendingBatchOrder(
    lines: InboundLine[],
    remark: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    return this.prisma.$transaction(async (tx) => {
      const shelf = await tx.shelf.findFirst({
        where: { status: 1 },
        orderBy: { id: 'asc' },
      });
      if (!shelf) {
        throw new UnprocessableEntityException('没有可用货架，无法创建入库单');
      }

      const order = await tx.inboundOrder.create({
        data: {
          orderNo: generateOrderNo('INB'),
          orderType: InboundOrderType.pending_batch,
          status: OrderStatus.draft,
          remark,
          createdBy: operatorId,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'inbound_order',
        entityId: order.id,
        action: AuditAction.create,
        eventType: AuditEventType.INBOUND_ORDER_CREATED,
        beforeData: null,
        afterData: {
          orderNo: order.orderNo,
          orderType: order.orderType,
          status: order.status,
          remark: order.remark,
        },
        operatorId,
        requestId,
      });

      const boxCodes = Array.from(new Set(lines.map((line) => line.boxCode)));
      const boxMap = new Map<string, bigint>();
      for (const boxCode of boxCodes) {
        const createdBox = await tx.box.create({
          data: {
            boxCode,
            shelfId: shelf.id,
            status: 1,
          },
        });
        boxMap.set(boxCode, createdBox.id);

        await this.auditService.create({
          db: tx,
          entityType: 'box',
          entityId: createdBox.id,
          action: AuditAction.create,
          eventType: AuditEventType.BOX_CREATED,
          beforeData: null,
          afterData: createdBox as unknown as Record<string, unknown>,
          operatorId,
          requestId,
          remark: `created from inbound ${order.orderNo}`,
        });
      }

      await tx.inboundOrderItem.createMany({
        data: lines.map((line) => ({
          orderId: order.id,
          boxId: boxMap.get(line.boxCode) as bigint,
          productId: line.productId,
          qty: line.qty,
          sourceRowNo: line.sourceRowNo > 0 ? line.sourceRowNo : null,
        })),
      });

      return tx.inboundOrder.findUnique({
        where: { id: order.id },
        include: {
          creator: {
            select: {
              id: true,
              username: true,
            },
          },
          items: {
            include: {
              box: { select: { id: true, boxCode: true } },
              product: {
                select: {
                  id: true,
                  productId: true,
                  productName: true,
                  stockQty: true,
                },
              },
            },
            orderBy: { id: 'asc' },
          },
        },
      });
    });
  }

  private inventoryKey(boxId: bigint, productId: string): string {
    return `${boxId.toString()}-${productId}`;
  }
}
