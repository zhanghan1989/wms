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

@Injectable()
export class BoxesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(q?: string): Promise<unknown[]> {
    return this.prisma.box.findMany({
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
  }

  async listEmpty(): Promise<unknown[]> {
    const [boxes, inventoryRows] = await Promise.all([
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
      this.prisma.inventoryBoxSku.groupBy({
        by: ['boxId'],
        _sum: { qty: true },
      }),
    ]);

    const inventoryByBox = new Map<string, number>();
    inventoryRows.forEach((row) => {
      inventoryByBox.set(row.boxId.toString(), Number(row._sum.qty ?? 0));
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
      await this.auditService.create({
        db: tx,
        entityType: 'box',
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
      await this.auditService.create({
        db: tx,
        entityType: 'box',
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
    const id = parseId(idParam, 'boxId');
    const box = await this.prisma.box.findUnique({
      where: { id },
      select: { id: true, boxCode: true },
    });
    if (!box) throw new NotFoundException('箱号不存在');

    const [
      inventoryRows,
      itemCodeRows,
      inboundRows,
      outboundRows,
      stocktakeRows,
      movementRows,
      adjustRows,
      fbaRows,
      pendingBatchInboundRows,
    ] = await Promise.all([
      this.prisma.inventoryBoxSku.count({ where: { boxId: id } }),
      this.prisma.itemCode.count({ where: { boxId: id } }),
      this.prisma.inboundOrderItem.count({ where: { boxId: id } }),
      this.prisma.outboundOrderItem.count({ where: { boxId: id } }),
      this.prisma.stocktakeRecord.count({ where: { boxId: id } }),
      this.prisma.stockMovement.count({ where: { boxId: id } }),
      this.prisma.inventoryAdjustOrderItem.count({ where: { boxId: id } }),
      this.prisma.fbaReplenishment.count({ where: { boxId: id } }),
      this.prisma.batchInboundItem.count({
        where: {
          boxCode: box.boxCode,
          order: {
            status: {
              in: [BatchInboundOrderStatus.waiting_upload, BatchInboundOrderStatus.waiting_inbound],
            },
          },
        },
      }),
    ]);

    const lockingOrderNo = await this.findLockingBatchInboundOrderNoExact(box.boxCode);
    const reasons: string[] = [];
    if (lockingOrderNo) {
      reasons.push(`箱号已被批量入库单 ${lockingOrderNo} 锁定，请先确认或删除该单据`);
    }
    if (pendingBatchInboundRows > 0) {
      reasons.push(`存在 ${pendingBatchInboundRows} 条待处理批量入库明细`);
    }
    if (inventoryRows > 0) {
      reasons.push(`存在 ${inventoryRows} 条库存记录`);
    }
    if (itemCodeRows > 0) {
      reasons.push(`存在 ${itemCodeRows} 条条码记录`);
    }
    if (inboundRows > 0 || outboundRows > 0 || stocktakeRows > 0 || movementRows > 0 || adjustRows > 0 || fbaRows > 0) {
      reasons.push('存在历史单据记录');
    }

    return {
      canDelete: reasons.length === 0,
      reasons,
    };
  }

  async archiveAndRelease(
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
      throw new BadRequestException('该箱号已归档，不能重复释放');
    }

    const inventorySummary = await this.prisma.inventoryBoxSku.aggregate({
      where: { boxId: id },
      _sum: { qty: true },
    });
    const totalQty = Number(inventorySummary._sum.qty ?? 0);
    if (totalQty > 0) {
      throw new BadRequestException(`箱号暂时无法归档释放：当前库存总数量为 ${totalQty}`);
    }

    await this.ensureBoxNotUnderActiveFba(id, box.boxCode, '归档释放');

    const lockingOrderNo = await this.findLockingBatchInboundOrderNo(box.boxCode);
    if (lockingOrderNo) {
      throw new BadRequestException(
        `箱号暂时无法归档释放：存在批量入库单 ${lockingOrderNo} 正在采集或待入库`,
      );
    }

    const pendingBatchInboundRows = await this.prisma.batchInboundItem.count({
      where: {
        boxCode: box.boxCode,
        order: {
          status: {
            in: [BatchInboundOrderStatus.waiting_upload, BatchInboundOrderStatus.waiting_inbound],
          },
        },
      },
    });
    if (pendingBatchInboundRows > 0) {
      throw new BadRequestException(
        `箱号暂时无法归档释放：存在 ${pendingBatchInboundRows} 条批量入库中的箱号记录`,
      );
    }

    const archivedBoxCode = await this.buildArchivedBoxCode(box.boxCode);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.box.update({
        where: { id },
        data: {
          boxCode: archivedBoxCode,
          status: 0,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'box',
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
        await this.auditService.create({
          db: tx,
          entityType: 'box',
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

  private async ensureBoxNotUnderActiveFba(
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

  private async findLockingBatchInboundOrderNo(boxCode: string): Promise<string | null> {
    const normalized = normalizeBoxCode(boxCode);
    if (!normalized) return null;
    const orders = await this.prisma.batchInboundOrder.findMany({
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

    for (const order of orders) {
      const codes = this.parseCollectedBoxCodes(order.collectedBoxCodes);
      if (codes.includes(normalized)) {
        return order.orderNo;
      }
    }

    return null;
  }

  private async findLockingBatchInboundOrderNoExact(boxCode: string): Promise<string | null> {
    const target = String(boxCode ?? '').trim().toUpperCase();
    if (!target) return null;

    const orders = await this.prisma.batchInboundOrder.findMany({
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

  private async buildArchivedBoxCode(boxCode: string): Promise<string> {
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

}
