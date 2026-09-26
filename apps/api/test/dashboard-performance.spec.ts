import { DashboardCache } from '../src/inventory/dashboard-cache';
import { dashboardFirstPages, dashboardPage } from '../src/inventory/dashboard-pages';

describe('dashboard pagination and snapshot refresh', () => {
  afterEach(() => jest.useRealTimers());
  it('keeps total statistics and page ordering stable while the source is refreshed', () => {
    const rows = Array.from({ length: 65 }, (_, productId) => ({ productId }));
    const source = { demand: { topSkus: rows }, obsolete: { noSales90dSkus: rows, noSales90dCount: 65, noSales90dStockQty: 900 } };
    const first = dashboardFirstPages(source) as any;
    expect(first.demand.topSkus).toHaveLength(30);
    expect(first.obsolete.noSales90dStockQty).toBe(900);
    expect((dashboardFirstPages(source) as any).pagination.snapshotId).toBe(first.pagination.snapshotId);
    const newer = dashboardFirstPages({ demand: { topSkus: [] }, obsolete: { noSales90dSkus: [] } }) as any;
    expect(newer.pagination.snapshotId).not.toBe(first.pagination.snapshotId);
    expect((dashboardPage(first.pagination.snapshotId, 'top', '30') as any).items[0].productId).toBe(30);
    expect((dashboardPage(first.pagination.snapshotId, 'top', '60') as any).items).toHaveLength(5);
    expect(() => dashboardPage(first.pagination.snapshotId, 'top', '-1')).toThrow();
    expect(() => dashboardPage('expired', 'top', '0')).toThrow('过期');
  });
  it('coalesces simultaneous forced refresh requests', async () => {
    const cache = new DashboardCache();
    const build = jest.fn().mockResolvedValue({ count: 1 });
    const [a, b] = await Promise.all([cache.get('key', true, build), cache.get('key', true, build)]);
    expect(a).toEqual(b);
    expect(build).toHaveBeenCalledTimes(1);
  });
  it('serves a bounded stale snapshot and replaces it after background refresh', async () => {
    jest.useFakeTimers();
    const cache = new DashboardCache();
    await cache.get('key', false, async () => ({ count: 1 }));
    jest.advanceTimersByTime(61_000);
    let complete!: (value: unknown) => void;
    const build = jest.fn(() => new Promise(resolve => { complete = resolve; }));
    expect(await cache.get('key', false, build)).toEqual({ count: 1 });
    const fresh = cache.get('key', true, build);
    complete({ count: 2 });
    expect(await fresh).toEqual({ count: 2 });
    expect(build).toHaveBeenCalledTimes(1);
  });
  it('allows retry after a failed initial calculation', async () => {
    const cache = new DashboardCache();
    await expect(cache.get('key', false, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    await expect(cache.get('key', false, async () => 2)).resolves.toBe(2);
  });
});

import { MasterProductsService } from '../src/master-products/master-products.service';
describe('inventory home cursor', () => {
  it('preserves filtering and uses the last visible row rather than the lookahead row', async () => {
    const rows = Array.from({ length: 31 }, (_, n) => ({ id: BigInt(n + 1), stockQty: 40 - n, productId: `P${n}` }));
    const findMany = jest.fn().mockResolvedValue(rows);
    const service = new MasterProductsService({ masterProduct: { findMany } } as never, {} as never);
    const first = await service.list(1, 30, '', true);
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
    expect(cursor).toEqual({ id: '30', stockQty: 11, productId: 'P29' });
    await service.list(2, 30, '', true, first.nextCursor!);
    expect(findMany.mock.calls[1][0].skip).toBe(0);
    expect(findMany.mock.calls[1][0].where.AND[1].OR[0]).toEqual({ stockQty: { lt: 11 } });
    expect(JSON.stringify(findMany.mock.calls[0][0].where)).toContain('肩带配件');
    await expect(service.list(2, 30, '', true, 'invalid')).rejects.toThrow('分页');
  });
});

import { InventoryService } from '../src/inventory/inventory.service';
describe('lightweight inventory summary', () => {
  it('excludes accessories and resolves legacy inbound SKUs without counting ambiguous mappings', async () => {
    const prisma = {
      masterProduct: { findMany: jest.fn().mockResolvedValue([
        { productId: 'P1', productType: null, stockQty: 10 },
        { productId: 'A1', productType: '肩带配件', stockQty: 100 },
      ]) },
      fbaReplenishment: { findMany: jest.fn().mockResolvedValue([
        { sku: { productId: 'P1' }, status: 'pending_outbound', actualQty: 2, requestedQty: 4 },
        { sku: { productId: 'A1' }, status: 'pending_confirm', requestedQty: 50 },
      ]) },
      batchInboundItem: { groupBy: jest.fn().mockResolvedValueOnce([
        { productId: 'legacy', _sum: { qty: 3 } }, { productId: 'A1', _sum: { qty: 20 } },
      ]).mockResolvedValueOnce([{ productId: 'P1', _sum: { qty: 5 } }]) },
      sku: { findMany: jest.fn().mockResolvedValue([{ productId: 'P1', sku: 'legacy' }]) },
    };
    const service = new InventoryService(prisma as never, {} as never);
    await expect(service.getOverviewHealthSummary()).resolves.toEqual({
      totalStock: 10, availableStock: 8, lockedStock: 2, inTransitStock: 3,
      arrangedProductionStock: 5, securedStock: 16,
    });
  });
});

import { readFileSync } from 'fs';
import { join } from 'path';
import { createContext, runInContext } from 'vm';
describe('dashboard scroll requests', () => {
  it('fetches only the next 30 rows and discards a response belonging to the previous view', async () => {
    const script = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
    const source = script.slice(script.indexOf('const overviewIncrementalTables'), script.indexOf('\nfunction setOverviewFbaDependentVisibility'));
    let count = 0;
    const handlers = new Set<() => Promise<void>>();
    const wrap = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500,
      addEventListener: (_: string, fn: () => Promise<void>) => handlers.add(fn),
      removeEventListener: (_: string, fn: () => Promise<void>) => handlers.delete(fn) };
    const body = { closest: () => wrap, set innerHTML(_: string) { count = 0; },
      insertAdjacentHTML: (_: string, html: string) => { count += (html.match(/<tr>/g) || []).length; } };
    let complete!: (data: unknown) => void;
    const request = jest.fn((_url: string) => new Promise(resolve => { complete = resolve; }));
    const context = createContext({ $: () => body, request, URLSearchParams, showToast: jest.fn(), renderOverviewTable: jest.fn() });
    runInContext(source, context);
    const render = (context as any).renderOverviewIncrementalTable;
    render('table', Array(30).fill({}), () => '<tr></tr>', 1, { snapshotId: 'first', total: 65, list: 'top' });
    expect(count).toBe(30);
    wrap.scrollTop = 450;
    const scroll = [...handlers][0];
    const pending = scroll();
    await scroll();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toContain('offset=30');
    render('table', [1], () => '<tr></tr>', 1, null);
    complete({ items: Array(30).fill({}), hasMore: true });
    await pending;
    expect(count).toBe(1);
    expect(handlers.size).toBe(1);
  });
});
