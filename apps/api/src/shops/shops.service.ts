import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShopDto } from './dto/create-shop.dto';
import { UpdateShopDto } from './dto/update-shop.dto';

@Injectable()
export class ShopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(q?: string): Promise<unknown[]> {
    return this.prisma.shop.findMany({
      where: q ? { name: { contains: q } } : undefined,
      orderBy: [{ status: 'desc' }, { id: 'desc' }],
    });
  }

  async create(payload: CreateShopDto, operatorId: bigint, requestId?: string): Promise<unknown> {
    const name = payload.name.trim();
    if (!name) {
      throw new BadRequestException('店铺名称不能为空');
    }
    const exists = await this.prisma.shop.findUnique({ where: { name } });
    if (exists) {
      throw new BadRequestException('店铺已存在');
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.shop.create({
        data: {
          name,
          status: payload.status ?? 1,
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'shop',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.SHOP_CREATED,
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
    payload: UpdateShopDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const id = parseId(idParam, 'shopId');
    const shop = await this.prisma.shop.findUnique({ where: { id } });
    if (!shop) {
      throw new NotFoundException('店铺不存在');
    }

    const name = payload.name?.trim();
    if (name && name !== shop.name) {
      const duplicate = await this.prisma.shop.findUnique({ where: { name } });
      if (duplicate) {
        throw new BadRequestException('店铺已存在');
      }
      await this.assertSkuShopMoveHasNoConflict(shop.name, name, '重命名店铺');
    }

    return this.prisma.$transaction(async (tx) => {
      let affectedSkuCount = 0;
      if (name && name !== shop.name) {
        const renameResult = await tx.sku.updateMany({
          where: { shop: shop.name },
          data: { shop: name },
        });
        affectedSkuCount = renameResult.count;
      }

      const updated = await tx.shop.update({
        where: { id },
        data: {
          ...(name ? { name } : {}),
          ...(payload.status === undefined ? {} : { status: payload.status }),
        },
      });
      await this.auditService.create({
        db: tx,
        entityType: 'shop',
        entityId: updated.id,
        action: AuditAction.update,
        eventType: AuditEventType.SHOP_UPDATED,
        beforeData: shop as unknown as Record<string, unknown>,
        afterData: {
          ...(updated as unknown as Record<string, unknown>),
          affectedSkuCount,
        },
        operatorId,
        requestId,
      });
      return updated;
    });
  }

  async remove(idParam: string, operatorId: bigint, requestId?: string): Promise<{ success: boolean }> {
    const id = parseId(idParam, 'shopId');
    const shop = await this.prisma.shop.findUnique({ where: { id } });
    if (!shop) {
      throw new NotFoundException('店铺不存在');
    }

    await this.assertSkuShopMoveHasNoConflict(shop.name, '', '删除店铺');

    await this.prisma.$transaction(async (tx) => {
      const clearResult = await tx.sku.updateMany({
        where: { shop: shop.name },
        data: { shop: '' },
      });

      await tx.shop.delete({ where: { id } });
      await this.auditService.create({
        db: tx,
        entityType: 'shop',
        entityId: id,
        action: AuditAction.delete,
        eventType: AuditEventType.SHOP_DELETED,
        beforeData: {
          ...(shop as unknown as Record<string, unknown>),
          affectedSkuCount: clearResult.count,
        },
        afterData: null,
        operatorId,
        requestId,
      });
    });
    return { success: true };
  }

  private async assertSkuShopMoveHasNoConflict(
    sourceShop: string,
    targetShop: string,
    actionLabel: string,
  ): Promise<void> {
    const normalizedSourceShop = String(sourceShop ?? '').trim();
    const normalizedTargetShop = String(targetShop ?? '').trim();
    if (normalizedSourceShop === normalizedTargetShop) {
      return;
    }

    const sourceRows = await this.prisma.sku.findMany({
      where: {
        shop: normalizedSourceShop,
        status: 1,
      },
      select: {
        sku: true,
      },
    });
    if (!sourceRows.length) {
      return;
    }

    const sourceSkuSet = new Set(sourceRows.map((row) => row.sku));
    const targetRows = await this.prisma.sku.findMany({
      where: {
        shop: normalizedTargetShop,
        sku: {
          in: Array.from(sourceSkuSet),
        },
        status: 1,
      },
      select: {
        sku: true,
      },
      orderBy: [{ sku: 'asc' }, { id: 'asc' }],
    });
    if (!targetRows.length) {
      return;
    }

    const conflictSkus = Array.from(new Set(targetRows.map((row) => row.sku))).slice(0, 20);
    const suffix = targetRows.length > 20 ? ' 等' : '';
    const targetName = normalizedTargetShop || '空店铺';
    throw new BadRequestException(
      `${actionLabel}会造成 SKU + 店铺 重复。目标店铺「${targetName}」已存在这些 SKU：${conflictSkus.join('、')}${suffix}`,
    );
  }
}
