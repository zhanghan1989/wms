import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, BatchInboundOrderStatus, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { buildEquivalentBoxCodes, normalizeBoxCode } from '../common/box-code';
import { parseId } from '../common/utils';
import { AuditEventType, AuditEventTypeValue } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBoxDto } from './dto/create-box.dto';
import { UpdateBoxDto } from './dto/update-box.dto';

interface BoxAuditArgs {
  auditService: AuditService;
  tx: Prisma.TransactionClient;
  entityId: bigint;
  action: AuditAction;
  eventType: AuditEventTypeValue;
  beforeData: Record<string, unknown> | null | undefined;
  afterData: Record<string, unknown> | null | undefined;
  operatorId: bigint;
  requestId?: string;
  remark?: string;
}

type BoxListRow = Prisma.BoxGetPayload<{
  include: {
    shelf: {
      select: {
        id: true;
        shelfCode: true;
        name: true;
      };
    };
  };
}>;

@Injectable()
export class BoxesService {
  constructor(
    readonly prisma: PrismaService,
    readonly auditService: AuditService,
  ) {}

  async list(q?: string): Promise<unknown[]> {
    const boxes = await this.prisma.box.findMany({
      where: {
        status: 1,
        ...(q
          ? {
              OR: [{ boxCode: { contains: q } }],
            }
          : {}),
      },
      include: {
        shelf: {
          select: {
            id: true,
            shelfCode: true,
            name: true,
          },
        },
      },
      orderBy: { id: 'desc' },
    });

    return this.buildBoxListItems(boxes);
  }

