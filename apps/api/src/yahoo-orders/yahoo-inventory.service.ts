import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, YahooInventoryMapping, YahooOrderConnection } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { JapanJob } from '../company-scope/company-job';
import { PrismaService } from '../prisma/prisma.service';
import { inventoryCombos, isInventoryCombo, validInventoryCombo } from '../rakuten-rms-api/rakuten-inventory-combos';
import { RakutenInventoryService } from '../rakuten-rms-api/rakuten-inventory.service';
import { YahooOrdersClient, YahooRequestError, YahooStockRecord, YahooStockTarget, yahooStockKey } from './yahoo-orders.client';
import { YAHOO_CONNECTION_ID, YahooOrdersService, YahooSession } from './yahoo-orders.service';

const connectionId = YAHOO_CONNECTION_ID;
const batchSize = 100;
const previewLifetime = 10 * 60_000;
const ordersFreshFor = 25 * 60_000;
const productCode = /^[a-zA-Z0-9-]{1,99}$/;
const materials = ['肩带本体', '肩带配件'];
const asJson = (data: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(data));
const targetQuantity = (available: number, safety: number) => Math.min(99999, Math.max(0, available - safety));

type MappingInput = Record<string, unknown>;
type PreviewRow = YahooStockRecord & { productId: string; safetyStock: number; available: number; target: number };
type Issue = YahooStockTarget & { message: string };
type Plan = { rows: PreviewRow[]; issues: Issue[] };
type Trigger = 'preview' | 'scheduled' | 'manual';
type Summary = { eligible: number; changed: number; zero: number; issues: number; verified: number };

function targetFrom(input: MappingInput): YahooStockTarget {
  const itemCode = String(input.itemCode ?? '').trim();
  const subCode = String(input.subCode ?? '').trim();
  if (!productCode.test(itemCode) || (subCode && !productCode.test(subCode))) {
    throw new BadRequestException('Yahoo 商品编码和规格编码只能使用半角字母、数字和连字符');
  }
  return { itemCode, subCode };
}

function errorText(error: unknown): string {
  return error instanceof YahooRequestError || error instanceof BadRequestException || error instanceof ConflictException
    ? error.message.slice(0, 255) : 'WMS 无法完成本次雅虎库存任务，请查看服务日志';
}

function summarize(plan: Plan, verified = 0): Summary {
  const changed = plan.rows.filter(row => row.quantity !== row.target);
  return { eligible: plan.rows.length, changed: changed.length,
    zero: changed.filter(row => row.target === 0 && row.quantity! > 0).length, issues: plan.issues.length, verified };
}

@Injectable()
export class YahooInventoryService {
  private readonly logger = new Logger(YahooInventoryService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly yahoo: YahooOrdersService,
    private readonly client: YahooOrdersClient,
    private readonly warehouseStock: RakutenInventoryService,
  ) {}

  async status() {
    const [config, mappings, runs] = await Promise.all([
      this.db.yahooOrderConnection.findUnique({ where: { id: connectionId }, select: {
        enabled: true, inventoryEnabled: true, inventoryPauseReason: true, inventoryBaselineCount: true,
        lastCompleteOrdersAt: true, lastError: true, lockedUntil: true,
        shop: { select: { name: true, status: true } }, credentials: true,
      } }),
      this.db.yahooInventoryMapping.findMany({ where: { connectionId }, orderBy: [{ itemCode: 'asc' }, { subCode: 'asc' }] }),
      this.db.yahooInventoryRun.findMany({ where: { connectionId }, orderBy: { startedAt: 'desc' }, take: 20, select: {
        id: true, status: true, trigger: true, result: true, message: true, startedAt: true, finishedAt: true,
      } }),
    ]);
    const now = new Date();
    // The task is independent of Yahoo's 20-minute order pull.
    const date = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    const today = new Date(date + 'T17:30:00+09:00');
    const next = today > now ? today : new Date(today.getTime() + 86400000);
    return {
      shopName: config?.shop.name, authorized: Boolean(config?.credentials && config?.shop.status === 1),
      proxyConfigured: this.client.proxyConfigured,
      enabled: config?.inventoryEnabled ?? false, writeReady: config ? this.hasFreshOrders(config) : false,
      initialized: Boolean(config?.inventoryBaselineCount), pauseReason: config?.inventoryPauseReason,
      lastCompleteOrdersAt: config?.lastCompleteOrdersAt, nextRunAt: config?.inventoryEnabled ? next : null,
      running: Boolean(config?.lockedUntil && config.lockedUntil > now),
      mappings: mappings.map(row => ({ ...row, id: row.id.toString() })), runs,
    };
  }

