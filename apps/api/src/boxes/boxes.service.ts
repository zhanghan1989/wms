import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, BatchInboundOrderStatus, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
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
      where: q
        ? {
            OR: [{ boxCode: { contains: q } }],
          }
        : undefined,
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

  async create(payload: CreateBoxDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const boxCode = payload.boxCode.trim().toUpperCase();
    const lockedOrderNo = await this.findLockingBatchInboundOrderNo(boxCode);
    if (lockedOrderNo) {
      throw new BadRequestException(
        `箱号已被批量入库单 ${lockedOrderNo} 锁定，请先确认或删除该单据`,
      );
    }

    const exists = await this.prisma.box.findUnique({
      where: { boxCode },
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
      const nextBoxCode = payload.boxCode.trim().toUpperCase();
      if (nextBoxCode === box.boxCode) {
        payload.boxCode = nextBoxCode;
      } else {
        const lockedOrderNo = await this.findLockingBatchInboundOrderNo(nextBoxCode);
        if (lockedOrderNo) {
          throw new BadRequestException(
            `箱号已被批量入库单 ${lockedOrderNo} 锁定，请先确认或删除该单据`,
          );
        }

        const duplicate = await this.prisma.box.findUnique({
          where: { boxCode: nextBoxCode },
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

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'boxId');
    const box = await this.prisma.box.findUnique({ where: { id } });
    if (!box) throw new NotFoundException('箱号不存在');
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

  private async findLockingBatchInboundOrderNo(boxCode: string): Promise<string | null> {
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
      if (codes.includes(boxCode)) {
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
          .map((item) => String(item ?? '').trim().toUpperCase())
          .filter((item) => Boolean(item)),
      ),
    );
  }
}
