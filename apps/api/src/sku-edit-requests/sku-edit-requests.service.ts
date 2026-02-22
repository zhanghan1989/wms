import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ProductEditRequestStatus } from '@prisma/client';
import { parseId } from '../common/utils';
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

@Injectable()
export class SkuEditRequestsService {
  constructor(private readonly prisma: PrismaService) {}

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
}
