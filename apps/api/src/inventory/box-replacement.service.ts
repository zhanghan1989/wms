import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { buildEquivalentBoxCodes, normalizeBoxCode } from '../common/box-code';
import { AuditEventType } from '../constants/audit-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { ReplaceBoxDto, ReplaceBoxPreviewDto } from './dto/replace-box.dto';
import { availableStock } from './stock-availability';
import { recordStockAdjustment } from './stock-ledger';
import { lockStockProducts } from './stock-transaction';

@Injectable()
export class BoxReplacementService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private normalize(payload: ReplaceBoxPreviewDto) {
    const fromBoxCode = normalizeBoxCode(payload.fromBoxCode);
    const toBoxCode = normalizeBoxCode(payload.toBoxCode);
    if (!fromBoxCode || !toBoxCode) throw new BadRequestException('箱号必须是1至6位数字');
    if (fromBoxCode === toBoxCode) throw new BadRequestException('新箱号不能与旧箱号相同');
    return { fromBoxCode, toBoxCode, shelfCode: String(payload.shelfCode ?? '').trim().toUpperCase() };
  }

  private async loadSource(db: Prisma.TransactionClient, fromBoxCode: string) {
    const matches = await db.box.findMany({
      where: { boxCode: { in: buildEquivalentBoxCodes(fromBoxCode) } }, include: { shelf: true },
    });
    if (!matches.length) throw new NotFoundException('旧箱号不存在');
    if (matches.length !== 1) throw new ConflictException('旧箱号存在重复编码，请先处理箱号数据');
    const box = matches[0];
    if (box.status !== 1) throw new ConflictException('旧箱号未启用');
    const rows = await db.masterProductBoxInventory.findMany({
      where: { boxId: box.id }, orderBy: { productId: 'asc' },
    });
    if (rows.some(row => !Number.isSafeInteger(row.qty) || row.qty < 0)) {
      throw new ConflictException('旧箱库存数据异常，请先处理库存');
    }
    const items = rows.filter(row => row.qty > 0);
    if (!items.length) throw new ConflictException('旧箱为空箱，不能换箱');
    return { box, rows, items };
  }

  private async check(db: Prisma.TransactionClient, payload: ReplaceBoxPreviewDto) {
    const input = this.normalize(payload);
    const source = await this.loadSource(db, input.fromBoxCode);
    const target = await db.box.findFirst({ where: { boxCode: { in: buildEquivalentBoxCodes(input.toBoxCode) } } });
    if (target) throw new ConflictException('新箱号已存在（包括空箱和禁用箱），请使用不存在的箱号');
    const shelf = input.shelfCode
      ? await db.shelf.findUnique({ where: { shelfCode: input.shelfCode } }) : source.box.shelf;
    if (!shelf || shelf.status !== 1) throw new ConflictException('新货架不存在或未启用');
    await this.checkTasks(db, source.box.id, [source.box.shelfId, shelf.id], input.fromBoxCode, input.toBoxCode);
    const balances = await availableStock(db, source.items.map(row => row.productId));
    const availableByProduct = new Map(balances.filter(item => item.boxId === source.box.id)
      .map(item => [item.productId, item.qty]));
    for (const row of source.items) {
      const available = availableByProduct.get(row.productId) ?? 0;
      if (available < row.qty) throw new ConflictException(`产品 ${row.productId} 存在拣货、FBA或BOM预占，不能整箱换号`);
    }
    const snapshotToken = createHash('sha256').update(JSON.stringify({
      boxId: String(source.box.id), boxCode: source.box.boxCode, shelfId: String(source.box.shelfId),
      updatedAt: source.box.updatedAt, targetShelfId: String(shelf.id), targetShelfUpdatedAt: shelf.updatedAt,
      toBoxCode: input.toBoxCode,
      items: source.rows.map(row => [row.productId, row.qty, row.updatedAt]),
    })).digest('hex');
    return { ...source, shelf, snapshotToken, input };
  }

  private async checkTasks(db: Prisma.TransactionClient, boxId: bigint, shelfIds: bigint[], from: string, to: string) {
    const pending = await db.batchInboundOrder.findMany({
      where: { status: { in: ['waiting_upload', 'waiting_inbound'] } },
      select: { orderNo: true, collectedBoxCodes: true, items: { where: { status: 'pending' }, select: { boxCode: true } } },
    });
    for (const order of pending) {
      const codes = [...(Array.isArray(order.collectedBoxCodes) ? order.collectedBoxCodes : []), ...order.items.map(item => item.boxCode)];
      if (codes.some(code => [from, to].includes(normalizeBoxCode(String(code))))) {
        throw new ConflictException(`箱号被批量入库单 ${order.orderNo} 占用，请先处理该单据`);
      }
    }
    const fba = await db.fbaReplenishment.findFirst({
      where: { boxId, status: { in: ['pending_confirm', 'pending_outbound'] } }, select: { requestNo: true },
    });
    if (fba) throw new ConflictException(`旧箱存在未完成的FBA补货申请 ${fba.requestNo}`);
    const picking = await db.overseasPickingBatch.findMany({
      where: { status: 'created' },
      select: { batchNo: true, items: { where: { dispatchMode: { in: ['', 'overseas'] } }, select: { pickingPlanSnapshot: true } } },
    });
    for (const batch of picking) {
      for (const item of batch.items) {
        const plans = Array.isArray(item.pickingPlanSnapshot) ? item.pickingPlanSnapshot : [];
        if (plans.some(plan => plan && typeof plan === 'object' && !Array.isArray(plan)
          && normalizeBoxCode(String(plan.boxCode ?? '')) === from)) {
          throw new ConflictException(`旧箱存在未完成的拣货批次 ${batch.batchNo}`);
        }
      }
    }
    const inbound = await db.inboundOrderItem.findFirst({ where: { boxId, order: { status: 'draft' } }, select: { order: { select: { orderNo: true } } } });
    if (inbound) throw new ConflictException(`旧箱存在未完成的入库单 ${inbound.order.orderNo}`);
    const outbound = await db.outboundOrderItem.findFirst({ where: { boxId, order: { status: 'draft' } }, select: { order: { select: { orderNo: true } } } });
    if (outbound) throw new ConflictException(`旧箱存在未完成的出库单 ${outbound.order.orderNo}`);
    const adjustment = await db.inventoryAdjustOrderItem.findFirst({ where: { boxId, order: { status: 'draft' } }, select: { order: { select: { adjustNo: true } } } });
    if (adjustment) throw new ConflictException(`旧箱存在未完成的库存调整单 ${adjustment.order.adjustNo}`);
    const stocktake = await db.stocktakeRecord.findFirst({ where: { boxId, task: { status: { in: ['draft', 'in_progress'] } } }, select: { task: { select: { taskNo: true } } } });
    if (stocktake) throw new ConflictException(`旧箱存在未完成的盘点任务 ${stocktake.task.taskNo}`);
    const planner = await db.stocktakePlannerTask.findFirst({ where: { shelfId: { in: shelfIds }, status: { in: ['pending', 'confirming'] } }, select: { taskNo: true } });
    if (planner) throw new ConflictException(`货架存在未完成的盘点任务 ${planner.taskNo}`);
    // Legacy item barcodes are a separate stock representation: never silently leave them in the old box.
    const itemCode = await db.itemCode.findFirst({ where: { boxId, status: { in: ['in_stock', 'frozen'] } }, select: { barcode: true } });
    if (itemCode) throw new ConflictException(`旧箱存在单品条码 ${itemCode.barcode}，请先处理单品库存`);
  }

  private summary(data: Awaited<ReturnType<BoxReplacementService['check']>>) {
    return {
      oldBoxCode: data.box.boxCode, newBoxCode: data.input.toBoxCode,
      oldShelfCode: data.box.shelf.shelfCode, newShelfCode: data.shelf.shelfCode,
      productCount: data.items.length, qty: data.items.reduce((sum, row) => sum + row.qty, 0),
      items: data.items.map(row => ({ productId: row.productId, qty: row.qty })),
      snapshotToken: data.snapshotToken,
    };
  }

  async source(boxCode: string) {
    const normalized = normalizeBoxCode(boxCode);
    if (!normalized) throw new BadRequestException('箱号必须是1至6位数字');
    const data = await this.loadSource(this.prisma, normalized);
    return { boxCode: data.box.boxCode, shelfCode: data.box.shelf.shelfCode,
      productCount: data.items.length, qty: data.items.reduce((sum, row) => sum + row.qty, 0) };
  }

  async preview(payload: ReplaceBoxPreviewDto) {
    return this.summary(await this.check(this.prisma, payload));
  }

  async replace(payload: ReplaceBoxDto, operatorId: bigint, requestId?: string) {
    const input = this.normalize(payload);
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(payload.operationId ?? '') || !/^[a-f0-9]{64}$/.test(payload.snapshotToken ?? '')) {
      throw new BadRequestException('换箱请求无效，请重新确认');
    }
    const operationKey = `replace-box:${operatorId}:${payload.operationId}`;
    const fingerprint = JSON.stringify({ ...input, snapshotToken: payload.snapshotToken });
    for (let attempt = 0; ; attempt++) {
      try {
        // Discover lock keys outside the transaction, then lock products before reading balances.
        // The transaction verifies this set again, so an arriving product cannot be missed.
        const candidates = await this.prisma.masterProductBoxInventory.findMany({
          where: { box: { boxCode: { in: buildEquivalentBoxCodes(input.fromBoxCode) } }, qty: { gt: 0 } },
          select: { productId: true },
        });
        const productIds = candidates.map(row => row.productId);
        const lockedProducts = new Set(productIds);
        return await this.prisma.$transaction(async tx => {
          await lockStockProducts(tx, productIds);
          const done = await tx.stockMovement.findUnique({ where: { operationKey }, select: { refId: true } });
          if (done) {
            const log = await tx.operationAuditLog.findFirst({ where: { entityType: 'inventory_adjust_order', entityId: done.refId, operatorId, remark: 'replace-box' } });
            const stored = log?.afterData as { fingerprint?: string; result?: ReturnType<BoxReplacementService['summary']> } | null;
            if (stored?.fingerprint !== fingerprint || !stored.result) throw new ConflictException('重复请求的换箱内容不同，请重新确认');
            return { ...stored.result, idempotent: true };
          }
          await tx.$queryRaw(Prisma.sql`SELECT id FROM boxes
            WHERE box_code IN (${Prisma.join(buildEquivalentBoxCodes(input.fromBoxCode))}) ORDER BY id FOR UPDATE`);
          // Serializable reads also protect the box's inventory range against newly inserted products.
          const data = await this.check(tx, payload);
          if (data.items.some(row => !lockedProducts.has(row.productId)) || data.snapshotToken !== payload.snapshotToken) throw new ConflictException('库存或货架已变化，请刷新后重新确认换箱');
          const result = this.summary(data);
          const target = await tx.box.create({ data: { boxCode: input.toBoxCode, shelfId: data.shelf.id, status: 1 } });
          await tx.masterProductBoxInventory.createMany({ data: data.items.map(row => ({ boxId: target.id, productId: row.productId, qty: row.qty })) });
          await tx.masterProductBoxInventory.deleteMany({ where: { boxId: data.box.id } });
          const order = await recordStockAdjustment(tx, operatorId, data.items.flatMap(row => [
            { boxId: data.box.id, productId: row.productId, qtyDelta: -row.qty },
            { boxId: target.id, productId: row.productId, qtyDelta: row.qty },
          ]), 'replace-box', operationKey);
          await this.audit.create({ db: tx, entityType: 'box', entityId: target.id,
            action: AuditAction.create, eventType: AuditEventType.BOX_CREATED, operatorId, requestId,
            afterData: { boxCode: target.boxCode, shelfCode: data.shelf.shelfCode, sourceBoxCode: data.box.boxCode }, remark: 'replace-box' });
          for (const box of [data.box, target]) {
            await this.audit.create({ db: tx, entityType: 'box', entityId: box.id,
              action: AuditAction.update, eventType: AuditEventType.BOX_FIELD_UPDATED, operatorId, requestId,
              beforeData: { boxCode: box.boxCode, qty: box.id === data.box.id ? result.qty : 0 },
              afterData: { ...result, boxCode: box.boxCode, qty: box.id === data.box.id ? 0 : result.qty }, remark: '整箱换号' });
          }
          await this.audit.create({ db: tx, entityType: 'inventory_adjust_order', entityId: order.id,
            action: AuditAction.update, eventType: AuditEventType.INVENTORY_ADJUST_CONFIRMED, operatorId, requestId,
            afterData: { fingerprint, result }, remark: 'replace-box' });
          return { ...result, idempotent: false };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: 60000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          const rawLockConflict = error.code === 'P2010' && ['1213', '1205'].includes(String(error.meta?.code));
          if (attempt < 2 && (rawLockConflict || ['P2034', 'P2002'].includes(error.code))) continue;
          if (error.code === 'P2002') throw new ConflictException('新箱号已被占用，请刷新后重试');
          if (rawLockConflict || error.code === 'P2034') throw new ConflictException('库存正在被其他操作使用，请稍后重试');
        }
        throw error;
      }
    }
  }
}
