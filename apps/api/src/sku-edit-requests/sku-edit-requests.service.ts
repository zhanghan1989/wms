import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma, ProductEditRequestStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSkuEditRequestDto } from './dto/create-sku-edit-request.dto';

type ProductSnapshot = {
  sku: string | null;
  rbSku: string | null;
  asin: string | null;
  fnsku: string | null;
  fbmSku: string | null;
  model: string | null;
  brand: string | null;
  type: string | null;
  color: string | null;
  shop: string | null;
  remark: string | null;
};
type EditableProductField = Exclude<keyof ProductSnapshot, 'sku'>;

const SNAPSHOT_FIELDS: Array<keyof ProductSnapshot> = [
  'sku',
  'rbSku',
  'asin',
  'fnsku',
  'fbmSku',
  'model',
  'brand',
  'type',
  'color',
  'shop',
  'remark',
];

const PRODUCT_EDIT_CONFIRM_PERMISSION_MESSAGE_FACTORY = '仅启用的佛山工厂管理者可确认编辑申请';

function normalizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function ensureSnapshot(value: unknown): ProductSnapshot {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    sku: normalizeNullableString(source.sku),
    rbSku: normalizeNullableString(source.rbSku),
    asin: normalizeNullableString(source.asin),
    fnsku: normalizeNullableString(source.fnsku),
    fbmSku: normalizeNullableString(source.fbmSku),
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
      rbSku: normalizeNullableString(sku.rbSku),
      asin: normalizeNullableString(sku.asin),
      fnsku: normalizeNullableString(sku.fnsku),
      fbmSku: normalizeNullableString(sku.fbmSku),
      model: normalizeNullableString(sku.model),
      brand: normalizeNullableString(sku.brand),
      type: normalizeNullableString(sku.type),
      color: normalizeNullableString(sku.color),
      shop: normalizeNullableString(sku.shop),
      remark: normalizeNullableString(sku.remark),
    };

    const resolveEditableField = (
      field: EditableProductField,
      fallback: string | null,
    ): string | null => {
      const rawPayload = payload as unknown as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(rawPayload, field)) {
        return normalizeNullableString(rawPayload[field]);
      }
      return fallback;
    };

    const afterData: ProductSnapshot = {
      // SKU cannot be edited in product edit requests.
      sku: beforeData.sku,
      rbSku: resolveEditableField('rbSku', beforeData.rbSku),
      asin: resolveEditableField('asin', beforeData.asin),
      fnsku: resolveEditableField('fnsku', beforeData.fnsku),
      fbmSku: resolveEditableField('fbmSku', beforeData.fbmSku),
      model: resolveEditableField('model', beforeData.model),
      brand: resolveEditableField('brand', beforeData.brand),
      type: resolveEditableField('type', beforeData.type),
      color: resolveEditableField('color', beforeData.color),
      shop: resolveEditableField('shop', beforeData.shop),
      remark: resolveEditableField('remark', beforeData.remark),
    };

    const changedFields = SNAPSHOT_FIELDS.filter((field) => beforeData[field] !== afterData[field]);
    if (!changedFields.length) {
      throw new BadRequestException('未检测到变更内容');
    }

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
      throw new NotFoundException('编辑申请不存在');
    }
    if (request.status !== ProductEditRequestStatus.pending) {
      throw new BadRequestException('仅待处理申请可确认');
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
        rbSku: afterSnapshot.rbSku,
        asin: afterSnapshot.asin,
        fnsku: afterSnapshot.fnsku,
        fbmSku: afterSnapshot.fbmSku,
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
    return db.productEditRequest.create({
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

