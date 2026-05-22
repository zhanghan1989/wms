import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma, ProductEditRequestStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { normalizeNullableText, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSkuEditRequestDto } from './dto/create-sku-edit-request.dto';

type ProductSnapshot = {
  productId: string | null;
  sku: string | null;
  rbSku: string | null;
  asin: string | null;
  fnsku: string | null;
  fbmSku: string | null;
  shop: string | null;
  remark: string | null;
};

type SkuEditRequestListResult = {
  items: unknown[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

const SNAPSHOT_FIELDS: Array<keyof ProductSnapshot> = [
  'productId',
  'rbSku',
  'asin',
  'fnsku',
  'fbmSku',
  'shop',
  'remark',
];

const PRODUCT_EDIT_CONFIRM_PERMISSION_MESSAGE_FACTORY =
  '只有工厂部门管理员或系统管理员可以确认产品编辑申请';

function ensureSnapshot(value: unknown): ProductSnapshot {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    productId: normalizeNullableText(source.productId),
    sku: normalizeNullableText(source.sku),
    rbSku: normalizeNullableText(source.rbSku),
    asin: normalizeNullableText(source.asin),
    fnsku: normalizeNullableText(source.fnsku),
    fbmSku: normalizeNullableText(source.fbmSku),
    shop: normalizeNullableText(source.shop),
    remark: normalizeNullableText(source.remark),
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

  async list(pageRaw?: string | number, pageSizeRaw?: string | number): Promise<SkuEditRequestListResult> {
    const page = this.normalizePositiveInt(pageRaw, 1);
    const pageSize = Math.min(this.normalizePositiveInt(pageSizeRaw, 30), 100);
    const skip = (page - 1) * pageSize;
    const requests = await this.prisma.productEditRequest.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: pageSize + 1,
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
    return {
      items: requests.slice(0, pageSize) as unknown[],
      page,
      pageSize,
      hasMore: requests.length > pageSize,
    };
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
      throw new NotFoundException('产品编辑申请不存在');
    }

    return this.attachProductNames(request);
  }

  async create(
    payload: CreateSkuEditRequestDto,
    operatorId: bigint,
    _requestId?: string,
  ): Promise<unknown> {
    const skuId = BigInt(payload.skuId);
    const sku = await this.prisma.sku.findFirst({
      where: {
        id: skuId,
        status: 1,
      },
    });
    if (!sku) {
      throw new NotFoundException('SKU不存在');
    }

    const beforeData: ProductSnapshot = {
      productId: normalizeNullableText(sku.productId),
      sku: normalizeNullableText(sku.sku),
      rbSku: normalizeNullableText(sku.rbSku),
      asin: normalizeNullableText(sku.asin),
      fnsku: normalizeNullableText(sku.fnsku),
      fbmSku: normalizeNullableText(sku.fbmSku),
      shop: normalizeNullableText(sku.shop),
      remark: normalizeNullableText(sku.remark),
    };

    const resolveEditableField = (
      field: keyof ProductSnapshot,
      fallback: string | null,
    ): string | null => {
      const rawPayload = payload as unknown as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(rawPayload, field)) {
        const value = rawPayload[field];
        if (value === undefined) {
          return fallback;
        }
        return normalizeNullableText(value);
      }
      return fallback;
    };

    const afterData: ProductSnapshot = {
      productId: resolveEditableField('productId', beforeData.productId),
      sku: beforeData.sku,
      rbSku: resolveEditableField('rbSku', beforeData.rbSku),
      asin: resolveEditableField('asin', beforeData.asin),
      fnsku: resolveEditableField('fnsku', beforeData.fnsku),
      fbmSku: resolveEditableField('fbmSku', beforeData.fbmSku),
      shop: resolveEditableField('shop', beforeData.shop),
      remark: resolveEditableField('remark', beforeData.remark),
    };

    const changedFields = SNAPSHOT_FIELDS.filter((field) => beforeData[field] !== afterData[field]);
    if (!changedFields.length) {
      throw new BadRequestException('未检测到任何字段变更');
    }

    await this.ensureSkuCodeAvailable(afterData.sku, skuId, beforeData.sku);

    return this.createPendingEditRequest(this.prisma, {
      skuId,
      beforeData,
      afterData,
      changedFields,
      createdBy: operatorId,
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
      throw new NotFoundException('产品编辑申请不存在');
    }
    if (request.status !== ProductEditRequestStatus.pending) {
      throw new BadRequestException('当前申请已处理完成');
    }
    await this.ensureCanConfirmByOperator(operatorId);

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
          status: 1,
          id: { not: request.skuId },
        },
        select: { id: true },
      });
      if (duplicated) {
        throw new BadRequestException('SKU 已存在');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const skuUpdateData: Prisma.SkuUncheckedUpdateInput = {
        productId: afterSnapshot.productId,
        sku: targetSkuCode,
        rbSku: afterSnapshot.rbSku,
        asin: afterSnapshot.asin,
        fnsku: afterSnapshot.fnsku,
        fbmSku: afterSnapshot.fbmSku,
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

      return this.attachProductNames(updatedRequest);
    });
  }

  private async createPendingEditRequest(
    db: Prisma.TransactionClient | PrismaService,
    payload: {
      skuId: bigint;
      beforeData: ProductSnapshot;
      afterData: ProductSnapshot;
      changedFields: Array<keyof ProductSnapshot>;
      createdBy: bigint;
    },
  ): Promise<unknown> {
    const created = await db.productEditRequest.create({
      data: {
        skuId: payload.skuId,
        status: ProductEditRequestStatus.pending,
        beforeData: payload.beforeData as unknown as object,
        afterData: payload.afterData as unknown as object,
        changedFields: payload.changedFields,
        createdBy: payload.createdBy,
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
    return this.attachProductNames(created);
  }

  private async attachProductNames<T extends { beforeData?: unknown; afterData?: unknown }>(
    requestOrRequests: T | T[],
  ): Promise<unknown> {
    const requests = Array.isArray(requestOrRequests) ? requestOrRequests : [requestOrRequests];
    const productIds = Array.from(
      new Set(
        requests
          .flatMap((request) => {
            const beforeSnapshot = ensureSnapshot(request.beforeData);
            const afterSnapshot = ensureSnapshot(request.afterData);
            return [beforeSnapshot.productId, afterSnapshot.productId];
          })
          .filter((productId): productId is string => Boolean(String(productId || '').trim())),
      ),
    );

    const productNameById = new Map<string, string | null>();
    if (productIds.length > 0) {
      const products = await this.prisma.masterProduct.findMany({
        where: {
          productId: {
            in: productIds,
          },
        },
        select: {
          productId: true,
          productName: true,
        },
      });
      products.forEach((product) => {
        productNameById.set(product.productId, product.productName ?? null);
      });
    }

    const enriched = requests.map((request) => {
      const beforeSnapshot = ensureSnapshot(request.beforeData);
      const afterSnapshot = ensureSnapshot(request.afterData);
      return {
        ...request,
        beforeData: {
          ...beforeSnapshot,
          productName: beforeSnapshot.productId
            ? (productNameById.get(beforeSnapshot.productId) ?? null)
            : null,
        },
        afterData: {
          ...afterSnapshot,
          productName: afterSnapshot.productId
            ? (productNameById.get(afterSnapshot.productId) ?? null)
            : null,
        },
      };
    });

    return Array.isArray(requestOrRequests) ? enriched : enriched[0];
  }

  private async ensureSkuCodeAvailable(
    targetSkuCode: string | null,
    currentSkuId: bigint,
    currentSkuCode: string | null,
  ): Promise<void> {
    if (!targetSkuCode || targetSkuCode === currentSkuCode) {
      return;
    }
    const duplicated = await this.prisma.sku.findFirst({
      where: {
        sku: targetSkuCode,
        status: 1,
        id: { not: currentSkuId },
      },
      select: { id: true },
    });
    if (duplicated) {
      throw new BadRequestException('SKU 已存在');
    }
  }

  private async ensureCanConfirmByOperator(operatorId: bigint): Promise<void> {
    const requiredDepartmentCode = 'factory';
    const denyMessage = PRODUCT_EDIT_CONFIRM_PERMISSION_MESSAGE_FACTORY;

    const [operator, departmentOption, roleOption] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: operatorId },
        select: {
          id: true,
          role: true,
          department: true,
          status: true,
        },
      }),
      this.prisma.departmentOption.findUnique({
        where: { code: requiredDepartmentCode },
        select: {
          status: true,
        },
      }),
      this.prisma.roleOption.findMany({
        where: {
          code: {
            in: ['admin', 'system_admin'],
          },
        },
        select: {
          code: true,
          status: true,
        },
      }),
    ]);

    const roleStatusMap = new Map(roleOption.map((item) => [String(item.code), Number(item.status ?? 1)]));
    const operatorRole = String(operator?.role ?? '');
    const isSystemAdmin = operatorRole === 'system_admin';
    const isFactoryAdmin =
      operatorRole === 'admin' &&
      String(operator?.department) === String(requiredDepartmentCode) &&
      Number(departmentOption?.status ?? 1) === 1;
    const isAllowed =
      Boolean(operator) &&
      Number(operator?.status) === 1 &&
      (isSystemAdmin || isFactoryAdmin) &&
      Number(roleStatusMap.get(operatorRole) ?? 1) === 1;

    if (!isAllowed) {
      throw new ForbiddenException(denyMessage);
    }
  }

  async markDeleted(idParam: string, _operatorId: bigint, _requestId?: string): Promise<unknown> {
    const id = parseId(idParam, 'productEditRequestId');
    const request = await this.prisma.productEditRequest.findUnique({ where: { id } });
    if (!request) {
      throw new NotFoundException('产品编辑申请不存在');
    }
    if (request.status !== ProductEditRequestStatus.pending) {
      throw new BadRequestException('当前申请不能删除');
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

  private normalizePositiveInt(value: string | number | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }
}
