import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AuditAction,
  BatchInboundItemStatus,
  BatchInboundOrderStatus,
  Prisma,
} from '@prisma/client';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CollectBatchInboundDto } from './dto/collect-batch-inbound.dto';

interface ParsedInboundLine {
  boxCode: string;
  skuCode: string;
  qty: number;
  sourceRowNo: number;
}

interface BatchInboundOrderSummary {
  id: string;
  orderNo: string;
  status: BatchInboundOrderStatus;
  expectedBoxCount: number;
  rangeStart: number;
  rangeEnd: number;
  collectedBoxCodes: string[];
  uploadedFileName: string | null;
  createdAt: Date;
  updatedAt: Date;
  creator: {
    id: string;
    username: string;
  };
  itemCount: number;
  pendingCount: number;
  confirmedCount: number;
}

interface BatchInboundOrderDetail extends BatchInboundOrderSummary {
  items: Array<{
    id: string;
    boxCode: string;
    skuCode: string;
    qty: number;
    sourceRowNo: number | null;
    status: BatchInboundItemStatus;
    confirmedAt: Date | null;
    createdAt: Date;
  }>;
}

interface BatchInboundConfirmResult {
  orderId: string;
  status: BatchInboundOrderStatus;
  idempotent: boolean;
  changedRows: number;
  detail: BatchInboundOrderDetail;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class BatchInboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(): Promise<BatchInboundOrderSummary[]> {
    const orders = await this.prisma.batchInboundOrder.findMany({
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        items: {
          select: {
            id: true,
            status: true,
          },
        },
      },
      orderBy: { id: 'desc' },
    });

