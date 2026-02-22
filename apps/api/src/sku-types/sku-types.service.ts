import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSkuTypeDto } from './dto/create-sku-type.dto';
import { UpdateSkuTypeDto } from './dto/update-sku-type.dto';

@Injectable()
export class SkuTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(q?: string): Promise<unknown[]> {
    return this.prisma.skuType.findMany({
      where: q ? { name: { contains: q } } : undefined,
      orderBy: [{ status: 'desc' }, { id: 'desc' }],
    });
  }

  async create(payload: CreateSkuTypeDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const name = payload.name.trim();
    if (!name) {
      throw new BadRequestException('类型名称不能为空');
    }
    const exists = await this.prisma.skuType.findUnique({ where: { name } });
    if (exists) {
      throw new BadRequestException('类型已存在');
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.skuType.create({
        data: {
          name,
          status: payload.status ?? 1,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'sku_type',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.SKU_TYPE_CREATED,
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
    payload: UpdateSkuTypeDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'skuTypeId');
    const skuType = await this.prisma.skuType.findUnique({ where: { id } });
    if (!skuType) {
      throw new NotFoundException('类型不存在');
    }

    const name = payload.name?.trim();
    if (name && name !== skuType.name) {
      const duplicate = await this.prisma.skuType.findUnique({ where: { name } });
      if (duplicate) {
        throw new BadRequestException('类型已存在');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.skuType.update({
        where: { id },
        data: {
          ...(name ? { name } : {}),
          ...(payload.status === undefined ? {} : { status: payload.status }),
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'sku_type',
        entityId: updated.id,
        action: AuditAction.update,
        eventType: AuditEventType.SKU_TYPE_UPDATED,
        beforeData: skuType as unknown as Record<string, unknown>,
        afterData: updated as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return updated;
    });
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'skuTypeId');
    const skuType = await this.prisma.skuType.findUnique({ where: { id } });
    if (!skuType) {
      throw new NotFoundException('类型不存在');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.skuType.delete({ where: { id } });
      await this.auditService.create({
        db: tx,
        entityType: 'sku_type',
        entityId: id,
        action: AuditAction.delete,
        eventType: AuditEventType.SKU_TYPE_DELETED,
        beforeData: skuType as unknown as Record<string, unknown>,
        afterData: null,
        operatorId,
        requestId,
      });
    });
    return { success: true };
  }
}
