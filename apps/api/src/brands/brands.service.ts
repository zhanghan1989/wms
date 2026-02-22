import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(q?: string): Promise<unknown[]> {
    return this.prisma.brand.findMany({
      where: q ? { name: { contains: q } } : undefined,
      orderBy: [{ status: 'desc' }, { id: 'desc' }],
    });
  }

  async create(payload: CreateBrandDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const name = payload.name.trim();
    if (!name) {
      throw new BadRequestException('品牌名称不能为空');
    }
    const exists = await this.prisma.brand.findUnique({ where: { name } });
    if (exists) {
      throw new BadRequestException('品牌已存在');
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.brand.create({
        data: {
          name,
          status: payload.status ?? 1,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'brand',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.BRAND_CREATED,
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
    payload: UpdateBrandDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'brandId');
    const brand = await this.prisma.brand.findUnique({ where: { id } });
    if (!brand) {
      throw new NotFoundException('品牌不存在');
    }

    const name = payload.name?.trim();
    if (name && name !== brand.name) {
      const duplicate = await this.prisma.brand.findUnique({ where: { name } });
      if (duplicate) {
        throw new BadRequestException('品牌已存在');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.brand.update({
        where: { id },
        data: {
          ...(name ? { name } : {}),
          ...(payload.status === undefined ? {} : { status: payload.status }),
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'brand',
        entityId: updated.id,
        action: AuditAction.update,
        eventType: AuditEventType.BRAND_UPDATED,
        beforeData: brand as unknown as Record<string, unknown>,
        afterData: updated as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });
      return updated;
    });
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'brandId');
    const brand = await this.prisma.brand.findUnique({ where: { id } });
    if (!brand) {
      throw new NotFoundException('品牌不存在');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.brand.delete({ where: { id } });
      await this.auditService.create({
        db: tx,
        entityType: 'brand',
        entityId: id,
        action: AuditAction.delete,
        eventType: AuditEventType.BRAND_DELETED,
        beforeData: brand as unknown as Record<string, unknown>,
        afterData: null,
        operatorId,
        requestId,
      });
    });
    return { success: true };
  }
}
