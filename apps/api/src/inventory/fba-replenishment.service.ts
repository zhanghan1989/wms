import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeBoxCode } from '../common/box-code';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { ConfirmFbaReplenishmentDto } from './dto/confirm-fba-replenishment.dto';
import { CreateFbaReplenishmentDto } from './dto/create-fba-replenishment.dto';
import { OutboundFbaReplenishmentDto } from './dto/outbound-fba-replenishment.dto';
import { FbaReplenishmentResponseDto } from './dto/fba-replenishment-response.dto';
import {
  InventoryService,
  findMasterProductBoxInventoryQty,
  updateMasterProductBoxInventoryQty,
  createFbaReplenishmentCreatedAudit,
  createFbaReplenishmentInventoryAdjustAudit,
  findMasterProductBoxInventoryByPairs,
  getBoxProductInventoryKey,
  createMasterProductInventoryAdjustAudit,
  createBoxInventoryAudit,
} from './inventory.service';

const FBA_REPLENISH_MARK = 'FBA补货';

@Injectable()
export class FbaReplenishmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly inventoryService: InventoryService,
  ) {}



  async deleteFbaReplenishment(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: string; requestNo: string; status: string; idempotent: boolean }> {
    const id = parseId(idParam, 'fbaReplenishmentId');

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fbaReplenishment.findUnique({
        where: { id },
        select: {
          id: true,
          requestNo: true,
          status: true,
          requestedQty: true,
          actualQty: true,
          expressNo: true,
        },
      });
      if (!row) {
        throw new NotFoundException('FBA 补货申请不存在');
      }

      if (String(row.status) === 'deleted') {
        return {
          id: row.id.toString(),
          requestNo: row.requestNo,
          status: String(row.status),
          idempotent: true,
        };
      }

      const deletedAt = new Date();
      const updated = await tx.fbaReplenishment.update({
        where: { id: row.id },
        data: {
          status: 'deleted',
          deletedBy: operatorId,
          deletedAt,
        },
        select: {
          id: true,
          requestNo: true,
          status: true,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'fba_replenishment',
        entityId: row.id,
        action: AuditAction.delete,
        eventType: AuditEventType.INVENTORY_ADJUST_VOIDED,
        beforeData: {
          status: row.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
        },
        afterData: {
          status: updated.status,
          deletedAt,
        },
        operatorId,
        requestId,
      });

      return {
        id: updated.id.toString(),
        requestNo: updated.requestNo,
        status: updated.status,
        idempotent: false,
      };
    });
  }



  async reopenFbaReplenishment(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ id: string; requestNo: string; status: string; idempotent: boolean }> {
    const id = parseId(idParam, 'fbaReplenishmentId');

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fbaReplenishment.findUnique({
        where: { id },
        select: {
          id: true,
          requestNo: true,
          status: true,
          requestedQty: true,
          actualQty: true,
          expressNo: true,
          confirmedBy: true,
          confirmedAt: true,
        },
      });

      if (!row) {
        throw new NotFoundException('FBA 补货申请不存在');
      }
      if (String(row.status) === 'deleted') {
        throw new UnprocessableEntityException(
          '已删除的FBA补货申请单不能变更',
        );
      }
      if (String(row.status) === 'outbound') {
        throw new UnprocessableEntityException(
          '已出库的FBA补货申请单不能变更',
        );
      }
      if (String(row.status) === 'pending_confirm') {
        return {
          id: row.id.toString(),
          requestNo: row.requestNo,
          status: String(row.status),
          idempotent: true,
        };
      }
      if (String(row.status) !== 'pending_outbound') {
        throw new ConflictException(
          `申请单 ${row.requestNo} 当前状态不支持变更`,
        );
      }

      const updated = await tx.fbaReplenishment.update({
        where: { id: row.id },
        data: {
          status: 'pending_confirm',
          confirmedBy: null,
          confirmedAt: null,
        },
        select: {
          id: true,
          requestNo: true,
          status: true,
        },
      });

      await createFbaReplenishmentInventoryAdjustAudit({
        auditService: this.auditService,
        tx,
        entityId: row.id,
        beforeData: {
          status: row.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
          confirmedBy: row.confirmedBy?.toString() ?? null,
          confirmedAt: row.confirmedAt,
        },
        afterData: {
          status: updated.status,
          requestedQty: row.requestedQty,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
          confirmedBy: null,
          confirmedAt: null,
        },
        operatorId,
        requestId,
      });

      return {
        id: updated.id.toString(),
        requestNo: updated.requestNo,
        status: updated.status,
        idempotent: false,
      };
    });
  }



  async listFbaReplenishments(): Promise<FbaReplenishmentResponseDto[]> {
    const rows = await this.prisma.fbaReplenishment.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        sku: {
          select: {
            id: true,
            sku: true,
            fnsku: true,
            productId: true,
            masterProduct: {
              select: {
                productName: true,
              },
            },
          },
        },
        box: {
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { id: true, shelfCode: true } },
          },
        },
      },
    });

    return rows.map((row) => {
      return {
        id: row.id.toString(),
        requestNo: row.requestNo,
        status: row.status,
        createdAt: row.createdAt,
        creator: row.creator
          ? {
              id: row.creator.id.toString(),
              username: row.creator.username,
            }
          : null,
        sku: row.sku
          ? {
              id: row.sku.id.toString(),
              sku: row.sku.sku,
              fnsku: row.sku.fnsku,
              productId: row.sku.productId,
              productName: row.sku.masterProduct?.productName ?? null,
            }
          : null,
        box: row.box
          ? {
              id: row.box.id.toString(),
              boxCode: row.box.boxCode,
              shelfCode: row.box.shelf?.shelfCode ?? null,
            }
          : null,
        requestedQty: row.requestedQty,
        actualQty: row.actualQty,
        expressNo: row.expressNo,
      };
    });
  }



  async getFbaPendingSummary(): Promise<{
    pendingConfirmCount: number;
    pendingBySku: Record<string, number>;
    pendingByBoxSku: Record<string, number>;
  }> {
    const pendingConfirmCount = await this.prisma.fbaReplenishment.count({
      where: {
        status: { in: ['pending_confirm', 'pending_outbound'] },
      },
    });

    const pendingRows = await this.prisma.fbaReplenishment.findMany({
      where: {
        status: { in: ['pending_confirm', 'pending_outbound'] },
      },
      select: {
        skuId: true,
        boxId: true,
        status: true,
        requestedQty: true,
        actualQty: true,
      },
    });

    const pendingBySku: Record<string, number> = {};
    const pendingByBoxSku: Record<string, number> = {};

    pendingRows.forEach((row) => {
      const qty = Number(
        row.status === 'pending_outbound'
          ? (row.actualQty ?? row.requestedQty)
          : row.requestedQty,
      );
      if (qty <= 0) return;

      const skuKey = row.skuId.toString();
      pendingBySku[skuKey] = (pendingBySku[skuKey] ?? 0) + qty;

      const boxSkuKey = `${row.boxId.toString()}-${skuKey}`;
      pendingByBoxSku[boxSkuKey] = (pendingByBoxSku[boxSkuKey] ?? 0) + qty;
    });

    return {
      pendingConfirmCount,
      pendingBySku,
      pendingByBoxSku,
    };
  }



  async buildFbaOutboundExcel(): Promise<{ fileName: string; content: Buffer }> {
    const rows = await this.prisma.fbaReplenishment.findMany({
      where: {
        status: 'outbound',
      },
      orderBy: {
        outboundAt: 'desc',
      },
      include: {
        sku: {
          select: {
            sku: true,
            rbSku: true,
            asin: true,
            fnsku: true,
            fbmSku: true,
            shop: true,
            remark: true,
          },
        },
        box: {
          select: {
            boxCode: true,
            shelf: {
              select: {
                shelfCode: true,
              },
            },
          },
        },
        creator: {
          select: {
            username: true,
          },
        },
        confirmer: {
          select: {
            username: true,
          },
        },
        outbounder: {
          select: {
            username: true,
          },
        },
      },
    });

    const data = rows.map((row) => ({
      '申请单号': row.requestNo ?? '',
      '状态': '已出库',
      'SKU': row.sku?.sku ?? '',
      'rbSKU': row.sku?.rbSku ?? '',
      'ASIN': row.sku?.asin ?? '',
      'FNSKU': row.sku?.fnsku ?? '',
      'FBMSKU': row.sku?.fbmSku ?? '',
      '店铺': row.sku?.shop ?? '',
      '产品备注': row.sku?.remark ?? '',
      '箱号': row.box?.boxCode ?? '',
      '货架号': row.box?.shelf?.shelfCode ?? '',
      '申请数量': Number(row.requestedQty ?? 0),
      '实际数量': Number(row.actualQty ?? row.requestedQty ?? 0),
      '快递单号': row.expressNo ?? '',
      '申请时间': this.inventoryService.formatDateTimeForExport(row.createdAt),
      '确认时间': this.inventoryService.formatDateTimeForExport(row.confirmedAt),
      '出库时间': this.inventoryService.formatDateTimeForExport(row.outboundAt),
      '申请人': row.creator?.username ?? '',
      '确认人': row.confirmer?.username ?? '',
      '出库人': row.outbounder?.username ?? '',
    }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'FBA出库记录');
    const content = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    return {
      fileName: `fba_outbound_${this.inventoryService.formatDateForFilename(new Date())}.xlsx`,
      content,
    };
  }



async createFbaReplenishment(payload: CreateFbaReplenishmentDto,
  operatorId: bigint,
  requestId?: string,
): Promise<FbaReplenishmentResponseDto> {
  const skuId = BigInt(payload.skuId);
  const boxCode = normalizeBoxCode(payload.boxCode);
  const requestedQty = Number(payload.qty);
  const remark = payload.remark?.trim() || FBA_REPLENISH_MARK;

  if (!boxCode) throw new BadRequestException('箱号不能为空');
  if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
    throw new BadRequestException('申请数量必须是大于 0 的整数');
  }

  return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const [sku, box] = await Promise.all([
      tx.sku.findUnique({
        where: { id: skuId },
        select: {
          id: true,
          sku: true,
          fnsku: true,
          shop: true,
          productId: true,
          masterProduct: {
            select: {
              id: true,
              productId: true,
              productName: true,
              stockQty: true,
            },
          },
        },
      }),
      this.inventoryService.findBoxByEquivalentCode(tx, boxCode),
    ]);
    if (!sku) throw new NotFoundException('SKU 不存在');
    if (!box) throw new NotFoundException('箱号不存在');
    const productId = String(sku.productId || '').trim();
    if (!productId || !sku.masterProduct) {
      throw new ConflictException('该 SKU 未关联主商品');
    }
    if (!String(sku.fnsku ?? '').trim()) {
      throw new BadRequestException('该 SKU 未维护 FNSKU，不能申请 FBA 补货');
    }
    if (!String(sku.shop ?? '').trim()) {
      throw new BadRequestException('该 SKU 未维护店铺，不能申请 FBA 补货');
    }

    const currentQty = await findMasterProductBoxInventoryQty(tx, box.id, productId);
    if (currentQty <= 0) {
      throw new ConflictException('当前箱号没有该主商品库存，不能申请 FBA 补货');
    }

    const existingActiveSku = await tx.fbaReplenishment.findFirst({
      where: {
        skuId: sku.id,
        status: {
          in: ['pending_confirm', 'pending_outbound'],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        requestNo: true,
        status: true,
        boxId: true,
        requestedQty: true,
        actualQty: true,
      },
    });
    if (existingActiveSku) {
      if (existingActiveSku.boxId !== box.id) {
        throw new ConflictException('该 SKU 已在其他箱号存在 FBA 补货申请，请先处理现有申请');
      }
      const activeQty = this.inventoryService.getActiveFbaReservedQty(existingActiveSku);
      throw new ConflictException(
        `该 SKU 已有 FBA 申请 ${existingActiveSku.requestNo}，当前状态为 ${this.inventoryService.getFbaStatusLabel(existingActiveSku.status)}，占用数量 ${activeQty}`,
      );
    }

    const activeProductRows = await tx.fbaReplenishment.findMany({
      where: {
        boxId: box.id,
        status: {
          in: ['pending_confirm', 'pending_outbound'],
        },
        sku: {
          productId,
        },
      },
      select: {
        status: true,
        requestedQty: true,
        actualQty: true,
      },
    });
    const reservedQty = activeProductRows.reduce(
      (sum, row) => sum + this.inventoryService.getActiveFbaReservedQty(row),
      0,
    );
    const availableQty = currentQty - reservedQty;
    if (requestedQty > availableQty) {
      throw new ConflictException(`申请数量不能大于可用库存，当前可用库存为 ${availableQty}`);
    }

    const requestNo = await this.inventoryService.generateFbaRequestNo(tx);
    const created = await tx.fbaReplenishment.create({
      data: {
        requestNo,
        status: 'pending_confirm',
        skuId: sku.id,
        boxId: box.id,
        requestedQty,
        actualQty: null,
        remark,
        createdBy: operatorId,
      },
      include: {
        sku: {
          select: { id: true, sku: true, productId: true },
        },
        box: {
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { shelfCode: true } },
          },
        },
        creator: { select: { id: true, username: true } },
      },
    });

    await createFbaReplenishmentCreatedAudit({
      auditService: this.auditService,
      tx,
      entityId: created.id,
      afterData: {
        requestNo: created.requestNo,
        status: created.status,
        skuId: created.skuId.toString(),
        productId,
        boxId: created.boxId.toString(),
        requestedQty: created.requestedQty,
      },
      operatorId,
      requestId,
    });

    return {
      id: created.id.toString(),
      requestNo: created.requestNo,
      status: created.status,
      sku: {
        id: created.sku.id.toString(),
        sku: created.sku.sku,
        productId: created.sku.productId,
        productName: sku.masterProduct.productName,
      },
      box: {
        id: created.box.id.toString(),
        boxCode: created.box.boxCode,
        shelfCode: created.box.shelf?.shelfCode ?? null,
      },
      requestedQty: created.requestedQty,
      actualQty: created.actualQty,
      expressNo: created.expressNo,
      remark: created.remark,
      creator: created.creator
        ? {
            id: created.creator.id.toString(),
            username: created.creator.username,
          }
        : null,
      createdAt: created.createdAt,
    };
  });
}



