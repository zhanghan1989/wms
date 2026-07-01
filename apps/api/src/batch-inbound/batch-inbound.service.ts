import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { readFile } from 'fs/promises';
import {
  AuditAction,
  BatchInboundItemStatus,
  BatchInboundOrderStatus,
  Prisma,
} from '@prisma/client';
import { join } from 'path';
import * as XLSX from 'xlsx';
import { AuditService } from '../audit/audit.service';
import { buildEquivalentBoxCodes, normalizeBoxCode } from '../common/box-code';
import { APP_TIMEZONE, getZonedDateParts, parseId } from '../common/utils';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { CollectBatchInboundDto } from './dto/collect-batch-inbound.dto';

interface ParsedInboundLine {
  boxCode: string;
  productId: string;
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
  domesticOrderNo: string | null;
  seaOrderNo: string | null;
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
    productId: string;
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
const BATCH_INBOUND_ITEM_ORDER_BY = [
  { boxCode: 'asc' },
  { productId: 'asc' },
  { id: 'asc' },
] satisfies Prisma.BatchInboundItemOrderByWithRelationInput[];
const BATCH_INBOUND_ITEM_PRODUCT_ORDER_BY = [
  { productId: 'asc' },
  { id: 'asc' },
] satisfies Prisma.BatchInboundItemOrderByWithRelationInput[];
const BATCH_INBOUND_TEMPLATE_FILE = '批量入库.xlsx';

@Injectable()
export class BatchInboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async getUploadTemplate(): Promise<{ fileName: string; content: Buffer }> {
    return getUploadTemplateByOverride.call(this);
  }

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
          orderBy: BATCH_INBOUND_ITEM_ORDER_BY,
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
      if (this.readSeaOrderNo(order)) {
        throw new UnprocessableEntityException('已保存海运单号的批量入库单不能删除');
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

      const initialBoxNumber = payload.initialBoxNumber ?? 1;
      const rangeStart = this.findContinuousRangeStart(usedNumbers, payload.boxCount, initialBoxNumber);
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

      const uploadedProductIds = Array.from(new Set(mergedLines.map((line) => line.productId))).sort();
      const existingProducts = await tx.masterProduct.findMany({
        where: {
          productId: {
            in: uploadedProductIds,
          },
        },
        select: {
          productId: true,
        },
      });
      const existingProductIdSet = new Set(existingProducts.map((item) => item.productId));
      const missingProductIds = uploadedProductIds.filter((productId) => !existingProductIdSet.has(productId));
      if (missingProductIds.length > 0) {
        throw new UnprocessableEntityException(
          `以下产品ID在系统中不存在：${missingProductIds.join(', ')}`,
        );
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
          productId: line.productId,
          qty: line.qty,
          sourceRowNo: line.sourceRowNo,
          status: BatchInboundItemStatus.pending,
        })),
      });

      const updatedOrder = await tx.batchInboundOrder.update({
        where: { id: order.id },
        data: {
          status: this.readSeaOrderNo(order)
            ? BatchInboundOrderStatus.waiting_inbound
            : BatchInboundOrderStatus.waiting_upload,
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
            orderBy: BATCH_INBOUND_ITEM_ORDER_BY,
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

  async updateDomesticOrderNo(
    orderIdParam: string,
    domesticOrderNoRaw: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<BatchInboundOrderDetail> {
    const orderId = parseId(orderIdParam, 'batchInboundOrderId');
    const domesticOrderNo = domesticOrderNoRaw.trim();
    if (!domesticOrderNo) {
      throw new BadRequestException('国内单号不能为空');
    }

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
          items: {
            orderBy: BATCH_INBOUND_ITEM_ORDER_BY,
          },
        },
      });
      if (!order) {
        throw new NotFoundException('批量入库单不存在');
      }
      if (order.status === BatchInboundOrderStatus.confirmed) {
        throw new UnprocessableEntityException('已确认的批量入库单不能编辑单号');
      }
      if (order.status === BatchInboundOrderStatus.void) {
        throw new UnprocessableEntityException('已作废的批量入库单不能编辑单号');
      }

      const nextStatus = this.readSeaOrderNo(order)
        ? BatchInboundOrderStatus.waiting_inbound
        : BatchInboundOrderStatus.waiting_upload;

      const updatedOrder = await tx.batchInboundOrder.update({
        where: { id: order.id },
        data: {
          domesticOrderNo,
          status: nextStatus,
        },
        include: {
          creator: {
            select: {
              id: true,
              username: true,
            },
          },
          items: {
            orderBy: BATCH_INBOUND_ITEM_ORDER_BY,
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
          domesticOrderNo: this.readDomesticOrderNo(order),
        },
        afterData: {
          status: updatedOrder.status,
          domesticOrderNo: this.readDomesticOrderNo(updatedOrder),
        },
        operatorId,
        requestId,
        remark: '保存国内单号',
      });

      return this.toOrderDetail(updatedOrder);
    });
  }

  async updateSeaOrderNo(
    orderIdParam: string,
    seaOrderNoRaw: string,
    operatorId: bigint,
    requestId?: string,
  ): Promise<BatchInboundOrderDetail> {
    const orderId = parseId(orderIdParam, 'batchInboundOrderId');
    const seaOrderNo = seaOrderNoRaw.trim();
    if (!seaOrderNo) {
      throw new BadRequestException('海运单号不能为空');
    }

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
          items: {
            orderBy: BATCH_INBOUND_ITEM_ORDER_BY,
          },
        },
      });
      if (!order) {
        throw new NotFoundException('批量入库单不存在');
      }
      if (order.status === BatchInboundOrderStatus.confirmed) {
        throw new UnprocessableEntityException('已确认的批量入库单不能编辑单号');
      }
      if (order.status === BatchInboundOrderStatus.void) {
        throw new UnprocessableEntityException('已作废的批量入库单不能编辑单号');
      }
      if (!this.readDomesticOrderNo(order)) {
        throw new UnprocessableEntityException('请先保存国内单号');
      }
      if (!order.uploadedFileName) {
        throw new UnprocessableEntityException('请先上传批量入库文档');
      }

      const updatedOrder = await tx.batchInboundOrder.update({
        where: { id: order.id },
        data: {
          seaOrderNo,
          status: BatchInboundOrderStatus.waiting_inbound,
        },
        include: {
          creator: {
            select: {
              id: true,
              username: true,
            },
          },
          items: {
            orderBy: BATCH_INBOUND_ITEM_ORDER_BY,
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
          seaOrderNo: this.readSeaOrderNo(order),
        },
        afterData: {
          status: updatedOrder.status,
          seaOrderNo: this.readSeaOrderNo(updatedOrder),
        },
        operatorId,
        requestId,
        remark: '保存海运单号',
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
        orderBy: BATCH_INBOUND_ITEM_PRODUCT_ORDER_BY,
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
        orderBy: BATCH_INBOUND_ITEM_ORDER_BY,
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
      productId: string;
      qty: number;
      status: BatchInboundItemStatus;
    },
    operatorId: bigint,
    requestId?: string,
  ): Promise<void> {
    const productId = String(item.productId || '').trim();
    const [product, box] = await Promise.all([
      tx.masterProduct.findUnique({
        where: { productId },
        select: {
          id: true,
          productId: true,
          stockQty: true,
        },
      }),
      this.resolveOrCreateBox(tx, item.boxCode, operatorId, requestId, order.orderNo),
    ]);

    if (!product) {
      throw new UnprocessableEntityException(`产品ID不存在：${productId}`);
    }

    const inventory = await tx.masterProductBoxInventory.findUnique({
      where: {
        boxId_productId: {
          boxId: box.id,
          productId,
        },
      },
    });

    const beforeQty = Number(inventory?.qty ?? 0);
    const afterQty = beforeQty + item.qty;

    if (inventory) {
      await tx.masterProductBoxInventory.update({
        where: {
          boxId_productId: {
            boxId: box.id,
            productId,
          },
        },
        data: {
          qty: afterQty,
        },
      });
    } else {
      await tx.masterProductBoxInventory.create({
        data: {
          boxId: box.id,
          productId,
          qty: item.qty,
        },
      });
    }

    const totalQty = await this.recalculateMasterProductStockQty(tx, productId);

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
        scope: 'master_product',
        boxCode: box.boxCode,
        productId,
        qty: beforeQty,
      },
      afterData: {
        scope: 'master_product',
        boxCode: box.boxCode,
        productId,
        qty: afterQty,
        qtyDelta: item.qty,
      },
      operatorId,
      requestId,
      remark: `batch inbound ${order.orderNo}`,
    });

    await this.auditService.create({
      db: tx,
      entityType: 'master_product',
      entityId: product.id,
      action: AuditAction.update,
      eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED,
      beforeData: {
        productId,
        stockQty: Number(product.stockQty ?? 0),
      },
      afterData: {
        productId,
        stockQty: totalQty,
        boxCode: box.boxCode,
        qtyDelta: item.qty,
      },
      operatorId,
      requestId,
      remark: `batch inbound ${order.orderNo}`,
    });
  }

  private async resolveOrCreateBox(
    tx: Tx,
    boxCode: string,
    operatorId: bigint,
    requestId: string | undefined,
    orderNo: string,
  ): Promise<{ id: bigint; boxCode: string }> {
    const existing = await tx.box.findFirst({
      where: {
        boxCode: {
          in: buildEquivalentBoxCodes(boxCode),
        },
      },
      select: {
        id: true,
        boxCode: true,
      },
      orderBy: { id: 'asc' },
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
    return parseExcelLinesByOverride.call(this, fileBuffer);
  }

  private mergeLines(lines: ParsedInboundLine[]): ParsedInboundLine[] {
    const map = new Map<string, ParsedInboundLine>();
    lines.forEach((line) => {
      const key = `${line.boxCode}||${line.productId}`;
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
      return a.productId.localeCompare(b.productId, 'en', { sensitivity: 'base' });
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

  private findContinuousRangeStart(used: Set<number>, count: number, initialBoxNumber = 1): number {
    let start = initialBoxNumber;
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
    return Number(normalized);
  }

  private normalizeBoxCode(raw: string | null | undefined): string {
    return normalizeBoxCode(raw);
  }

  private formatBoxCode(num: number): string {
    return num.toString().padStart(3, '0');
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

  private async recalculateMasterProductStockQty(tx: Tx, productId: string): Promise<number> {
    const aggregate = await tx.masterProductBoxInventory.aggregate({
      where: {
        productId,
        qty: { gt: 0 },
      },
      _sum: {
        qty: true,
      },
    });

    const totalQty = Number(aggregate._sum.qty ?? 0);
    await tx.masterProduct.update({
      where: { productId },
      data: {
        stockQty: totalQty,
      },
    });

    return totalQty;
  }

  private buildBatchInboundOrderNo(batchNo: string, boxCount: number): string {
    const parts = getZonedDateParts(new Date(), APP_TIMEZONE);
    return `BINB-${parts.year}${parts.month}${parts.day}-${batchNo}-${boxCount}`;
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
          orderBy: BATCH_INBOUND_ITEM_ORDER_BY,
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
    domesticOrderNo?: string | null;
    seaOrderNo?: string | null;
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
      domesticOrderNo: this.readDomesticOrderNo(order),
      seaOrderNo: this.readSeaOrderNo(order),
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
    domesticOrderNo?: string | null;
    seaOrderNo?: string | null;
    createdAt: Date;
    updatedAt: Date;
    collectedBoxCodes: Prisma.JsonValue;
    creator: { id: bigint; username: string };
    items: Array<{
      id: bigint;
      boxCode: string;
      productId: string;
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
      domesticOrderNo: this.readDomesticOrderNo(order),
      seaOrderNo: this.readSeaOrderNo(order),
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
        productId: item.productId,
        qty: item.qty,
        sourceRowNo: item.sourceRowNo,
        status: item.status,
        confirmedAt: item.confirmedAt,
        createdAt: item.createdAt,
      })),
    };
  }

  private readDomesticOrderNo(order: unknown): string | null {
    const value = (order as { domesticOrderNo?: string | null } | null)?.domesticOrderNo;
    if (!value) return null;
    const normalized = value.trim();
    return normalized || null;
  }

  private readSeaOrderNo(order: unknown): string | null {
    const value = (order as { seaOrderNo?: string | null } | null)?.seaOrderNo;
    if (!value) return null;
    const normalized = value.trim();
    return normalized || null;
  }
}

async function getUploadTemplateByOverride(this: BatchInboundService) {
  const fileName = BATCH_INBOUND_TEMPLATE_FILE;
  const cwd = process.cwd();
  const candidates = [
    join(cwd, 'docs', fileName),
    join(cwd, '..', '..', 'docs', fileName),
  ];

  for (const templatePath of candidates) {
    try {
      const content = await readFile(templatePath);
      return {
        fileName,
        content,
      };
    } catch {
      // try next candidate
    }
  }

  throw new NotFoundException(`模板文件不存在：${fileName}`);
};

function parseExcelLinesByOverride(
  this: BatchInboundService,
  fileBuffer: Buffer,
): ParsedInboundLine[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  } catch {
    throw new BadRequestException('无法解析 Excel 文件');
  }

  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) {
    throw new BadRequestException('Excel 中没有可读取的工作表');
  }

  const sheet = workbook.Sheets[firstSheet];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  if (rows.length === 0) {
    throw new BadRequestException('Excel 中没有数据');
  }

  const parsed: ParsedInboundLine[] = [];
  const errors: string[] = [];

  rows.forEach((row, index) => {
    const rowNo = index + 2;
    const normalizedRow: Record<string, string> = {};
    Object.entries(row).forEach(([key, value]) => {
      normalizedRow[this['normalizeHeader'](key)] = String(value ?? '').trim();
    });

    const rawBoxCode = this['pickField'](normalizedRow, ['箱号', '箱号编码', 'box', 'boxcode', 'boxno']);
    const productId = this['pickField'](normalizedRow, ['产品ID', '产品id', 'productId', 'productid']);
    const qtyRaw = this['pickField'](normalizedRow, ['数量', '总数', 'qty', 'count', 'quantity']);

    const boxCode = this['normalizeBoxCode'](rawBoxCode);
    if (!boxCode || !productId || !qtyRaw) {
      errors.push(`第${rowNo}行：箱号/产品ID/数量为必填`);
      return;
    }

    const qty = Number(qtyRaw);
    if (!Number.isInteger(qty) || qty <= 0) {
      errors.push(`第${rowNo}行：数量必须是大于 0 的整数`);
      return;
    }

    parsed.push({
      boxCode,
      productId: productId.trim(),
      qty,
      sourceRowNo: rowNo,
    });
  });

  if (errors.length > 0) {
    throw new UnprocessableEntityException(`Excel 校验失败：${errors.join(' | ')}`);
  }

  return parsed;
};
