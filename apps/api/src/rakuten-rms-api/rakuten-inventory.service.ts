import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, RakutenRmsConnection } from '@prisma/client';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { parseId } from '../common/utils';
import { availableStock } from '../inventory/stock-availability';
import { calculateProductStockAvailability } from '../master-products/master-product-bom-stock';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { RakutenInventoryCatalogService } from './rakuten-inventory-catalog.service';
import { SaveRakutenInventoryMappingDto } from './dto/rakuten-inventory.dto';
import { RakutenRmsApiClient } from './rakuten-rms-api.client';
import { RakutenRmsApiCryptoService } from './rakuten-rms-api-crypto.service';
import { InventoryPlanContext, InventoryPlanRow, InventoryRecord, InventorySkuIssue, InventoryStockBreakdown, inventoryFullCheckDue, inventoryKey } from './rakuten-inventory.types';

const MATERIAL_TYPES = ['肩带本体', '肩带配件'];
const LOCK_KEY = 'inventory-write';
const LEASE_MS = 10 * 60_000;
const PAGE_SIZE = 400;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const settingsOf = (row: InventoryRecord) => ({
  ...(!row.operationLeadTime || !Object.keys(row.operationLeadTime).length ? {} : { operationLeadTime: row.operationLeadTime }),
  ...(!row.shipFromIds?.length ? {} : { shipFromIds: row.shipFromIds }),
});

@Injectable()
export class RakutenInventoryService {
  private readonly logger = new Logger(RakutenInventoryService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: RakutenRmsApiClient,
    private readonly crypto: RakutenRmsApiCryptoService,
    private readonly orders: OrdersService,
    private readonly catalog: RakutenInventoryCatalogService,
  ) {}

  private async connection(id: string, requireActive = true) {
    const row = await this.prisma.rakutenRmsConnection.findUnique({ where: { id: parseId(id) }, include: { shop: true } });
    if (!row) throw new NotFoundException('乐天连接不存在');
    if (requireActive && (row.status !== 1 || row.shop.status !== 1)) throw new BadRequestException('乐天店铺或连接已停用');
    if (requireActive && row.licenseExpiresAt && row.licenseExpiresAt <= new Date()) throw new BadRequestException('乐天API License已过期');
    return row;
  }
  private credentials(row: RakutenRmsConnection) {
    return [
      this.crypto.decrypt(row.encryptedServiceSecret, row.serviceSecretIv, row.serviceSecretAuthTag),
      this.crypto.decrypt(row.encryptedLicenseKey, row.licenseKeyIv, row.licenseKeyAuthTag),
    ] as const;
  }

  private async locked<T>(action: (renew: () => Promise<void>) => Promise<T>): Promise<T> {
    await this.prisma.rakutenScheduleControl.upsert({ where: { key: LOCK_KEY }, create: { key: LOCK_KEY, enabled: false }, update: {} });
    const token = randomUUID();
    const acquired = await this.prisma.rakutenScheduleControl.updateMany({
      where: { key: LOCK_KEY, OR: [{ runToken: null }, { heartbeatAt: { lt: new Date(Date.now() - LEASE_MS) } }] },
      data: { runToken: token, heartbeatAt: new Date() },
    });
    if (acquired.count !== 1) throw new ConflictException('库存同步或配置正在处理，请稍后重试');
    const renew = async () => {
      const result = await this.prisma.rakutenScheduleControl.updateMany({
        where: { key: LOCK_KEY, runToken: token, heartbeatAt: { gte: new Date(Date.now() - LEASE_MS) } },
        data: { heartbeatAt: new Date() },
      });
      if (result.count !== 1) throw new ConflictException('库存同步锁已失效，本轮已停止，请重新预览');
    };
    try {
      // Acquiring this lease proves the previous owner has released it or expired.
      // Interrupted writes are never replayed after a server restart.
      await this.prisma.rakutenRmsConnection.updateMany({ where: { inventoryRuns: { some: { status: 'running' } } }, data: {
        inventorySyncEnabled: false, inventoryPauseReason: '上次库存写入执行中断，结果尚未确认；请检查乐天库存并手动验证后再开启',
      } });
      await this.prisma.rakutenInventoryRun.updateMany({ where: { status: { in: ['planning', 'checking', 'running'] } },
        data: { status: 'interrupted', finishedAt: new Date(), message: '服务重启或执行中断，请检查乐天库存并重新预览；未自动重试', result: { requiresReview: true } } });
      return await action(renew);
    }
    finally { await this.prisma.rakutenScheduleControl.updateMany({ where: { key: LOCK_KEY, runToken: token }, data: { runToken: null, heartbeatAt: null } }); }
  }

