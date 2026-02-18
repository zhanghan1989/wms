import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSkuDto } from './dto/create-sku.dto';
import { UpdateSkuDto } from './dto/update-sku.dto';

@Injectable()
export class SkusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(q?: string): Promise<unknown[]> {
    const where: Prisma.SkuWhereInput = {};
    if (q) {
      where.OR = [
        { sku: { contains: q } },
        { erpSku: { contains: q } },
        { asin: { contains: q } },
        { fnsku: { contains: q } },
      ];
    }
    return this.prisma.sku.findMany({
      where,
      orderBy: { id: 'desc' },
    });
  }

  async create(
    payload: CreateSkuDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const exists = await this.prisma.sku.findUnique({ where: { sku: payload.sku } });
    if (exists) {
      throw new BadRequestException('sku already exists');
    }
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.sku.create({
        data: payload,
      });
      await this.auditService.create({
        db: tx,
        entityType: 'sku',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.SKU_CREATED,
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
    payload: UpdateSkuDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'skuId');
    const sku = await this.prisma.sku.findUnique({ where: { id } });
    if (!sku) throw new NotFoundException('sku not found');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.sku.update({
        where: { id },
        data: payload,
      });
      const eventType = updated.status === 0 ? AuditEventType.SKU_DISABLED : AuditEventType.SKU_FIELD_UPDATED;
      await this.auditService.create({
        db: tx,
        entityType: 'sku',
        entityId: updated.id,
        action: AuditAction.update,
        eventType,
        beforeData: sku as unknown as Record<string, unknown>,
        afterData: updated as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return updated;
    });
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'skuId');
    const sku = await this.prisma.sku.findUnique({ where: { id } });
    if (!sku) throw new NotFoundException('sku not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.sku.delete({ where: { id } });
      await this.auditService.create({
        db: tx,
        entityType: 'sku',
        entityId: id,
        action: AuditAction.delete,
        eventType: AuditEventType.SKU_DELETED,
        beforeData: sku as unknown as Record<string, unknown>,
        afterData: null,
        operatorId,
        requestId,
      });
    });
    return { success: true };
  }
}