  async saveMapping(input: MappingInput) {
    const target = targetFrom(input);
    const productId = String(input.productId ?? '').trim();
    const safetyStock = Number(input.safetyStock ?? 0);
    if (!productId || productId.length > 128 || !Number.isInteger(safetyStock) || safetyStock < 0 || safetyStock > 99999 ||
        (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new BadRequestException('产品 ID、安全库存或启用状态无效');
    return this.useConnection(async session => {
      await this.recoverInterrupted();
      if (!(await this.validProducts([productId])).has(productId)) {
        throw new BadRequestException('请选择启用中的 WMS 成品、肩带或有效组合');
      }
      const listing = await this.client.getStockProduct(session.row.sellerId, session.credentials, target.itemCode, session.signal);
      if (!listing || !this.hasVariant(listing.subCodes, target.subCode)) {
        throw new BadRequestException('Yahoo 商品或规格编码不存在');
      }
      const settings = { productId, source: 'manual', safetyStock, enabled: input.enabled !== false };
      await this.assertLease(session);
      await this.db.yahooInventoryMapping.upsert({
        where: { connectionId_itemCode_subCode: { connectionId, ...target } },
        create: { connectionId, ...target, ...settings }, update: settings,
      });
      return this.status();
    });
  }

  async disableMapping(id: string) {
    if (!/^[1-9]\d{0,19}$/.test(id)) throw new BadRequestException('SKU 映射编号无效');
    return this.useConnection(async session => {
      await this.recoverInterrupted();
      await this.assertLease(session);
      const changed = await this.db.yahooInventoryMapping.updateMany({ where: { id: BigInt(id), connectionId }, data: { enabled: false } });
      if (!changed.count) throw new NotFoundException('Yahoo SKU 映射不存在');
      return this.status();
    });
  }

  async autoMatch(input: MappingInput) {
    const { itemCode } = targetFrom(input);
    return this.useConnection(async session => {
      await this.recoverInterrupted();
      const listing = await this.client.getStockProduct(session.row.sellerId, session.credentials, itemCode, session.signal);
      if (!listing) throw new BadRequestException('Yahoo 商品不存在');
      const variants = listing.subCodes.length ? listing.subCodes : [''];
      const codes = variants.map(code => code || itemCode);
      const candidates = await this.findShopProducts(session.row.shop.name, codes);
      const products = [...new Set([...candidates.values()].flatMap(values => [...values]))];
      const valid = await this.validProducts(products);
      const existing = await this.db.yahooInventoryMapping.findMany({ where: { connectionId, itemCode } });
      const saved = new Set(existing.map(row => row.subCode));
      const rows: Prisma.YahooInventoryMappingCreateManyInput[] = [];
      const issues: Issue[] = [];
      for (const subCode of variants) {
        if (saved.has(subCode)) continue;
        const skus = candidates.get(subCode || itemCode) ?? new Set();
        if (skus.size !== 1) {
          issues.push({ itemCode, subCode, message: skus.size ? '对应多个 WMS 产品' : '未匹配本店 SKU' });
          continue;
        }
        const productId = [...skus][0];
        if (!valid.has(productId)) {
          issues.push({ itemCode, subCode, message: 'WMS 产品已停用、不存在或组合明细无效' });
          continue;
        }
        rows.push({ connectionId, itemCode, subCode, productId, source: 'auto', safetyStock: 0 });
      }
      await this.assertLease(session);
      if (rows.length) await this.db.yahooInventoryMapping.createMany({ data: rows, skipDuplicates: true });
      return { created: rows.length, existing: saved.size, issues };
    });
  }

  async test(input: MappingInput) {
    return this.useConnection(async ({ row, credentials, signal }) => {
      const target = input.itemCode
        ? targetFrom(input)
        : await this.db.yahooInventoryMapping.findFirst({ where: { connectionId, enabled: true } });
      if (!target) throw new BadRequestException('请输入一个 Yahoo 商品编码和对应规格，或先配置 SKU 映射');
      const listing = await this.client.getStockProduct(row.sellerId, credentials, target.itemCode, signal);
      if (!listing || !this.hasVariant(listing.subCodes, target.subCode)) throw new BadRequestException('Yahoo 商品或规格编码不存在');
      const stocks = await this.client.getStock(row.sellerId, credentials, [target], signal);
      const sample = stocks.get(yahooStockKey(target))!;
      return { listingOnSale: listing.onSale, stockAvailable: sample.present, quantity: sample.quantity, published: sample.published };
    });
  }

  async setEnabled(enabled: boolean) {
    if (!enabled) {
      await this.db.yahooOrderConnection.updateMany({ where: { id: connectionId }, data: { inventoryEnabled: false } });
      return this.status();
    }
    return this.useConnection(async session => {
      await this.recoverInterrupted();
      const config = await this.assertOrders(session);
      if (config.inventoryPauseReason) throw new ConflictException('请重新预览并手动确认同步，处理库存同步暂停原因');
      if (!config.inventoryBaselineCount) throw new ConflictException('请至少完成一次手动预览和确认同步');
      await this.db.yahooOrderConnection.updateMany({
        where: { id: connectionId, lockToken: session.token }, data: { inventoryEnabled: true, inventoryFailureCount: 0 },
      });
      return this.status();
    });
  }

  preview(actorId: string) {
    return this.background(announce => this.run('preview', actorId, announce));
  }

  execute(actorId: string, previewId: string) {
    if (!/^[a-f0-9-]{36}$/.test(previewId)) throw new BadRequestException('库存预览编号无效');
    return this.background(announce => this.run('manual', actorId, announce, previewId));
  }

  async job(actorId: string, id: string, page: number) {
    const row = await this.db.yahooInventoryRun.findFirst({ where: { id, connectionId } });
    if (!row) throw new NotFoundException('雅虎库存任务不存在');
    const plan = row.plan as Plan | null;
    const count = plan?.rows.length ?? 0;
    const currentPage = Math.min(Math.max(page, 1), Math.max(1, Math.ceil(count / 50)));
    return { id: row.id, status: row.status, canExecute: row.actorId === actorId, result: row.result, message: row.message, expiresAt: row.expiresAt,
      rows: plan?.rows.slice((currentPage - 1) * 50, currentPage * 50) ?? [], total: count, page: currentPage,
      issues: plan?.issues.slice(0, 50) ?? [] };
  }

  @Cron('0 30 17 * * *', { name: 'yahoo-inventory-sync', timeZone: 'Asia/Tokyo', waitForCompletion: true })
  @JapanJob()
  async scheduled(): Promise<void> {
    const config = await this.db.yahooOrderConnection.findUnique({ where: { id: connectionId }, select: { inventoryEnabled: true } });
    if (!config?.inventoryEnabled) return;
    try {
      await this.run('scheduled', null);
    } catch (error) {
      this.logger.warn(errorText(error));
    }
  }

  @Cron('0 15 3 * * *', { name: 'yahoo-inventory-cleanup', timeZone: 'Asia/Tokyo' })
  async cleanPlans(): Promise<void> {
    const ids = await this.db.yahooInventoryRun.findMany({
      where: { plan: { not: Prisma.DbNull }, finishedAt: { lt: new Date(Date.now() - 30 * 86400000) } },
      select: { id: true }, take: 500,
    });
    if (ids.length) await this.db.yahooInventoryRun.updateMany({ where: { id: { in: ids.map(row => row.id) } }, data: { plan: Prisma.DbNull } });
  }

  private async run(trigger: Trigger, actorId: string | null, announce?: (id: string) => void, previewId?: string) {
    await this.useConnection(async session => {
      await this.recoverInterrupted();
      const config = trigger === 'scheduled'
        ? await this.db.yahooOrderConnection.findUniqueOrThrow({ where: { id: connectionId } })
        : session.row;
      if (trigger === 'scheduled' && !config.inventoryEnabled) return;
      if (trigger === 'manual') await this.assertOrders(session);
      const old = previewId ? await this.db.yahooInventoryRun.findFirst({ where: {
        id: previewId, connectionId, actorId, status: 'preview', expiresAt: { gt: new Date() },
      } }) : null;
      if (previewId && !old?.plan) throw new ConflictException('预览已使用或超过 10 分钟，请重新预览');

      const id = old?.id ?? randomUUID();
      if (old) {
        await this.db.yahooInventoryRun.update({ where: { id }, data: { status: 'checking', trigger } });
      } else {
        await this.db.yahooInventoryRun.create({ data: { id, connectionId, actorId, trigger, status: 'planning' } });
      }
      announce?.(id);
      let plan: Plan | undefined;
      let verified = 0;
      let writeAttempted = false;
      let massChange = false;
      try {
        if (trigger === 'scheduled') await this.assertOrders(session, true);
        plan = await this.buildPlan(session);
        const summary = summarize(plan);
        if (trigger === 'preview') {
          await this.finish(id, 'preview', plan, summary);
          return;
        }
        if (old && !isDeepStrictEqual(old.plan, plan)) throw new ConflictException('Yahoo 库存或 WMS 可售数已变化，请重新预览');
        if (trigger === 'scheduled') {
          const positive = plan.rows.filter(row => row.quantity! > 0).length;
          massChange = (summary.zero >= 10 && summary.zero >= positive * 0.5) ||
            (config.inventoryBaselineCount >= 10 && summary.eligible < config.inventoryBaselineCount * 0.5) ||
            (summary.issues >= 10 && summary.issues >= (summary.eligible + summary.issues) * 0.5);
          if (massChange) throw new ConflictException('预计大量归零或有效 SKU 范围骤减，请人工预览确认');
        }
        if (!plan.rows.length) throw new ConflictException('没有可同步的已发布 Yahoo SKU');
        const changed = plan.rows.filter(row => row.quantity !== row.target);
        for (let index = 0; index < changed.length; index += batchSize) {
          const group = changed.slice(index, index + batchSize);
          await this.assertOrders(session, trigger === 'scheduled');
          await this.assertNoUntrackedOrders(session);
          await this.verifyBeforeWrite(session, group);
          await this.assertOrders(session, trigger === 'scheduled');
          if (!writeAttempted) {
            await this.db.yahooInventoryRun.update({ where: { id }, data: { status: 'writing', plan: asJson(plan) } });
          }
          writeAttempted = true;
          await this.client.setStock(session.row.sellerId, session.credentials,
            group.map(row => ({ ...row, quantity: row.target, overdraft: row.overdraft! })), session.signal);
          const remote = await this.client.getStock(session.row.sellerId, session.credentials, group, session.signal);
          for (const row of group) {
            const confirmed = remote.get(yahooStockKey(row));
            if (!confirmed?.present || !confirmed.published || confirmed.closed !== row.closed ||
                confirmed.quantity !== row.target || confirmed.overdraft !== row.overdraft) {
              throw new YahooRequestError('Yahoo 库存回读与目标不一致');
            }
            verified++;
          }
        }
        await this.assertLease(session);
        await this.finish(id, plan.issues.length ? 'partial' : 'success', plan, summarize(plan, verified));
        if (!plan.issues.length) {
          await this.db.yahooOrderConnection.updateMany({ where: { id: connectionId, lockToken: session.token },
            data: { inventoryPauseReason: null, inventoryFailureCount: 0, inventoryBaselineCount: plan.rows.length } });
        }
      } catch (error) {
        const message = errorText(error);
        const pause = writeAttempted || massChange ||
          (trigger === 'scheduled' && config.inventoryFailureCount + 1 >= 3);
        await this.db.yahooInventoryRun.update({ where: { id }, data: {
          status: writeAttempted ? 'needs_review' : 'failed', message, finishedAt: new Date(),
          ...(plan ? { plan: asJson(plan), result: asJson(summarize(plan, verified)) } : {}),
        } });
        await this.db.yahooOrderConnection.updateMany({ where: { id: connectionId, lockToken: session.token }, data: {
          ...(trigger === 'scheduled' ? { inventoryFailureCount: { increment: 1 } } : {}),
          ...(pause ? { inventoryEnabled: false, inventoryPauseReason: message } : {}),
        } });
        throw error;
      }
    });
  }

  private async buildPlan(session: YahooSession): Promise<Plan> {
    const configured = await this.db.yahooInventoryMapping.findMany({
      where: { connectionId, enabled: true }, orderBy: [{ itemCode: 'asc' }, { subCode: 'asc' }], take: 2001,
    });
    if (!configured.length) throw new ConflictException('请先配置并启用雅虎 SKU 映射');
    if (configured.length > 2000 || new Set(configured.map(row => row.itemCode)).size > 300) {
      throw new ConflictException('单轮支持最多 300 个 Yahoo 商品、2,000 条 SKU 映射，请调整启用范围');
    }
    const products = new Map<string, NonNullable<Awaited<ReturnType<YahooOrdersClient['getStockProduct']>>> | null>();
    const issues: Issue[] = [];
    const candidates: YahooInventoryMapping[] = [];
    const valid = await this.validProducts([...new Set(configured.map(row => row.productId))]);
    const matched = await this.findShopProducts(session.row.shop.name, configured.map(row => row.subCode || row.itemCode));

    for (const mapping of configured) {
      await this.assertLease(session);
      if (!valid.has(mapping.productId)) {
        issues.push({ ...this.target(mapping), message: 'WMS 产品已停用、不存在或组合明细无效' });
        continue;
      }
      const key = mapping.subCode || mapping.itemCode;
      if (matched.get(key)?.size !== 1 || !matched.get(key)?.has(mapping.productId)) {
        issues.push({ ...this.target(mapping), message: '库存映射与本店订单 SKU 的产品不一致，请核对 WMS SKU' });
        continue;
      }
      if (!products.has(mapping.itemCode)) {
        products.set(mapping.itemCode, await this.client.getStockProduct(session.row.sellerId, session.credentials, mapping.itemCode, session.signal));
      }
      const item = products.get(mapping.itemCode);
      if (!item?.onSale || !this.hasVariant(item.subCodes, mapping.subCode)) {
        issues.push({ ...this.target(mapping), message: item ? '商品未在售或规格已变化' : '商品已不存在' });
      } else {
        candidates.push(mapping);
      }
    }
    if (!candidates.length) return { rows: [], issues };
    const guard = () => this.assertLease(session);
    const available = await this.warehouseStock.stockQuantities([...new Set(candidates.map(row => row.productId))], guard);
    const rows: PreviewRow[] = [];
    for (let index = 0; index < candidates.length; index += batchSize) {
      await guard();
      const batch = candidates.slice(index, index + batchSize);
      const stock = await this.client.getStock(session.row.sellerId, session.credentials, batch, session.signal);
      for (const row of batch) {
        const remote = stock.get(yahooStockKey(row))!;
        if (!remote.present || !remote.published || remote.closed || remote.quantity === null || remote.overdraft === null) {
          issues.push({ ...this.target(row), message: '库存不存在、未发布、已关闭或不受数量管理' });
          continue;
        }
        const quantity = available.get(row.productId);
        if (!Number.isSafeInteger(quantity) || quantity! < 0) throw new BadRequestException('WMS 可售库存计算无效');
        rows.push({ ...remote, productId: row.productId, safetyStock: row.safetyStock,
          available: quantity!, target: targetQuantity(quantity!, row.safetyStock) });
      }
    }
    return { rows, issues };
  }

  private async verifyBeforeWrite(session: YahooSession, planned: PreviewRow[]) {
    const productIds = [...new Set(planned.map(row => row.productId))];
    const valid = await this.validProducts(productIds);
    const matched = await this.findShopProducts(session.row.shop.name, planned.map(row => row.subCode || row.itemCode));
    if (valid.size !== productIds.length || planned.some(row => {
      const ids = matched.get(row.subCode || row.itemCode);
      return ids?.size !== 1 || !ids.has(row.productId);
    })) throw new ConflictException('写入前发现 WMS 产品或 SKU 关系已变更，本轮已停止');
    const remote = await this.client.getStock(session.row.sellerId, session.credentials, planned, session.signal);
    const available = await this.warehouseStock.stockQuantities(productIds, () => this.assertLease(session));
    for (const row of planned) {
      const stock = remote.get(yahooStockKey(row));
      if (!stock?.present || !stock.published || stock.quantity !== row.quantity || stock.closed !== row.closed ||
          stock.overdraft !== row.overdraft || stock.updatedAt !== row.updatedAt ||
          available.get(row.productId) !== row.available) {
        throw new ConflictException('写入前发现库存或订单预占变化，本轮已停止');
      }
    }
  }

  private async validProducts(productIds: string[]) {
    const combos = await inventoryCombos(this.db, productIds);
    const valid = new Set([...combos].filter(([, combo]) => validInventoryCombo(combo)).map(([id]) => id));
    const ids = productIds.filter(id => !isInventoryCombo(id));
    const exact = new Set(ids);
    for (let offset = 0; offset < ids.length; offset += 500) {
      const products = await this.db.masterProduct.findMany({
        where: { status: 1, productId: { in: ids.slice(offset, offset + 500) } },
        select: { productId: true, productType: true },
      });
      for (const product of products) {
        if (exact.has(product.productId) && !materials.includes(String(product.productType ?? '').trim())) valid.add(product.productId);
      }
    }
    return valid;
  }

  private async findShopProducts(shop: string, codes: string[]) {
    const keys = [...new Set(codes)];
    const byCode = new Map<string, Set<string>>();
    for (let offset = 0; offset < keys.length; offset += 500) {
      const batch = keys.slice(offset, offset + 500);
      const data = await this.db.sku.findMany({
        where: { shop, status: 1, sku: { in: batch }, productId: { not: null } },
        select: { sku: true, productId: true },
      });
      const allowed = new Set(batch);
      for (const row of data) {
        if (!allowed.has(row.sku) || !row.productId) continue;
        const values = byCode.get(row.sku) ?? new Set<string>();
        values.add(row.productId);
        byCode.set(row.sku, values);
      }
    }
    return byCode;
  }

  private async assertNoUntrackedOrders(session: YahooSession) {
    const now = new Date();
    const since = new Date(now.getTime() - 90 * 86400000);
    const { row, credentials, signal } = session;
    let total = 0;
    const pageSize = 1000;
    const seen = new Set<string>();
    for (let start = 1; start === 1 || start <= total; start += pageSize) {
      const page = await this.client.outstanding(row.sellerId, credentials, since, now, start, pageSize, signal);
      if (start === 1) total = page.total;
      if (page.total !== total) throw new ConflictException('Yahoo 待发货订单在核对期间变化，请稍后重试');
      for (const { id } of page.statuses) {
        if (seen.has(id)) throw new ConflictException('Yahoo 待发货订单在核对期间变化，请稍后重试');
        seen.add(id);
      }
      const pending = page.statuses.filter(order => order.outstanding).map(order => order.id);
      if (!pending.length) continue;
      const captured = await this.db.manualOrderRecord.findMany({ where: { shopName: row.shop.name, orderId: { in: pending } },
        distinct: ['orderId'], select: { orderId: true } });
      if (captured.length !== pending.length) throw new ConflictException('Yahoo 有尚未进入 WMS 的未出荷订单，请核对拉单后再同步库存');
    }
  }

  private hasFreshOrders(config: Pick<YahooOrderConnection, 'enabled' | 'lastCompleteOrdersAt' | 'lastError'>) {
    return config.enabled && !config.lastError && !!config.lastCompleteOrdersAt && Date.now() - config.lastCompleteOrdersAt.getTime() < ordersFreshFor;
  }

  private async assertOrders(session: YahooSession, scheduled = false) {
    const config = await this.db.yahooOrderConnection.findUnique({ where: { id: connectionId } });
    if (!config || config.lockToken !== session.token || !config.lockedUntil || config.lockedUntil <= new Date()) {
      throw new ConflictException('雅虎库存任务已失去连接锁');
    }
    session.signal.throwIfAborted();
    if (!this.hasFreshOrders(config)) throw new ConflictException('雅虎最近 25 分钟没有完整拉单，请先完成订单导入');
    if (scheduled && !config.inventoryEnabled) throw new ConflictException('雅虎库存自动同步已经暂停');
    return config;
  }

  private async assertLease(session: YahooSession) {
    session.signal.throwIfAborted();
    const count = await this.db.yahooOrderConnection.count({
      where: { id: connectionId, lockToken: session.token, lockedUntil: { gt: new Date() } },
    });
    if (!count) throw new ConflictException('雅虎库存任务已失去连接锁');
  }

  private async recoverInterrupted() {
    const interrupted = await this.db.yahooInventoryRun.updateMany({
      where: { connectionId, status: 'writing' },
      data: { status: 'needs_review', message: '上一次库存写入中断，请核对 Yahoo 库存', finishedAt: new Date() },
    });
    if (interrupted.count) {
      await this.db.yahooOrderConnection.update({ where: { id: connectionId }, data: {
        inventoryEnabled: false, inventoryPauseReason: '上一次库存写入中断，请重新预览并核对实存',
      } });
    }
    await this.db.yahooInventoryRun.updateMany({ where: { connectionId, status: { in: ['planning', 'checking'] } },
      data: { status: 'failed', message: '任务中断，库存写入前结束', finishedAt: new Date() } });
  }

  private finish(id: string, status: 'success' | 'preview' | 'partial', plan: Plan, summary: Summary) {
    return this.db.yahooInventoryRun.update({ where: { id },
      data: { status, plan: asJson(plan), result: asJson(summary), finishedAt: new Date(),
        expiresAt: status === 'preview' ? new Date(Date.now() + previewLifetime) : null } });
  }

  private useConnection<T>(operation: (session: YahooSession) => Promise<T>): Promise<T> {
    return this.yahoo.withConnection(operation).catch(error => {
      if (error instanceof YahooRequestError) throw new BadRequestException(error.message);
      throw error;
    });
  }

  private background(operation: (announce: (id: string) => void) => Promise<void>) {
    return new Promise<{ jobId: string }>((resolve, reject) => {
      let queued = false;
      void operation(jobId => { queued = true; resolve({ jobId }); }).catch(error => {
        if (queued) this.logger.warn(errorText(error));
        else reject(error);
      });
    });
  }

  private hasVariant(codes: string[], subCode: string) {
    return codes.length ? codes.includes(subCode) : subCode === '';
  }

  private target(row: YahooStockTarget): YahooStockTarget {
    return { itemCode: row.itemCode, subCode: row.subCode };
  }
}
