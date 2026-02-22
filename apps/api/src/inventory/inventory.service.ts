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
import { ConfirmFbaReplenishmentDto } from './dto/confirm-fba-replenishment.dto';
import { CreateFbaReplenishmentDto } from './dto/create-fba-replenishment.dto';
import { ManualAdjustDto } from './dto/manual-adjust.dto';
import { OutboundFbaReplenishmentDto } from './dto/outbound-fba-replenishment.dto';

interface AdjustOrderResult {
  orderId: string;
  status: OrderStatus;
  idempotent: boolean;
  changedRows: number;
}

const FBA_REPLENISH_MARK = 'FBA补货';

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

  async createFbaReplenishment(
    payload: CreateFbaReplenishmentDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const skuId = BigInt(payload.skuId);
    const boxCode = payload.boxCode.trim();
    const requestedQty = Number(payload.qty);
    const remark = payload.remark?.trim() || FBA_REPLENISH_MARK;

    if (!boxCode) throw new BadRequestException('箱号不能为空');
    if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
      throw new BadRequestException('申请数量必须是大于0的整数');
    }

    return this.prisma.$transaction(async (tx) => {
      const [sku, box] = await Promise.all([
        tx.sku.findUnique({
          where: { id: skuId },
          select: {
            id: true,
            sku: true,
            model: true,
            brand: true,
          },
        }),
        tx.box.findUnique({
          where: { boxCode },
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { shelfCode: true } },
          },
        }),
      ]);
      if (!sku) throw new NotFoundException('SKU不存在');
      if (!box) throw new NotFoundException('箱号不存在');

      const inventory = await tx.inventoryBoxSku.findUnique({
        where: {
          boxId_skuId: {
            boxId: box.id,
            skuId: sku.id,
          },
        },
        select: { qty: true },
      });
      if (!inventory || inventory.qty <= 0) {
        throw new ConflictException('当前箱号下该SKU无可用库存，无法创建FBA补货申请');
      }

      const existingActive = await tx.fbaReplenishment.findFirst({
        where: {
          skuId: sku.id,
          status: {
            in: ['pending_confirm', 'pending_outbound'],
          },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          requestNo: true,
          status: true,
          boxId: true,
          requestedQty: true,
          actualQty: true,
        },
      });
      if (existingActive) {
        if (existingActive.boxId !== box.id) {
          throw new ConflictException(
            '\u76f8\u540cSKU\u7684\u5df2\u7533\u8bf7FBA\u8865\u8d27\uff0c\u53ef\u4ee5\u5220\u9664\u8865\u8d27\u5355\uff0c\u6267\u884c\u5408\u7bb1\u64cd\u4f5c\u540e\u91cd\u65b0\u7533\u8bf7FBA\u8865\u8d27\u3002',
          );
        }
        const activeQty =
          existingActive.status === 'pending_outbound'
            ? (existingActive.actualQty ?? existingActive.requestedQty)
            : existingActive.requestedQty;
        let message = `本SKU已发起FBA申请${activeQty}件（申请单号：${existingActive.requestNo}），当前状态：${this.getFbaStatusLabel(existingActive.status)}。`;
        if (existingActive.status === 'pending_confirm') {
          message += '可先删除该申请后重新提交申请。';
        }
        throw new ConflictException(message);
      }

      if (requestedQty > inventory.qty) {
        throw new ConflictException(`申请数量不能大于当前库存（${inventory.qty}）`);
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
            select: { id: true, sku: true, model: true, brand: true },
          },
          box: {
            select: {
              id: true,
              boxCode: true,
              shelf: { select: { shelfCode: true } },
            },
          },
          creator: { select: { id: true, username: true } },
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
          model: created.sku.model,
          brand: created.sku.brand,
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

  async confirmFbaReplenishment(
    idParam: string,
    payload: ConfirmFbaReplenishmentDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'fbaReplenishmentId');
    const actualQty = Number(payload.actualQty);
    if (!Number.isInteger(actualQty) || actualQty <= 0) {
      throw new BadRequestException('实际数量必须是大于0的整数');
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fbaReplenishment.findUnique({
        where: { id },
        include: {
          sku: { select: { id: true, sku: true, model: true, brand: true } },
          box: {
            select: {
              id: true,
              boxCode: true,
              shelf: { select: { shelfCode: true } },
            },
          },
        },
      });
      if (!row) throw new NotFoundException('FBA补货申请不存在');
      if (row.status === 'outbound') {
        throw new UnprocessableEntityException('已出库申请不可再次确认');
      }
      if (String(row.status) === 'deleted') {
        throw new UnprocessableEntityException('已删除申请不可再次确认');
      }

      const inventory = await tx.inventoryBoxSku.findUnique({
        where: {
          boxId_skuId: {
            boxId: row.box.id,
            skuId: row.sku.id,
          },
        },
        select: { qty: true },
      });
      const maxQty = Number(inventory?.qty ?? 0);
      if (actualQty > maxQty) {
        throw new ConflictException(`实际数量不能大于当前箱号里该SKU的最大数量（${maxQty}）`);
      }

      const updated = await tx.fbaReplenishment.update({
        where: { id: row.id },
        data: {
          status: 'pending_outbound',
          actualQty,
          confirmedBy: operatorId,
          confirmedAt: new Date(),
        },
        include: {
          sku: { select: { id: true, sku: true, model: true, brand: true } },
          box: {
            select: {
              id: true,
              boxCode: true,
              shelf: { select: { shelfCode: true } },
            },
          },
          creator: { select: { id: true, username: true } },
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'fba_replenishment',
        entityId: updated.id,
        action: AuditAction.update,
        eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
        beforeData: {
          status: row.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
        },
        afterData: {
          status: updated.status,
          requestedQty: updated.requestedQty,
          actualQty: updated.actualQty,
        },
        operatorId,
        requestId,
      });

      return {
        id: updated.id.toString(),
        requestNo: updated.requestNo,
        status: updated.status,
        sku: {
          id: updated.sku.id.toString(),
          sku: updated.sku.sku,
          model: updated.sku.model,
          brand: updated.sku.brand,
        },
        box: {
          id: updated.box.id.toString(),
          boxCode: updated.box.boxCode,
          shelfCode: updated.box.shelf?.shelfCode ?? null,
        },
        requestedQty: updated.requestedQty,
        actualQty: updated.actualQty,
        expressNo: updated.expressNo,
        remark: updated.remark,
        creator: updated.creator
          ? {
              id: updated.creator.id.toString(),
              username: updated.creator.username,
            }
          : null,
        createdAt: updated.createdAt,
      };
    });
  }

  async outboundFbaReplenishments(
    payload: OutboundFbaReplenishmentDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ updatedCount: number; expressNo: string }> {
    const ids = Array.from(new Set((payload.ids || []).map((id) => BigInt(id))));
    const expressNo = payload.expressNo.trim();
    if (!ids.length) throw new BadRequestException('请至少选择一条申请单');
    if (!expressNo) throw new BadRequestException('快递号不能为空');

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.fbaReplenishment.findMany({
        where: { id: { in: ids } },
        orderBy: { id: 'asc' },
      });
      if (rows.length !== ids.length) {
        throw new NotFoundException('存在不存在的FBA补货申请');
      }

      const invalid = rows.find((row) => row.status !== 'pending_outbound');
      if (invalid) {
        throw new ConflictException(`申请单 ${invalid.requestNo} 当前状态不可出库`);
      }

      const requiredMap = new Map<string, { boxId: bigint; skuId: bigint; qty: number }>();
      rows.forEach((row) => {
        const qty = Number(row.actualQty ?? row.requestedQty);
        const key = `${row.boxId.toString()}-${row.skuId.toString()}`;
        const prev = requiredMap.get(key);
        if (prev) {
          prev.qty += qty;
        } else {
          requiredMap.set(key, {
            boxId: row.boxId,
            skuId: row.skuId,
            qty,
          });
        }
      });

      const requiredRows = Array.from(requiredMap.values());
      const inventoryRows = await tx.inventoryBoxSku.findMany({
        where: {
          OR: requiredRows.map((row) => ({
            boxId: row.boxId,
            skuId: row.skuId,
          })),
        },
      });
      const inventoryMap = new Map(
        inventoryRows.map((row) => [`${row.boxId.toString()}-${row.skuId.toString()}`, row]),
      );

      for (const reqRow of requiredRows) {
        const key = `${reqRow.boxId.toString()}-${reqRow.skuId.toString()}`;
        const inventory = inventoryMap.get(key);
        const currentQty = Number(inventory?.qty ?? 0);
        if (currentQty < reqRow.qty) {
          throw new ConflictException(`库存不足：箱号ID ${reqRow.boxId.toString()}，SKU ID ${reqRow.skuId.toString()}`);
        }
      }

      for (const reqRow of requiredRows) {
        const key = `${reqRow.boxId.toString()}-${reqRow.skuId.toString()}`;
        const inventory = inventoryMap.get(key)!;
        await tx.inventoryBoxSku.update({
          where: {
            boxId_skuId: {
              boxId: reqRow.boxId,
              skuId: reqRow.skuId,
            },
          },
          data: {
            qty: inventory.qty - reqRow.qty,
          },
        });
      }

      const outboundAt = new Date();
      for (const row of rows) {
        const qtyDelta = -(Number(row.actualQty ?? row.requestedQty));
        await tx.stockMovement.create({
          data: {
            movementType: 'adjust',
            refType: 'fba_replenishment',
            refId: row.id,
            boxId: row.boxId,
            skuId: row.skuId,
            qtyDelta,
            operatorId,
          },
        });

        await this.auditService.create({
          db: tx,
          entityType: 'box',
          entityId: row.boxId,
          action: AuditAction.update,
          eventType: AuditEventType.BOX_STOCK_OUTBOUND,
          beforeData: null,
          afterData: {
            skuId: row.skuId.toString(),
            qtyDelta,
            by: 'fba_replenishment',
            requestNo: row.requestNo,
          },
          operatorId,
          requestId,
          remark: `fba outbound ${row.requestNo}`,
        });

        await this.auditService.create({
          db: tx,
          entityType: 'fba_replenishment',
          entityId: row.id,
          action: AuditAction.update,
          eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
          beforeData: {
            status: row.status,
            actualQty: row.actualQty,
            expressNo: row.expressNo,
          },
          afterData: {
            status: 'outbound',
            actualQty: row.actualQty,
            expressNo,
          },
          operatorId,
          requestId,
        });
      }

      await tx.fbaReplenishment.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'outbound',
          outboundBy: operatorId,
          outboundAt,
          expressNo,
        },
      });

      return {
        updatedCount: rows.length,
        expressNo,
      };
    });
  }

  async deleteFbaReplenishment(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: string; requestNo: string; status: string; idempotent: boolean }> {
    const id = parseId(idParam, 'fbaReplenishmentId');

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fbaReplenishment.findUnique({
        where: { id },
        select: {
          id: true,
          requestNo: true,
          status: true,
          requestedQty: true,
          actualQty: true,
          expressNo: true,
        },
      });
      if (!row) {
        throw new NotFoundException('FBA补货申请不存在');
      }

      if (String(row.status) === 'deleted') {
        return {
          id: row.id.toString(),
          requestNo: row.requestNo,
          status: String(row.status),
          idempotent: true,
        };
      }

      const deletedAt = new Date();
      const updated = await tx.fbaReplenishment.update({
        where: { id: row.id },
        data: {
          status: 'deleted' as any,
          deletedBy: operatorId,
          deletedAt,
        },
        select: {
          id: true,
          requestNo: true,
          status: true,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'fba_replenishment',
        entityId: row.id,
        action: AuditAction.delete,
        eventType: AuditEventType.INVENTORY_ADJUST_VOIDED,
        beforeData: {
          status: row.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
        },
        afterData: {
          status: updated.status,
          deletedAt,
        },
        operatorId,
        requestId,
      });

      return {
        id: updated.id.toString(),
        requestNo: updated.requestNo,
        status: updated.status,
        idempotent: false,
      };
    });
  }

  async reopenFbaReplenishment(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: string; requestNo: string; status: string; idempotent: boolean }> {
    const id = parseId(idParam, 'fbaReplenishmentId');

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fbaReplenishment.findUnique({
        where: { id },
        select: {
          id: true,
          requestNo: true,
          status: true,
          requestedQty: true,
          actualQty: true,
          expressNo: true,
          confirmedBy: true,
          confirmedAt: true,
        },
      });

      if (!row) {
        throw new NotFoundException('FBA补货申请不存在');
      }
      if (String(row.status) === 'deleted') {
        throw new UnprocessableEntityException(
          '\u5df2\u5220\u9664\u7684FBA\u8865\u8d27\u7533\u8bf7\u5355\u4e0d\u80fd\u53d8\u66f4',
        );
      }
      if (String(row.status) === 'outbound') {
        throw new UnprocessableEntityException(
          '\u5df2\u51fa\u5e93\u7684FBA\u8865\u8d27\u7533\u8bf7\u5355\u4e0d\u80fd\u53d8\u66f4',
        );
      }
      if (String(row.status) === 'pending_confirm') {
        return {
          id: row.id.toString(),
          requestNo: row.requestNo,
          status: String(row.status),
          idempotent: true,
        };
      }
      if (String(row.status) !== 'pending_outbound') {
        throw new ConflictException(
          `\u7533\u8bf7\u5355 ${row.requestNo} \u5f53\u524d\u72b6\u6001\u4e0d\u652f\u6301\u53d8\u66f4`,
        );
      }

      const updated = await tx.fbaReplenishment.update({
        where: { id: row.id },
        data: {
          status: 'pending_confirm',
          confirmedBy: null,
          confirmedAt: null,
        },
        select: {
          id: true,
          requestNo: true,
          status: true,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'fba_replenishment',
        entityId: row.id,
        action: AuditAction.update,
        eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
        beforeData: {
          status: row.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
          confirmedBy: row.confirmedBy?.toString() ?? null,
          confirmedAt: row.confirmedAt,
        },
        afterData: {
          status: updated.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
          confirmedBy: null,
          confirmedAt: null,
        },
        operatorId,
        requestId,
      });

      return {
        id: updated.id.toString(),
        requestNo: updated.requestNo,
        status: updated.status,
        idempotent: false,
      };
    });
  }

  async listFbaReplenishments(): Promise<unknown[]> {
    const rows = await this.prisma.fbaReplenishment.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        sku: {
          select: {
            id: true,
            sku: true,
            model: true,
            brand: true,
          },
        },
        box: {
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { id: true, shelfCode: true } },
          },
        },
      },
    });

    return rows.map((row) => {
      return {
        id: row.id.toString(),
        requestNo: row.requestNo,
        status: row.status,
        createdAt: row.createdAt,
        creator: row.creator
          ? {
              id: row.creator.id.toString(),
              username: row.creator.username,
            }
          : null,
        sku: row.sku
          ? {
              id: row.sku.id.toString(),
              sku: row.sku.sku,
              model: row.sku.model,
              brand: row.sku.brand,
            }
          : null,
        box: row.box
          ? {
              id: row.box.id.toString(),
              boxCode: row.box.boxCode,
              shelfCode: row.box.shelf?.shelfCode ?? null,
            }
          : null,
        requestedQty: row.requestedQty,
        actualQty: row.actualQty,
        expressNo: row.expressNo,
      };
    });
  }

  async getFbaPendingSummary(): Promise<{
    pendingConfirmCount: number;
    pendingBySku: Record<string, number>;
    pendingByBoxSku: Record<string, number>;
  }> {
    const pendingConfirmCount = await this.prisma.fbaReplenishment.count({
      where: {
        status: { in: ['pending_confirm', 'pending_outbound'] },
      },
    });

    const pendingRows = await this.prisma.fbaReplenishment.findMany({
      where: {
        status: { in: ['pending_confirm', 'pending_outbound'] },
      },
      select: {
        skuId: true,
        boxId: true,
        status: true,
        requestedQty: true,
        actualQty: true,
      },
    });

    const pendingBySku: Record<string, number> = {};
    const pendingByBoxSku: Record<string, number> = {};

    pendingRows.forEach((row) => {
      const qty = Number(
        row.status === 'pending_outbound'
          ? (row.actualQty ?? row.requestedQty)
          : row.requestedQty,
      );
      if (qty <= 0) return;

      const skuKey = row.skuId.toString();
      pendingBySku[skuKey] = (pendingBySku[skuKey] ?? 0) + qty;

      const boxSkuKey = `${row.boxId.toString()}-${skuKey}`;
      pendingByBoxSku[boxSkuKey] = (pendingByBoxSku[boxSkuKey] ?? 0) + qty;
    });

    return {
      pendingConfirmCount,
      pendingBySku,
      pendingByBoxSku,
    };
  }

  private formatFbaRequestNo(date: Date): string {
    const pad = (num: number) => String(num).padStart(2, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const mi = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `FBA-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
  }

  private async generateFbaRequestNo(tx: Prisma.TransactionClient): Promise<string> {
    let candidate = new Date();
    for (let i = 0; i < 5; i += 1) {
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
    throw new ConflictException('申请单号重复，请稍后重试');
  }

  private getFbaStatusLabel(status: string): string {
    if (status === 'pending_confirm') return '待确认';
    if (status === 'pending_outbound') return '待出库';
    if (status === 'outbound') return '已出库';
    if (status === 'deleted') return '已删除';
    return status;
  }

  private normalizeAdjustItem(item: CreateAdjustOrderItemDto): {
    boxId: bigint;
    skuId: bigint;
    qtyDelta: number;
    reason?: string;
  } {
    if (item.qtyDelta === 0) {
      throw new BadRequestException('调整数量不能为0');
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
      throw new NotFoundException('调整明细中存在不存在的箱号');
    }
    if (skus.length !== uniqueSkuIds.length) {
      throw new NotFoundException('调整明细中存在不存在的SKU');
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
        throw new UnprocessableEntityException('已作废调整单不能确认');
      }
    }

    const order = await tx.inventoryAdjustOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('调整单不存在');
    if (order.items.length === 0) {
      throw new UnprocessableEntityException('调整单没有明细');
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
        throw new ConflictException(
          `库存不足：箱号ID ${item.boxId.toString()}，SKU ID ${item.skuId.toString()}`,
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
      if (!sku) throw new NotFoundException('SKU不存在');
      return sku;
    }

    const keyword = payload.keyword?.trim();
    if (!keyword) {
      throw new BadRequestException('skuId或关键字不能为空');
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
      throw new NotFoundException('未找到匹配的SKU');
    }
    if (matched.length > 1) {
      throw new UnprocessableEntityException('匹配到多个SKU，请明确选择skuId');
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
      if (!box) throw new NotFoundException('箱号不存在');
      return box;
    }
    const boxCode = payload.boxCode?.trim();
    if (!boxCode) {
      throw new BadRequestException('boxId或箱号不能为空');
    }
    const box = await tx.box.findUnique({
      where: { boxCode },
      select: { id: true, boxCode: true },
    });
    if (!box) throw new NotFoundException('箱号不存在');
    return box;
  }

  private inventoryKey(boxId: bigint, skuId: bigint): string {
    return `${boxId.toString()}-${skuId.toString()}`;
  }
}