  async status(connectionId: string, actorId?: bigint) {
    const connection = await this.connection(connectionId, false);
    const mappings = await this.prisma.rakutenInventoryMapping.findMany({ where: { connectionId: connection.id }, orderBy: { id: 'asc' }, take: 200 });
    const mappingCount = await this.prisma.rakutenInventoryMapping.count({ where: { connectionId: connection.id } });
    const runs = await this.prisma.rakutenInventoryRun.findMany({ where: { connectionId: connection.id }, orderBy: { startedAt: 'desc' }, take: 20,
      select: { id: true, trigger: true, status: true, actorId: true, expiresAt: true, message: true, result: true, startedAt: true, finishedAt: true } });
    return {
      enabled: connection.inventorySyncEnabled, lastFullSyncedAt: connection.inventoryLastFullSyncedAt, pauseReason: connection.inventoryPauseReason, failureCount: connection.inventoryFailureCount, mappingCount, catalog: await this.catalog.summary(connection),
      mappings: mappings.map((row) => ({ ...row, id: row.id.toString(), connectionId: row.connectionId.toString() })),
      runs: runs.map(({ actorId: _actorId, ...run }) => run),
      resumableJobId: actorId === undefined ? null : runs.find((run) => run.actorId === actorId.toString()
        && (['planning', 'checking', 'running'].includes(run.status) || run.status === 'preview' && run.expiresAt && run.expiresAt > new Date()))?.id ?? null,
    };
  }