async confirmFbaReplenishment(idParam: string,
  payload: ConfirmFbaReplenishmentDto,
  operatorId: bigint,
  requestId?: string,
): Promise<FbaReplenishmentResponseDto> {
  const id = parseId(idParam, 'fbaReplenishmentId');
  const actualQty = Number(payload.actualQty);
  if (!Number.isInteger(actualQty) || actualQty <= 0) {
    throw new BadRequestException('实际数量必须是大于 0 的整数');
  }

  return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const row = await tx.fbaReplenishment.findUnique({
      where: { id },
      include: {
        sku: {
          select: {
            id: true,
            sku: true,
            productId: true,
            masterProduct: {
              select: {
                productName: true,
              },
            },
          },
        },
        box: {
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { shelfCode: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('FBA 补货申请不存在');
    if (row.status === 'outbound') {
      throw new UnprocessableEntityException('已出库的 FBA 补货申请不能修改确认数量');
    }
    if (String(row.status) === 'deleted') {
      throw new UnprocessableEntityException('已删除的 FBA 补货申请不能修改确认数量');
    }
    await this.inventoryService.ensureSkusNotUnderPendingEdit(tx, [row.sku.id]);

    const productId = String(row.sku.productId || '').trim();
    if (!productId) {
      throw new ConflictException('当前补货申请对应的 SKU 未关联主商品');
    }

    const [currentQty, reservedRows] = await Promise.all([
      findMasterProductBoxInventoryQty(tx, row.box.id, productId),
      tx.fbaReplenishment.findMany({
        where: {
          id: { not: row.id },
          boxId: row.box.id,
          status: { in: ['pending_confirm', 'pending_outbound'] },
          sku: { productId },
        },
        select: {
          status: true,
          requestedQty: true,
          actualQty: true,
        },
      }),
    ]);
    const reservedQty = reservedRows.reduce(
      (sum, item) => sum + this.inventoryService.getActiveFbaReservedQty(item),
      0,
    );
    const availableQty = Math.max(0, currentQty - reservedQty);
    if (actualQty > availableQty) {
      throw new ConflictException(`实际数量不能大于可用库存，当前可用库存为 ${availableQty}`);
    }

    const updated = await tx.fbaReplenishment.update({
      where: { id: row.id },
      data: {
        status: 'pending_outbound',
        actualQty,
        confirmedBy: operatorId,
        confirmedAt: new Date(),
      },
      include: {
        sku: {
          select: {
            id: true,
            sku: true,
            productId: true,
            masterProduct: {
              select: {
                productName: true,
              },
            },
          },
        },
        box: {
          select: {
            id: true,
            boxCode: true,
            shelf: { select: { shelfCode: true } },
          },
        },
        creator: { select: { id: true, username: true } },
      },
    });

    await createFbaReplenishmentInventoryAdjustAudit({
      auditService: this.auditService,
      tx,
      entityId: updated.id,
      beforeData: {
        status: row.status,
        requestedQty: row.requestedQty,
        actualQty: row.actualQty,
      },
      afterData: {
        status: updated.status,
        requestedQty: updated.requestedQty,
        actualQty: updated.actualQty,
      },
      operatorId,
      requestId,
    });

    return {
      id: updated.id.toString(),
      requestNo: updated.requestNo,
      status: updated.status,
      sku: {
        id: updated.sku.id.toString(),
        sku: updated.sku.sku,
        productId: updated.sku.productId,
        productName: updated.sku.masterProduct?.productName ?? null,
      },
      box: {
        id: updated.box.id.toString(),
        boxCode: updated.box.boxCode,
        shelfCode: updated.box.shelf?.shelfCode ?? null,
      },
      requestedQty: updated.requestedQty,
      actualQty: updated.actualQty,
      expressNo: updated.expressNo,
      remark: updated.remark,
      creator: updated.creator
        ? {
            id: updated.creator.id.toString(),
            username: updated.creator.username,
          }
        : null,
      createdAt: updated.createdAt,
    };
  });
}



async outboundFbaReplenishments(payload: OutboundFbaReplenishmentDto,
  operatorId: bigint,
  requestId?: string,
): Promise<{ updatedCount: number; expressNo: string }> {
  const ids = Array.from(new Set((payload.ids || []).map((id) => BigInt(id))));
  const expressNo = payload.expressNo.trim();
  if (!ids.length) throw new BadRequestException('至少选择一条补货申请');
  if (!expressNo) throw new BadRequestException('快递单号不能为空');

  return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const rows = await tx.fbaReplenishment.findMany({
      where: { id: { in: ids } },
      include: {
        sku: {
          select: {
            id: true,
            productId: true,
            masterProduct: {
              select: {
                id: true,
                productId: true,
                stockQty: true,
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    if (rows.length !== ids.length) {
      throw new NotFoundException('存在未找到的 FBA 补货申请');
    }

    const invalid = rows.find((row) => row.status !== 'pending_outbound');
    if (invalid) {
      throw new ConflictException(`申请单 ${invalid.requestNo} 当前状态不支持出库`);
    }
    await this.inventoryService.ensureSkusNotUnderPendingEdit(
      tx,
      Array.from(new Set(rows.map((row) => row.skuId.toString()))).map((id) => BigInt(id)),
    );

    const requiredMap = new Map<string, { boxId: bigint; productId: string; qty: number }>();
    rows.forEach((row) => {
      const productId = String(row.sku.productId || '').trim();
      if (!productId) {
        throw new ConflictException(`申请单 ${row.requestNo} 对应 SKU 未关联主商品`);
      }
      const qty = Number(row.actualQty ?? row.requestedQty);
      const key = `${row.boxId.toString()}-${productId}`;
      const prev = requiredMap.get(key);
      if (prev) {
        prev.qty += qty;
      } else {
        requiredMap.set(key, {
          boxId: row.boxId,
          productId,
          qty,
        });
      }
    });

    const requiredRows = Array.from(requiredMap.values());
    const inventoryRows = await findMasterProductBoxInventoryByPairs(tx, requiredRows);
    const inventoryMap = new Map(
      inventoryRows.map((row) => [getBoxProductInventoryKey(row.boxId, row.productId), row]),
    );

    for (const reqRow of requiredRows) {
      const key = getBoxProductInventoryKey(reqRow.boxId, reqRow.productId);
      const inventory = inventoryMap.get(key);
      const currentQty = Number(inventory?.qty ?? 0);
      if (currentQty < reqRow.qty) {
        throw new ConflictException(
          `箱号 ${reqRow.boxId.toString()} 的产品 ${reqRow.productId} 库存不足，无法完成出库`,
        );
      }
    }

    for (const reqRow of requiredRows) {
      const key = getBoxProductInventoryKey(reqRow.boxId, reqRow.productId);
      const inventory = inventoryMap.get(key)!;
      await updateMasterProductBoxInventoryQty(
        tx,
        reqRow.boxId,
        reqRow.productId,
        Number(inventory.qty) - reqRow.qty,
      );
    }

    const affectedProductIds = Array.from(new Set(requiredRows.map((row) => row.productId)));
    const productRows = await tx.masterProduct.findMany({
      where: { productId: { in: affectedProductIds } },
      select: {
        id: true,
        productId: true,
        stockQty: true,
      },
    });
    const productById = new Map(productRows.map((row) => [row.productId, row]));
    for (const productId of affectedProductIds) {
      const product = productById.get(productId);
      if (!product) continue;
      const totalQty = await this.inventoryService.recalculateMasterProductStockQty(tx, productId);
      await createMasterProductInventoryAdjustAudit({
        auditService: this.auditService,
        tx,
        entityId: product.id,
        beforeData: {
          productId,
          stockQty: Number(product.stockQty ?? 0),
        },
        afterData: {
          productId,
          stockQty: totalQty,
          by: 'fba_replenishment',
          expressNo,
        },
        operatorId,
        requestId,
        remark: 'fba outbound',
      });
    }

    const outboundAt = new Date();
    for (const row of rows) {
      const qtyDelta = -(Number(row.actualQty ?? row.requestedQty));
      await tx.stockMovement.create({
        data: {
          movementType: 'adjust',
          refType: 'fba_replenishment',
          refId: row.id,
          boxId: row.boxId,
          skuId: row.skuId,
          qtyDelta,
          operatorId,
        },
      });

      await createBoxInventoryAudit({
        auditService: this.auditService,
        tx,
        entityId: row.boxId,
        eventType: AuditEventType.BOX_STOCK_OUTBOUND,
        beforeData: null,
        afterData: {
          productId: row.sku.productId,
          skuId: row.skuId.toString(),
          qtyDelta,
          by: 'fba_replenishment',
          requestNo: row.requestNo,
        },
        operatorId,
        requestId,
        remark: `fba outbound ${row.requestNo}`,
      });

      await createFbaReplenishmentInventoryAdjustAudit({
        auditService: this.auditService,
        tx,
        entityId: row.id,
        beforeData: {
          status: row.status,
          actualQty: row.actualQty,
          expressNo: row.expressNo,
        },
        afterData: {
          status: 'outbound',
          actualQty: row.actualQty,
          expressNo,
        },
        operatorId,
        requestId,
      });
    }

    await tx.fbaReplenishment.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'outbound',
        outboundBy: operatorId,
        outboundAt,
        expressNo,
      },
    });

    return {
      updatedCount: rows.length,
      expressNo,
    };
  });
}


}
