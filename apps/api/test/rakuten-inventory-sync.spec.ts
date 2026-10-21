import 'reflect-metadata';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { RakutenInventorySchedulerService } from '../src/rakuten-rms-api/rakuten-inventory-scheduler.service';
import { inventoryFullCheckDue } from '../src/rakuten-rms-api/rakuten-inventory.types';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { availableStock } from '../src/inventory/stock-availability';
import { RakutenInventoryService } from '../src/rakuten-rms-api/rakuten-inventory.service';
import { RakutenOrderSchedulerService } from '../src/rakuten-rms-api/rakuten-order-scheduler.service';
import { InventoryRecord } from '../src/rakuten-rms-api/rakuten-inventory.types';
import { OrdersService } from '../src/orders/orders.service';

jest.mock('../src/inventory/stock-availability', () => ({ availableStock: jest.fn() }));
const available = jest.mocked(availableStock);
const row = { id: 11n, connectionId: 1n, productId: 'P', manageNumber: 'item', variantId: 'SkuA', safetyStock: 0, enabled: true };
function fixture() {
  const connection = { id: 1n, status: 1, syncOrders: true, inventorySyncEnabled: true, shop: { status: 1, name: '店铺' },
    lastOrdersSyncedAt: new Date(), licenseExpiresAt: null, lastSyncError: null };
  const runs = new Map<string, any>();
  const prisma: any = {
    $transaction: jest.fn((action) => action(prisma)),
    rakutenRmsConnection: { findUnique: jest.fn().mockResolvedValue(connection), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([connection]) },
    rakutenScheduleControl: { upsert: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    rakutenInventoryMapping: { findMany: jest.fn().mockResolvedValue([row]), upsert: jest.fn(), updateMany: jest.fn(), count: jest.fn().mockResolvedValue(1) },
    rakutenComboProduct: { findMany: jest.fn().mockResolvedValue([]) },
    masterProduct: { findMany: jest.fn().mockResolvedValue([{ productId: 'P', status: 1, productType: '包' }]), findUnique: jest.fn().mockResolvedValue({ productId: 'P', status: 1, productType: '包' }) },
    rakutenInventoryRun: {
      create: jest.fn(async ({ data }) => { const record = { ...data, startedAt: new Date() }; runs.set(data.id, record); return record; }),
      findFirst: jest.fn(async ({ where, select }) => {
        const run = runs.get(where.id);
        return run && run.connectionId === where.connectionId && run.actorId === where.actorId
          && (!where.status || run.status === where.status) && (!where.expiresAt || run.expiresAt > where.expiresAt.gt)
          ? select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, run[key]])) : run : null;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const run of runs.values()) {
          if (where.id && run.id !== where.id || typeof where.status === 'string' && run.status !== where.status
            || where.status?.in && !where.status.in.includes(run.status) || where.expiresAt && run.expiresAt <= where.expiresAt.gt) continue;
          Object.assign(run, data); count += 1;
        }
        return { count };
      }),
      update: jest.fn(async ({ where, data }) => { const run = runs.get(where.id); Object.assign(run, data); return run; }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  let remote: InventoryRecord = { manageNumber: 'item', variantId: 'SkuA', quantity: 3,
    operationLeadTime: { normalDeliveryTimeId: 4, backOrderDeliveryTimeId: 5 }, shipFromIds: [7] };
  const client = {
    getItemVariantIds: jest.fn().mockResolvedValue(['SkuA']),
    getItemsVariantIds: jest.fn().mockResolvedValue(new Map([['item', ['SkuA']]])),
    getInventory: jest.fn(async (_a: string, _b: string, _keys: any[]) => [{ ...remote }]),
    upsertInventory: jest.fn(async (_a, _b, writes) => { const { mode: _mode, ...value } = writes[0]; remote = value; }),
  };
  const orders = { inventorySyncPendingDemands: jest.fn().mockResolvedValue([]) };
  available.mockResolvedValue([{ productId: 'P', qty: 10 }] as any);
  const catalog = { summary: jest.fn(), scope: jest.fn(async (_connection, mappings) => mappings), needsRefresh: jest.fn().mockResolvedValue(false), refresh: jest.fn() };
  const service = new RakutenInventoryService(prisma as any, client as any, { decrypt: () => 'test-only' } as any, orders as any, catalog as any);
  return { service, prisma, client, connection, runs, orders, catalog };
}

