import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AuditAction,
  InboundOrderType,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { generateOrderNo, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateInboundOrderDto,
  CreateInboundOrderItemDto,
} from './dto/create-inbound-order.dto';

interface InboundLine {
  boxCode: string;
  sku: string;
  qty: number;
  sourceRowNo: number;
}

@Injectable()
export class InboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(status?: OrderStatus): Promise<unknown[]> {
    return this.prisma.inboundOrder.findMany({
      where: status ? { status } : undefined,
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        items: {
          include: {
            box: { select: { id: true, boxCode: true } },
            sku: { select: { id: true, sku: true } },
          },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'desc' },
    });
  }

  async importExcel(
    fileBuffer: Buffer,
    originalName: string | undefined,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const parsedLines = this.parseExcelLines(fileBuffer);
    const mergedLines = this.mergeLines(parsedLines);
    await this.ensureBoxesAreNew(mergedLines);
    const remark = originalName ? `import:${originalName}` : 'import-excel';
    return this.createPendingBatchOrder(mergedLines, remark, operatorId, requestId);
  }

  async create(
    payload: CreateInboundOrderDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    const normalized = payload.items.map((item) => this.normalizeItem(item));
    const mergedLines = this.mergeLines(normalized);
    await this.ensureBoxesAreNew(mergedLines);
    return this.createPendingBatchOrder(
      mergedLines,
      payload.remark ?? 'manual-create',
      operatorId,
      requestId,
    );
  }

  async confirm(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    idempotent: boolean;
    changedRows: number;
  }> {
    const orderId = parseId(idParam, 'inboundOrderId');
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: bigint; status: OrderStatus }>>(
        Prisma.sql`SELECT id, status FROM inbound_orders WHERE id = ${orderId} FOR UPDATE`,
      );
      if (locked.length === 0) {
        throw new NotFoundException('inbound order not found');
      }

      if (locked[0].status === OrderStatus.confirmed) {
        return {
          orderId: orderId.toString(),
          status: OrderStatus.confirmed,
          idempotent: true,
          changedRows: 0,
        };
      }
      if (locked[0].status === OrderStatus.void) {
        throw new UnprocessableEntityException('void order cannot be confirmed');
      }

      const order = await tx.inboundOrder.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) throw new NotFoundException('inbound order not found');
      if (order.items.length === 0) {
        throw new UnprocessableEntityException('inbound order has no items');
      }

      const currentInventoryRows = await tx.inventoryBoxSku.findMany({
        where: {
          OR: order.items.map((item) => ({
            boxId: item.boxId,
            skuId: item.skuId,
          })),
        },
      });
      const currentQtyMap = new Map<string, number>();
      const existingInventoryKeys = new Set<string>();
      currentInventoryRows.forEach((row) => {
        const key = this.inventoryKey(row.boxId, row.skuId);
        currentQtyMap.set(key, row.qty);
        existingInventoryKeys.add(key);
      });

      for (const item of order.items) {
        const key = this.inventoryKey(item.boxId, item.skuId);
        const beforeQty = currentQtyMap.get(key) ?? 0;
        const afterQty = beforeQty + item.qty;

        if (existingInventoryKeys.has(key)) {
          await tx.inventoryBoxSku.update({
            where: {
              boxId_skuId: {
                boxId: item.boxId,
                skuId: item.skuId,
              },
            },
            data: {
              qty: {
                increment: item.qty,
              },
            },
          });
        } else {
          await tx.inventoryBoxSku.create({
            data: {
              boxId: item.boxId,
              skuId: item.skuId,
              qty: item.qty,
            },
          });
          existingInventoryKeys.add(key);
        }
        currentQtyMap.set(key, afterQty);

        await tx.stockMovement.create({
          data: {
            movementType: 'inbound',
            refType: 'inbound_order',
            refId: order.id,
            boxId: item.boxId,
            skuId: item.skuId,
            qtyDelta: item.qty,
            operatorId,
          },
        });

        await this.auditService.create({
          db: tx,
          entityType: 'box',
          entityId: item.boxId,
          action: AuditAction.update,
          eventType: AuditEventType.BOX_STOCK_INCREASED,
          beforeData: {
            boxId: item.boxId,
            skuId: item.skuId,
            qty: beforeQty,
          },
          afterData: {
            boxId: item.boxId,
            skuId: item.skuId,
            qty: afterQty,
          },
          operatorId,
          requestId,
          remark: `inbound order ${order.orderNo}`,
        });
      }

      await tx.inboundOrder.update({
        where: { id: orderId },
        data: { status: OrderStatus.confirmed },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'inbound_order',
        entityId: order.id,
        action: AuditAction.update,
        eventType: AuditEventType.INBOUND_ORDER_CONFIRMED,
        beforeData: { status: order.status },
        afterData: { status: OrderStatus.confirmed },
        operatorId,
        requestId,
      });

      return {
        orderId: order.id.toString(),
        status: OrderStatus.confirmed,
        idempotent: false,
        changedRows: order.items.length,
      };
    });
  }

  async void(
    idParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{
    orderId: string;
    status: OrderStatus;
    idempotent: boolean;
  }> {
    const orderId = parseId(idParam, 'inboundOrderId');
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: bigint; status: OrderStatus }>>(
        Prisma.sql`SELECT id, status FROM inbound_orders WHERE id = ${orderId} FOR UPDATE`,
      );
      if (locked.length === 0) throw new NotFoundException('inbound order not found');

      if (locked[0].status === OrderStatus.confirmed) {
        throw new UnprocessableEntityException('confirmed order cannot be voided');
      }
      if (locked[0].status === OrderStatus.void) {
        return {
          orderId: orderId.toString(),
          status: OrderStatus.void,
          idempotent: true,
        };
      }

      const before = await tx.inboundOrder.findUnique({ where: { id: orderId } });
      if (!before) throw new NotFoundException('inbound order not found');

      await tx.inboundOrder.update({
        where: { id: orderId },
        data: { status: OrderStatus.void },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'inbound_order',
        entityId: orderId,
        action: AuditAction.update,
        eventType: AuditEventType.INBOUND_ORDER_VOIDED,
        beforeData: { status: before.status },
        afterData: { status: OrderStatus.void },
        operatorId,
        requestId,
      });

      return {
        orderId: orderId.toString(),
        status: OrderStatus.void,
        idempotent: false,
      };
    });
  }

  private normalizeItem(item: CreateInboundOrderItemDto): InboundLine {
    const boxCode = item.boxCode.trim();
    const sku = item.sku.trim();
    if (!boxCode || !sku) {
      throw new BadRequestException('boxCode and sku are required');
    }
    return {
      boxCode,
      sku,
      qty: item.qty,
      sourceRowNo: item.sourceRowNo ?? 0,
    };
  }

  private parseExcelLines(fileBuffer: Buffer): InboundLine[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    } catch {
      throw new BadRequestException('invalid excel file');
    }
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new BadRequestException('excel has no sheet');
    }
    const sheet = workbook.Sheets[firstSheet];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (rows.length === 0) {
      throw new BadRequestException('excel has no data rows');
    }

    const errors: string[] = [];
    const result: InboundLine[] = [];

    rows.forEach((row, idx) => {
      const rowNo = idx + 2;
      const normalized: Record<string, string> = {};
      Object.entries(row).forEach(([key, value]) => {
        normalized[this.normalizeHeader(key)] = String(value ?? '').trim();
      });

      const boxCode = this.pickField(normalized, ['箱号', 'box', 'boxcode']);
      const sku = this.pickField(normalized, ['sku', '商品编码']);
      const qtyRaw = this.pickField(normalized, ['数量', 'qty', 'count']);

      if (!boxCode || !sku || !qtyRaw) {
        errors.push(`row ${rowNo}: 箱号/SKU/数量 are required`);
        return;
      }

      const qtyNumber = Number(qtyRaw);
      if (!Number.isInteger(qtyNumber) || qtyNumber <= 0) {
        errors.push(`row ${rowNo}: 数量 must be a positive integer`);
        return;
      }

      result.push({
        boxCode,
        sku,
        qty: qtyNumber,
        sourceRowNo: rowNo,
      });
    });

    if (errors.length > 0) {
      throw new UnprocessableEntityException(`excel validation failed: ${errors.join(' | ')}`);
    }

    return result;
  }

  private normalizeHeader(header: string): string {
    return header.replace(/\s+/g, '').toLowerCase();
  }

  private pickField(row: Record<string, string>, aliases: string[]): string | null {
    for (const alias of aliases) {
      const normalizedAlias = this.normalizeHeader(alias);
      const value = row[normalizedAlias];
      if (value) return value;
    }
    return null;
  }

  private mergeLines(lines: InboundLine[]): InboundLine[] {
    const map = new Map<string, InboundLine>();
    lines.forEach((line) => {
      const key = `${line.boxCode}||${line.sku}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...line });
        return;
      }
      existing.qty += line.qty;
      existing.sourceRowNo = existing.sourceRowNo || line.sourceRowNo;
    });
    return Array.from(map.values());
  }

  private async ensureBoxesAreNew(lines: InboundLine[]): Promise<void> {
    const uniqueBoxes = Array.from(new Set(lines.map((line) => line.boxCode)));
    const existing = await this.prisma.box.findMany({
      where: { boxCode: { in: uniqueBoxes } },
      select: { boxCode: true },
    });
    if (existing.length > 0) {
      const boxCodes = existing.map((item) => item.boxCode).join(', ');
      throw new UnprocessableEntityException(`box already exists: ${boxCodes}`);
    }
  }

  private async createPendingBatchOrder(
    lines: InboundLine[],
    remark: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<unknown> {
    return this.prisma.$transaction(async (tx) => {
      const shelf = await tx.shelf.findFirst({
        where: { status: 1 },
        orderBy: { id: 'asc' },
      });
      if (!shelf) {
        throw new UnprocessableEntityException('please create at least one active shelf first');
      }

      const order = await tx.inboundOrder.create({
        data: {
          orderNo: generateOrderNo('INB'),
          orderType: InboundOrderType.pending_batch,
          status: OrderStatus.draft,
          remark,
          createdBy: operatorId,
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'inbound_order',
        entityId: order.id,
        action: AuditAction.create,
        eventType: AuditEventType.INBOUND_ORDER_CREATED,
        beforeData: null,
        afterData: {
          orderNo: order.orderNo,
          orderType: order.orderType,
          status: order.status,
          remark: order.remark,
        },
        operatorId,
        requestId,
      });

      const skuCodes = Array.from(new Set(lines.map((line) => line.sku)));
      const skuMap = new Map<string, bigint>();
      const existingSkus = await tx.sku.findMany({
        where: { sku: { in: skuCodes } },
        select: { id: true, sku: true },
      });
      existingSkus.forEach((sku) => skuMap.set(sku.sku, sku.id));

      for (const skuCode of skuCodes) {
        if (skuMap.has(skuCode)) continue;
        const createdSku = await tx.sku.create({
          data: {
            sku: skuCode,
            status: 1,
          },
        });
        skuMap.set(createdSku.sku, createdSku.id);

        await this.auditService.create({
          db: tx,
          entityType: 'sku',
          entityId: createdSku.id,
          action: AuditAction.create,
          eventType: AuditEventType.SKU_CREATED,
          beforeData: null,
          afterData: createdSku as unknown as Record<string, unknown>,
          operatorId,
          requestId,
          remark: `auto created from inbound ${order.orderNo}`,
        });
      }

      const boxCodes = Array.from(new Set(lines.map((line) => line.boxCode)));
      const boxMap = new Map<string, bigint>();
      for (const boxCode of boxCodes) {
        const createdBox = await tx.box.create({
          data: {
            boxCode,
            shelfId: shelf.id,
            status: 1,
          },
        });
        boxMap.set(boxCode, createdBox.id);

        await this.auditService.create({
          db: tx,
          entityType: 'box',
          entityId: createdBox.id,
          action: AuditAction.create,
          eventType: AuditEventType.BOX_CREATED,
          beforeData: null,
          afterData: createdBox as unknown as Record<string, unknown>,
          operatorId,
          requestId,
          remark: `created from inbound ${order.orderNo}`,
        });
      }

      await tx.inboundOrderItem.createMany({
        data: lines.map((line) => ({
          orderId: order.id,
          boxId: boxMap.get(line.boxCode) as bigint,
          skuId: skuMap.get(line.sku) as bigint,
          qty: line.qty,
          sourceRowNo: line.sourceRowNo > 0 ? line.sourceRowNo : null,
        })),
      });

      return tx.inboundOrder.findUnique({
        where: { id: order.id },
        include: {
          creator: {
            select: {
              id: true,
              username: true,
            },
          },
          items: {
            include: {
              box: { select: { id: true, boxCode: true } },
              sku: { select: { id: true, sku: true } },
            },
            orderBy: { id: 'asc' },
          },
        },
      });
    });
  }

  private inventoryKey(boxId: bigint, skuId: bigint): string {
    return `${boxId.toString()}-${skuId.toString()}`;
  }
}