  async issues(connectionId: string, pageRaw?: string) {
    const page = Number(pageRaw ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new BadRequestException('异常页码不合法');
    const connection = await this.connection(connectionId, false);
    const where = { connectionId: connection.id, enabled: true, syncIssue: { not: null } };
    const [total, rows] = await Promise.all([
      this.prisma.rakutenInventoryMapping.count({ where }),
      this.prisma.rakutenInventoryMapping.findMany({ where, orderBy: { id: 'asc' }, skip: (page - 1) * 50, take: 50 }),
    ]);
    return { page, pageSize: 50, total, rows: rows.map((row) => ({ mappingId: row.id.toString(), productId: row.productId,
      manageNumber: row.manageNumber, variantId: row.variantId, reason: row.syncIssue, detectedAt: row.syncIssueAt, safetyStock: row.safetyStock, enabled: row.enabled })) };
  }

  async checkConnection(connectionId: string) {
    return this.locked(async (renew) => {
      const connection = await this.connection(connectionId);
      const credentials = this.credentials(connection);
      const steps: Array<{ api: string; status: string; message: string }> = [];
      const test = async <T>(api: string, action: () => Promise<T>): Promise<T | undefined> => {
        await renew();
        try { const value = await action(); steps.push({ api, status: 'passed', message: '读取成功' }); return value; }
        catch (error) { steps.push({ api, status: 'failed', message: error instanceof Error ? error.message : '读取失败，请检查权限' }); return undefined; }
      };
      const page = await test('items.search', () => this.client.searchCatalogPage(...credentials, '*'));
      const sample = page?.variants.find((row) => !row.hidden && !row.unlimitedStock);
      if (sample) {
        await test('items.get', () => this.client.getItemVariantIds(...credentials, sample.manageNumber));
        await test('items.bulk.get', () => this.client.getItemsVariantIds(...credentials, [sample.manageNumber]));
        await test('inventories.bulk.get_2.1', async () => {
          const rows = await this.client.getInventory(...credentials, [sample]);
          if (!rows.some((row) => inventoryKey(row) === inventoryKey(sample))) throw new BadRequestException('样本SKU缺少库存设置，请先在RMS检查');
          return rows;
        });
      } else for (const api of ['items.get', 'items.bulk.get', 'inventories.bulk.get_2.1']) steps.push({ api, status: 'unverified', message: '没有可用样本SKU，尚未验证；请先读取或配置店铺商品' });
      steps.push({ api: 'inventories.bulk.upsert_2.1', status: 'unverified', message: '此检测不写入库存，无法确认写入权限；请在RMS检查授权，再通过手动同步验证' });
      return { readReady: steps.filter((row) => row.api !== 'inventories.bulk.upsert_2.1').every((row) => row.status === 'passed'), steps, checkedAt: new Date() };
    });
  }

  async cleanupHistory() {
    return this.locked(async (renew) => {
      const now = new Date();
      const ago = (days: number) => new Date(now.getTime() - days * 86400000);
      const policies = [
        { status: 'preview', expiresAt: { lt: ago(7) } },
        { status: 'success', finishedAt: { lt: ago(30) } },
        { status: { in: ['failed', 'partial', 'interrupted'] }, finishedAt: { lt: ago(90) } },
      ];
      let purged = 0;
      for (const policy of policies) for (let batch = 0; batch < 10; batch++) {
        await renew();
        const where = { ...policy, planPurgedAt: null };
        const rows = await this.prisma.rakutenInventoryRun.findMany({ where, select: { id: true }, orderBy: { startedAt: 'asc' }, take: 500 });
        if (!rows.length) break;
        const result = await this.prisma.rakutenInventoryRun.updateMany({ where: { ...where, id: { in: rows.map((row) => row.id) } },
          data: { plan: [], planPurgedAt: now, ...(policy.status === 'preview' ? { status: 'expired', message: '预览已过期，明细已按保留规则清理', finishedAt: now } : {}) } });
        purged += result.count;
        if (rows.length < 500) break;
      }
      return { purged };
    });
  }

  async setEnabled(connectionId: string, enabled: boolean) {
    return this.locked(async () => {
      const connection = await this.connection(connectionId, enabled);
      if (enabled && !connection.syncOrders) throw new BadRequestException('请先在乐天连接中启用订单导入，库存同步依赖最新订单');
      if (enabled && !await this.prisma.rakutenInventoryMapping.count({ where: { connectionId: connection.id, enabled: true } })) {
        throw new BadRequestException('请先配置至少一个商品与SKU对应关系');
      }
      if (enabled && connection.inventoryPauseReason) throw new ConflictException('此店铺因异常暂停，请先预览并手动同步验证成功，再开启自动同步');
      await this.prisma.rakutenRmsConnection.update({ where: { id: connection.id }, data: { inventorySyncEnabled: enabled } });
      return { enabled };
    });
  }

  async saveMapping(connectionId: string, payload: SaveRakutenInventoryMappingDto) {
    return this.locked(async (renew) => {
      const connection = await this.connection(connectionId);
      const productId = payload.productId.trim();
      const product = await this.prisma.masterProduct.findUnique({ where: { productId }, select: { productId: true, status: true, productType: true } });
      if (!product || product.productId !== productId || product.status !== 1 || MATERIAL_TYPES.includes(String(product.productType ?? '').trim())) {
        throw new BadRequestException('产品不存在、已停用或属于肩带本体/配件，不能同步');
      }
      const manageNumber = payload.manageNumber.toLowerCase();
      const credentials = this.credentials(connection);
      await renew();
      const variants = await this.client.getItemVariantIds(...credentials, manageNumber);
      if (!variants.includes(payload.variantId)) throw new BadRequestException('乐天商品中不存在此SKU管理番号，请核对大小写及对应关系');
      await renew();
      const current = await this.client.getInventory(...credentials, [{ manageNumber, variantId: payload.variantId }]);
      if (!current.some((row) => inventoryKey(row) === inventoryKey({ manageNumber, variantId: payload.variantId }))) throw new BadRequestException('此SKU尚无可读取的库存设置，请先在RMS完成设置');
      await this.prisma.rakutenInventoryMapping.upsert({
        where: { connectionId_manageNumber_variantId: { connectionId: connection.id, manageNumber, variantId: payload.variantId } },
        create: { connectionId: connection.id, productId, manageNumber, variantId: payload.variantId, safetyStock: payload.safetyStock, enabled: payload.enabled },
        update: { productId, safetyStock: payload.safetyStock, enabled: payload.enabled, source: 'manual', lastPublishedQuantity: null, lastPublishedAt: null, syncIssue: null, syncIssueAt: null },
      });
      if (connection.inventoryCatalogVersion) await this.prisma.rakutenInventoryCatalog.updateMany({ where: {
        connectionId: connection.id, version: connection.inventoryCatalogVersion, manageNumber, variantId: payload.variantId,
      }, data: { productId, matchStatus: 'manual' } });
      return this.status(connectionId);
    });
  }

  async catalogStatus(connectionId: string, pageRaw?: string, issuesOnly = false, search = '', matchStatus = '') {
    const page = Number(pageRaw ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new BadRequestException('清单页码不合法');
    return this.catalog.summary(await this.connection(connectionId, false), page, issuesOnly, search.trim().slice(0, 100), matchStatus);
  }

  async refreshCatalog(connectionId: string): Promise<{ jobId: string; status: string }> {
    let announce!: (value: { jobId: string; status: string }) => void;
    let reject!: (error: unknown) => void;
    const started = new Promise<{ jobId: string; status: string }>((resolve, fail) => { announce = resolve; reject = fail; });
    // Keep the same lease from job creation through publication, while returning
    // the persisted job ID immediately so the browser can poll without timeouts.
    void this.locked(async (renew) => {
      const connection = await this.connection(connectionId);
      const job = await this.catalog.queue(connection.id);
      announce({ jobId: job.id, status: 'running' });
      await this.catalog.refresh(connection, renew);
    }).catch((error: unknown) => {
      reject(error);
      this.logger.warn(`Catalog refresh failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
    return started;
  }

  async disableMapping(connectionId: string, mappingId: string) {
    return this.locked(async () => {
      await this.prisma.rakutenInventoryMapping.updateMany({ where: { id: parseId(mappingId), connectionId: parseId(connectionId) }, data: { enabled: false } });
      return this.status(connectionId);
    });
  }

  /** A shared stock pool is reduced by real order claims; published SKUs then
   * independently see the full remaining pool, per the user's allocation rule. */
  private async stockQuantities(productIds: string[], renew: () => Promise<void>, details?: Map<string, InventoryStockBreakdown>) {
    // All reservation and physical-stock reads share a repeatable-read snapshot.
    // External API calls happen after this read transaction has completed.
    return this.prisma.$transaction((tx) => this.stockSnapshot(productIds, renew, tx, details), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10000, timeout: 120000,
    });
  }

  private async stockSnapshot(productIds: string[], renew: () => Promise<void>, tx: Prisma.TransactionClient, details?: Map<string, InventoryStockBreakdown>) {
    const pending = await this.orders.inventorySyncPendingDemands(tx);
    const ids = [...new Set([...productIds, ...pending.map((row) => row.productId)])];
    const products = [] as Array<{
      productId: string; status: number; productType: string | null;
      bomComponents: Array<{ quantity: number; componentProductId: string; componentProduct: { status: number; productType: string | null } }>;
    }>;
    for (let offset = 0; offset < ids.length; offset += 500) {
      await renew();
      const batch = await tx.masterProduct.findMany({ where: { productId: { in: ids.slice(offset, offset + 500) } },
        select: { productId: true, status: true, productType: true },
      });
      const shoulderIds = batch.filter((row) => String(row.productType ?? '').trim() === '肩带').map((row) => row.productId);
      const shoulders = shoulderIds.length ? await tx.masterProduct.findMany({ where: { productId: { in: shoulderIds } },
        select: { productId: true, bomComponents: { select: { quantity: true, componentProductId: true, componentProduct: { select: { status: true, productType: true } } } } },
      }) : [];
      const bomById = new Map(shoulders.map((row) => [row.productId, row.bomComponents]));
      products.push(...batch.map((row) => ({ ...row, bomComponents: bomById.get(row.productId) ?? [] })));
    }
    const byId = new Map(products.map((row) => [row.productId, row]));
    if (ids.some((id) => !byId.has(id))) throw new BadRequestException('库存同步涉及不存在的产品，请先修复订单或映射');
    const targetProducts = productIds.map((id) => byId.get(id)!);
    const targetPools = new Set(targetProducts.flatMap((row) => [row.productId, ...row.bomComponents.map((item) => item.componentProductId)]));
    const relevant = new Set(products.filter((row) => targetPools.has(row.productId)
      || row.bomComponents.some((item) => targetPools.has(item.componentProductId))).map((row) => row.productId));
    const stockIds = [...new Set(products.filter((row) => relevant.has(row.productId)).flatMap((row) => [row.productId,
      ...(String(row.productType ?? '').trim() === '肩带' ? row.bomComponents.map((item) => item.componentProductId) : []),
    ]))];
    const stock = new Map<string, number>();
    for (let offset = 0; offset < stockIds.length; offset += 500) {
      await renew();
      const rows = await availableStock(tx, stockIds.slice(offset, offset + 500));
      for (const row of rows) stock.set(row.productId, (stock.get(row.productId) ?? 0) + Math.max(0, Number(row.qty)));
    }
    const beforePending = new Map(stock);
    const consume = (id: string, qty: number) => stock.set(id, Math.max(0, (stock.get(id) ?? 0) - qty));
    for (const demand of pending) {
      if (!relevant.has(demand.productId)) continue;
      const product = byId.get(demand.productId)!;
      const finished = Math.min(stock.get(product.productId) ?? 0, demand.quantity);
      consume(product.productId, finished);
      const assembly = demand.quantity - finished;
      if (assembly && String(product.productType ?? '').trim() === '肩带') {
        for (const item of product.bomComponents) {
          if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new BadRequestException('待发货肩带BOM用量异常，已停止同步');
          consume(item.componentProductId, assembly * item.quantity);
        }
      }
    }
    return new Map(productIds.map((id) => {
      const product = byId.get(id)!;
      if (product.status !== 1 || MATERIAL_TYPES.includes(String(product.productType ?? '').trim())) throw new BadRequestException(`产品 ${id} 已停用或属于肩带材料，已停止同步`);
      const availability = calculateProductStockAvailability({
        productType: product.productType, stockQty: stock.get(id) ?? 0,
        bomComponents: product.bomComponents.map((item) => ({ quantity: item.quantity,
          componentProduct: { ...item.componentProduct, stockQty: stock.get(item.componentProductId) ?? 0 } })),
      });
      if (details) {
        const before = calculateProductStockAvailability({ productType: product.productType, stockQty: beforePending.get(id) ?? 0,
          bomComponents: product.bomComponents.map((item) => ({ quantity: item.quantity,
            componentProduct: { ...item.componentProduct, stockQty: beforePending.get(item.componentProductId) ?? 0 } })) });
        details.set(id, { finishedStock: before.finishedStock, assemblableStock: before.assemblableStock,
          beforePending: before.fulfillableStock, pendingReserved: Math.max(0, before.fulfillableStock - availability.fulfillableStock),
          availableQuantity: availability.fulfillableStock });
      }
      return [id, availability.fulfillableStock];
    }));
  }

  private assertFreshOrders(connection: RakutenRmsConnection) {
    if (!connection.syncOrders || !connection.lastOrdersSyncedAt || connection.lastOrdersSyncedAt.getTime() < Date.now() - 25 * 60_000 || connection.lastSyncError) {
      throw new ConflictException('此店铺订单未在最近25分钟内完整导入，请先开启订单导入并运行自动处理检查');
    }
  }

  private async buildPlan(connectionId: string, renew: () => Promise<void>, progress: (message: string) => Promise<void> = async () => {}, shared?: Map<string, number>, scheduled = false, context?: InventoryPlanContext): Promise<InventoryPlanRow[]> {
    const connection = await this.connection(connectionId);
    this.assertFreshOrders(connection);
    const configured = await this.prisma.rakutenInventoryMapping.findMany({ where: { connectionId: connection.id, enabled: true }, orderBy: { id: 'asc' } });
    let mappings = await this.catalog.scope(connection, configured);
    if (scheduled && connection.inventoryBaselineCount >= 10 && mappings.length < connection.inventoryBaselineCount * 0.5) {
      await this.pause(connection.id, `可同步SKU从 ${connection.inventoryBaselineCount} 个降至 ${mappings.length} 个，已暂停，请检查清单与映射`);
    }
    if (!mappings.length) throw new BadRequestException('此店铺没有已匹配且启用的在售SKU，请刷新乐天清单并处理未匹配项');
    const allMappings = mappings;
    const issues: InventorySkuIssue[] = [];
    const isolate = (mapping: typeof mappings[number], reason: string) => issues.push({ mappingId: mapping.id.toString(), productId: mapping.productId,
      manageNumber: mapping.manageNumber, variantId: mapping.variantId, reason });
    const details = scheduled ? undefined : new Map<string, InventoryStockBreakdown>();
    const ids = [...new Set(mappings.map((row) => row.productId))];
    const quantities = shared ?? new Map<string, number>();
    const missing = ids.filter((id) => !quantities.has(id));
    if (missing.length) {
      await progress('正在计算仓库库存和待发货预占');
      for (const [id, value] of await this.stockQuantities(missing, renew, details)) quantities.set(id, value);
    }
    const scopeCount = mappings.length;
    const targetOf = (row: typeof mappings[number]) => Math.min(99999, Math.max(0, (quantities.get(row.productId) ?? 0) - row.safetyStock));
    const credentials = this.credentials(connection);
    const remote = new Map<string, InventoryRecord>();
    for (let offset = 0; offset < mappings.length; offset += 1000) {
      await renew();
      await progress(`正在批量比对乐天库存 ${offset} / ${scopeCount}`);
      const chunk = mappings.slice(offset, offset + 1000);
      const expected = new Set(chunk.map(inventoryKey));
      const current = await this.client.getInventory(...credentials, chunk.map(({ manageNumber, variantId }) => ({ manageNumber, variantId })));
      for (const row of current) {
        const key = inventoryKey(row);
        if (!expected.has(key) || remote.has(key)) throw new BadRequestException('乐天库存返回未知或重复SKU，已停止同步');
        remote.set(key, row);
      }
      for (const mapping of chunk) if (!remote.has(inventoryKey(mapping))) isolate(mapping, '未读到此SKU的库存及配送设置，请在RMS检查后刷新清单');
    }
    mappings = mappings.filter((row) => remote.has(inventoryKey(row)));
    const positiveCount = [...remote.values()].filter((row) => row.quantity > 0).length;
    // Compare the actual remote quantity too: sales and receipts can cancel out
    // locally while Rakuten has already deducted an order from its inventory.
    if (context?.mode === 'incremental') mappings = mappings.filter((row) => row.syncIssue || row.lastPublishedQuantity !== targetOf(row)
      || remote.get(inventoryKey(row))!.quantity !== targetOf(row));
    if (context) { context.scopeCount = scopeCount; context.skippedCount = scopeCount - mappings.length - issues.length; }
    const manageNumbers = [...new Set(mappings.map((row) => row.manageNumber))];
    const variantsByItem = new Map<string, Set<string>>();
    for (let offset = 0; offset < manageNumbers.length; offset += 50) {
      await renew();
      await progress(`正在校验在售商品 ${offset} / ${manageNumbers.length}`);
      const variants = await this.client.getItemsVariantIds(...credentials, manageNumbers.slice(offset, offset + 50), true);
      for (const [key, values] of variants) variantsByItem.set(key, new Set(values));
    }
    mappings = mappings.filter((mapping) => {
      if (variantsByItem.get(mapping.manageNumber)?.has(mapping.variantId)) return true;
      isolate(mapping, '商品或SKU已下架、销售期无效或编号失效，请刷新清单并修正映射'); return false;
    });
    if (context) context.issues = issues;
    for (const issue of issues) await this.prisma.rakutenInventoryMapping.updateMany({ where: { id: parseId(issue.mappingId), connectionId: connection.id },
      data: { syncIssue: issue.reason, syncIssueAt: new Date() } });
    if (scheduled && issues.length >= 10 && issues.length >= allMappings.length * 0.5) await this.pause(connection.id, `${issues.length} 个SKU异常（达到范围50%），已暂停，请检查清单及连接`);
    const plan: InventoryPlanRow[] = mappings.map((mapping) => {
      const old = remote.get(inventoryKey(mapping))!;
      return { mappingId: mapping.id.toString(), productId: mapping.productId,
        manageNumber: mapping.manageNumber, variantId: mapping.variantId, quantity: targetOf(mapping),
        currentQuantity: old.quantity, safetyStock: mapping.safetyStock, ...(details?.has(mapping.productId) ? { stock: details.get(mapping.productId) } : {}), ...settingsOf(old) };
    });
    if (scheduled) {
      const positive = plan.filter((row) => row.currentQuantity > 0);
      const zeroed = positive.filter((row) => row.quantity === 0).length;
      if (zeroed >= 10 && zeroed >= positiveCount * 0.5) await this.pause(connection.id, `${zeroed} 个有库存SKU将归零（达到50%），已暂停，请检查仓库和预占后手动验证`);
    }
    return plan;
  }

  private async pause(connectionId: bigint, reason: string): Promise<never> {
    await this.prisma.rakutenRmsConnection.update({ where: { id: connectionId }, data: { inventorySyncEnabled: false, inventoryPauseReason: reason } });
    throw new ConflictException(reason);
  }

  /** Resolve only once the lease and persisted job exist, without holding HTTP open. */
  private background(action: (started: (id: string) => void) => Promise<unknown>) {
    return new Promise<{ jobId: string }>((resolve, reject) => {
      void action((id) => resolve({ jobId: id })).catch((error: unknown) => {
        reject(error);
        this.logger.warn(`Inventory background job failed: ${error instanceof Error ? error.message : 'unknown'}`);
      });
    });
  }
  queuePreview(connectionId: string, actorId: bigint) { return this.background((started) => this.preview(connectionId, actorId, started)); }
  queueExecute(connectionId: string, previewId: string, actorId: bigint) { return this.background((started) => this.execute(connectionId, previewId, actorId, started)); }

  async jobStatus(connectionId: string, jobId: string, actorId: bigint, pageRaw?: string, filter = 'all') {
    const page = Number(pageRaw ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new BadRequestException('预览页码不合法');
    if (!['all', 'changed', 'zero'].includes(filter)) throw new BadRequestException('预览筛选不合法');
    const run = await this.prisma.rakutenInventoryRun.findFirst({ where: { id: jobId, connectionId: parseId(connectionId), actorId: actorId.toString() } });
    if (!run) throw new NotFoundException('库存任务不存在或不属于当前用户');
    const plan = Array.isArray(run.plan) ? run.plan as unknown as InventoryPlanRow[] : [];
    const filtered = plan.filter((row) => filter === 'all' || filter === 'changed' && row.quantity !== row.currentQuantity || filter === 'zero' && row.currentQuantity > 0 && row.quantity === 0);
    return { detailsPurged: Boolean(run.planPurgedAt), filteredTotal: filtered.length, filter, jobId: run.id, previewId: run.id, status: run.status, message: run.message, result: run.result,
      expiresAt: run.expiresAt, page, pageSize: 50, total: plan.length,
      changedCount: plan.filter((row) => row.quantity !== row.currentQuantity).length,
      zeroedCount: plan.filter((row) => row.currentQuantity > 0 && row.quantity === 0).length,
      rows: run.status === 'preview' ? filtered.slice((page - 1) * 50, page * 50) : [] };
  }

  async preview(connectionId: string, actorId: bigint, started?: (id: string) => void) {
    return this.locked(async (renew) => {
      await this.connection(connectionId);
      const run = await this.prisma.rakutenInventoryRun.create({ data: {
        id: randomUUID(), connectionId: parseId(connectionId), actorId: actorId.toString(), trigger: 'manual', status: 'planning', plan: [], message: '正在准备库存预览',
      } });
      started?.(run.id);
      try {
        const context: InventoryPlanContext = { mode: 'full', scopeCount: 0, skippedCount: 0 };
        const plan = await this.buildPlan(connectionId, renew, async (message) => {
          await this.prisma.rakutenInventoryRun.update({ where: { id: run.id }, data: { message } });
        }, undefined, false, context);
        const expiresAt = new Date(Date.now() + 10 * 60_000);
        await this.prisma.rakutenInventoryRun.update({ where: { id: run.id }, data: { status: 'preview', plan: json(plan), result: json(context), expiresAt, message: '预览完成，请核对后确认同步' } });
        return { previewId: run.id, expiresAt, rows: plan, changedCount: plan.filter((row) => row.quantity !== row.currentQuantity).length };
      } catch (error) {
        await this.prisma.rakutenInventoryRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), message: error instanceof Error ? error.message : '预览失败' } });
        throw error;
      }
    });
  }

  async execute(connectionId: string, previewId: string, actorId: bigint, started?: (id: string) => void) {
    return this.locked(async (renew) => {
      const run = await this.prisma.rakutenInventoryRun.findFirst({ where: { id: previewId, connectionId: parseId(connectionId), actorId: actorId.toString(), status: 'preview', expiresAt: { gt: new Date() } } });
      if (!run) throw new ConflictException('预览已过期、已执行或不属于当前店铺/用户，请重新预览');
      const claim = await this.prisma.rakutenInventoryRun.updateMany({ where: { id: run.id, status: 'preview', expiresAt: { gt: new Date() } }, data: { status: 'checking', message: '正在重新核对库存和映射' } });
      if (claim.count !== 1) throw new ConflictException('预览已失效，请重新预览');
      started?.(run.id);
      try {
        const context: InventoryPlanContext = { mode: 'full', scopeCount: 0, skippedCount: 0 };
        const fresh = await this.buildPlan(connectionId, renew, async (message) => {
          await this.prisma.rakutenInventoryRun.update({ where: { id: run.id }, data: { message } });
        }, undefined, false, context);
        if (!isDeepStrictEqual(context.issues ?? [], (run.result as unknown as InventoryPlanContext | null)?.issues ?? []) || !isDeepStrictEqual(fresh, run.plan)) throw new ConflictException('库存、映射或配送设置已有变化，请重新预览后同步');
        await this.prisma.rakutenInventoryRun.update({ where: { id: run.id }, data: { status: 'running' } });
        return await this.writePlan(connectionId, run.id, fresh, renew, false, context);
      } catch (error) {
        await this.prisma.rakutenInventoryRun.updateMany({ where: { id: run.id, status: 'checking' }, data: { status: 'failed', finishedAt: new Date(), message: error instanceof Error ? error.message : '复核失败' } });
        throw error;
      }
    });
  }

  private async writePlan(connectionId: string, runId: string, plan: InventoryPlanRow[], renew: () => Promise<void>, scheduled: boolean, context?: InventoryPlanContext) {
    let verified = 0;
    let attempted = 0;
    let acknowledged = 0;
    const changed = plan.filter((row) => row.currentQuantity !== row.quantity);
    try {
      for (let offset = 0; offset < changed.length; offset += PAGE_SIZE) {
        await renew();
        const connection = await this.connection(connectionId);
        this.assertFreshOrders(connection);
        if (scheduled && !connection.inventorySyncEnabled) throw new ConflictException('店铺库存同步已关闭，本轮已停止');
        const credentials = this.credentials(connection);
        await this.prisma.rakutenInventoryRun.update({ where: { id: runId }, data: { message: `已核对 ${verified} / ${changed.length} 个待更新SKU`, result: { changed: changed.length, attempted, acknowledged, verified } } });
        const chunk = changed.slice(offset, offset + PAGE_SIZE);
        // Read immediately before replacement to preserve the latest delivery settings.
        const latest = await this.client.getInventory(...credentials, chunk);
        const byKey = new Map(latest.map((row) => [inventoryKey(row), row]));
        const writes = chunk.map((row) => {
          const old = byKey.get(inventoryKey(row));
          if (!old || old.quantity !== row.currentQuantity || !isDeepStrictEqual(settingsOf(old), settingsOf(row))) {
            throw new ConflictException('乐天库存或配送设置在同步前发生变化，已停止，请重新预览');
          }
          return { manageNumber: row.manageNumber, variantId: row.variantId, quantity: row.quantity, mode: 'ABSOLUTE' as const, ...settingsOf(old) };
        });
        const freshStock = await this.stockQuantities([...new Set(chunk.map((row) => row.productId))], renew);
        if (chunk.some((row) => Math.min(99999, Math.max(0, (freshStock.get(row.productId) ?? 0) - row.safetyStock)) !== row.quantity)) {
          throw new ConflictException('仓库库存或待发货预占已变化，请重新预览');
        }
        await renew();
        attempted += writes.length;
        await this.client.upsertInventory(...credentials, writes);
        acknowledged += writes.length;
        await renew();
        const readback = await this.client.getInventory(...credentials, writes);
        const checked = new Map(readback.map((row) => [inventoryKey(row), row]));
        for (const row of writes) {
          const actual = checked.get(inventoryKey(row));
          if (!actual || actual.quantity !== row.quantity || !isDeepStrictEqual(settingsOf(actual), settingsOf(row))) {
            throw new ConflictException(`写入后 ${row.manageNumber}/${row.variantId} 回读结果不一致（可能有新订单），请检查乐天库存；未自动重试`);
          }
          verified += 1;
        }
        await this.rememberPublished(connectionId, chunk);
      }
      await this.rememberPublished(connectionId, plan.filter((row) => row.currentQuantity === row.quantity));
      const issues = context?.issues ?? [];
      const complete = issues.length === 0;
      const fullRequested = !context || context.mode === 'full';
      const full = fullRequested && complete;
      const result = { changed: changed.length, verified, unchanged: plan.length - changed.length,
        issues, excluded: issues.length, requiresReview: !complete, mode: context?.mode ?? 'full', total: context?.scopeCount ?? plan.length, checked: context?.scopeCount ?? plan.length, validated: plan.length, skipped: context?.skippedCount ?? 0 };
      await this.prisma.rakutenRmsConnection.update({ where: { id: parseId(connectionId) }, data: {
        inventoryFailureCount: 0, inventoryBaselineCount: context?.scopeCount ?? plan.length, ...(complete ? { inventoryPauseReason: null } : {}),
        ...(full ? { inventoryLastFullSyncedAt: new Date() } : {}),
      } });
      await this.prisma.rakutenInventoryRun.update({ where: { id: runId }, data: { status: complete ? 'success' : 'partial', finishedAt: new Date(), result, message: `隔离异常 ${issues.length} 个；${fullRequested ? "完整核对" : "变化检查"}：共 ${result.total} 个SKU，比对 ${result.checked} 个，校验商品 ${result.validated} 个，更新并核对 ${verified} 个，跳过未变化 ${result.skipped} 个` } });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '库存同步失败';
      if (attempted > verified) await this.prisma.rakutenRmsConnection.update({ where: { id: parseId(connectionId) }, data: {
        inventorySyncEnabled: false, inventoryPauseReason: `写入未全部回读确认，请检查乐天库存并手动验证：${message}`,
      } });
      await this.prisma.rakutenInventoryRun.update({ where: { id: runId }, data: {
        status: acknowledged || verified ? 'partial' : 'failed', finishedAt: new Date(),
        message: `${message}（尝试写入 ${attempted}，API确认 ${acknowledged}，回读确认 ${verified}）`,
        result: { changed: changed.length, attempted, acknowledged, verified, requiresReview: true },
      } });
      throw error;
    }
  }

  private async rememberPublished(connectionId: string, rows: InventoryPlanRow[]) {
    // Group by quantity to avoid one database update per SKU when many share stock.
    for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
      const groups = new Map<number, bigint[]>();
      for (const row of rows.slice(offset, offset + PAGE_SIZE)) {
        const ids = groups.get(row.quantity) ?? [];
        ids.push(parseId(row.mappingId)); groups.set(row.quantity, ids);
      }
      for (const [quantity, ids] of groups) await this.prisma.rakutenInventoryMapping.updateMany({
        where: { connectionId: parseId(connectionId), id: { in: ids } },
        data: { lastPublishedQuantity: quantity, lastPublishedAt: new Date(), syncIssue: null, syncIssueAt: null },
      });
    }
  }

  async runScheduled() {
    return this.locked(async (renew) => {
      const connections = await this.prisma.rakutenRmsConnection.findMany({ where: { status: 1, inventorySyncEnabled: true, shop: { status: 1 } }, select: { id: true, shop: { select: { name: true } } }, orderBy: { id: 'asc' } });
      const errors: string[] = [];
      let completed = 0;
      const shared = new Map<string, number>();
      for (const connection of connections) {
        const runId = randomUUID();
        await this.prisma.rakutenInventoryRun.create({ data: { id: runId, connectionId: connection.id, trigger: 'scheduled', status: 'planning', plan: [] } });
        try {
          const active = await this.connection(connection.id.toString());
          if (await this.catalog.needsRefresh(active)) await this.catalog.refresh(active, renew);
          const context: InventoryPlanContext = { mode: inventoryFullCheckDue(active.inventoryLastFullSyncedAt) ? 'full' : 'incremental', scopeCount: 0, skippedCount: 0 };
          const plan = await this.buildPlan(connection.id.toString(), renew, async (message) => {
            await this.prisma.rakutenInventoryRun.update({ where: { id: runId }, data: { message } });
          }, shared, true, context);
          await this.prisma.rakutenInventoryRun.update({ where: { id: runId }, data: { plan: json(plan), status: 'running' } });
          await this.writePlan(connection.id.toString(), runId, plan, renew, true, context);
          if (context.issues?.length) errors.push(`${connection.shop.name}：隔离异常SKU ${context.issues.length} 个，请查看库存待处理列表`);
          completed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : '库存同步失败';
          await this.prisma.rakutenInventoryRun.updateMany({ where: { id: runId, status: { in: ['planning', 'running'] } }, data: { status: 'failed', message, finishedAt: new Date() } });
          const updated = await this.prisma.rakutenRmsConnection.update({ where: { id: connection.id }, data: { inventoryFailureCount: { increment: 1 } } });
          if (updated?.inventoryFailureCount >= 3) await this.prisma.rakutenRmsConnection.update({ where: { id: connection.id }, data: {
            inventorySyncEnabled: false, inventoryPauseReason: `库存同步连续失败 ${updated.inventoryFailureCount} 次：${message}`,
          } });
          errors.push(`${connection.shop.name}：${message}`);
          this.logger.warn(`Inventory sync failed for connection ${connection.id}: ${message}`);
        }
      }
      return { status: errors.length ? completed ? 'partial' as const : 'failed' as const : 'success' as const, errors, completed };
    });
  }
}
