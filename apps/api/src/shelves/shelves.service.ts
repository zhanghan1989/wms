import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShelfDto } from './dto/create-shelf.dto';
import { UpdateShelfDto } from './dto/update-shelf.dto';

@Injectable()
export class ShelvesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(q?: string): Promise<unknown[]> {
    return this.prisma.shelf.findMany({
      where: q
        ? {
            OR: [
              { shelfCode: { contains: q } },
              { name: { contains: q } },
            ],
          }
        : undefined,
      orderBy: { id: 'desc' },
    });
  }

  async create(payload: CreateShelfDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const exists = await this.prisma.shelf.findUnique({
      where: {
        shelfCode: payload.shelfCode,
      },
    });
    if (exists) throw new BadRequestException('shelf code already exists');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.shelf.create({
        data: {
          shelfCode: payload.shelfCode,
          name: payload.name ?? null,
          status: payload.status ?? 1,
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
      });
      return created;
    });
  }

  async update(
    idParam: string,
    payload: UpdateShelfDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'shelfId');
    const shelf = await this.prisma.shelf.findUnique({ where: { id } });
    if (!shelf) throw new NotFoundException('shelf not found');

    if (payload.shelfCode && payload.shelfCode !== shelf.shelfCode) {
      const duplicate = await this.prisma.shelf.findUnique({
        where: { shelfCode: payload.shelfCode },
      });
      if (duplicate) {
        throw new BadRequestException('shelf code already exists');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.shelf.update({
        where: { id },
        data: payload,
      });
      const eventType = updated.status === 0 ? AuditEventType.SHELF_DISABLED : AuditEventType.SHELF_FIELD_UPDATED;
      await this.auditService.create({
        db: tx,
        entityType: 'shelf',
        entityId: updated.id,
        action: AuditAction.update,
        eventType,
        beforeData: shelf as unknown as Record<string, unknown>,
        afterData: updated as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return updated;
    });
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'shelfId');
    const shelf = await this.prisma.shelf.findUnique({ where: { id } });
    if (!shelf) throw new NotFoundException('shelf not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.shelf.delete({ where: { id } });
      await this.auditService.create({
        db: tx,
        entityType: 'shelf',
        entityId: id,
        action: AuditAction.delete,
        eventType: AuditEventType.SHELF_DELETED,
        beforeData: shelf as unknown as Record<string, unknown>,
        afterData: null,
        operatorId,
        requestId,
      });
    });
    return { success: true };
  }
}
