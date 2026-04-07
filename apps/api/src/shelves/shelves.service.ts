import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShelfDto } from './dto/create-shelf.dto';
import { UpdateShelfDto } from './dto/update-shelf.dto';

interface ShelfAuditArgs {
  auditService: AuditService;
  tx: Prisma.TransactionClient;
  entityId: bigint;
  action: AuditAction;
  eventType: (typeof AuditEventType)[keyof typeof AuditEventType];
  beforeData: Record<string, unknown> | null | undefined;
  afterData: Record<string, unknown> | null | undefined;
  operatorId: bigint;
  requestId?: string;
}

// Archived boxes may still reference historical default shelf codes in old records.
const ARCHIVED_BOX_FALLBACK_SHELF_CODES = ['00', 'S-00', 'Z-0'];

async function createShelfAudit({
  auditService,
  tx,
  entityId,
  action,
  eventType,
  beforeData,
  afterData,
  operatorId,
  requestId,
}: ShelfAuditArgs): Promise<void> {
  await auditService.create({
    db: tx,
    entityType: 'shelf',
    entityId,
    action,
    eventType,
    beforeData,
    afterData,
    operatorId,
    requestId,
  });
}

async function reassignArchivedBoxesBeforeShelfDelete(
  tx: Prisma.TransactionClient,
  shelfId: bigint,
): Promise<void> {
  const archivedBoxCount = await tx.box.count({
    where: { shelfId, status: 0 },
  });
  if (archivedBoxCount <= 0) {
    return;
  }

  const fallbackShelf = await tx.shelf.findFirst({
    where: {
      id: { not: shelfId },
      status: 1,
      shelfCode: { in: ARCHIVED_BOX_FALLBACK_SHELF_CODES },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (!fallbackShelf) {
    throw new BadRequestException('未找到可承接归档箱的兼容货架，无法删除当前货架');
  }

  await tx.box.updateMany({
    where: { shelfId, status: 0 },
    data: { shelfId: fallbackShelf.id },
  });
}

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
            OR: [{ shelfCode: { contains: q } }, { name: { contains: q } }],
          }
        : undefined,
      orderBy: { id: 'desc' },
    });
  }

  async create(payload: CreateShelfDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const shelfCode = this.normalizeShelfCode(payload.shelfCode);
    if (!shelfCode) throw new BadRequestException('货架编码格式错误');
    const exists = await this.prisma.shelf.findFirst({
      where: {
        shelfCode: { in: this.buildEquivalentShelfCodes(shelfCode) },
      },
    });
    if (exists) throw new BadRequestException('货架编码已存在');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.shelf.create({
        data: {
          shelfCode,
          name: payload.name ?? null,
          status: payload.status ?? 1,
        },
      });
      await createShelfAudit({
        auditService: this.auditService,
        tx,
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
    if (!shelf) throw new NotFoundException('货架不存在');

    if (payload.shelfCode) {
      payload.shelfCode = this.normalizeShelfCode(payload.shelfCode);
      if (!payload.shelfCode) {
        throw new BadRequestException('货架编码格式错误');
      }
    }

    if (payload.shelfCode && payload.shelfCode !== shelf.shelfCode) {
      const duplicate = await this.prisma.shelf.findFirst({
        where: {
          id: { not: id },
          shelfCode: { in: this.buildEquivalentShelfCodes(payload.shelfCode) },
        },
      });
      if (duplicate) {
        throw new BadRequestException('货架编码已存在');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.shelf.update({
        where: { id },
        data: payload,
      });
      const eventType =
        updated.status === 0 ? AuditEventType.SHELF_DISABLED : AuditEventType.SHELF_FIELD_UPDATED;
      await createShelfAudit({
        auditService: this.auditService,
        tx,
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

  async getDeleteCheck(idParam: string): Promise<{ canDelete: boolean; reasons: string[] }> {
    const id = parseId(idParam, 'shelfId');
    const shelf = await this.prisma.shelf.findUnique({
      where: { id },
      select: { id: true, shelfCode: true },
    });
    if (!shelf) throw new NotFoundException('货架不存在');

    const [boxCount, sampleBoxes] = await Promise.all([
      this.prisma.box.count({ where: { shelfId: id, status: 1 } }),
      this.prisma.box.findMany({
        where: { shelfId: id, status: 1 },
        select: { boxCode: true },
        orderBy: { boxCode: 'asc' },
        take: 3,
      }),
    ]);

    const reasons: string[] = [];
    if (boxCount > 0) {
      const sample = sampleBoxes.map((item) => item.boxCode).join('、');
      const sampleText = sample
        ? `，例如：${sample}${boxCount > sampleBoxes.length ? ' 等' : ''}`
        : '';
      reasons.push(`货架下仍有 ${boxCount} 个启用中的箱号${sampleText}`);
    }

    return {
      canDelete: reasons.length === 0,
      reasons,
    };
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'shelfId');
    const shelf = await this.prisma.shelf.findUnique({ where: { id } });
    if (!shelf) throw new NotFoundException('货架不存在');
    const check = await this.getDeleteCheck(idParam);
    if (!check.canDelete) {
      throw new BadRequestException(`货架无法删除：${check.reasons.join('；')}`);
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await reassignArchivedBoxesBeforeShelfDelete(tx, id);
        await tx.shelf.delete({ where: { id } });
        await createShelfAudit({
          auditService: this.auditService,
          tx,
          entityId: id,
          action: AuditAction.delete,
          eventType: AuditEventType.SHELF_DELETED,
          beforeData: shelf as unknown as Record<string, unknown>,
          afterData: null,
          operatorId,
          requestId,
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('货架仍有关联箱号或历史记录，无法删除');
      }
      throw error;
    }
    return { success: true };
  }

  private normalizeShelfCode(raw: string | null | undefined): string {
    const value = String(raw ?? '').trim().toUpperCase();
    if (!value) return '';

    if (/^(?:00|[A-Z][0-9])$/.test(value)) {
      return value;
    }
    return '';
  }

  private buildEquivalentShelfCodes(normalized: string): string[] {
    const codes = new Set<string>([normalized]);
    if (normalized === '00') {
      codes.add('S-00');
      codes.add('Z-0');
    }
    return Array.from(codes);
  }
}
