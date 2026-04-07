import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, OrderStatus, Prisma } from '@prisma/client';
export interface AdjustOrderResult {
  orderId: string;
  status: OrderStatus;
  idempotent: boolean;
  changedRows?: number;
  adjustNo?: string;
}

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';

import { CreateAdjustOrderDto, CreateAdjustOrderItemDto } from './dto/create-adjust-order.dto';
import { ManualAdjustDto } from './dto/manual-adjust.dto';
import { MoveProductBetweenBoxesDto } from './dto/move-product-between-boxes.dto';
import { generateOrderNo, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import {
  findMasterProductBoxInventoryQty,
  upsertMasterProductBoxInventoryQty,
  buildMasterProductBoxInventoryWhereUnique,
  createInventoryAdjustOrderCreatedAudit,
  createInventoryAdjustOrderConfirmedAudit,
  createMasterProductInventoryAdjustAudit,
  createBoxInventoryAudit,
} from './inventory.service';


@Injectable()
export class InventoryAdjustService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly inventoryService: InventoryService,
  ) {}

  async createAdjustOrder(
    payload: CreateAdjustOrderDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const normalizedItems = payload.items.map((item) => this.normalizeAdjustItem(item));
    return this.prisma.$transaction(async (tx) => {
      await this.inventoryService.ensureReferences(tx, normalizedItems);

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

      await createInventoryAdjustOrderCreatedAudit({
        auditService: this.auditService,
        tx,
        entityId: order.id,
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



  async moveProductBetweenBoxes(
    payload: MoveProductBetweenBoxesDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ qty: number; oldBoxCode: string; newBoxCode: string; productId: string }> {
    const productId = String(payload.productId || '').trim();
    const fromBoxCode = String(payload.fromBoxCode || '').trim();
    const toBoxCode = String(payload.toBoxCode || '').trim();

    if (!productId) {
      throw new BadRequestException('productId不能为空');
    }
    if (!fromBoxCode || !toBoxCode) {
      throw new BadRequestException('原箱号和目标箱号不能为空');
    }
    if (fromBoxCode.toUpperCase() === toBoxCode.toUpperCase()) {
      throw new BadRequestException('目标箱号不能与原箱号相同');
    }

    return this.prisma.$transaction(async (tx) => {
      const [product, sourceBox, targetBox] = await Promise.all([
        tx.masterProduct.findUnique({
          where: { productId },
          select: {
            id: true,
            productId: true,
            productName: true,
            stockQty: true,
          },
        }),
        tx.box.findUnique({
          where: { boxCode: fromBoxCode },
          select: { id: true, boxCode: true },
        }),
        tx.box.findUnique({
          where: { boxCode: toBoxCode },
          select: { id: true, boxCode: true },
        }),
      ]);

      if (!product) throw new NotFoundException('主商品不存在');
      if (!sourceBox) throw new NotFoundException('原箱号不存在');
      if (!targetBox) throw new NotFoundException('目标箱号不存在');

      await this.inventoryService.ensureBoxesNotUnderActiveFba(tx, [sourceBox.id, targetBox.id], '移箱');

      const qty = await findMasterProductBoxInventoryQty(tx, sourceBox.id, product.productId);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new ConflictException('原箱号中没有可移动的主商品库存');
      }

      const targetQty = await findMasterProductBoxInventoryQty(tx, targetBox.id, product.productId);

      await tx.masterProductBoxInventory.delete({
        where: buildMasterProductBoxInventoryWhereUnique(sourceBox.id, product.productId),
      });

      await upsertMasterProductBoxInventoryQty(
        tx,
        targetBox.id,
        product.productId,
        targetQty + qty,
      );

      const totalQty = await this.inventoryService.recalculateMasterProductStockQty(tx, product.productId);

      await createMasterProductInventoryAdjustAudit({
        auditService: this.auditService,
        tx,
        entityId: product.id,
        beforeData: {
          scope: 'move_between_boxes',
          productId: product.productId,
          productName: product.productName,
          stockQty: Number(product.stockQty ?? 0),
          fromBoxCode: sourceBox.boxCode,
          toBoxCode: targetBox.boxCode,
        },
        afterData: {
          scope: 'move_between_boxes',
          productId: product.productId,
          productName: product.productName,
          stockQty: totalQty,
          fromBoxCode: sourceBox.boxCode,
          toBoxCode: targetBox.boxCode,
          qty,
        },
        operatorId,
        requestId,
        remark: 'move-product-between-boxes',
      });

      return {
        qty,
        oldBoxCode: sourceBox.boxCode,
        newBoxCode: targetBox.boxCode,
        productId: product.productId,
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
      throw new BadRequestException('调整数量不能为 0');
    }
    return {
      boxId: BigInt(item.boxId),
      skuId: BigInt(item.skuId),
      qtyDelta: item.qtyDelta,
      reason: item.reason,
    };
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
        throw new NotFoundException('调整单不存在');
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
        throw new UnprocessableEntityException('已作废的调整单不能确认');
      }
    }

    const order = await tx.inventoryAdjustOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('调整单不存在');
    if (order.items.length === 0) {
      throw new UnprocessableEntityException('调整单没有明细，无法确认');
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
      const key = this.inventoryService.inventoryKey(row.boxId, row.skuId);
      currentQtyMap.set(key, row.qty);
      existingInventoryKeys.add(key);
    });

    for (const item of order.items) {
      const key = this.inventoryService.inventoryKey(item.boxId, item.skuId);
      const beforeQty = currentQtyMap.get(key) ?? 0;
      const afterQty = beforeQty + item.qtyDelta;
      if (afterQty < 0) {
        throw new ConflictException(
          `库存不足，箱号ID ${item.boxId.toString()}、SKU ID ${item.skuId.toString()}`,
        );
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

      await createBoxInventoryAudit({
        auditService: this.auditService,
        tx,
        entityId: item.boxId,
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

    await createInventoryAdjustOrderConfirmedAudit({
      auditService: this.auditService,
      tx,
      entityId: order.id,
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

  async manualAdjust(payload: ManualAdjustDto,
  operatorId: bigint,
  requestId?: string,
): Promise<AdjustOrderResult & { adjustNo: string }> {
  return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const sku =
      payload.skuId || payload.keyword
        ? await this.inventoryService.resolveSkuForManual(tx, payload)
        : null;
    const productId =
      String(payload.productId || '').trim() ||
      (sku
        ? String(
            (
              await tx.sku.findUnique({
                where: { id: sku.id },
                select: { productId: true },
              })
            )?.productId || '',
          ).trim()
        : '');

    if (!productId) {
      throw new BadRequestException('请输入主商品ID');
    }

    const product = await tx.masterProduct.findUnique({
      where: { productId },
      select: {
        id: true,
        productId: true,
        productName: true,
        stockQty: true,
      },
    });
    if (!product) {
      throw new NotFoundException('主商品ID不存在');
    }

    const box = await this.inventoryService.resolveBoxForManual(tx, payload);
    const qtyDelta = Math.trunc(Number(payload.qtyDelta));
    if (!Number.isInteger(qtyDelta) || qtyDelta === 0) {
      throw new BadRequestException('调整数量不能为 0');
    }

    const beforeQty = await findMasterProductBoxInventoryQty(tx, box.id, productId);
    const afterQty = beforeQty + qtyDelta;
    if (afterQty < 0) {
      throw new ConflictException(`当前箱号内主商品库存不足，调整前库存为 ${beforeQty}`);
    }

    const adjustOrder = await tx.inventoryAdjustOrder.create({
      data: {
        adjustNo: generateOrderNo('ADJ'),
        status: OrderStatus.confirmed,
        remark: payload.reason ?? 'manual-adjust',
        createdBy: operatorId,
      },
    });

    if (sku) {
      await tx.inventoryAdjustOrderItem.create({
        data: {
          orderId: adjustOrder.id,
          boxId: box.id,
          skuId: sku.id,
          qtyDelta,
          reason: payload.reason ?? null,
        },
      });

      await tx.stockMovement.create({
        data: {
          movementType: 'adjust',
          refType: 'inventory_adjust_order',
          refId: adjustOrder.id,
          boxId: box.id,
          skuId: sku.id,
          qtyDelta,
          operatorId,
        },
      });
    }

    await upsertMasterProductBoxInventoryQty(tx, box.id, productId, afterQty);

    const totalQty = await this.inventoryService.recalculateMasterProductStockQty(tx, productId);

    await createInventoryAdjustOrderCreatedAudit({
      auditService: this.auditService,
      tx,
      entityId: adjustOrder.id,
      afterData: {
        adjustNo: adjustOrder.adjustNo,
        status: adjustOrder.status,
        productId,
        boxId: box.id.toString(),
        qtyDelta,
      },
      operatorId,
      requestId,
    });

    await createBoxInventoryAudit({
      auditService: this.auditService,
      tx,
      entityId: box.id,
      eventType:
        qtyDelta > 0 ? AuditEventType.BOX_STOCK_INCREASED : AuditEventType.BOX_STOCK_OUTBOUND,
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
      remark: payload.reason ?? 'manual-adjust',
    });

    await createMasterProductInventoryAdjustAudit({
      auditService: this.auditService,
      tx,
      entityId: product.id,
      beforeData: {
        productId,
        productName: product.productName,
        stockQty: Number(product.stockQty ?? 0),
      },
      afterData: {
        productId,
        productName: product.productName,
        stockQty: totalQty,
        boxCode: box.boxCode,
        qtyDelta,
      },
      operatorId,
      requestId,
      remark: payload.reason ?? 'manual-adjust',
    });

    return {
      orderId: adjustOrder.id.toString(),
      status: OrderStatus.confirmed,
      idempotent: false,
      changedRows: 1,
      adjustNo: adjustOrder.adjustNo,
    };
  });
}
}
