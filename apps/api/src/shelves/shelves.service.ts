import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
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
    const shelfCode = this.normalizeShelfCode(payload.shelfCode);
    if (!shelfCode) throw new BadRequestException('货架号格式无效');
    const exists = await this.prisma.shelf.findFirst({
      where: {
        OR: [{ shelfCode }, { shelfCode: this.toLegacyShelfCode(shelfCode) }],
      },
    });
    if (exists) throw new BadRequestException('货架号已存在');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.shelf.create({
        data: {
          shelfCode,
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
    if (!shelf) throw new NotFoundException('货架不存在');

    if (payload.shelfCode) {
      payload.shelfCode = this.normalizeShelfCode(payload.shelfCode);
      if (!payload.shelfCode) {
        throw new BadRequestException('货架号格式无效');
      }
    }

    if (payload.shelfCode && payload.shelfCode !== shelf.shelfCode) {
      const duplicate = await this.prisma.shelf.findFirst({
        where: {
          id: { not: id },
          OR: [{ shelfCode: payload.shelfCode }, { shelfCode: this.toLegacyShelfCode(payload.shelfCode) }],
        },
      });
      if (duplicate) {
        throw new BadRequestException('货架号已存在');
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

  async getDeleteCheck(idParam: string): Promise<{ canDelete: boolean; reasons: string[] }> {
    const id = parseId(idParam, 'shelfId');
    const shelf = await this.prisma.shelf.findUnique({
      where: { id },
      select: { id: true, shelfCode: true },
    });
    if (!shelf) throw new NotFoundException('货架不存在');

    const [boxCount, sampleBoxes] = await Promise.all([
      this.prisma.box.count({ where: { shelfId: id } }),
      this.prisma.box.findMany({
        where: { shelfId: id },
        select: { boxCode: true },
        orderBy: { boxCode: 'asc' },
        take: 3,
      }),
    ]);

    const reasons: string[] = [];
    if (boxCount > 0) {
      const sample = sampleBoxes.map((item) => item.boxCode).join('、');
      const sampleText = sample ? `（如：${sample}${boxCount > sampleBoxes.length ? ' 等' : ''}）` : '';
      reasons.push(`货架下仍有 ${boxCount} 个箱号${sampleText}`);
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
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('货架下仍有关联箱号或历史单据，无法删除。请先迁移箱号，或改为禁用。');
      }
      throw error;
    }
    return { success: true };
  }

  private normalizeShelfCode(raw: string | null | undefined): string {
    const value = String(raw ?? '').trim().toUpperCase();
    if (!value) return '';

    if (/^\d{1,3}$/.test(value)) {
      return value.padStart(Math.max(2, value.length), '0');
    }

    const matched = value.match(/^S[-_\s]?(\d{1,3})$/);
    if (!matched) {
      return '';
    }
    return matched[1].padStart(Math.max(2, matched[1].length), '0');
  }

  private toLegacyShelfCode(normalized: string): string {
    return `S-${normalized}`;
  }
}