describe('Rakuten inventory sync', () => {
  beforeEach(() => jest.clearAllMocks());
  it('previews without writing, preserves delivery fields and verifies an absolute update', async () => {
    const f = fixture();
    const preview = await f.service.preview('1', 2n);
    expect(preview.rows[0]).toMatchObject({ quantity: 10, currentQuantity: 3 });
    expect(f.runs.get(preview.previewId).plan.format).toBe('gzip-chunks-v1');
    for (const [query] of f.prisma.rakutenInventoryRun.update.mock.calls) expect(query.select).toEqual({ id: true });
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
    // MySQL JSON storage can reorder object keys; comparison must be semantic.
    f.runs.get(preview.previewId).plan = preview.rows.map((value) => Object.fromEntries(Object.entries(value).reverse()));
    await expect(f.service.execute('1', preview.previewId, 2n)).resolves.toMatchObject({ verified: 1, unchanged: 0 });
    expect(f.client.upsertInventory).toHaveBeenCalledWith('test-only', 'test-only', [{
      manageNumber: 'item', variantId: 'SkuA', quantity: 10, mode: 'ABSOLUTE',
      operationLeadTime: { normalDeliveryTimeId: 4, backOrderDeliveryTimeId: 5 }, shipFromIds: [7],
    }]);
    expect(f.runs.get(preview.previewId).status).toBe('success');
    await expect(f.service.execute('1', preview.previewId, 2n)).rejects.toBeInstanceOf(ConflictException);
  });
  it('computes a combo from the bottleneck component after pending reservations', async () => {
    const f = fixture();
    f.prisma.rakutenComboProduct.findMany.mockResolvedValue([{ comboName: 'zh-set', items: ['A', 'B'].map((productId) => ({ productId, product: { status: 1, productType: '包' } })) }]);
    f.prisma.masterProduct.findMany.mockResolvedValue(['A', 'B'].map((productId) => ({ productId, status: 1, productType: '包' })));
    f.orders.inventorySyncPendingDemands.mockResolvedValue([{ productId: 'B', quantity: 2 }]);
    available.mockResolvedValue([{ productId: 'A', qty: 10 }, { productId: 'B', qty: 6 }] as any);
    const details = new Map();
    const quantities = await (f.service as any).stockQuantities(['zh-set'], jest.fn(), details);
    expect(quantities.get('zh-set')).toBe(4);
    expect(details.get('zh-set')).toMatchObject({ beforePending: 6, pendingReserved: 2, availableQuantity: 4 });
  });

  it('does not count shared shoulder materials twice within the same combo', async () => {
    const f = fixture();
    f.prisma.rakutenComboProduct.findMany.mockResolvedValue([{ comboName: 'zh-straps', items: ['S', 'T'].map((productId) => ({ productId, product: { status: 1, productType: '肩带' } })) }]);
    f.prisma.masterProduct.findMany.mockImplementation(async ({ select }: any) => ['S', 'T'].map((productId) => ({ productId, status: 1, productType: '肩带',
      ...(select.bomComponents ? { bomComponents: [{ componentProductId: 'BODY', quantity: 1, componentProduct: { status: 1, productType: '肩带本体' } }] } : {}) })));
    available.mockResolvedValue([{ productId: 'BODY', qty: 10 }] as any);
    const quantities = await (f.service as any).stockQuantities(['zh-straps'], jest.fn());
    expect(quantities.get('zh-straps')).toBe(5);
  });

  it('rejects missing and empty combos and supports manually confirmed combo mappings', async () => {
    const f = fixture();
    await expect((f.service as any).stockQuantities(['zh-missing'], jest.fn())).rejects.toThrow('组合配置');
    f.prisma.rakutenComboProduct.findMany.mockResolvedValue([{ comboName: 'zh-set', items: [{ productId: 'P', product: { status: 1, productType: '包' } }] }]);
    await f.service.saveMapping('1', { productId: 'zh-set', manageNumber: 'item', variantId: 'SkuA', safetyStock: 2, enabled: true });
    expect(f.prisma.rakutenInventoryMapping.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ productId: 'zh-set' }) }));
  });

  it('includes zero quantities and applies safety stock', async () => {
    const f = fixture();
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue([{ ...row, safetyStock: 15 }]);
    const preview = await f.service.preview('1', 2n);
    expect(preview.rows[0].quantity).toBe(0);
    await f.service.execute('1', preview.previewId, 2n);
    expect(f.client.upsertInventory.mock.calls[0][2][0].quantity).toBe(0);
  });
  it('rejects expired, foreign-user and foreign-shop previews', async () => {
    const f = fixture(); const preview = await f.service.preview('1', 2n);
    await expect(f.service.execute('1', preview.previewId, 3n)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.execute('2', preview.previewId, 2n)).rejects.toBeInstanceOf(ConflictException);
    f.runs.get(preview.previewId).expiresAt = new Date(0);
    await expect(f.service.execute('1', preview.previewId, 2n)).rejects.toBeInstanceOf(ConflictException);
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('stops when local quantity changes after preview', async () => {
    const f = fixture(); const preview = await f.service.preview('1', 2n);
    available.mockResolvedValue([{ productId: 'P', qty: 1 }] as any);
    await expect(f.service.execute('1', preview.previewId, 2n)).rejects.toThrow('已有变化');
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('stops when remote stock changes immediately before writing', async () => {
    const f = fixture(); const preview = await f.service.preview('1', 2n);
    f.client.getInventory.mockResolvedValueOnce([{ ...preview.rows[0], quantity: 3 }]).mockResolvedValueOnce([{ ...preview.rows[0], quantity: 2 }]);
    await expect(f.service.execute('1', preview.previewId, 2n)).rejects.toThrow('同步前发生变化');
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('does not retry an ambiguous write and records that review is required', async () => {
    const f = fixture(); const preview = await f.service.preview('1', 2n);
    f.client.upsertInventory.mockRejectedValueOnce(new Error('写入结果未知'));
    await expect(f.service.execute('1', preview.previewId, 2n)).rejects.toThrow('写入结果未知');
    expect(f.client.upsertInventory).toHaveBeenCalledTimes(1);
    expect(f.runs.get(preview.previewId)).toMatchObject({ status: 'failed', result: { requiresReview: true } });
    expect(f.prisma.rakutenRmsConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ inventorySyncEnabled: false, inventoryPauseReason: expect.stringContaining('未全部回读确认') }) }));
  });
  it('detects readback mismatches', async () => {
    const f = fixture(); const preview = await f.service.preview('1', 2n);
    f.client.upsertInventory.mockImplementationOnce(async () => {});
    await expect(f.service.execute('1', preview.previewId, 2n)).rejects.toThrow('回读结果不一致');
    expect(f.runs.get(preview.previewId).status).toBe('partial');
  });
  it('never invents defaults when the remote inventory is missing', async () => {
    const f = fixture(); f.client.getInventory.mockResolvedValueOnce([]);
    const preview = await f.service.preview('1', 2n);
    expect(preview.rows).toEqual([]);
    expect(f.runs.get(preview.previewId).result.issues[0].reason).toContain('未读到');
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('validates item variants case-sensitively and excludes body/accessory mappings', async () => {
    const f = fixture();
    await expect(f.service.saveMapping('1', { ...row, variantId: 'skua' })).rejects.toThrow('不存在此SKU');
    for (const productType of ['肩带本体', '肩带配件']) {
      f.prisma.masterProduct.findUnique.mockResolvedValueOnce({ status: 1, productType });
      await expect(f.service.saveMapping('1', { ...row })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(f.prisma.rakutenInventoryMapping.upsert).not.toHaveBeenCalled();
  });
  it('rejects stale/incomplete order imports and cross-instance overlap', async () => {
    const f = fixture(); f.connection.lastOrdersSyncedAt = new Date(0);
    await expect(f.service.preview('1', 2n)).rejects.toThrow('最近25分钟');
    f.prisma.rakutenScheduleControl.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(f.service.preview('1', 2n)).rejects.toThrow('正在处理');
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('deducts pending shoulder demands from finished units then BOM materials, while each SKU gets the full remainder', async () => {
    const f = fixture();
    const strap = { productId: 'S', productType: '肩带', status: 1 };
    const bom = [
      { componentProductId: 'BODY', quantity: 1, componentProduct: { productType: '肩带本体', status: 1 } },
      { componentProductId: 'HOOK', quantity: 2, componentProduct: { productType: '肩带配件', status: 1 } },
    ];
    f.prisma.masterProduct.findMany.mockImplementation(async (query: any) => query.select.bomComponents ? [{ productId: 'S', bomComponents: bom }] as any : [strap]);
    available.mockResolvedValue([{ productId: 'S', qty: 2 }, { productId: 'BODY', qty: 10 }, { productId: 'HOOK', qty: 17 }] as any);
    f.orders.inventorySyncPendingDemands.mockResolvedValue([{ productId: 'S', quantity: 5 }]);
    const result = await (f.service as any).stockQuantities(['S'], jest.fn());
    // Two finished units plus three assemblies reserved: BODY=7, HOOK=11 => 5 left.
    expect(result.get('S')).toBe(5);
  });
  it('writes and verifies at most 400 SKUs per request', async () => {
    const f = fixture();
    const plan = Array.from({ length: 401 }, (_, i) => ({ mappingId: String(i), productId: 'P', manageNumber: 'item', variantId: `v${i}`, quantity: 10, currentQuantity: 0, safetyStock: 0 }));
    const remote = new Map(plan.map((row) => [row.variantId, 0]));
    (f.client.getInventory as jest.Mock).mockImplementation(async (_a, _b, keys) => keys.map((key: any) => ({ manageNumber: key.manageNumber, variantId: key.variantId, quantity: remote.get(key.variantId) })));
    f.client.upsertInventory.mockImplementation(async (_a, _b, writes) => { writes.forEach((row: any) => remote.set(row.variantId, row.quantity)); });
    f.runs.set('batch', {});
    const result = await (f.service as any).writePlan('1', 'batch', plan, jest.fn(), false);
    expect(result).toMatchObject({ verified: 401 });
    expect(f.client.upsertInventory.mock.calls.map((call) => call[2].length)).toEqual([400, 1]);
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
    expect(f.orders.inventorySyncPendingDemands).toHaveBeenCalledWith(f.prisma);
  });

  it('does not calculate or write WMS mappings outside the current shop catalog', async () => {
    const f = fixture(); f.catalog.scope.mockResolvedValueOnce([]);
    await expect(f.service.preview('1', 2n)).rejects.toThrow('在售SKU');
    expect(available).not.toHaveBeenCalled();
    expect(f.client.getInventory).not.toHaveBeenCalled();
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('refreshes a stale catalog before the scheduled inventory plan is built', async () => {
    const f = fixture(); f.catalog.needsRefresh.mockResolvedValueOnce(true);
    await f.service.runScheduled();
    expect(f.catalog.refresh).toHaveBeenCalledTimes(1);
    expect(f.catalog.refresh.mock.invocationCallOrder[0]).toBeLessThan(f.catalog.scope.mock.invocationCallOrder[0]);
    expect(f.client.upsertInventory).toHaveBeenCalledTimes(1);
  });

  it('returns a persisted background preview before remote checks finish, and scopes paginated results to its owner', async () => {
    const f = fixture();
    let finish!: (value: Map<string, string[]>) => void;
    f.client.getItemsVariantIds.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const job = await f.service.queuePreview('1', 2n);
    expect(f.runs.get(job.jobId).status).toBe('planning');
    for (let i = 0; i < 20 && !finish; i++) await new Promise(setImmediate);
    expect(finish).toBeDefined();
    finish(new Map([['item', ['SkuA']]]));
    for (let i = 0; i < 20 && f.runs.get(job.jobId).status !== 'preview'; i++) await new Promise(setImmediate);
    const page = await f.service.jobStatus('1', job.jobId, 2n, '1');
    expect(page).toMatchObject({ status: 'preview', total: 1, changedCount: 1, pageSize: 50 });
    await expect(f.service.jobStatus('1', job.jobId, 3n)).rejects.toThrow('不存在');
    await expect(f.service.jobStatus('2', job.jobId, 2n)).rejects.toThrow('不存在');
    await expect(f.service.jobStatus('1', job.jobId, 2n, '-1')).rejects.toThrow('页码');
    f.runs.get(job.jobId).plan = Array.from({ length: 101 }, () => page.rows[0]);
    expect((await f.service.jobStatus('1', job.jobId, 2n, '3')).rows).toHaveLength(1);
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('polls running and completed tasks without loading their large stored plan', async () => {
    const f = fixture();
    for (const status of ['planning', 'checking', 'running', 'success', 'failed']) {
      const run = { id: 'job', connectionId: 1n, actorId: '2', status,
        get plan(): never { throw new Error('must not load plan'); } };
      f.runs.set('job', run);
      await expect(f.service.jobStatus('1', 'job', 2n)).resolves.toMatchObject({ status, rows: [] });
    }
    expect(f.prisma.rakutenInventoryRun.findFirst).toHaveBeenCalledTimes(5);
    for (const [query] of f.prisma.rakutenInventoryRun.findFirst.mock.calls) expect(query.select.plan).toBeUndefined();
  });

  it('keeps combo stock correct with a large unrelated stock pool and shared materials', async () => {
    const f = fixture();
    const unrelated = Array.from({ length: 10000 }, (_, i) => `P${i}`);
    const combo = { comboName: 'zh-shared', items: ['S', 'T'].map((productId) => ({ productId, product: { status: 1, productType: '肩带' } })) };
    f.prisma.rakutenComboProduct.findMany.mockResolvedValue([combo]);
    f.prisma.masterProduct.findMany.mockImplementation(async ({ where, select }: any) => where.productId.in.map((productId: string) => ({
      productId, status: 1, productType: ['S', 'T'].includes(productId) ? '肩带' : '包',
      ...(select.bomComponents ? { bomComponents: [{ componentProductId: 'BODY', quantity: 1, componentProduct: { status: 1, productType: '肩带本体' } }] } : {}),
    })));
    available.mockImplementation(async (_tx, ids) => ids.map((productId) => ({ productId, qty: productId === 'BODY' ? 11 : 0 })) as any);
    const result = await (f.service as any).stockQuantities(['zh-shared', ...unrelated], jest.fn());
    expect(result.get('zh-shared')).toBe(5);
    expect(result.size).toBe(10001);
  });

  it('batches large SKU isolation and reports the stages after the final item check', async () => {
    const f = fixture();
    const mappings = Array.from({ length: 1201 }, (_, i) => ({ ...row, id: BigInt(i + 1), variantId: `v${i}` }));
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue(mappings);
    f.client.getInventory.mockImplementation(async (_a, _b, keys) => keys.map((key: any) => ({ ...key, quantity: 0 })));
    f.client.getItemsVariantIds.mockResolvedValue(new Map([['item', []]]));
    const progress = jest.fn();
    const context = { mode: 'full', scopeCount: 0, skippedCount: 0 };
    const plan = await (f.service as any).buildPlan('1', jest.fn(), progress, undefined, false, context);
    expect(plan).toEqual([]);
    const writes = f.prisma.rakutenInventoryMapping.updateMany.mock.calls.map(([query]: any) => query);
    expect(writes.map((query: any) => query.where.id.in.length)).toEqual([500, 500, 201]);
    expect(progress).toHaveBeenCalledWith('已校验在售商品 1 / 1');
    expect(progress).toHaveBeenCalledWith('正在记录异常SKU 1000 / 1201');
    expect(progress).toHaveBeenLastCalledWith('正在生成库存预览，已隔离异常SKU 1201 个');
  });

  it('returns a background execute job and never allows its preview to execute twice', async () => {
    const f = fixture(); const preview = await f.service.preview('1', 2n);
    const job = await f.service.queueExecute('1', preview.previewId, 2n);
    expect(job.jobId).toBe(preview.previewId);
    for (let i = 0; i < 20 && !['success', 'failed'].includes(f.runs.get(job.jobId).status); i++) await new Promise(setImmediate);
    expect(f.runs.get(job.jobId).status).toBe('success');
    await expect(f.service.queueExecute('1', preview.previewId, 2n)).rejects.toThrow('预览已过期');
    expect(f.client.upsertInventory).toHaveBeenCalledTimes(1);
  });
  it('marks an interrupted worker for review after reclaiming its lease, without replaying writes', async () => {
    const f = fixture();
    f.runs.set('interrupted', { id: 'interrupted', status: 'running' });
    await f.service.setEnabled('1', false);
    expect(f.runs.get('interrupted')).toMatchObject({ status: 'interrupted', result: { requiresReview: true } });
    expect(f.prisma.rakutenRmsConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { inventoryRuns: { some: { status: 'running' } } }, data: expect.objectContaining({ inventorySyncEnabled: false, inventoryPauseReason: expect.stringContaining('执行中断') }),
    }));
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('batches actual product validation into groups of fifty', async () => {
    const f = fixture();
    const mappings = Array.from({ length: 51 }, (_, i) => ({ ...row, id: BigInt(i + 1), manageNumber: `item${i}` }));
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue(mappings);
    f.client.getItemsVariantIds.mockImplementation(async (_a, _b, keys) => new Map(keys.map((key: string) => [key, ['SkuA']])));
    f.client.getInventory.mockImplementation(async (_a, _b, keys) => keys.map((key: any) => ({ ...key, quantity: 0 })));
    const preview = await f.service.preview('1', 2n);
    expect(preview.rows).toHaveLength(51);
    expect(f.client.getItemsVariantIds.mock.calls.map((call) => call[2].length)).toEqual([50, 1]);
    expect(f.client.getItemVariantIds).not.toHaveBeenCalled();
  });
  it('shares initial quantities across stores but recomputes stock immediately before a write', async () => {
    const f = fixture();
    f.prisma.rakutenRmsConnection.findMany.mockResolvedValue([f.connection, { ...f.connection, id: 2n }]);
    await f.service.runScheduled();
    expect(f.orders.inventorySyncPendingDemands).toHaveBeenCalledTimes(2);
    expect(f.client.upsertInventory).toHaveBeenCalledTimes(1);
  });
  it('does not load unrelated physical stock, while retaining reservations from shoulders sharing materials', async () => {
    const f = fixture();
    const component = { componentProductId: 'BODY', quantity: 1, componentProduct: { status: 1, productType: '肩带本体' } };
    f.orders.inventorySyncPendingDemands.mockResolvedValue([{ productId: 'T', quantity: 3 }, { productId: 'Q', quantity: 9 }]);
    f.prisma.masterProduct.findMany.mockImplementation(async (query: any) => query.select.bomComponents
      ? ['S', 'T'].map((productId) => ({ productId, bomComponents: [component] }))
      : [{ productId: 'S', productType: '肩带', status: 1 }, { productId: 'T', productType: '肩带', status: 1 }, { productId: 'Q', productType: '包', status: 1 }] as any);
    available.mockResolvedValue([{ productId: 'BODY', qty: 10 }, { productId: 'T', qty: 1 }] as any);
    const quantities = await (f.service as any).stockQuantities(['S'], jest.fn());
    expect(quantities.get('S')).toBe(8);
    const ids = available.mock.calls[0][1];
    expect(ids).toEqual(expect.arrayContaining(['S', 'T', 'BODY']));
    expect(ids).not.toContain('Q');
  });
  it('pauses automatic writes when at least ten and half of positive SKUs would become zero', async () => {
    const f = fixture();
    const mappings = Array.from({ length: 10 }, (_, i) => ({ ...row, id: BigInt(i + 1), variantId: `v${i}` }));
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue(mappings);
    f.client.getItemsVariantIds.mockResolvedValue(new Map([['item', mappings.map((m) => m.variantId)]]));
    f.client.getInventory.mockImplementation(async (_a, _b, keys) => keys.map((key: any) => ({ ...key, quantity: 3 })));
    available.mockResolvedValue([]);
    await f.service.runScheduled();
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
    expect(f.prisma.rakutenRmsConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ inventorySyncEnabled: false, inventoryPauseReason: expect.stringContaining('归零') }) }));
    // An explicit fresh manual preview is still allowed for a legitimate zero-stock change.
    expect((await f.service.preview('1', 2n)).rows.every((value) => value.quantity === 0)).toBe(true);
  });
  it('pauses when the eligible scope drops below half its last successful baseline', async () => {
    const f = fixture(); Object.assign(f.connection, { inventoryBaselineCount: 100 });
    await f.service.runScheduled();
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
    expect(f.prisma.rakutenRmsConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ inventorySyncEnabled: false, inventoryPauseReason: expect.stringContaining('100') }) }));
  });
  it('pauses after three consecutive scheduled failures and requires manual verification before re-enabling', async () => {
    const f = fixture(); f.catalog.scope.mockRejectedValue(new Error('清单失败'));
    f.prisma.rakutenRmsConnection.update.mockResolvedValue({ inventoryFailureCount: 3 });
    await f.service.runScheduled();
    expect(f.prisma.rakutenRmsConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ inventorySyncEnabled: false, inventoryPauseReason: expect.stringContaining('连续失败 3 次') }) }));
    Object.assign(f.connection, { inventoryPauseReason: '连续失败' });
    await expect(f.service.setEnabled('1', true)).rejects.toThrow('手动同步验证');
  });

  it('skips product detail checks and writes for unchanged hourly quantities but still compares actual remote stock', async () => {
    const f = fixture(); Object.assign(f.connection, { inventoryLastFullSyncedAt: new Date() });
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue([{ ...row, lastPublishedQuantity: 10 }]);
    f.client.getInventory.mockResolvedValue([{ manageNumber: 'item', variantId: 'SkuA', quantity: 10 }]);
    await f.service.runScheduled();
    expect(f.orders.inventorySyncPendingDemands).toHaveBeenCalledTimes(1);
    expect(f.client.getItemsVariantIds).not.toHaveBeenCalled();
    expect(f.client.getInventory).toHaveBeenCalledTimes(1); expect(f.client.upsertInventory).not.toHaveBeenCalled();
    expect([...f.runs.values()][0]).toMatchObject({ status: 'success', result: { mode: 'incremental', total: 1, skipped: 1, checked: 1, validated: 0 } });
    expect(f.prisma.rakutenRmsConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ inventoryBaselineCount: 1 }) }));
  });
  it('checks only changed or unconfirmed SKUs during ordinary hourly runs', async () => {
    const f = fixture(); Object.assign(f.connection, { inventoryLastFullSyncedAt: new Date() });
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue([
      { ...row, variantId: 'unchanged', lastPublishedQuantity: 10 },
      { ...row, id: 12n, variantId: 'SkuA', lastPublishedQuantity: 5 },
    ]);
    const getRemote = f.client.getInventory.getMockImplementation()!;
    f.client.getInventory.mockImplementation(async (a, b, keys) => {
      const values = await getRemote(a, b, keys.filter((key) => key.variantId !== 'unchanged'));
      return keys.map((key) => key.variantId === 'unchanged' ? { ...key, quantity: 10 } : values[0]);
    });
    await f.service.runScheduled();
    expect(f.client.getInventory.mock.calls[0][2]).toHaveLength(2);
    expect(f.client.upsertInventory.mock.calls[0][2]).toEqual([expect.objectContaining({ variantId: 'SkuA' })]);
    expect(f.prisma.rakutenInventoryMapping.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastPublishedQuantity: 10 }) }));
    expect([...f.runs.values()][0].result).toMatchObject({ mode: 'incremental', total: 2, skipped: 1, verified: 1 });
  });
  it('reconciles remote drift on the next full check even when local stock equals its last successful quantity', async () => {
    const f = fixture(); Object.assign(f.connection, { inventoryLastFullSyncedAt: new Date(Date.now() - 86400000) });
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue([{ ...row, lastPublishedQuantity: 10 }]);
    await f.service.runScheduled();
    expect(f.client.getInventory).toHaveBeenCalled(); expect(f.client.upsertInventory).toHaveBeenCalledTimes(1);
    expect([...f.runs.values()][0].result.mode).toBe('full');
    expect(f.prisma.rakutenRmsConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ inventoryLastFullSyncedAt: expect.any(Date) }) }));
  });
  it('detects remote sales even when local stock returns to its last confirmed quantity after offsetting receipts', async () => {
    const f = fixture(); Object.assign(f.connection, { inventoryLastFullSyncedAt: new Date() });
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue([{ ...row, lastPublishedQuantity: 10 }]);
    // Local 10 is unchanged, but Rakuten now has 3 after sales.
    await f.service.runScheduled();
    expect(f.client.upsertInventory.mock.calls[0][2][0]).toMatchObject({ quantity: 10 });
    expect([...f.runs.values()][0].result).toMatchObject({ mode: 'incremental', verified: 1 });
  });
  it('does not advance successful published quantities or the full-check date when a write is unconfirmed', async () => {
    const f = fixture(); f.client.upsertInventory.mockRejectedValue(new Error('写入未知'));
    await f.service.runScheduled();
    expect(f.prisma.rakutenInventoryMapping.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.rakutenRmsConnection.update.mock.calls.every((call: any) => !call[0].data.inventoryLastFullSyncedAt)).toBe(true);
  });
  it('stops a long-running plan when order-import freshness expires before the next write', async () => {
    const f = fixture(); const preview = await f.service.preview('1', 2n);
    f.prisma.rakutenRmsConnection.findUnique.mockResolvedValueOnce({ ...f.connection })
      .mockResolvedValue({ ...f.connection, lastOrdersSyncedAt: new Date(0) });
    await expect(f.service.execute('1', preview.previewId, 2n)).rejects.toThrow('最近25分钟');
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('invalidates a published quantity after manually changing a mapping, even when the new quantity may match', async () => {
    const f = fixture(); await f.service.saveMapping('1', { productId: 'P', manageNumber: 'item', variantId: 'SkuA', safetyStock: 2, enabled: true });
    expect(f.prisma.rakutenInventoryMapping.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ lastPublishedQuantity: null, lastPublishedAt: null }) }));
  });

  it('reads full inventory snapshots in batches of at most one thousand', async () => {
    const f = fixture();
    const mappings = Array.from({ length: 1001 }, (_, i) => ({ ...row, id: BigInt(i + 1), manageNumber: `item${Math.floor(i / 400)}`, variantId: `v${i}` }));
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue(mappings);
    f.client.getInventory.mockImplementation(async (_a, _b, keys) => keys.map((key) => ({ ...key, quantity: 10 })));
    f.client.getItemsVariantIds.mockResolvedValue(new Map(['item0', 'item1', 'item2'].map((manageNumber) => [manageNumber,
      mappings.filter((row) => row.manageNumber === manageNumber).map((row) => row.variantId)])));
    const preview = await f.service.preview('1', 2n);
    expect(preview.rows).toHaveLength(1001);
    expect(f.client.getInventory.mock.calls.map((call) => call[2].length)).toEqual([1000, 1]);
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });

  it('isolates an invalid SKU and writes valid SKUs while keeping the full-check date unadvanced', async () => {
    const f = fixture();
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue([{ ...row }, { ...row, id: 12n, variantId: 'invalid' }]);
    f.client.getInventory.mockImplementation(async (_a, _b, keys) => keys.map((key) => ({ ...key, quantity: key.variantId === 'SkuA' ? 3 : 4 })));
    // Keep real write/readback behavior for the valid SKU.
    f.client.upsertInventory.mockImplementation(async (_a, _b, writes) => { f.client.getInventory.mockImplementation(async (_x, _y, keys) => keys.map((key) => ({ ...key, quantity: writes[0].quantity }))); });
    const result = await f.service.runScheduled();
    expect(result.status).toBe('partial');
    expect(f.client.upsertInventory.mock.calls[0][2]).toEqual([expect.objectContaining({ variantId: 'SkuA' })]);
    const run = [...f.runs.values()][0];
    expect(run).toMatchObject({ status: 'partial', result: { excluded: 1, verified: 1, requiresReview: true } });
    expect(f.prisma.rakutenInventoryMapping.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [12n] }, connectionId: 1n }, data: expect.objectContaining({ syncIssue: expect.stringContaining('失效') }) }));
    expect(f.prisma.rakutenRmsConnection.update.mock.calls.every((call: any) => !call[0].data.inventoryLastFullSyncedAt)).toBe(true);
  });
  it('never treats a remote request failure as an isolated bad SKU', async () => {
    const f = fixture(); f.client.getItemsVariantIds.mockRejectedValue(new Error('HTTP 403'));
    await expect(f.service.preview('1', 2n)).rejects.toThrow('403');
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
    expect(f.prisma.rakutenInventoryMapping.updateMany).not.toHaveBeenCalled();
  });
  it('pauses the store when at least ten and half of its SKU definitions are invalid', async () => {
    const f = fixture();
    const mappings = Array.from({ length: 10 }, (_, i) => ({ ...row, id: BigInt(i + 1), variantId: `bad${i}` }));
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue(mappings);
    f.client.getInventory.mockImplementation(async (_a, _b, keys) => keys.map((key) => ({ ...key, quantity: 3 })));
    await f.service.runScheduled();
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
    expect(f.prisma.rakutenRmsConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ inventorySyncEnabled: false, inventoryPauseReason: expect.stringContaining('10 个SKU异常') }) }));
  });
  it('filters preview pages while retaining full-plan counts and confirmation ownership', async () => {
    const f = fixture(); const preview = await f.service.preview('1', 2n);
    f.runs.get(preview.previewId).plan = [
      { ...preview.rows[0], quantity: 0 }, { ...preview.rows[0], quantity: 3 }, { ...preview.rows[0], quantity: 10 },
    ];
    const zero = await f.service.jobStatus('1', preview.previewId, 2n, '1', 'zero');
    expect(zero).toMatchObject({ total: 3, filteredTotal: 1, changedCount: 2, zeroedCount: 1 });
    expect(zero.rows[0].quantity).toBe(0);
    expect((await f.service.jobStatus('1', preview.previewId, 2n, '1', 'changed')).rows).toHaveLength(2);
    await expect(f.service.jobStatus('1', preview.previewId, 2n, '1', 'invalid')).rejects.toThrow('筛选');
  });
  it('explains ordinary stock and safety stock without suggesting that BOM applies to it', async () => {
    const f = fixture(); f.orders.inventorySyncPendingDemands.mockResolvedValue([{ productId: 'P', quantity: 4 }]);
    f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue([{ ...row, safetyStock: 2 }]);
    const preview = await f.service.preview('1', 2n);
    expect(preview.rows[0]).toMatchObject({ quantity: 4, stock: { finishedStock: 10, assemblableStock: null, beforePending: 10, pendingReserved: 4, availableQuantity: 6 } });
  });
  it('connection diagnostics check read permissions independently and never pretend to verify write permission', async () => {
    const f = fixture();
    (f.client as any).searchCatalogPage = jest.fn().mockResolvedValue({ variants: [{ manageNumber: 'item', variantId: 'SkuA', hidden: false, unlimitedStock: false }] });
    f.client.getItemsVariantIds.mockRejectedValue(new Error('HTTP 403'));
    const result = await f.service.checkConnection('1');
    expect(result.readReady).toBe(false);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ api: 'items.bulk.get', status: 'failed', message: 'HTTP 403' }),
      expect.objectContaining({ api: 'inventories.bulk.get_2.1', status: 'passed' }),
      expect.objectContaining({ api: 'inventories.bulk.upsert_2.1', status: 'unverified' }),
    ]));
    expect(f.client.upsertInventory).not.toHaveBeenCalled();
  });
  it('does not report no-sample permission checks as passed', async () => {
    const f = fixture(); (f.client as any).searchCatalogPage = jest.fn().mockResolvedValue({ variants: [] });
    const result = await f.service.checkConnection('1');
    expect(result.readReady).toBe(false);
    expect(result.steps.filter((row) => row.status === 'unverified')).toHaveLength(4);
  });
  it('lists isolated issues in scoped pages without leaking connection credentials', async () => {
    const f = fixture(); f.prisma.rakutenInventoryMapping.findMany.mockResolvedValue([{ ...row, syncIssue: '失效', syncIssueAt: new Date() }]);
    const issues = await f.service.issues('1', '2');
    expect(issues.rows[0]).toMatchObject({ mappingId: '11', reason: '失效' });
    expect(f.prisma.rakutenInventoryMapping.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { connectionId: 1n, enabled: true, syncIssue: { not: null } }, skip: 50, take: 50 }));
    await expect(f.service.issues('1', '0')).rejects.toThrow('页码');
  });
  it('clears only aged terminal plan details, keeping summaries, failures and live previews protected', async () => {
    const f = fixture(); let calls = 0;
    f.prisma.rakutenInventoryRun.findMany.mockImplementation(async ({ where }: any) => {
      expect(where.planPurgedAt).toBeNull();
      const days = where.status === 'preview' ? 7 : where.status === 'success' ? 30 : 90;
      const cutoff = where.expiresAt?.lt || where.finishedAt.lt;
      expect(Math.round((Date.now() - cutoff.getTime()) / 86400000)).toBe(days);
      calls++; return [{ id: `old${calls}` }];
    });
    await f.service.cleanupHistory();
    const updates = f.prisma.rakutenInventoryRun.updateMany.mock.calls.filter((call: any) => call[0].data.planPurgedAt);
    expect(updates).toHaveLength(3);
    for (const [input] of updates) {
      expect(input.data.plan).toEqual([]); expect(input.data.result).toBeUndefined();
      expect(input.data.status).not.toBe('running');
      if (input.where.status !== 'preview') expect(input.data.message).toBeUndefined();
    }
  });

  it('does not fetch BOM for ordinary products', async () => {
    const f = fixture(); await f.service.preview('1', 2n);
    expect(f.prisma.masterProduct.findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.masterProduct.findMany.mock.calls[0][0].select).not.toHaveProperty('bomComponents');
  });
});

