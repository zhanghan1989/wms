import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma, ProductEditRequestStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSkuEditRequestDto } from './dto/create-sku-edit-request.dto';

type ProductSnapshot = {
  sku: string | null;
  erpSku: string | null;
  asin: string | null;
  fnsku: string | null;
  model: string | null;
  brand: string | null;
  type: string | null;
  color: string | null;
  shop: string | null;
  remark: string | null;
};

const SNAPSHOT_FIELDS: Array<keyof ProductSnapshot> = [
  'sku',
  'erpSku',
  'asin',
  'fnsku',
  'model',
  'brand',
  'type',
  'color',
  'shop',
  'remark',
];

function normalizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function ensureSnapshot(value: unknown): ProductSnapshot {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    sku: normalizeNullableString(source.sku),
    erpSku: normalizeNullableString(source.erpSku),
    asin: normalizeNullableString(source.asin),
    fnsku: normalizeNullableString(source.fnsku),
    model: normalizeNullableString(source.model),
    brand: normalizeNullableString(source.brand),
    type: normalizeNullableString(source.type),
    color: normalizeNullableString(source.color),
    shop: normalizeNullableString(source.shop),
    remark: normalizeNullableString(source.remark),
  };
}

@Injectable()
export class SkuEditRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async pendingSummary(): Promise<{ pendingCount: number }> {
    const pendingCount = await this.prisma.productEditRequest.count({
      where: { status: ProductEditRequestStatus.pending },
    });
    return { pendingCount };
  }

  async list(): Promise<unknown[]> {
    return this.prisma.productEditRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        sku: {
          select: {
            id: true,
            sku: true,
          },
        },
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });
  }

  async detail(idParam: string): Promise<unknown> {
    const id = parseId(idParam, 'productEditRequestId');
    const request = await this.prisma.productEditRequest.findUnique({
      where: { id },
      include: {
        sku: {
          select: {
            id: true,
            sku: true,
          },
        },
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('编辑申请不存在');
    }

    return request;
  }

  async create(
    payload: CreateSkuEditRequestDto,
    operatorId: bigint,
    _requestId?: string,
  ): Promise<unknown> {
    const skuId = BigInt(payload.skuId);
    const sku = await this.prisma.sku.findUnique({ where: { id: skuId } });
    if (!sku) {
      throw new NotFoundException('SKU不存在');
    }

    const beforeData: ProductSnapshot = {
      sku: normalizeNullableString(sku.sku),
      erpSku: normalizeNullableString(sku.erpSku),
      asin: normalizeNullableString(sku.asin),
      fnsku: normalizeNullableString(sku.fnsku),
      model: normalizeNullableString(sku.model),
      brand: normalizeNullableString(sku.brand),
      type: normalizeNullableString(sku.type),
      color: normalizeNullableString(sku.color),
      shop: normalizeNullableString(sku.shop),
      remark: normalizeNullableString(sku.remark),
    };

    const afterData: ProductSnapshot = {
      sku: normalizeNullableString(payload.sku ?? sku.sku),
      erpSku: normalizeNullableString(payload.erpSku ?? sku.erpSku),
      asin: normalizeNullableString(payload.asin ?? sku.asin),
      fnsku: normalizeNullableString(payload.fnsku ?? sku.fnsku),
      model: normalizeNullableString(payload.model ?? sku.model),
      brand: normalizeNullableString(payload.brand ?? sku.brand),
      type: normalizeNullableString(payload.type ?? sku.type),
      color: normalizeNullableString(payload.color ?? sku.color),
      shop: normalizeNullableString(payload.shop ?? sku.shop),
      remark: normalizeNullableString(payload.remark ?? sku.remark),
    };

    const changedFields = SNAPSHOT_FIELDS.filter((field) => beforeData[field] !== afterData[field]);
    if (!changedFields.length) {
      throw new BadRequestException('未检测到变更内容');
    }

    return this.prisma.productEditRequest.create({
      data: {
        skuId,
        status: ProductEditRequestStatus.pending,
        beforeData: beforeData as unknown as object,
        afterData: afterData as unknown as object,
        changedFields,
        createdBy: operatorId,
      },
      include: {
        sku: {
          select: {
            id: true,
            sku: true,
          },
        },
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });
  }

  async confirm(idParam: string, operatorId: bigint, requestId?: string): Promise<unknown> {
    const id = parseId(idParam, 'productEditRequestId');
    const request = await this.prisma.productEditRequest.findUnique({
      where: { id },
      include: {
        sku: true,
        creator: {
          select: { id: true, username: true },
        },
      },
    });
    if (!request) {
      throw new NotFoundException('编辑申请不存在');
    }
    if (request.status !== ProductEditRequestStatus.pending) {
      throw new BadRequestException('仅待处理申请可确认');
    }

    const beforeSnapshot = ensureSnapshot(request.beforeData);
    const afterSnapshot = ensureSnapshot(request.afterData);
    if (!afterSnapshot.sku) {
      throw new BadRequestException('SKU不能为空');
    }
    const targetSkuCode = afterSnapshot.sku;

    if (targetSkuCode !== request.sku.sku) {
      const duplicated = await this.prisma.sku.findFirst({
        where: {
          sku: targetSkuCode,
          id: { not: request.skuId },
        },
        select: { id: true },
      });
      if (duplicated) {
        throw new BadRequestException('SKU已存在');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const skuUpdateData: Prisma.SkuUpdateInput = {
        sku: targetSkuCode,
        erpSku: afterSnapshot.erpSku,
        asin: afterSnapshot.asin,
        fnsku: afterSnapshot.fnsku,
        model: afterSnapshot.model,
        brand: afterSnapshot.brand,
        type: afterSnapshot.type,
        color: afterSnapshot.color,
        shop: afterSnapshot.shop,
        remark: afterSnapshot.remark,
      };

      const updatedSku = await tx.sku.update({
        where: { id: request.skuId },
        data: skuUpdateData,
      });

      const updatedRequest = await tx.productEditRequest.update({
        where: { id },
        data: {
          status: ProductEditRequestStatus.confirmed,
        },
        include: {
          sku: {
            select: {
              id: true,
              sku: true,
            },
          },
          creator: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'sku',
        entityId: updatedSku.id,
        action: AuditAction.update,
        eventType: AuditEventType.SKU_FIELD_UPDATED,
        beforeData: beforeSnapshot as unknown as Record<string, unknown>,
        afterData: afterSnapshot as unknown as Record<string, unknown>,
        operatorId,
        requestId,
      });

      return updatedRequest;
    });
  }

  async markDeleted(idParam: string, _operatorId: bigint, _requestId?: string): Promise<unknown> {
    const id = parseId(idParam, 'productEditRequestId');
    const request = await this.prisma.productEditRequest.findUnique({ where: { id } });
    if (!request) {
      throw new NotFoundException('编辑申请不存在');
    }
    if (request.status !== ProductEditRequestStatus.pending) {
      throw new BadRequestException('仅待处理申请可删除');
    }

    return this.prisma.productEditRequest.update({
      where: { id },
      data: { status: ProductEditRequestStatus.deleted },
      include: {
        sku: {
          select: {
            id: true,
            sku: true,
          },
        },
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
      },
    });
  }
}
