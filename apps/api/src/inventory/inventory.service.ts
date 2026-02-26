import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { readFile } from 'fs/promises';
import { AuditAction, BatchInboundOrderStatus, OrderStatus, Prisma, ProductEditRequestStatus } from '@prisma/client';
import * as iconv from 'iconv-lite';
import { join } from 'path';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { APP_TIMEZONE, generateOrderNo, getZonedDateParts, parseId } from '../common/utils';
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

interface BulkInventoryUpdateRow {
  boxCode: string;
  sku: string;
  qty: number;
}

const FBA_REPLENISH_MARK = 'FBA补货';
const SKU_EDIT_PENDING_BLOCK_MESSAGE = '正在编辑产品申请中，请管理员确认后再执行相关操作。';
const STOCK_ADJUSTMENT_WAREHOUSE_ID = '64774';
const INVENTORY_BULK_UPDATE_TEMPLATE_FILE = '批量更新库存.xlsx';
const BULK_UPDATE_DEFAULT_SHELF_CODE = '00';
const BULK_UPDATE_DEFAULT_SHELF_NAME = '\u9ed8\u8ba4\u8d27\u67b6';
const LOW_COVERAGE_DAYS = 14;
const OUT_OF_STOCK_DAYS = 7;
const PRODUCTION_TARGET_DAYS = 45;
const ANOMALY_MIN_7D_QTY = 20;
const ANOMALY_RATIO = 2;

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async searchSkus(keyword?: string, page = 1, pageSize = 10): Promise<unknown[]> {
    if (!keyword?.trim()) return [];
    const key = keyword.trim();
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safePageSizeRaw = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 10;
    const safePageSize = Math.min(50, safePageSizeRaw);
    const offset = (safePage - 1) * safePageSize;

    const skuExactWhere: Prisma.SkuWhereInput = { sku: { equals: key } };
    const skuExactExists = await this.prisma.sku.findFirst({
      where: skuExactWhere,
      select: { id: true },
    });
    if (skuExactExists) {
      return await this.prisma.sku.findMany({
        where: skuExactWhere,
        skip: offset,
        take: safePageSize,
        orderBy: { id: 'desc' },
      });
    }

    const otherExactWhere: Prisma.SkuWhereInput = {
      OR: [{ asin: { equals: key } }, { fnsku: { equals: key } }, { fbmSku: { equals: key } }, { rbSku: { equals: key } }],
    };
    const otherExactExists = await this.prisma.sku.findFirst({
      where: otherExactWhere,
      select: { id: true },
    });
    if (otherExactExists) {
      return await this.prisma.sku.findMany({
        where: otherExactWhere,
        skip: offset,
        take: safePageSize,
        orderBy: { id: 'desc' },
      });
    }

    return await this.prisma.sku.findMany({
      where: {
        model: { contains: key },
      },
      skip: offset,
      take: safePageSize,
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
            rbSku: true,
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
      await this.ensureSkusNotUnderPendingEdit(tx, [row.sku.id]);

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
      await this.ensureSkusNotUnderPendingEdit(
        tx,
        Array.from(new Set(rows.map((row) => row.skuId.toString()))).map((id) => BigInt(id)),
      );

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
            fnsku: true,
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
              fnsku: row.sku.fnsku,
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

  async getSkuInventoryTotals(): Promise<Record<string, number>> {
    const rows = await this.prisma.inventoryBoxSku.groupBy({
      by: ['skuId'],
      _sum: {
        qty: true,
      },
    });

    const totals: Record<string, number> = {};
    rows.forEach((row) => {
      totals[row.skuId.toString()] = Number(row._sum.qty ?? 0);
    });
    return totals;
  }

  async getOverviewDashboard(): Promise<unknown> {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const from7d = new Date(now.getTime() - 7 * dayMs);
    const from14d = new Date(now.getTime() - 14 * dayMs);
    const from30d = new Date(now.getTime() - 30 * dayMs);
    const from90d = new Date(now.getTime() - 90 * dayMs);
    const from270d = new Date(now.getTime() - 270 * dayMs);

    const outboundWhereBase: Prisma.StockMovementWhereInput = {
      qtyDelta: { lt: 0 },
      OR: [{ refType: 'fba_replenishment' }, { movementType: 'outbound' }],
    };

    const [
      activeSkus,
      inventoryRows,
      pendingRows,
      inTransitRows,
      outbound30Rows,
      outbound14Rows,
      outbound7Rows,
      outbound90Rows,
      outbound270Rows,
      activeBoxes,
      inventoryByBoxRows,
    ] = await Promise.all([
      this.prisma.sku.findMany({
        where: { status: 1 },
        select: {
          id: true,
          sku: true,
          model: true,
          rbSku: true,
        },
      }),
      this.prisma.inventoryBoxSku.groupBy({
        by: ['skuId'],
        _sum: { qty: true },
      }),
      this.prisma.fbaReplenishment.findMany({
        where: {
          status: { in: ['pending_confirm', 'pending_outbound'] },
        },
        select: {
          skuId: true,
          status: true,
          requestedQty: true,
          actualQty: true,
        },
      }),
      this.prisma.batchInboundItem.groupBy({
        by: ['skuCode'],
        where: {
          status: 'pending',
          order: {
            status: BatchInboundOrderStatus.waiting_inbound,
          },
        },
        _sum: { qty: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['skuId'],
        where: {
          ...outboundWhereBase,
          createdAt: { gte: from30d },
        },
        _sum: { qtyDelta: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['skuId'],
        where: {
          ...outboundWhereBase,
          createdAt: { gte: from14d },
        },
        _sum: { qtyDelta: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['skuId'],
        where: {
          ...outboundWhereBase,
          createdAt: { gte: from7d },
        },
        _sum: { qtyDelta: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['skuId'],
        where: {
          ...outboundWhereBase,
          createdAt: { gte: from90d },
        },
        _sum: { qtyDelta: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['skuId'],
        where: {
          ...outboundWhereBase,
          createdAt: { gte: from270d },
        },
        _sum: { qtyDelta: true },
      }),
      this.prisma.box.findMany({
        where: {
          status: 1,
          shelf: {
            status: 1,
          },
        },
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
      this.prisma.inventoryBoxSku.groupBy({
        by: ['boxId'],
        _sum: { qty: true },
      }),
    ]);

    const skuById = new Map(
      activeSkus.map((item) => [item.id.toString(), item]),
    );
    const skuIdByCode = new Map(
      activeSkus.map((item) => [String(item.sku || '').trim(), item.id.toString()]),
    );

    const inventoryBySku = new Map<string, number>();
    inventoryRows.forEach((row) => {
      inventoryBySku.set(row.skuId.toString(), Number(row._sum.qty ?? 0));
    });

    const lockedBySku = new Map<string, number>();
    pendingRows.forEach((row) => {
      const qty = Number(
        row.status === 'pending_outbound'
          ? (row.actualQty ?? row.requestedQty)
          : row.requestedQty,
      );
      if (qty <= 0) return;
      const key = row.skuId.toString();
      lockedBySku.set(key, (lockedBySku.get(key) ?? 0) + qty);
    });

    const inTransitBySku = new Map<string, number>();
    inTransitRows.forEach((row) => {
      const skuCode = String(row.skuCode || '').trim();
      const skuId = skuIdByCode.get(skuCode);
      if (!skuId) return;
      const qty = Number(row._sum.qty ?? 0);
      if (qty <= 0) return;
      inTransitBySku.set(skuId, (inTransitBySku.get(skuId) ?? 0) + qty);
    });

    const toOutboundMap = (rows: Array<{ skuId: bigint; _sum: { qtyDelta: number | null } }>) => {
      const map = new Map<string, number>();
      rows.forEach((row) => {
        const qty = Math.max(0, -Number(row._sum.qtyDelta ?? 0));
        if (qty <= 0) return;
        map.set(row.skuId.toString(), qty);
      });
      return map;
    };

    const outbound30BySku = toOutboundMap(outbound30Rows);
    const outbound14BySku = toOutboundMap(outbound14Rows);
    const outbound7BySku = toOutboundMap(outbound7Rows);
    const outbound90BySku = toOutboundMap(outbound90Rows);
    const outbound270BySku = toOutboundMap(outbound270Rows);

    const inventoryByBox = new Map<string, number>();
    inventoryByBoxRows.forEach((row) => {
      inventoryByBox.set(row.boxId.toString(), Number(row._sum.qty ?? 0));
    });

    let totalStock = 0;
    let availableStock = 0;
    let lockedStock = 0;
    let inTransitStock = 0;
    let outOfStockSkuCount = 0;
    let lowCoverageSkuCount = 0;

    const recommendations: Array<{
      skuId: string;
      sku: string;
      model: string | null;
      rbSku: string | null;
      availableStock: number;
      lockedStock: number;
      inTransitStock: number;
      avgDailyOutbound: number;
      coverageDays: number;
      targetStock: number;
      suggestedProductionQty: number;
      priority: string;
    }> = [];
    const noSales90dSkus: Array<{
      skuId: string;
      sku: string;
      model: string | null;
      rbSku: string | null;
      totalStock: number;
      availableStock: number;
      inTransitStock: number;
    }> = [];
    const noSales270dSkus: Array<{
      skuId: string;
      sku: string;
      model: string | null;
      rbSku: string | null;
      totalStock: number;
      availableStock: number;
      inTransitStock: number;
    }> = [];

    activeSkus.forEach((sku) => {
      const skuId = sku.id.toString();
      const stock = inventoryBySku.get(skuId) ?? 0;
      const locked = lockedBySku.get(skuId) ?? 0;
      const available = stock - locked;
      const inTransit = inTransitBySku.get(skuId) ?? 0;
      const outbound30 = outbound30BySku.get(skuId) ?? 0;
      const avgDailyOutbound = outbound30 / 30;
      const coverageDays = avgDailyOutbound > 0 ? available / avgDailyOutbound : Number.POSITIVE_INFINITY;

      totalStock += stock;
      availableStock += available;
      lockedStock += locked;
      inTransitStock += inTransit;

      if (available <= 0) {
        outOfStockSkuCount += 1;
      }
      if (avgDailyOutbound > 0 && coverageDays < LOW_COVERAGE_DAYS) {
        lowCoverageSkuCount += 1;
      }

      if (stock > 0) {
        if (!(outbound90BySku.get(skuId) ?? 0)) {
          noSales90dSkus.push({
            skuId,
            sku: sku.sku,
            model: sku.model,
            rbSku: sku.rbSku,
            totalStock: stock,
            availableStock: available,
            inTransitStock: inTransit,
          });
        }
        if (!(outbound270BySku.get(skuId) ?? 0)) {
          noSales270dSkus.push({
            skuId,
            sku: sku.sku,
            model: sku.model,
            rbSku: sku.rbSku,
            totalStock: stock,
            availableStock: available,
            inTransitStock: inTransit,
          });
        }
      }

      if (avgDailyOutbound <= 0) {
        return;
      }

      const targetStock = Math.ceil(avgDailyOutbound * PRODUCTION_TARGET_DAYS);
      const suggestedProductionQty = Math.max(0, targetStock - (available + inTransit));

      if (suggestedProductionQty <= 0 && coverageDays >= LOW_COVERAGE_DAYS) {
        return;
      }

      let priority = '中';
      if (coverageDays < OUT_OF_STOCK_DAYS || available <= 0) {
        priority = '紧急';
      } else if (coverageDays < LOW_COVERAGE_DAYS) {
        priority = '高';
      }

      recommendations.push({
        skuId,
        sku: sku.sku,
        model: sku.model,
        rbSku: sku.rbSku,
        availableStock: available,
        lockedStock: locked,
        inTransitStock: inTransit,
        avgDailyOutbound,
        coverageDays,
        targetStock,
        suggestedProductionQty,
        priority,
      });
    });

    const priorityWeight: Record<string, number> = { 紧急: 3, 高: 2, 中: 1 };
    recommendations.sort((a, b) => {
      const p = (priorityWeight[b.priority] ?? 0) - (priorityWeight[a.priority] ?? 0);
      if (p !== 0) return p;
      const s = b.suggestedProductionQty - a.suggestedProductionQty;
      if (s !== 0) return s;
      return b.avgDailyOutbound - a.avgDailyOutbound;
    });

    const sortByStockDesc = <T extends { totalStock: number; availableStock: number; sku: string }>(rows: T[]) => {
      rows.sort((a, b) => {
        if (b.totalStock !== a.totalStock) return b.totalStock - a.totalStock;
        if (b.availableStock !== a.availableStock) return b.availableStock - a.availableStock;
        return String(a.sku || '').localeCompare(String(b.sku || ''), 'en', { numeric: true });
      });
    };
    sortByStockDesc(noSales90dSkus);
    sortByStockDesc(noSales270dSkus);

    const emptyBoxes = activeBoxes
      .map((box) => ({
        boxId: box.id.toString(),
        boxCode: box.boxCode,
        shelfCode: box.shelf?.shelfCode ?? null,
        totalStock: inventoryByBox.get(box.id.toString()) ?? 0,
      }))
      .filter((box) => box.totalStock <= 0)
      .sort((a, b) =>
        String(a.boxCode || '').localeCompare(String(b.boxCode || ''), 'en', { numeric: true }),
      );

    const topSkus = Array.from(outbound30BySku.entries())
      .map(([skuId, qty30d]) => {
        const sku = skuById.get(skuId);
        return {
          skuId,
          sku: sku?.sku ?? skuId,
          model: sku?.model ?? null,
          rbSku: sku?.rbSku ?? null,
          qty30d,
          avgDailyOutbound: qty30d / 30,
        };
      })
      .sort((a, b) => b.qty30d - a.qty30d)
      .slice(0, 10);

    const anomalySkus = Array.from(outbound7BySku.entries())
      .map(([skuId, qty7d]) => {
        const qty14d = outbound14BySku.get(skuId) ?? qty7d;
        const prev7d = Math.max(0, qty14d - qty7d);
        const ratio = prev7d > 0 ? qty7d / prev7d : null;
        const delta = qty7d - prev7d;
        return { skuId, qty7d, prev7d, ratio, delta };
      })
      .filter((item) => item.qty7d >= ANOMALY_MIN_7D_QTY)
      .filter((item) => item.prev7d === 0 || (item.ratio ?? 0) >= ANOMALY_RATIO)
      .map((item) => {
        const sku = skuById.get(item.skuId);
        return {
          skuId: item.skuId,
          sku: sku?.sku ?? item.skuId,
          model: sku?.model ?? null,
          rbSku: sku?.rbSku ?? null,
          qty7d: item.qty7d,
          prev7d: item.prev7d,
          ratio: item.ratio,
          delta: item.delta,
        };
      })
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 10);

    const outboundQty30d = Array.from(outbound30BySku.values()).reduce((sum, qty) => sum + qty, 0);
    const outboundQty14d = Array.from(outbound14BySku.values()).reduce((sum, qty) => sum + qty, 0);
    const outboundQty7d = Array.from(outbound7BySku.values()).reduce((sum, qty) => sum + qty, 0);
    const avgDailyOutbound = outboundQty30d / 30;
    const coverageDays = avgDailyOutbound > 0 ? availableStock / avgDailyOutbound : null;

    const urgentCount = recommendations.filter((item) => item.priority === '紧急').length;
    const highCount = recommendations.filter((item) => item.priority === '高').length;
    const mediumCount = recommendations.filter((item) => item.priority === '中').length;

    return {
      generatedAt: now.toISOString(),
      health: {
        totalStock,
        availableStock,
        lockedStock,
        inTransitStock,
        outOfStockSkuCount,
        lowCoverageSkuCount,
        coverageDays,
        avgDailyOutbound,
      },
      demand: {
        outboundQty7d,
        outboundQty14d,
        outboundQty30d,
        avgDailyOutbound,
        topSkus,
        anomalySkus,
      },
      production: {
        targetDays: PRODUCTION_TARGET_DAYS,
        recommendationCount: recommendations.length,
        urgentCount,
        highCount,
        mediumCount,
        recommendations: recommendations.slice(0, 50),
      },
      obsolete: {
        noSales90dCount: noSales90dSkus.length,
        noSales270dCount: noSales270dSkus.length,
        noSales90dSkus: noSales90dSkus.slice(0, 100),
        noSales270dSkus: noSales270dSkus.slice(0, 100),
        emptyBoxCount: emptyBoxes.length,
        emptyBoxes: emptyBoxes.slice(0, 200),
      },
    };
  }

  async getBulkUpdateTemplate(): Promise<{ fileName: string; content: Buffer }> {
    const cwd = process.cwd();
    const candidates = [
      join(cwd, 'docs', INVENTORY_BULK_UPDATE_TEMPLATE_FILE),
      join(cwd, '..', '..', 'docs', INVENTORY_BULK_UPDATE_TEMPLATE_FILE),
    ];

    for (const templatePath of candidates) {
      try {
        const content = await readFile(templatePath);
        return {
          fileName: INVENTORY_BULK_UPDATE_TEMPLATE_FILE,
          content,
        };
      } catch {
        // try next candidate
      }
    }

    throw new NotFoundException(`模板文件不存在：${INVENTORY_BULK_UPDATE_TEMPLATE_FILE}`);
  }

  async importBulkUpdateExcel(
    fileBuffer: Buffer,
    originalName: string | undefined,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{
    totalRows: number;
    changedSkuCount: number;
    changedItemCount: number;
    changedRows: number;
    fileName: string | null;
    adjustNo: string | null;
  }> {
    const rows = this.parseBulkInventoryUpdateRows(fileBuffer);
    const skuCodes = Array.from(new Set(rows.map((row) => row.sku)));
    const boxCodes = Array.from(new Set(rows.map((row) => row.boxCode)));

    return this.prisma.$transaction(async (tx) => {
      const [skus, boxes] = await Promise.all([
        tx.sku.findMany({
          where: {
            sku: { in: skuCodes },
          },
          select: {
            id: true,
            sku: true,
          },
        }),
        tx.box.findMany({
          where: {
            boxCode: { in: boxCodes },
          },
          select: {
            id: true,
            boxCode: true,
            status: true,
            shelf: {
              select: {
                status: true,
              },
            },
          },
        }),
      ]);

      const skuByCode = new Map(skus.map((item) => [item.sku, item]));
      const missingSkuCodes = skuCodes.filter((skuCode) => !skuByCode.has(skuCode));
      if (missingSkuCodes.length > 0) {
        const preview = missingSkuCodes.slice(0, 20).join('、');
        const suffix = missingSkuCodes.length > 20 ? ' 等' : '';
        throw new UnprocessableEntityException(`以下SKU不存在：${preview}${suffix}`);
      }

      const boxByCode = new Map<
        string,
        {
          id: bigint;
          boxCode: string;
          status: number;
          shelf: { status: number } | null;
        }
      >(boxes.map((item) => [item.boxCode, item]));
      const missingBoxCodes = boxCodes.filter((boxCode) => !boxByCode.has(boxCode));
      if (missingBoxCodes.length > 0) {
        const defaultShelf = await this.resolveOrCreateBulkUpdateDefaultShelf(
          tx,
          operatorId,
          requestId,
        );
        for (const boxCode of missingBoxCodes) {
          const resolvedBox = await this.resolveOrCreateBulkUpdateBox(
            tx,
            boxCode,
            defaultShelf.id,
            operatorId,
            requestId,
          );
          const mappedBox = {
            id: resolvedBox.id,
            boxCode: resolvedBox.boxCode,
            status: resolvedBox.status,
            shelf: { status: resolvedBox.shelfStatus },
          };
          boxByCode.set(boxCode, mappedBox);
          boxByCode.set(resolvedBox.boxCode, mappedBox);
        }
      }

      const disabledBoxCodes = Array.from(boxByCode.values())
        .filter((item) => Number(item.status) !== 1 || Number(item.shelf?.status ?? 0) !== 1)
        .map((item) => item.boxCode);
      if (disabledBoxCodes.length > 0) {
        const preview = disabledBoxCodes.slice(0, 20).join('、');
        const suffix = disabledBoxCodes.length > 20 ? ' 等' : '';
        throw new UnprocessableEntityException(`以下箱号未启用，不能更新库存：${preview}${suffix}`);
      }

      const targets = rows.map((row) => {
        const sku = skuByCode.get(row.sku);
        const box = boxByCode.get(row.boxCode);
        if (!sku || !box) {
          throw new UnprocessableEntityException('批量更新库存数据无效');
        }
        return {
          skuId: sku.id,
          skuCode: sku.sku,
          boxId: box.id,
          boxCode: box.boxCode,
          qty: row.qty,
        };
      });

      const inventoryRows = targets.length
        ? await tx.inventoryBoxSku.findMany({
            where: {
              OR: targets.map((target) => ({
                boxId: target.boxId,
                skuId: target.skuId,
              })),
            },
            select: {
              boxId: true,
              skuId: true,
              qty: true,
            },
          })
        : [];

      const inventoryQtyByBoxSku = new Map<string, number>();
      inventoryRows.forEach((row) => {
        const key = this.inventoryKey(row.boxId, row.skuId);
        inventoryQtyByBoxSku.set(key, Number(row.qty ?? 0));
      });

      const adjustItems: Array<{
        boxId: bigint;
        skuId: bigint;
        qtyDelta: number;
        reason: string;
      }> = [];
      targets.forEach((target) => {
        const key = this.inventoryKey(target.boxId, target.skuId);
        const currentQty = inventoryQtyByBoxSku.get(key) ?? 0;
        const delta = target.qty - currentQty;
        if (delta === 0) return;
        adjustItems.push({
          boxId: target.boxId,
          skuId: target.skuId,
          qtyDelta: delta,
          reason: '批量更新库存',
        });
      });

      const changedSkuCount = new Set(adjustItems.map((item) => item.skuId.toString())).size;

      if (adjustItems.length === 0) {
        return {
          totalRows: rows.length,
          changedSkuCount: 0,
          changedItemCount: 0,
          changedRows: 0,
          fileName: originalName ?? null,
          adjustNo: null,
        };
      }

      const order = await tx.inventoryAdjustOrder.create({
        data: {
          adjustNo: generateOrderNo('ADJ'),
          status: OrderStatus.draft,
          remark: originalName ? `bulk-inventory-update:${originalName}` : 'bulk-inventory-update',
          createdBy: operatorId,
        },
      });

      await tx.inventoryAdjustOrderItem.createMany({
        data: adjustItems.map((item) => ({
          orderId: order.id,
          boxId: item.boxId,
          skuId: item.skuId,
          qtyDelta: item.qtyDelta,
          reason: item.reason,
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
          itemCount: adjustItems.length,
          mode: 'bulk_inventory_update',
          fileName: originalName ?? null,
        },
        operatorId,
        requestId,
      });

      const result = await this.applyAdjustOrder(tx, order.id, operatorId, requestId, false);
      return {
        totalRows: rows.length,
        changedSkuCount,
        changedItemCount: adjustItems.length,
        changedRows: result.changedRows,
        fileName: originalName ?? null,
        adjustNo: order.adjustNo,
      };
    });
  }

  async buildStockAdjustmentCsv(): Promise<{ fileName: string; content: Buffer }> {
    const [skus, inventoryRows, pendingRows] = await Promise.all([
      this.prisma.sku.findMany({
        select: {
          id: true,
          sku: true,
        },
      }),
      this.prisma.inventoryBoxSku.groupBy({
        by: ['skuId'],
        _sum: {
          qty: true,
        },
      }),
      this.prisma.fbaReplenishment.findMany({
        where: {
          status: { in: ['pending_confirm', 'pending_outbound'] },
        },
        select: {
          skuId: true,
          status: true,
          requestedQty: true,
          actualQty: true,
        },
      }),
    ]);

    const inventoryBySku = new Map<string, number>();
    inventoryRows.forEach((row) => {
      inventoryBySku.set(row.skuId.toString(), Number(row._sum.qty ?? 0));
    });

    const pendingBySku = new Map<string, number>();
    pendingRows.forEach((row) => {
      const qty = Number(
        row.status === 'pending_outbound'
          ? (row.actualQty ?? row.requestedQty)
          : row.requestedQty,
      );
      if (qty <= 0) return;
      const key = row.skuId.toString();
      pendingBySku.set(key, (pendingBySku.get(key) ?? 0) + qty);
    });

    const lines: string[] = [
      ['SKUコード', '倉庫ID', '実在庫数', '差分指定']
        .map((cell) => this.escapeCsvCell(cell))
        .join(','),
    ];

    const sortedSkus = [...skus].sort((a, b) =>
      String(a.sku || '').localeCompare(String(b.sku || ''), 'en', { numeric: true }),
    );

    sortedSkus.forEach((sku) => {
      const skuKey = sku.id.toString();
      const totalQty = inventoryBySku.get(skuKey) ?? 0;
      const pendingQty = pendingBySku.get(skuKey) ?? 0;
      const actualQty = totalQty - pendingQty;
      const row = [sku.sku || '', STOCK_ADJUSTMENT_WAREHOUSE_ID, actualQty, ''];
      lines.push(row.map((cell) => this.escapeCsvCell(cell)).join(','));
    });

    const csvText = `${lines.join('\r\n')}\r\n`;
    const fileName = `stock_ajustment_${this.formatDateForFilename(new Date())}.csv`;
    return {
      fileName,
      content: iconv.encode(csvText, 'shift_jis'),
    };
  }

  private parseBulkInventoryUpdateRows(fileBuffer: Buffer): BulkInventoryUpdateRow[] {
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
    const result: BulkInventoryUpdateRow[] = [];
    const seenKeys = new Set<string>();

    rows.forEach((rawRow, idx) => {
      const rowNo = idx + 2;
      const normalized: Record<string, string> = {};
      Object.entries(rawRow).forEach(([key, value]) => {
        normalized[this.normalizeImportHeader(key)] = String(value ?? '').trim();
      });

      const boxCode = this.pickImportField(normalized, ['箱号', 'box', 'boxcode', '箱子', 'box id']);
      if (!boxCode) {
        errors.push(`第${rowNo}行：箱号为必填字段`);
        return;
      }

      const sku = this.pickImportField(normalized, [
        'sku',
        'sku(fba编码)',
        'sku（fba编码）',
        'sku编码',
        '产品sku',
        '商品sku',
      ]);
      if (!sku) {
        errors.push(`第${rowNo}行：SKU为必填字段`);
        return;
      }

      const uniqueKey = `${boxCode}__${sku}`;
      if (seenKeys.has(uniqueKey)) {
        errors.push(`第${rowNo}行：箱号 ${boxCode} + SKU ${sku} 重复，请保留一行`);
        return;
      }

      const qtyText = this.pickImportField(normalized, ['数量', 'qty', '库存数量', '库存数', '在库数']);
      if (qtyText === null) {
        errors.push(`第${rowNo}行：数量为必填字段`);
        return;
      }

      const qty = Number(String(qtyText || '').replaceAll(',', '').trim());
      if (!Number.isInteger(qty) || qty < 0) {
        errors.push(`第${rowNo}行：数量必须是大于等于0的整数`);
        return;
      }

      seenKeys.add(uniqueKey);
      result.push({ boxCode, sku, qty });
    });

    if (errors.length > 0) {
      throw new UnprocessableEntityException(errors.join(' | '));
    }

    return result;
  }

  private normalizeImportHeader(header: string): string {
    return String(header || '')
      .replace(/[\s_\-()（）\[\]【】]/g, '')
      .toLowerCase();
  }

  private pickImportField(row: Record<string, string>, aliases: string[]): string | null {
    for (const alias of aliases) {
      const normalizedAlias = this.normalizeImportHeader(alias);
      const value = String(row[normalizedAlias] ?? '').trim();
      if (value) {
        return value;
      }
    }
    return null;
  }

  private formatFbaRequestNo(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `FBA-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
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

  private formatDateForFilename(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
  }

  private escapeCsvCell(value: string | number): string {
    const text = String(value ?? '');
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  private async ensureSkusNotUnderPendingEdit(
    tx: Prisma.TransactionClient,
    skuIds: bigint[],
  ): Promise<void> {
    if (!Array.isArray(skuIds) || skuIds.length === 0) {
      return;
    }
    const uniqueSkuIds = Array.from(new Set(skuIds.map((id) => id.toString()))).map((id) => BigInt(id));
    const pending = await tx.productEditRequest.findFirst({
      where: {
        skuId: { in: uniqueSkuIds },
        status: ProductEditRequestStatus.pending,
      },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictException(SKU_EDIT_PENDING_BLOCK_MESSAGE);
    }
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
          { rbSku: { contains: keyword } },
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

  private async resolveOrCreateBulkUpdateDefaultShelf(
    tx: Prisma.TransactionClient,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: bigint }> {
    const existed = await tx.shelf.findFirst({
      where: {
        OR: [{ shelfCode: BULK_UPDATE_DEFAULT_SHELF_CODE }, { shelfCode: `S-${BULK_UPDATE_DEFAULT_SHELF_CODE}` }],
      },
      select: {
        id: true,
        shelfCode: true,
        name: true,
        status: true,
      },
    });

    if (!existed) {
      const created = await tx.shelf.create({
        data: {
          shelfCode: BULK_UPDATE_DEFAULT_SHELF_CODE,
          name: BULK_UPDATE_DEFAULT_SHELF_NAME,
          status: 1,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'shelf',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.SHELF_CREATED,
        beforeData: null,
        afterData: created as unknown as Record<string, unknown>,
        operatorId,
        requestId,
        remark: 'auto created from bulk inventory update',
      });

      return { id: created.id };
    }

    if (Number(existed.status) === 1) {
      return { id: existed.id };
    }

    const updated = await tx.shelf.update({
      where: { id: existed.id },
      data: { status: 1 },
      select: {
        id: true,
        shelfCode: true,
        name: true,
        status: true,
      },
    });

    await this.auditService.create({
      db: tx,
      entityType: 'shelf',
      entityId: updated.id,
      action: AuditAction.update,
      eventType: AuditEventType.SHELF_FIELD_UPDATED,
      beforeData: existed as unknown as Record<string, unknown>,
      afterData: updated as unknown as Record<string, unknown>,
      operatorId,
      requestId,
      remark: 'enabled for bulk inventory update',
    });

    return { id: updated.id };
  }

  private async resolveOrCreateBulkUpdateBox(
    tx: Prisma.TransactionClient,
    boxCode: string,
    defaultShelfId: bigint,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: bigint; boxCode: string; status: number; shelfStatus: number }> {
    const found = await tx.box.findUnique({
      where: { boxCode },
      select: {
        id: true,
        boxCode: true,
        status: true,
        shelf: {
          select: {
            status: true,
          },
        },
      },
    });

    if (found) {
      return {
        id: found.id,
        boxCode: found.boxCode,
        status: Number(found.status ?? 0),
        shelfStatus: Number(found.shelf?.status ?? 0),
      };
    }

    try {
      const created = await tx.box.create({
        data: {
          boxCode,
          shelfId: defaultShelfId,
          status: 1,
        },
        select: {
          id: true,
          boxCode: true,
          status: true,
          shelf: {
            select: {
              status: true,
            },
          },
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'box',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.BOX_CREATED,
        beforeData: null,
        afterData: {
          id: created.id,
          boxCode: created.boxCode,
          shelfId: defaultShelfId,
          status: created.status,
        },
        operatorId,
        requestId,
        remark: 'auto created from bulk inventory update',
      });

      return {
        id: created.id,
        boxCode: created.boxCode,
        status: Number(created.status ?? 0),
        shelfStatus: Number(created.shelf?.status ?? 0),
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await tx.box.findUnique({
          where: { boxCode },
          select: {
            id: true,
            boxCode: true,
            status: true,
            shelf: {
              select: {
                status: true,
              },
            },
          },
        });

        if (existing) {
          return {
            id: existing.id,
            boxCode: existing.boxCode,
            status: Number(existing.status ?? 0),
            shelfStatus: Number(existing.shelf?.status ?? 0),
          };
        }
      }
      throw error;
    }
  }

  private inventoryKey(boxId: bigint, skuId: bigint): string {
    return `${boxId.toString()}-${skuId.toString()}`;
  }
}