describe('independent hourly inventory processing', () => {
  it('registers the hourly half-past Tokyo job with overlap prevention', () => {
    const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, RakutenInventorySchedulerService.prototype.runScheduledInventorySync);
    expect(options).toMatchObject({ cronTime: '0 30 * * * *', name: 'rakuten-inventory-sync', timeZone: 'Asia/Tokyo', waitForCompletion: true });
  });
  it('the twenty-minute order flow never triggers inventory, including manual check', async () => {
    const schedules = { enabled: jest.fn().mockResolvedValue(true), execute: jest.fn(async (_key, action) => action()) };
    const scheduler = new RakutenOrderSchedulerService({ syncRakutenTrackingStatuses: async () => ({ failedCount: 0 }) } as any,
      { runScheduledAutomation: async () => undefined } as any, { runScheduledSync: async () => ({ results: [] }), syncAllConnections: async () => ({ results: [] }) } as any, schedules as any);
    await scheduler.runScheduledOrderProcessing(); await scheduler.runNow();
    expect(schedules.execute.mock.calls.map((row) => row[0])).not.toContain('inventory');
  });
  it.each([true, false])('the hourly job respects the persisted global switch: %s', async (enabled) => {
    const inventory = { runScheduled: jest.fn().mockResolvedValue({ status: 'success', errors: [] }) };
    const schedules = { execute: jest.fn(async (_key, action) => enabled ? action() : undefined) };
    await new RakutenInventorySchedulerService(inventory as any, schedules as any).runScheduledInventorySync();
    expect(inventory.runScheduled).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });
  it('uses the Japanese calendar day for daily full checks, including midnight and first setup', () => {
    expect(inventoryFullCheckDue(null)).toBe(true);
    expect(inventoryFullCheckDue(new Date('2026-10-14T15:30:00Z'), new Date('2026-10-15T14:30:00Z'))).toBe(false);
    expect(inventoryFullCheckDue(new Date('2026-10-15T14:30:00Z'), new Date('2026-10-15T15:30:00Z'))).toBe(true);
  });

});

describe('pending order reservation deduplication', () => {
  it('does not deduct a picking-batch order twice and includes unbatched Rakuten orders', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 1n, skuCode: 'P', orderQuantity: 5 }, { id: 2n, skuCode: 'P', orderQuantity: 3 },
    ]);
    const service = new OrdersService({
      rakutenOrderRecord: { findMany }, amazonOrderRecord: { findMany: jest.fn().mockResolvedValue([]) },
      manualOrderRecord: { findMany: jest.fn().mockResolvedValue([]) },
      overseasPickingBatchItem: { findMany: jest.fn().mockResolvedValue([{ sourceRecordId: 1n }]) },
    } as any);
    await expect(service.inventorySyncPendingDemands()).resolves.toEqual([{ productId: 'P', quantity: 3 }]);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ deletedAt: null, warehouseShippedAt: null, sendStatus: 'unsent' });
  });
});
