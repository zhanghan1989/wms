import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, OrderStatus, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { generateOrderNo, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateAdjustOrderDto,
  CreateAdjustOrderItemDto,
} from './dto/create-adjust-order.dto';
import { ManualAdjustDto } from './dto/manual-adjust.dto';

interface AdjustOrderResult {
  orderId: string;
  status: OrderStatus;
  idempotent: boolean;
  changedRows: number;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async searchSkus(keyword?: string): Promise<unknown[]> {
    if (!keyword?.trim()) return [];
    const key = keyword.trim();
    return this.prisma.sku.findMany({
      where: {
        OR: [
          { sku: { contains: key } },
          { erpSku: { contains: key } },
          { asin: { contains: key } },
          { fnsku: { contains: key } },
        ],
      },
      take: 20,
      orderBy: { id: 'desc' },
    });
  }

  async productBoxes(skuId: number): Promise<unknown[]> {
    return this.prisma.inventoryBoxSku.findMany({
      where: {
        skuId: BigInt(skuId),
        qty: { gt: 0 },
      },
      include: {
        box: {
          include: {
            shelf: {
              select: {
                id: true,
                shelfCode: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: {
        boxId: 'asc',
      },
    });
  }

  async boxSkus(boxId: number): Promise<unknown[]> {
    return this.prisma.inventoryBoxSku.findMany({
      where: {
        boxId: BigInt(boxId),
        qty: { gt: 0 },
      },
      include: {
        box: {
          include: {
            shelf: {
              select: {
                id: true,
                shelfCode: true,
                name: true,
              },
            },
          },
        },
        sku: {
          select: {
            id: true,
            sku: true,
            erpSku: true,
            asin: true,
            fnsku: true,
          },
        },
      },
      orderBy: {
        sku: {
          sku: 'asc',
        },
      },
    });
  }

  async createAdjustOrder(
    payload: CreateAdjustOrderDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const normalizedItems = payload.items.map((item) => this.normalizeAdjustItem(item));
    return this.prisma.$transaction(async (tx) => {
      await this.ensureReferences(tx, normalizedItems);

      const order = await tx.inventoryAdjustOrder.create({
        data: {
          adjustNo: generateOrderNo('ADJ'),
          status: OrderStatus.draft,
          remark: payload.remark ?? null,
          createdBy: operatorId,
        },
      });

      await tx.inventoryAdjustOrderItem.createMany({
        data: normalizedItems.map((item) => ({
          orderId: order.id,
          boxId: item.boxId,
          skuId: item.skuId,
          qtyDelta: item.qtyDelta,
          reason: item.reason ?? null,
        })),
      });

      await this.auditService.create({
        db: tx,
        entityType: 'inventory_adjust_order',
        entityId: order.id,
        action: AuditAction.create,
        eventType: AuditEventType.INVENTORY_ADJUST_CREATED,
        beforeData: null,
        afterData: {
          adjustNo: order.adjustNo,
          status: order.status,
          itemCount: normalizedItems.length,
        },
        operatorId,
        requestId,
      });

      return tx.inventoryAdjustOrder.findUnique({
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
              sku: { select: { id: true, sku: true } },
            },
            orderBy: { id: 'asc' },
          },
        },
      });
    });
  }

  async confirmAdjustOrder(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<AdjustOrderResult> {
    const orderId = parseId(idParam, 'adjustOrderId');
    return this.prisma.$transaction(async (tx) =>
      this.applyAdjustOrder(tx, orderId, operatorId, requestId, true),
    );
  }

  async manualAdjust(
    payload: ManualAdjustDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<AdjustOrderResult & { adjustNo: string }> {
    return this.prisma.$transaction(async (tx) => {
      const sku = await this.resolveSkuForManual(tx, payload);
      const box = await this.resolveBoxForManual(tx, payload);

      const order = await tx.inventoryAdjustOrder.create({
        data: {
          adjustNo: generateOrderNo('ADJ'),
          status: OrderStatus.draft,
          remark: 'manual-adjust',
          createdBy: operatorId,
        },
      });
      await tx.inventoryAdjustOrderItem.create({
        data: {
          orderId: order.id,
          boxId: box.id,
          skuId: sku.id,
          qtyDelta: payload.qtyDelta,
          reason: payload.reason ?? null,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'inventory_adjust_order',
        entityId: order.id,
        action: AuditAction.create,
        eventType: AuditEventType.INVENTORY_ADJUST_CREATED,
        beforeData: null,
        afterData: {
          adjustNo: order.adjustNo,
          status: order.status,
          mode: 'manual',
        },
        operatorId,
        requestId,
      });

      const result = await this.applyAdjustOrder(tx, order.id, operatorId, requestId, false);
      return {
        ...result,
        adjustNo: order.adjustNo,
      };
    });
  }

  private normalizeAdjustItem(item: CreateAdjustOrderItemDto): {
    boxId: bigint;
    skuId: bigint;
    qtyDelta: number;
    reason?: string;
  } {
    if (item.qtyDelta === 0) {
      throw new BadRequestException('qtyDelta cannot be 0');
    }
    return {
      boxId: BigInt(item.boxId),
      skuId: BigInt(item.skuId),
      qtyDelta: item.qtyDelta,
      reason: item.reason,
    };
  }

  private async ensureReferences(
    tx: Prisma.TransactionClient,
    items: Array<{ boxId: bigint; skuId: bigint }>,
  ): Promise<void> {
    const uniqueBoxIds = Array.from(new Set(items.map((item) => item.boxId.toString()))).map((id) => BigInt(id));
    const uniqueSkuIds = Array.from(new Set(items.map((item) => item.skuId.toString()))).map((id) => BigInt(id));

    const [boxes, skus] = await Promise.all([
      tx.box.findMany({
        where: { id: { in: uniqueBoxIds } },
        select: { id: true },
      }),
      tx.sku.findMany({
        where: { id: { in: uniqueSkuIds } },
        select: { id: true },
      }),
    ]);

    if (boxes.length !== uniqueBoxIds.length) {
      throw new NotFoundException('box not found in adjust items');
    }
    if (skus.length !== uniqueSkuIds.length) {
      throw new NotFoundException('sku not found in adjust items');
    }
  }

  private async applyAdjustOrder(
    tx: Prisma.TransactionClient,
    orderId: bigint,
    operatorId: bigint,
    requestId: string | undefined,
    lockOrder: boolean,
  ): Promise<AdjustOrderResult> {
    if (lockOrder) {
      const locked = await tx.$queryRaw<Array<{ id: bigint; status: OrderStatus }>>(
        Prisma.sql`SELECT id, status FROM inventory_adjust_orders WHERE id = ${orderId} FOR UPDATE`,
      );
      if (locked.length === 0) {
        throw new NotFoundException('adjust order not found');
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
        throw new UnprocessableEntityException('void adjust order cannot be confirmed');
      }
    }

    const order = await tx.inventoryAdjustOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('adjust order not found');
    if (order.items.length === 0) {
      throw new UnprocessableEntityException('adjust order has no items');
    }

    const currentInventoryRows = await tx.inventoryBoxSku.findMany({
      where: {
        OR: order.items.map((item) => ({
          boxId: item.boxId,
          skuId: item.skuId,
        })),
      },
    });
    const currentQtyMap = new Map<string, number>();
    const existingInventoryKeys = new Set<string>();
    currentInventoryRows.forEach((row) => {
      const key = this.inventoryKey(row.boxId, row.skuId);
      currentQtyMap.set(key, row.qty);
      existingInventoryKeys.add(key);
    });

    for (const item of order.items) {
      const key = this.inventoryKey(item.boxId, item.skuId);
      const beforeQty = currentQtyMap.get(key) ?? 0;
      const afterQty = beforeQty + item.qtyDelta;
      if (afterQty < 0) {
        throw new ConflictException(`insufficient inventory for box ${item.boxId} sku ${item.skuId}`);
      }

      if (existingInventoryKeys.has(key)) {
        await tx.inventoryBoxSku.update({
          where: {
            boxId_skuId: {
              boxId: item.boxId,
              skuId: item.skuId,
            },
          },
          data: {
            qty: afterQty,
          },
        });
      } else {
        await tx.inventoryBoxSku.create({
          data: {
            boxId: item.boxId,
            skuId: item.skuId,
            qty: afterQty,
          },
        });
        existingInventoryKeys.add(key);
      }

      currentQtyMap.set(key, afterQty);

      await tx.stockMovement.create({
        data: {
          movementType: 'adjust',
          refType: 'inventory_adjust_order',
          refId: order.id,
          boxId: item.boxId,
          skuId: item.skuId,
          qtyDelta: item.qtyDelta,
          operatorId,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'box',
        entityId: item.boxId,
        action: AuditAction.update,
        eventType:
          item.qtyDelta > 0
            ? AuditEventType.BOX_STOCK_INCREASED
            : AuditEventType.BOX_STOCK_OUTBOUND,
        beforeData: {
          boxId: item.boxId,
          skuId: item.skuId,
          qty: beforeQty,
        },
        afterData: {
          boxId: item.boxId,
          skuId: item.skuId,
          qty: afterQty,
        },
        operatorId,
        requestId,
        remark: `adjust order ${order.adjustNo}`,
      });
    }

    await tx.inventoryAdjustOrder.update({
      where: { id: orderId },
      data: { status: OrderStatus.confirmed },
    });

    await this.auditService.create({
      db: tx,
      entityType: 'inventory_adjust_order',
      entityId: order.id,
      action: AuditAction.update,
      eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
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
  }

  private async resolveSkuForManual(
    tx: Prisma.TransactionClient,
    payload: ManualAdjustDto,
  ): Promise<{ id: bigint; sku: string }> {
    if (payload.skuId) {
      const sku = await tx.sku.findUnique({
        where: { id: BigInt(payload.skuId) },
        select: { id: true, sku: true },
      });
      if (!sku) throw new NotFoundException('sku not found');
      return sku;
    }

    const keyword = payload.keyword?.trim();
    if (!keyword) {
      throw new BadRequestException('skuId or keyword is required');
    }

    const matched = await tx.sku.findMany({
      where: {
        OR: [
          { sku: { contains: keyword } },
          { erpSku: { contains: keyword } },
          { asin: { contains: keyword } },
          { fnsku: { contains: keyword } },
        ],
      },
      select: { id: true, sku: true },
      take: 20,
    });
    if (matched.length === 0) {
      throw new NotFoundException('no sku matched');
    }
    if (matched.length > 1) {
      throw new UnprocessableEntityException('multiple skus matched, please choose skuId explicitly');
    }
    return matched[0];
  }

  private async resolveBoxForManual(
    tx: Prisma.TransactionClient,
    payload: ManualAdjustDto,
  ): Promise<{ id: bigint; boxCode: string }> {
    if (payload.boxId) {
      const box = await tx.box.findUnique({
        where: { id: BigInt(payload.boxId) },
        select: { id: true, boxCode: true },
      });
      if (!box) throw new NotFoundException('box not found');
      return box;
    }
    const boxCode = payload.boxCode?.trim();
    if (!boxCode) {
      throw new BadRequestException('boxId or boxCode is required');
    }
    const box = await tx.box.findUnique({
      where: { boxCode },
      select: { id: true, boxCode: true },
    });
    if (!box) throw new NotFoundException('box not found');
    return box;
  }

  private inventoryKey(boxId: bigint, skuId: bigint): string {
    return `${boxId.toString()}-${skuId.toString()}`;
  }
}