    return orders.map((order) => this.toOrderSummary(order));
  }

  async detail(orderIdParam: string): Promise<BatchInboundOrderDetail> {
    const orderId = parseId(orderIdParam, 'batchInboundOrderId');
    const order = await this.prisma.batchInboundOrder.findUnique({
      where: { id: orderId },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        items: {
          orderBy: [{ boxCode: 'asc' }, { skuCode: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!order) {
      throw new NotFoundException('批量入库单不存在');
    }

    return this.toOrderDetail(order);
  }

  async removeOrder(
    orderIdParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<{ success: boolean }> {
    const orderId = parseId(orderIdParam, 'batchInboundOrderId');

    await this.prisma.$transaction(async (tx) => {
      const order = await tx.batchInboundOrder.findUnique({
        where: { id: orderId },
        include: {
          items: {
            select: { id: true },
          },
        },
      });
      if (!order) {
        throw new NotFoundException('批量入库单不存在');
      }
      if (order.status === BatchInboundOrderStatus.confirmed) {
        throw new UnprocessableEntityException('已确认的批量入库单不能删除');
      }

      await tx.batchInboundItem.deleteMany({
        where: { orderId: order.id },
      });
      await tx.batchInboundOrder.delete({
        where: { id: order.id },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'batch_inbound_order',
        entityId: order.id,
        action: AuditAction.delete,
        eventType: AuditEventType.INBOUND_ORDER_VOIDED,
        beforeData: {
          orderNo: order.orderNo,
          status: order.status,
          itemCount: order.items.length,
        },
        afterData: null,
        operatorId,
        requestId,
        remark: '删除批量入库单',
      });
    });

    return { success: true };
  }

  async collect(
    payload: CollectBatchInboundDto,
    operatorId: bigint,
    requestId?: string,
  ): Promise<BatchInboundOrderDetail> {
    return this.prisma.$transaction(async (tx) => {
      const normalizedBatchNo = payload.batchNo.trim().replace(/^0+/, '');
      if (!normalizedBatchNo || !/^[1-9]\d*$/.test(normalizedBatchNo)) {
        throw new BadRequestException('批号必须是大于0的数字');
      }
      const orderNo = this.buildBatchInboundOrderNo(normalizedBatchNo, payload.boxCount);

      const duplicated = await tx.batchInboundOrder.findUnique({
        where: { orderNo },
        select: { id: true },
      });
      if (duplicated) {
        throw new UnprocessableEntityException(`单号已存在：${orderNo}，请先删除已有的单号`);
      }

      const usedNumbers = await this.getUsedBoxNumbers(tx);
      const reservedNumbers = await this.getReservedBoxNumbers(tx);
      reservedNumbers.forEach((num) => usedNumbers.add(num));

      const rangeStart = this.findContinuousRangeStart(usedNumbers, payload.boxCount);
      const rangeEnd = rangeStart + payload.boxCount - 1;
      const collectedBoxCodes = Array.from({ length: payload.boxCount }, (_, index) =>
        this.formatBoxCode(rangeStart + index),
      );

      const created = await (async () => {
        try {
          return await tx.batchInboundOrder.create({
            data: {
              orderNo,
              status: BatchInboundOrderStatus.waiting_upload,
              expectedBoxCount: payload.boxCount,
              rangeStart,
              rangeEnd,
              collectedBoxCodes,
              createdBy: operatorId,
            },
            include: {
              creator: {
                select: {
                  id: true,
                  username: true,
                },
              },
              items: true,
            },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw new UnprocessableEntityException(`单号已存在：${orderNo}，请先删除已有的单号`);
          }
          throw error;
        }
      })();

      await this.auditService.create({
        db: tx,
        entityType: 'batch_inbound_order',
        entityId: created.id,
        action: AuditAction.create,
        eventType: AuditEventType.INBOUND_ORDER_CREATED,
        beforeData: null,
        afterData: {
          orderNo: created.orderNo,
          status: created.status,
          expectedBoxCount: created.expectedBoxCount,
          rangeStart: created.rangeStart,
          rangeEnd: created.rangeEnd,
          collectedBoxCodes,
        },
        operatorId,
        requestId,
      });

      return this.toOrderDetail(created);
    });
  }

  async upload(
    orderIdParam: string,
    fileBuffer: Buffer,
    originalName: string | undefined,
    operatorId: bigint,
    requestId?: string,
  ): Promise<BatchInboundOrderDetail> {
    const orderId = parseId(orderIdParam, 'batchInboundOrderId');
    const parsedLines = this.parseExcelLines(fileBuffer);
    const mergedLines = this.mergeLines(parsedLines);

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.batchInboundOrder.findUnique({
        where: { id: orderId },
        include: {
          creator: {
            select: {
              id: true,
              username: true,
            },
          },
          items: true,
        },
      });
      if (!order) {
        throw new NotFoundException('批量入库单不存在');
      }
      if (order.status === BatchInboundOrderStatus.confirmed) {
        throw new UnprocessableEntityException('已确认的批量入库单不能上传文件');
      }
      if (order.status === BatchInboundOrderStatus.void) {
        throw new UnprocessableEntityException('已作废的批量入库单不能上传文件');
      }

      const collectedBoxCodes = this.parseCollectedBoxCodes(order.collectedBoxCodes);
      const uploadedBoxCodes = Array.from(new Set(mergedLines.map((line) => line.boxCode))).sort(
        (a, b) => this.boxCodeToNumber(a) - this.boxCodeToNumber(b),
      );

      this.validateUploadedBoxes(collectedBoxCodes, uploadedBoxCodes);

      await tx.batchInboundItem.deleteMany({
        where: { orderId: order.id },
      });

      await tx.batchInboundItem.createMany({
        data: mergedLines.map((line) => ({
          orderId: order.id,
          boxCode: line.boxCode,
          skuCode: line.skuCode,
          qty: line.qty,
          sourceRowNo: line.sourceRowNo,
          status: BatchInboundItemStatus.pending,
        })),
      });

      const updatedOrder = await tx.batchInboundOrder.update({
        where: { id: order.id },
        data: {
          status: BatchInboundOrderStatus.waiting_inbound,
          uploadedFileName: originalName ?? null,
        },
        include: {
          creator: {
            select: {
              id: true,
              username: true,
            },
          },
          items: {
            orderBy: [{ boxCode: 'asc' }, { skuCode: 'asc' }, { id: 'asc' }],
          },
        },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'batch_inbound_order',
        entityId: order.id,
        action: AuditAction.update,
        eventType: AuditEventType.INBOUND_ORDER_CREATED,
        beforeData: {
          status: order.status,
          uploadedFileName: order.uploadedFileName,
          itemCount: order.items.length,
        },
        afterData: {
          status: updatedOrder.status,
          uploadedFileName: updatedOrder.uploadedFileName,
          itemCount: updatedOrder.items.length,
        },
        operatorId,
        requestId,
        remark: '上传批量入库Excel',
      });

      return this.toOrderDetail(updatedOrder);
    });
  }

  async confirmItem(
    orderIdParam: string,
    itemIdParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<BatchInboundConfirmResult> {
    const orderId = parseId(orderIdParam, 'batchInboundOrderId');
    const itemId = parseId(itemIdParam, 'batchInboundItemId');

    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      const item = await tx.batchInboundItem.findFirst({
        where: {
          id: itemId,
          orderId: order.id,
        },
      });
      if (!item) {
        throw new NotFoundException('批量入库明细不存在');
      }

      if (item.status === BatchInboundItemStatus.confirmed) {
        const detail = await this.loadOrderDetailInTx(tx, order.id);
        return {
          orderId: order.id.toString(),
          status: detail.status,
          idempotent: true,
          changedRows: 0,
          detail,
        };
      }

      await this.applyItemConfirm(tx, order, item, operatorId, requestId);
      const status = await this.syncOrderStatus(tx, order.id, operatorId, requestId);
      const detail = await this.loadOrderDetailInTx(tx, order.id);

      return {
        orderId: order.id.toString(),
        status,
        idempotent: false,
        changedRows: 1,
        detail,
      };
    });
  }

  async confirmBox(
    orderIdParam: string,
    boxCodeParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<BatchInboundConfirmResult> {
    const orderId = parseId(orderIdParam, 'batchInboundOrderId');
    const boxCode = this.normalizeBoxCode(boxCodeParam);
    if (!boxCode) {
      throw new BadRequestException('箱号格式不正确');
    }

    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      const pendingItems = await tx.batchInboundItem.findMany({
        where: {
          orderId: order.id,
          boxCode,
          status: BatchInboundItemStatus.pending,
        },
        orderBy: [{ skuCode: 'asc' }, { id: 'asc' }],
      });

      if (pendingItems.length === 0) {
        const detail = await this.loadOrderDetailInTx(tx, order.id);
        return {
          orderId: order.id.toString(),
          status: detail.status,
          idempotent: true,
          changedRows: 0,
          detail,
        };
      }

      for (const item of pendingItems) {
        await this.applyItemConfirm(tx, order, item, operatorId, requestId);
      }

      const status = await this.syncOrderStatus(tx, order.id, operatorId, requestId);
      const detail = await this.loadOrderDetailInTx(tx, order.id);

      return {
        orderId: order.id.toString(),
        status,
        idempotent: false,
        changedRows: pendingItems.length,
        detail,
      };
    });
  }

  async confirmAll(
    orderIdParam: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<BatchInboundConfirmResult> {
    const orderId = parseId(orderIdParam, 'batchInboundOrderId');

    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId);
      const pendingItems = await tx.batchInboundItem.findMany({
        where: {
          orderId: order.id,
          status: BatchInboundItemStatus.pending,
        },
        orderBy: [{ boxCode: 'asc' }, { skuCode: 'asc' }, { id: 'asc' }],
      });

      if (pendingItems.length === 0) {
        const detail = await this.loadOrderDetailInTx(tx, order.id);
        return {
          orderId: order.id.toString(),
          status: detail.status,
          idempotent: true,
          changedRows: 0,
          detail,
        };
      }

      for (const item of pendingItems) {
        await this.applyItemConfirm(tx, order, item, operatorId, requestId);
      }

      const status = await this.syncOrderStatus(tx, order.id, operatorId, requestId);
      const detail = await this.loadOrderDetailInTx(tx, order.id);

      return {
        orderId: order.id.toString(),
        status,
        idempotent: false,
        changedRows: pendingItems.length,
        detail,
      };
    });
  }

  private async lockOrder(
    tx: Tx,
    orderId: bigint,
  ): Promise<{ id: bigint; status: BatchInboundOrderStatus; orderNo: string }> {
    const rows = await tx.$queryRaw<
      Array<{ id: bigint; status: BatchInboundOrderStatus; order_no: string }>
    >(Prisma.sql`
      SELECT id, status, order_no
      FROM batch_inbound_orders
      WHERE id = ${orderId}
      FOR UPDATE
    `);

    if (rows.length === 0) {
      throw new NotFoundException('批量入库单不存在');
    }

    const locked = rows[0];
    if (locked.status === BatchInboundOrderStatus.waiting_upload) {
      throw new UnprocessableEntityException('请先上传批量入库文档');
    }
    if (locked.status === BatchInboundOrderStatus.void) {
      throw new UnprocessableEntityException('已作废的批量入库单不能确认');
    }

    return {
      id: locked.id,
      status: locked.status,
      orderNo: locked.order_no,
    };
  }

  private async syncOrderStatus(
    tx: Tx,
    orderId: bigint,
    operatorId: bigint,
    requestId?: string,
  ): Promise<BatchInboundOrderStatus> {
    const order = await tx.batchInboundOrder.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
      },
    });
    if (!order) {
      throw new NotFoundException('批量入库单不存在');
    }

    const pendingCount = await tx.batchInboundItem.count({
      where: {
        orderId: order.id,
        status: BatchInboundItemStatus.pending,
      },
    });
    const totalCount = await tx.batchInboundItem.count({
      where: {
        orderId: order.id,
      },
    });

    const nextStatus =
      totalCount > 0 && pendingCount === 0
        ? BatchInboundOrderStatus.confirmed
        : BatchInboundOrderStatus.waiting_inbound;

    if (nextStatus !== order.status) {
      await tx.batchInboundOrder.update({
        where: { id: order.id },
        data: { status: nextStatus },
      });

      await this.auditService.create({
        db: tx,
        entityType: 'batch_inbound_order',
        entityId: order.id,
        action: AuditAction.update,
        eventType:
          nextStatus === BatchInboundOrderStatus.confirmed
            ? AuditEventType.INBOUND_ORDER_CONFIRMED
            : AuditEventType.INBOUND_ORDER_CREATED,
        beforeData: {
          status: order.status,
        },
        afterData: {
          status: nextStatus,
        },
        operatorId,
        requestId,
      });
    }

    return nextStatus;
  }

  private async applyItemConfirm(
    tx: Tx,
    order: { id: bigint; orderNo: string },
    item: {
      id: bigint;
      boxCode: string;
      skuCode: string;
      qty: number;
      status: BatchInboundItemStatus;
    },
    operatorId: bigint,
    requestId?: string,
  ): Promise<void> {
    const sku = await this.resolveOrCreateSku(tx, item.skuCode, operatorId, requestId, order.orderNo);
    const box = await this.resolveOrCreateBox(tx, item.boxCode, operatorId, requestId, order.orderNo);

    const inventory = await tx.inventoryBoxSku.findUnique({
      where: {
        boxId_skuId: {
          boxId: box.id,
          skuId: sku.id,
        },
      },
    });

    const beforeQty = inventory?.qty ?? 0;
    const afterQty = beforeQty + item.qty;

    if (inventory) {
      await tx.inventoryBoxSku.update({
        where: {
          boxId_skuId: {
            boxId: box.id,
            skuId: sku.id,
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
          boxId: box.id,
          skuId: sku.id,
          qty: item.qty,
        },
      });
    }

    await tx.stockMovement.create({
      data: {
        movementType: 'inbound',
        refType: 'batch_inbound_order',
        refId: order.id,
        boxId: box.id,
        skuId: sku.id,
        qtyDelta: item.qty,
        operatorId,
      },
    });

    await tx.batchInboundItem.update({
      where: { id: item.id },
      data: {
        status: BatchInboundItemStatus.confirmed,
        confirmedAt: new Date(),
      },
    });

    await this.auditService.create({
      db: tx,
      entityType: 'box',
      entityId: box.id,
      action: AuditAction.update,
      eventType: AuditEventType.BOX_STOCK_INCREASED,
      beforeData: {
        boxCode: box.boxCode,
        skuCode: sku.sku,
        qty: beforeQty,
      },
      afterData: {
        boxCode: box.boxCode,
        skuCode: sku.sku,
        qty: afterQty,
      },
      operatorId,
      requestId,
      remark: `batch inbound ${order.orderNo}`,
    });
  }

  private async resolveOrCreateSku(
    tx: Tx,
    skuCode: string,
    operatorId: bigint,
    requestId: string | undefined,
    orderNo: string,
  ): Promise<{ id: bigint; sku: string }> {
    const existing = await tx.sku.findUnique({
      where: { sku: skuCode },
      select: {
        id: true,
        sku: true,
      },
    });
    if (existing) {
      return existing;
    }

    const created = await tx.sku.create({
      data: {
        sku: skuCode,
        status: 1,
      },
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
      remark: `auto created from batch inbound ${orderNo}`,
    });

    return {
      id: created.id,
      sku: created.sku,
    };
  }

  private async resolveOrCreateBox(
    tx: Tx,
    boxCode: string,
    operatorId: bigint,
    requestId: string | undefined,
    orderNo: string,
  ): Promise<{ id: bigint; boxCode: string }> {
    const existing = await tx.box.findUnique({
      where: { boxCode },
      select: {
        id: true,
        boxCode: true,
      },
    });
    if (existing) {
      return existing;
    }

    const shelf = await tx.shelf.findFirst({
      where: { status: 1 },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!shelf) {
      throw new UnprocessableEntityException('请先创建启用状态的货架');
    }

    const created = await tx.box.create({
      data: {
        boxCode,
        shelfId: shelf.id,
        status: 1,
      },
    });

    await this.auditService.create({
      db: tx,
      entityType: 'box',
      entityId: created.id,
      action: AuditAction.create,
      eventType: AuditEventType.BOX_CREATED,
      beforeData: null,
      afterData: created as unknown as Record<string, unknown>,
      operatorId,
      requestId,
      remark: `auto created from batch inbound ${orderNo}`,
    });

    return {
      id: created.id,
      boxCode: created.boxCode,
    };
  }

  private parseExcelLines(fileBuffer: Buffer): ParsedInboundLine[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    } catch {
      throw new BadRequestException('无效的Excel文件');
    }

    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new BadRequestException('Excel中没有工作表');
    }

    const sheet = workbook.Sheets[firstSheet];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    if (rows.length === 0) {
      throw new BadRequestException('Excel中没有数据行');
    }

    const parsed: ParsedInboundLine[] = [];
    const errors: string[] = [];

    rows.forEach((row, index) => {
      const rowNo = index + 2;
      const normalizedRow: Record<string, string> = {};
      Object.entries(row).forEach(([key, value]) => {
        normalizedRow[this.normalizeHeader(key)] = String(value ?? '').trim();
      });

      const rawBoxCode = this.pickField(normalizedRow, [
        '箱号',
        '箱碼',
        'box',
        'boxcode',
        'boxno',
      ]);
      const skuCode = this.pickField(normalizedRow, ['sku']);
      const qtyRaw = this.pickField(normalizedRow, [
        '数量',
        '數量',
        'qty',
        'count',
        'quantity',
      ]);

      const boxCode = this.normalizeBoxCode(rawBoxCode);
      if (!boxCode || !skuCode || !qtyRaw) {
        errors.push(`第${rowNo}行：箱号/SKU/数量为必填`);
        return;
      }

      const qty = Number(qtyRaw);
      if (!Number.isInteger(qty) || qty <= 0) {
        errors.push(`第${rowNo}行：数量必须是正整数`);
        return;
      }

      parsed.push({
        boxCode,
        skuCode: skuCode.trim(),
        qty,
        sourceRowNo: rowNo,
      });
    });

    if (errors.length > 0) {
      throw new UnprocessableEntityException(`Excel校验失败：${errors.join(' | ')}`);
    }

    return parsed;
  }

  private mergeLines(lines: ParsedInboundLine[]): ParsedInboundLine[] {
    const map = new Map<string, ParsedInboundLine>();
    lines.forEach((line) => {
      const key = `${line.boxCode}||${line.skuCode}`;
      const existing = map.get(key);
      if (existing) {
        existing.qty += line.qty;
        existing.sourceRowNo = Math.min(existing.sourceRowNo, line.sourceRowNo);
        return;
      }
      map.set(key, { ...line });
    });

    return Array.from(map.values()).sort((a, b) => {
      const boxCompare = this.boxCodeToNumber(a.boxCode) - this.boxCodeToNumber(b.boxCode);
      if (boxCompare !== 0) return boxCompare;
      return a.skuCode.localeCompare(b.skuCode, 'en', { sensitivity: 'base' });
    });
  }

  private validateUploadedBoxes(collected: string[], uploaded: string[]): void {
    const collectedSet = new Set(collected);
    const uploadedSet = new Set(uploaded);

    const missing = collected.filter((boxCode) => !uploadedSet.has(boxCode));
    const unexpected = uploaded.filter((boxCode) => !collectedSet.has(boxCode));

    if (missing.length === 0 && unexpected.length === 0 && collectedSet.size === uploadedSet.size) {
      return;
    }

    const message = [
      '上传文件中的箱号必须与采集到的箱号范围完全一致',
      `缺少箱号：${missing.length ? missing.join(', ') : '-'}`,
      `多余箱号：${unexpected.length ? unexpected.join(', ') : '-'}`,
    ].join(' | ');

    throw new UnprocessableEntityException(message);
  }

  private async getUsedBoxNumbers(tx: Tx): Promise<Set<number>> {
    const boxes = await tx.box.findMany({
      select: {
        boxCode: true,
      },
    });

    const used = new Set<number>();
    boxes.forEach((box) => {
      const num = this.boxCodeToNumber(box.boxCode);
      if (num > 0) {
        used.add(num);
      }
    });

    return used;
  }

  private async getReservedBoxNumbers(tx: Tx): Promise<Set<number>> {
    const orders = await tx.batchInboundOrder.findMany({
      where: {
        status: {
          in: [BatchInboundOrderStatus.waiting_upload, BatchInboundOrderStatus.waiting_inbound],
        },
      },
      select: {
        collectedBoxCodes: true,
      },
    });

    const reserved = new Set<number>();
    orders.forEach((order) => {
      const boxCodes = this.parseCollectedBoxCodes(order.collectedBoxCodes);
      boxCodes.forEach((code) => {
        const num = this.boxCodeToNumber(code);
        if (num > 0) {
          reserved.add(num);
        }
      });
    });

    return reserved;
  }

  private findContinuousRangeStart(used: Set<number>, count: number): number {
    let start = 1;
    const maxStart = 999999 - count + 1;

    while (start <= maxStart) {
      let ok = true;
      for (let step = 0; step < count; step += 1) {
        if (used.has(start + step)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return start;
      }
      start += 1;
    }

    throw new UnprocessableEntityException('无法找到足够连续的空箱号');
  }

  private boxCodeToNumber(boxCode: string): number {
    const normalized = this.normalizeBoxCode(boxCode);
    if (!normalized) {
      return 0;
    }
    const [, raw] = normalized.split('-');
    return Number(raw);
  }

  private normalizeBoxCode(raw: string | null | undefined): string {
    const value = String(raw ?? '').trim().toUpperCase();
    if (!value) {
      return '';
    }

    if (/^\d{1,6}$/.test(value)) {
      return this.formatBoxCode(Number(value));
    }

    const matched = value.match(/^B[-_\s]?(\d{1,6})$/);
    if (!matched) {
      return '';
    }

    return this.formatBoxCode(Number(matched[1]));
  }

  private formatBoxCode(num: number): string {
    return `B-${num.toString().padStart(4, '0')}`;
  }

  private normalizeHeader(header: string): string {
    return header.replace(/[\s_\-]/g, '').toLowerCase();
  }

  private pickField(row: Record<string, string>, aliases: string[]): string {
    for (const alias of aliases) {
      const key = this.normalizeHeader(alias);
      const value = row[key];
      if (value) {
        return value;
      }
    }

    return '';
  }

  private parseCollectedBoxCodes(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      throw new UnprocessableEntityException('采集箱号数据无效');
    }

    const boxCodes = value
      .map((item) => this.normalizeBoxCode(String(item ?? '')))
      .filter((item) => Boolean(item));

    if (boxCodes.length === 0) {
      throw new UnprocessableEntityException('采集箱号数据无效');
    }

    return Array.from(new Set(boxCodes)).sort((a, b) => this.boxCodeToNumber(a) - this.boxCodeToNumber(b));
  }

  private buildBatchInboundOrderNo(batchNo: string, boxCount: number): string {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `BINB-${yyyy}${mm}${dd}-${batchNo}-${boxCount}`;
  }

  private async loadOrderDetailInTx(tx: Tx, orderId: bigint): Promise<BatchInboundOrderDetail> {
    const order = await tx.batchInboundOrder.findUnique({
      where: { id: orderId },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        items: {
          orderBy: [{ boxCode: 'asc' }, { skuCode: 'asc' }, { id: 'asc' }],
        },
      },
    });

    if (!order) {
      throw new NotFoundException('批量入库单不存在');
    }

    return this.toOrderDetail(order);
  }

  private toOrderSummary(order: {
    id: bigint;
    orderNo: string;
    status: BatchInboundOrderStatus;
    expectedBoxCount: number;
    rangeStart: number;
    rangeEnd: number;
    uploadedFileName: string | null;
    createdAt: Date;
    updatedAt: Date;
    collectedBoxCodes: Prisma.JsonValue;
    creator: { id: bigint; username: string };
    items: Array<{ id: bigint; status: BatchInboundItemStatus }>;
  }): BatchInboundOrderSummary {
    const pendingCount = order.items.filter((item) => item.status === BatchInboundItemStatus.pending).length;
    const confirmedCount = order.items.length - pendingCount;

    return {
      id: order.id.toString(),
      orderNo: order.orderNo,
      status: order.status,
      expectedBoxCount: order.expectedBoxCount,
      rangeStart: order.rangeStart,
      rangeEnd: order.rangeEnd,
      collectedBoxCodes: this.parseCollectedBoxCodes(order.collectedBoxCodes),
      uploadedFileName: order.uploadedFileName,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      creator: {
        id: order.creator.id.toString(),
        username: order.creator.username,
      },
      itemCount: order.items.length,
      pendingCount,
      confirmedCount,
    };
  }

  private toOrderDetail(order: {
    id: bigint;
    orderNo: string;
    status: BatchInboundOrderStatus;
    expectedBoxCount: number;
    rangeStart: number;
    rangeEnd: number;
    uploadedFileName: string | null;
    createdAt: Date;
    updatedAt: Date;
    collectedBoxCodes: Prisma.JsonValue;
    creator: { id: bigint; username: string };
    items: Array<{
      id: bigint;
      boxCode: string;
      skuCode: string;
      qty: number;
      sourceRowNo: number | null;
      status: BatchInboundItemStatus;
      confirmedAt: Date | null;
      createdAt: Date;
    }>;
  }): BatchInboundOrderDetail {
    const pendingCount = order.items.filter((item) => item.status === BatchInboundItemStatus.pending).length;
    const confirmedCount = order.items.length - pendingCount;

    return {
      id: order.id.toString(),
      orderNo: order.orderNo,
      status: order.status,
      expectedBoxCount: order.expectedBoxCount,
      rangeStart: order.rangeStart,
      rangeEnd: order.rangeEnd,
      collectedBoxCodes: this.parseCollectedBoxCodes(order.collectedBoxCodes),
      uploadedFileName: order.uploadedFileName,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      creator: {
        id: order.creator.id.toString(),
        username: order.creator.username,
      },
      itemCount: order.items.length,
      pendingCount,
      confirmedCount,
      items: order.items.map((item) => ({
        id: item.id.toString(),
        boxCode: item.boxCode,
        skuCode: item.skuCode,
        qty: item.qty,
        sourceRowNo: item.sourceRowNo,
        status: item.status,
        confirmedAt: item.confirmedAt,
        createdAt: item.createdAt,
      })),
    };
  }
}
