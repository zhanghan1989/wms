import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
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
    const exists = await this.prisma.box.findUnique({
      where: { boxCode: payload.boxCode },
    });
    if (exists) throw new BadRequestException('box code already exists');

    const shelf = await this.prisma.shelf.findUnique({
      where: { id: BigInt(payload.shelfId) },
    });
    if (!shelf) throw new BadRequestException('shelf not found');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.box.create({
        data: {
          boxCode: payload.boxCode,
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
    if (!box) throw new NotFoundException('box not found');

    if (payload.boxCode && payload.boxCode !== box.boxCode) {
      const duplicate = await this.prisma.box.findUnique({
        where: { boxCode: payload.boxCode },
      });
      if (duplicate) throw new BadRequestException('box code already exists');
    }
    if (payload.shelfId) {
      const shelf = await this.prisma.shelf.findUnique({
        where: { id: BigInt(payload.shelfId) },
      });
      if (!shelf) throw new BadRequestException('shelf not found');
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
    if (!box) throw new NotFoundException('box not found');
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
}
