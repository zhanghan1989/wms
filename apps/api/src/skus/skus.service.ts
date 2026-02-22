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
      throw new BadRequestException('SKU已存在');
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
    void idParam;
    void payload;
    void operatorId;
    void requestId;
    throw new BadRequestException('请通过产品管理页面提交编辑申请，不能直接修改产品数据');
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'skuId');
    const sku = await this.prisma.sku.findUnique({ where: { id } });
    if (!sku) throw new NotFoundException('SKU不存在');
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