  async listManage(pageParam?: string, pageSizeParam?: string): Promise<{
    items: unknown[];
    page: number;
    pageSize: number;
    hasMore: boolean;
    total: number;
  }> {
    const page = this.normalizePage(pageParam);
    const pageSize = this.normalizePageSize(pageSizeParam, 30);
    const skip = (page - 1) * pageSize;
    const where = { status: 1 };
    const [boxes, total] = await Promise.all([
      this.prisma.box.findMany({
        where,
        include: {
          shelf: {
            select: {
              id: true,
              shelfCode: true,
              name: true,
            },
          },
        },
        orderBy: [{ boxCode: 'asc' }, { id: 'asc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.box.count({ where }),
    ]);

    const items = await this.buildBoxListItems(boxes);
    return {
      items,
      page,
      pageSize,
      hasMore: skip + boxes.length < total,
      total,
    };
  }

  private async buildBoxListItems(boxes: BoxListRow[]): Promise<unknown[]> {
    if (!boxes.length) {
      return [];
    }

    const boxIds = boxes.map((box) => box.id);
    const boxCodes = boxes.map((box) => box.boxCode);
    const [
      masterInventorySums,
      masterInventoryCounts,
      itemCodeCounts,
      inboundCounts,
      outboundCounts,
      stocktakeCounts,
      movementCounts,
      adjustCounts,
      fbaHistoryCounts,
      activeFbaCounts,
      pendingBatchInboundCounts,
      lockingOrders,
    ] = await Promise.all([
      this.prisma.masterProductBoxInventory.groupBy({
        by: ['boxId'],
        where: { boxId: { in: boxIds } },
        _sum: { qty: true },
      }),
      this.prisma.masterProductBoxInventory.groupBy({
        by: ['boxId'],
        where: { boxId: { in: boxIds } },
        _count: { _all: true },
      }),
      this.prisma.itemCode.groupBy({
        by: ['boxId'],
        where: { boxId: { in: boxIds } },
        _count: { _all: true },
      }),
      this.prisma.inboundOrderItem.groupBy({
        by: ['boxId'],
        where: { boxId: { in: boxIds } },
        _count: { _all: true },
      }),
      this.prisma.outboundOrderItem.groupBy({
        by: ['boxId'],
        where: { boxId: { in: boxIds } },
        _count: { _all: true },
      }),
      this.prisma.stocktakeRecord.groupBy({
        by: ['boxId'],
        where: { boxId: { in: boxIds } },
        _count: { _all: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['boxId'],
        where: { boxId: { in: boxIds } },
        _count: { _all: true },
      }),
      this.prisma.inventoryAdjustOrderItem.groupBy({
        by: ['boxId'],
        where: { boxId: { in: boxIds } },
        _count: { _all: true },
      }),
      this.prisma.fbaReplenishment.groupBy({
        by: ['boxId'],
        where: { boxId: { in: boxIds } },
        _count: { _all: true },
      }),
      this.prisma.fbaReplenishment.groupBy({
        by: ['boxId'],
        where: {
          boxId: { in: boxIds },
          status: { in: ['pending_confirm', 'pending_outbound'] },
        },
        _count: { _all: true },
      }),
      this.prisma.batchInboundItem.groupBy({
        by: ['boxCode'],
        where: {
          boxCode: { in: boxCodes },
          order: {
            status: {
              in: [BatchInboundOrderStatus.waiting_upload, BatchInboundOrderStatus.waiting_inbound],
            },
          },
        },
        _count: { _all: true },
      }),
      this.prisma.batchInboundOrder.findMany({
        where: {
          status: {
            in: [BatchInboundOrderStatus.waiting_upload, BatchInboundOrderStatus.waiting_inbound],
          },
        },
        select: {
          orderNo: true,
          collectedBoxCodes: true,
        },
        orderBy: { id: 'desc' },
      }),
    ]);

    const masterInventorySumByBoxId = new Map(
      masterInventorySums.map((row) => [row.boxId.toString(), Number(row._sum.qty ?? 0)]),
    );
    const masterInventoryCountByBoxId = new Map(
      masterInventoryCounts.map((row) => [row.boxId.toString(), Number(row._count._all ?? 0)]),
    );
    const itemCodeCountByBoxId = new Map(
      itemCodeCounts.map((row) => [row.boxId.toString(), Number(row._count._all ?? 0)]),
    );
    const inboundCountByBoxId = new Map(
      inboundCounts.map((row) => [row.boxId.toString(), Number(row._count._all ?? 0)]),
    );
    const outboundCountByBoxId = new Map(
      outboundCounts.map((row) => [row.boxId.toString(), Number(row._count._all ?? 0)]),
    );
    const stocktakeCountByBoxId = new Map(
      stocktakeCounts.map((row) => [row.boxId.toString(), Number(row._count._all ?? 0)]),
    );
    const movementCountByBoxId = new Map(
      movementCounts.map((row) => [row.boxId.toString(), Number(row._count._all ?? 0)]),
    );
    const adjustCountByBoxId = new Map(
      adjustCounts.map((row) => [row.boxId.toString(), Number(row._count._all ?? 0)]),
    );
    const fbaHistoryCountByBoxId = new Map(
      fbaHistoryCounts.map((row) => [row.boxId.toString(), Number(row._count._all ?? 0)]),
    );
    const activeFbaCountByBoxId = new Map(
      activeFbaCounts.map((row) => [row.boxId.toString(), Number(row._count._all ?? 0)]),
    );
    const pendingBatchInboundCountByCode = new Map(
      pendingBatchInboundCounts.map((row) => [String(row.boxCode), Number(row._count._all ?? 0)]),
    );
    const lockingOrderByCode = new Map<string, string>();
    for (const order of lockingOrders) {
      const rawCodes = Array.isArray(order.collectedBoxCodes) ? order.collectedBoxCodes : [];
      for (const item of rawCodes) {
        const code = String(item ?? '').trim().toUpperCase();
        if (code && !lockingOrderByCode.has(code)) {
          lockingOrderByCode.set(code, order.orderNo);
        }
      }
    }

    return boxes.map((box) => {
      const boxId = box.id.toString();
      const masterProductStock = masterInventorySumByBoxId.get(boxId) ?? 0;
      const totalStock = masterProductStock;
      const masterInventoryRows = masterInventoryCountByBoxId.get(boxId) ?? 0;
      const totalInventoryRows = masterInventoryRows;
      const itemCodeRows = itemCodeCountByBoxId.get(boxId) ?? 0;
      const inboundRows = inboundCountByBoxId.get(boxId) ?? 0;
      const outboundRows = outboundCountByBoxId.get(boxId) ?? 0;
      const stocktakeRows = stocktakeCountByBoxId.get(boxId) ?? 0;
      const movementRows = movementCountByBoxId.get(boxId) ?? 0;
      const adjustRows = adjustCountByBoxId.get(boxId) ?? 0;
      const fbaRows = fbaHistoryCountByBoxId.get(boxId) ?? 0;
      const activeFbaRows = activeFbaCountByBoxId.get(boxId) ?? 0;
      const pendingBatchInboundRows = pendingBatchInboundCountByCode.get(box.boxCode) ?? 0;
      const lockingOrderNo = lockingOrderByCode.get(String(box.boxCode).trim().toUpperCase()) ?? null;
      const deleteBlockedReasons: string[] = [];
      const archiveReleaseBlockedReasons: string[] = [];

      if (lockingOrderNo) {
        deleteBlockedReasons.push(`被批量入库单 ${lockingOrderNo} 占用`);
        archiveReleaseBlockedReasons.push(`被批量入库单 ${lockingOrderNo} 占用`);
      }
      if (pendingBatchInboundRows > 0) {
        const message = `存在 ${pendingBatchInboundRows} 条待处理批量入库明细`;
        deleteBlockedReasons.push(message);
        archiveReleaseBlockedReasons.push(message);
      }
      if (totalInventoryRows > 0) {
        deleteBlockedReasons.push(`存在 ${totalInventoryRows} 条库存记录`);
      }
      if (itemCodeRows > 0) {
        deleteBlockedReasons.push(`存在 ${itemCodeRows} 条 item code 记录`);
      }
      if (inboundRows > 0) {
        deleteBlockedReasons.push(`存在 ${inboundRows} 条入库记录`);
      }
      if (outboundRows > 0) {
        deleteBlockedReasons.push(`存在 ${outboundRows} 条出库记录`);
      }
      if (stocktakeRows > 0) {
        deleteBlockedReasons.push(`存在 ${stocktakeRows} 条盘点记录`);
      }
      if (movementRows > 0) {
        deleteBlockedReasons.push(`存在 ${movementRows} 条移动记录`);
      }
      if (adjustRows > 0) {
        deleteBlockedReasons.push(`存在 ${adjustRows} 条调整记录`);
      }
      if (fbaRows > 0) {
        deleteBlockedReasons.push(`存在 ${fbaRows} 条 FBA 历史记录`);
      }
      if (masterProductStock > 0) {
        archiveReleaseBlockedReasons.push(`当前主商品库存数量 ${masterProductStock}`);
      }
      if (activeFbaRows > 0) {
        archiveReleaseBlockedReasons.push(`存在 ${activeFbaRows} 条进行中的 FBA 记录`);
      }

      const canDelete =
        !lockingOrderNo &&
        pendingBatchInboundRows <= 0 &&
        totalInventoryRows <= 0 &&
        itemCodeRows <= 0 &&
        inboundRows <= 0 &&
        outboundRows <= 0 &&
        stocktakeRows <= 0 &&
        movementRows <= 0 &&
        adjustRows <= 0 &&
        fbaRows <= 0;
      const canArchiveRelease =
        !canDelete &&
        masterProductStock <= 0 &&
        activeFbaRows <= 0 &&
        !lockingOrderNo &&
        pendingBatchInboundRows <= 0;

      return {
        ...box,
        totalStock,
        canDelete,
        canArchiveRelease,
        deleteBlockedReasons,
        archiveReleaseBlockedReasons,
      };
    });
  }

  private normalizePage(value?: string): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10000) : 1;
  }

  private normalizePageSize(value?: string, defaultValue = 30): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : defaultValue;
  }

  async listEmpty(): Promise<unknown[]> {
    const [boxes, masterProductInventoryRows] = await Promise.all([
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
              id: true,
              shelfCode: true,
              name: true,
            },
          },
        },
        orderBy: { boxCode: 'asc' },
      }),
      this.prisma.masterProductBoxInventory.groupBy({
        by: ['boxId'],
        _sum: { qty: true },
      }),
    ]);

    const inventoryByBox = new Map<string, number>();
    masterProductInventoryRows.forEach((row) => {
      const key = row.boxId.toString();
      inventoryByBox.set(key, Number(row._sum.qty ?? 0));
    });

    return boxes
      .map((box) => ({
        id: box.id.toString(),
        boxCode: box.boxCode,
        shelfId: box.shelf?.id?.toString() ?? null,
        shelfCode: box.shelf?.shelfCode ?? null,
        shelfName: box.shelf?.name ?? null,
        totalStock: inventoryByBox.get(box.id.toString()) ?? 0,
      }))
      .filter((box) => box.totalStock <= 0);
  }

  async create(payload: CreateBoxDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const boxCode = normalizeBoxCode(payload.boxCode);
    if (!boxCode) throw new BadRequestException('箱号格式无效');
    const lockedOrderNo = await this.findLockingBatchInboundOrderNo(boxCode);
    if (lockedOrderNo) {
      throw new BadRequestException(
        `箱号已被批量入库单 ${lockedOrderNo} 锁定，请先确认或删除该单据`,
      );
    }

    const exists = await this.prisma.box.findFirst({
      where: {
        boxCode: { in: buildEquivalentBoxCodes(boxCode) },
      },
    });
    if (exists) throw new BadRequestException('箱号已存在');

    const shelf = await this.prisma.shelf.findUnique({
      where: { id: BigInt(payload.shelfId) },
    });
    if (!shelf) throw new BadRequestException('货架不存在');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.box.create({
        data: {
          boxCode,
          shelfId: BigInt(payload.shelfId),
          status: payload.status ?? 1,
        },
      });
      await createBoxAudit({
        auditService: this.auditService,
        tx,
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.BOX_CREATED,
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
    payload: UpdateBoxDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'boxId');
    const box = await this.prisma.box.findUnique({ where: { id } });
    if (!box) throw new NotFoundException('箱号不存在');

    if (payload.boxCode) {
      const nextBoxCode = normalizeBoxCode(payload.boxCode);
      if (!nextBoxCode) {
        throw new BadRequestException('箱号格式无效');
      }
      if (nextBoxCode === box.boxCode) {
        payload.boxCode = nextBoxCode;
      } else {
        const lockedOrderNo = await this.findLockingBatchInboundOrderNo(nextBoxCode);
        if (lockedOrderNo) {
          throw new BadRequestException(
            `箱号已被批量入库单 ${lockedOrderNo} 锁定，请先确认或删除该单据`,
          );
        }

        const duplicate = await this.prisma.box.findFirst({
          where: {
            id: { not: id },
            boxCode: { in: buildEquivalentBoxCodes(nextBoxCode) },
          },
        });
        if (duplicate) throw new BadRequestException('箱号已存在');
      }
      payload.boxCode = nextBoxCode;
    }

    if (payload.shelfId) {
      const shelf = await this.prisma.shelf.findUnique({
        where: { id: BigInt(payload.shelfId) },
      });
      if (!shelf) throw new BadRequestException('货架不存在');
    }

    return this.prisma.$transaction(async (tx) => {
      if (payload.shelfId && BigInt(payload.shelfId) !== box.shelfId) {
        await this.ensureBoxNotUnderActiveFba(id, box.boxCode, '移箱');
      }
      const updated = await tx.box.update({
        where: { id },
        data: {
          boxCode: payload.boxCode,
          shelfId: payload.shelfId ? BigInt(payload.shelfId) : undefined,
          status: payload.status,
        },
      });

      const eventType = this.resolveEventType(box.boxCode, updated.boxCode, updated.status);
      await createBoxAudit({
        auditService: this.auditService,
        tx,
        entityId: updated.id,
        action: AuditAction.update,
        eventType,
        beforeData: box as unknown as Record<string, unknown>,
        afterData: updated as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return updated;
    });
  }

  async getDeleteCheck(idParam: string): Promise<{ canDelete: boolean; reasons: string[] }> {
    return getDeleteCheckByProduct.call(this, idParam);
  }

  async archiveAndRelease(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ success: boolean; archivedBoxCode: string; releasedBoxCode: string }> {
    return archiveAndReleaseByProduct.call(this, idParam, operatorId, requestId);
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'boxId');
    const box = await this.prisma.box.findUnique({ where: { id } });
    if (!box) throw new NotFoundException('箱号不存在');
    const check = await this.getDeleteCheck(idParam);
    if (!check.canDelete) {
      throw new BadRequestException(`箱号无法删除：${check.reasons.join('；')}`);
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.box.delete({ where: { id } });
        await createBoxAudit({
          auditService: this.auditService,
          tx,
          entityId: id,
          action: AuditAction.delete,
          eventType: AuditEventType.BOX_DELETED,
          beforeData: box as unknown as Record<string, unknown>,
          afterData: null,
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('箱号已被库存或历史单据引用，无法删除。请先处理关联数据，或改为禁用。');
      }
      throw error;
    }
    return { success: true };
  }

  private resolveEventType(
    previousBoxCode: string,
    nextBoxCode: string,
    status: number,
  ): AuditEventTypeValue {
    if (status === 0) return AuditEventType.BOX_DISABLED;
    if (previousBoxCode !== nextBoxCode) return AuditEventType.BOX_RENAMED;
    return AuditEventType.BOX_FIELD_UPDATED;
  }

  async ensureBoxNotUnderActiveFba(
    boxId: bigint,
    boxCode: string,
    operationName: string,
  ): Promise<void> {
    const activeRow = await this.prisma.fbaReplenishment.findFirst({
      where: {
        boxId,
        status: { in: ['pending_confirm', 'pending_outbound'] },
      },
      select: {
        requestNo: true,
        status: true,
        sku: { select: { sku: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!activeRow) return;

    throw new ConflictException(
      `箱号 ${boxCode} 存在进行中的FBA补货申请 ${activeRow.requestNo}（SKU：${
        activeRow.sku?.sku || '-'
      }，状态：${this.getFbaStatusLabel(activeRow.status)}），禁止${operationName}`,
    );
  }

  private getFbaStatusLabel(status: string): string {
    if (status === 'pending_confirm') return '待确认';
    if (status === 'pending_outbound') return '待出库';
    if (status === 'outbound') return '已出库';
    if (status === 'deleted') return '已删除';
    return status;
  }

  private async loadPendingBatchInboundOrders(): Promise<
    Array<{ orderNo: string; collectedBoxCodes: Prisma.JsonValue }>
  > {
    return this.prisma.batchInboundOrder.findMany({
      where: {
        status: {
          in: [BatchInboundOrderStatus.waiting_upload, BatchInboundOrderStatus.waiting_inbound],
        },
      },
      select: {
        orderNo: true,
        collectedBoxCodes: true,
      },
      orderBy: { id: 'desc' },
    });
  }

  private async findLockingBatchInboundOrderNo(boxCode: string): Promise<string | null> {
    const normalized = normalizeBoxCode(boxCode);
    if (!normalized) return null;
    const orders = await this.loadPendingBatchInboundOrders();

    for (const order of orders) {
      const codes = this.parseCollectedBoxCodes(order.collectedBoxCodes);
      if (codes.includes(normalized)) {
        return order.orderNo;
      }
    }

    return null;
  }

  async findLockingBatchInboundOrderNoExact(boxCode: string): Promise<string | null> {
    const target = String(boxCode ?? '').trim().toUpperCase();
    if (!target) return null;

    const orders = await this.loadPendingBatchInboundOrders();

    for (const order of orders) {
      const rawCodes = Array.isArray(order.collectedBoxCodes) ? order.collectedBoxCodes : [];
      const matched = rawCodes.some((item) => String(item ?? '').trim().toUpperCase() === target);
      if (matched) {
        return order.orderNo;
      }
    }

    return null;
  }

  private parseCollectedBoxCodes(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(
      new Set(
        value
          .map((item) => normalizeBoxCode(String(item ?? '')))
          .filter((item) => Boolean(item)),
      ),
    );
  }

  async buildArchivedBoxCode(boxCode: string): Promise<string> {
    const base = `${boxCode}#ARCHIVED`;
    let attempt = 1;

    while (attempt <= 1000) {
      const suffix = String(attempt).padStart(3, '0');
      const candidate = `${base}-${suffix}`;
      const exists = await this.prisma.box.findFirst({
        where: { boxCode: candidate },
        select: { id: true },
      });
      if (!exists) {
        return candidate;
      }
      attempt += 1;
    }

    throw new ConflictException(`无法为箱号 ${boxCode} 生成可用的归档编号`);
  }

  async sumBoxMasterProductInventoryQty(boxId: bigint): Promise<number> {
    const masterProductInventorySummary = await this.prisma.masterProductBoxInventory.aggregate({
      where: { boxId },
      _sum: { qty: true },
    });

    return Number(masterProductInventorySummary._sum.qty ?? 0);
  }

  async sumBoxInventoryQty(boxId: bigint): Promise<number> {
    return this.sumBoxMasterProductInventoryQty(boxId);
  }

  async countPendingBatchInboundItemsByBoxCode(boxCode: string): Promise<number> {
    return this.prisma.batchInboundItem.count({
      where: {
        boxCode,
        order: {
          status: {
            in: [BatchInboundOrderStatus.waiting_upload, BatchInboundOrderStatus.waiting_inbound],
          },
        },
      },
    });
  }

}

async function createBoxAudit({
  auditService,
  tx,
  entityId,
  action,
  eventType,
  beforeData,
  afterData,
  operatorId,
  requestId,
  remark,
}: BoxAuditArgs): Promise<void> {
  await auditService.create({
    db: tx,
    entityType: 'box',
    entityId,
    action,
    eventType,
    beforeData,
    afterData,
    operatorId,
    requestId,
    remark,
  });
}

async function getDeleteCheckByProduct(
  this: BoxesService,
  idParam: string,
): Promise<{ canDelete: boolean; reasons: string[] }> {
  const id = parseId(idParam, 'boxId');
  const box = await this.prisma.box.findUnique({
    where: { id },
    select: { id: true, boxCode: true },
  });
  if (!box) throw new NotFoundException('箱号不存在');

  const [
    masterInventoryRows,
    itemCodeRows,
    inboundRows,
    outboundRows,
    stocktakeRows,
    movementRows,
    adjustRows,
    fbaRows,
    pendingBatchInboundRows,
  ] = await Promise.all([
    this.prisma.masterProductBoxInventory.count({ where: { boxId: id } }),
    this.prisma.itemCode.count({ where: { boxId: id } }),
    this.prisma.inboundOrderItem.count({ where: { boxId: id } }),
    this.prisma.outboundOrderItem.count({ where: { boxId: id } }),
    this.prisma.stocktakeRecord.count({ where: { boxId: id } }),
    this.prisma.stockMovement.count({ where: { boxId: id } }),
    this.prisma.inventoryAdjustOrderItem.count({ where: { boxId: id } }),
    this.prisma.fbaReplenishment.count({ where: { boxId: id } }),
    this.countPendingBatchInboundItemsByBoxCode(box.boxCode),
  ]);

  const lockingOrderNo = await this.findLockingBatchInboundOrderNoExact(box.boxCode);
  const reasons: string[] = [];
  const totalInventoryRows = masterInventoryRows;

  if (lockingOrderNo) {
    reasons.push(`箱号被批量入库单 ${lockingOrderNo} 占用，请先处理该入库单`);
  }
  if (pendingBatchInboundRows > 0) {
    reasons.push(`存在 ${pendingBatchInboundRows} 条待处理的批量入库明细`);
  }
  if (totalInventoryRows > 0) {
    reasons.push(`存在 ${totalInventoryRows} 条箱内库存记录`);
  }
  if (itemCodeRows > 0) {
    reasons.push(`存在 ${itemCodeRows} 条贴码记录`);
  }
  if (
    inboundRows > 0 ||
    outboundRows > 0 ||
    stocktakeRows > 0 ||
    movementRows > 0 ||
    adjustRows > 0 ||
    fbaRows > 0
  ) {
    reasons.push('存在历史业务记录');
  }

  return {
    canDelete: reasons.length === 0,
    reasons,
  };
};

async function archiveAndReleaseByProduct(
  this: BoxesService,
  idParam: string,
  operatorId: bigint,
  requestId?: string,
): Promise<{ success: boolean; archivedBoxCode: string; releasedBoxCode: string }> {
  const id = parseId(idParam, 'boxId');
  const box = await this.prisma.box.findUnique({
    where: { id },
    select: {
      id: true,
      boxCode: true,
      shelfId: true,
      status: true,
    },
  });
  if (!box) throw new NotFoundException('箱号不存在');
  if (Number(box.status ?? 0) !== 1) {
    throw new BadRequestException('只有启用中的箱号才能执行归档释放');
  }

  const totalQty = await this.sumBoxMasterProductInventoryQty(id);
  if (totalQty > 0) {
    throw new BadRequestException(`箱号仍有主商品库存，不能归档释放。当前主商品库存数量：${totalQty}`);
  }

  await this.ensureBoxNotUnderActiveFba(id, box.boxCode, '归档释放');

  const lockingOrderNo = await this.findLockingBatchInboundOrderNoExact(box.boxCode);
  if (lockingOrderNo) {
    throw new BadRequestException(`箱号被批量入库单 ${lockingOrderNo} 占用，不能归档释放`);
  }

  const pendingBatchInboundRows = await this.countPendingBatchInboundItemsByBoxCode(box.boxCode);
  if (pendingBatchInboundRows > 0) {
    throw new BadRequestException(
      `箱号存在 ${pendingBatchInboundRows} 条待处理批量入库明细，不能归档释放`,
    );
  }

  const archivedBoxCode = await this.buildArchivedBoxCode(box.boxCode);
  await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updated = await tx.box.update({
      where: { id },
      data: {
        boxCode: archivedBoxCode,
        status: 0,
      },
    });

    await createBoxAudit({
      auditService: this.auditService,
      tx,
      entityId: updated.id,
      action: AuditAction.update,
      eventType: AuditEventType.BOX_DISABLED,
      beforeData: box as unknown as Record<string, unknown>,
      afterData: updated as unknown as Record<string, unknown>,
      operatorId,
      requestId,
      remark: `archived and released original box code ${box.boxCode}`,
    });
  });

  return {
    success: true,
    archivedBoxCode,
    releasedBoxCode: box.boxCode,
  };
};
