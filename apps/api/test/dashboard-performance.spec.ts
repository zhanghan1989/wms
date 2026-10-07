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
  it('serializes full calculations across periods while coalescing queued requests', async () => {
    const cache = new DashboardCache();
    let complete!: (value: unknown) => void;
    const firstBuild = jest.fn(() => new Promise(resolve => { complete = resolve; }));
    const secondBuild = jest.fn().mockResolvedValue({ days: 60 });
    const first = cache.get('30', false, firstBuild);
    const second = cache.get('60', false, secondBuild);
    const repeated = cache.get('60', true, secondBuild);
    await Promise.resolve();
    expect(firstBuild).toHaveBeenCalledTimes(1);
    expect(secondBuild).not.toHaveBeenCalled();
    complete({ days: 30 });
    await expect(first).resolves.toEqual({ days: 30 });
    await expect(second).resolves.toEqual({ days: 60 });
    await expect(repeated).resolves.toEqual({ days: 60 });
    expect(secondBuild).toHaveBeenCalledTimes(1);
  });
  it('releases the calculation queue after a failure and still serves fresh cached data', async () => {
    const cache = new DashboardCache();
    await cache.get('cached', false, async () => 1);
    let fail!: (error: Error) => void;
    const first = cache.get('30', false, () => new Promise((_, reject) => { fail = reject; }));
    const rejection = expect(first).rejects.toThrow('failed');
    const second = cache.get('60', false, async () => 2);
    await Promise.resolve();
    await expect(cache.get('cached', false, async () => 3)).resolves.toBe(1);
    fail(new Error('failed'));
    await rejection;
    await expect(second).resolves.toBe(2);
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
      $queryRaw: jest.fn().mockImplementation((query: any) => Promise.resolve(query.sql.includes('SUM(stock_qty)')
        ? [{ totalStock: 10n }] : [{ productId: 'P1', sku: 'legacy', rbSku: null, fbmSku: null, shop: '' }])),
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
describe('dashboard refresh after inventory changes', () => {
  function setup(active: boolean) {
    const script = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
    const source = script.slice(script.indexOf('function loadOverviewDashboard(options'), script.indexOf('\nfunction formatFileSize'));
    const state = { token: 'session', overviewDashboard: { old: true }, overviewDashboardGeneration: 0,
      overviewNeedsRefresh: false, overviewDashboardCache: new Map(), overviewIncludesFba: false,
      overviewFbaSnapshotId: '', overviewDashboardDays: 30 };
    const request = jest.fn().mockResolvedValue({ fresh: true });
    const render = jest.fn();
    const context = createContext({ state, request, URLSearchParams, Date,
      $: () => ({ classList: { contains: () => active } }),
      overviewDashboardLoadPromise: null, overviewDashboardLoadKey: '',
      renderOverviewDashboard: render, setTextById: jest.fn(), formatOverviewNumber: String });
    runInContext(source, context);
    return { state, request, render, context: context as any };
  }

  it('defers recalculation while hidden and requests fresh data when the dashboard is next opened', async () => {
    const { state, request, context } = setup(false);
    state.overviewDashboardCache.set('base::30', { data: { old: true }, expiresAt: Date.now() + 60_000 });
    await context.refreshOverviewAfterInventoryChange();
    expect(request).not.toHaveBeenCalled();
    expect(state.overviewDashboardCache.size).toBe(0);
    expect(state.overviewDashboard).toBeNull();
    await context.loadOverviewDashboard();
    expect(request).toHaveBeenCalledWith(expect.stringContaining('refresh=true'));
    expect(state.overviewNeedsRefresh).toBe(false);
    expect(state.overviewDashboard).toEqual({ fresh: true });
  });

  it('refreshes the visible dashboard and rejects pre-change responses from the cache and renderer', async () => {
    const { state, request, render, context } = setup(true);
    let complete!: (data: unknown) => void;
    request.mockImplementation((url: string) => url.includes('/summary') ? Promise.resolve({})
      : new Promise(resolve => { complete = resolve; }));
    const oldRequest = context.loadOverviewDashboard({ forceRefresh: true });
    const finishOld = complete;
    const refreshed = context.refreshOverviewAfterInventoryChange();
    const finishNew = complete;
    finishNew({ fresh: true });
    await refreshed;
    finishOld({ old: true });
    await oldRequest;
    expect(state.overviewDashboard).toEqual({ fresh: true });
    expect(state.overviewDashboardCache.get('base::30').data).toEqual({ fresh: true });
    expect(render).toHaveBeenCalledTimes(1);
  });
});

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

describe('dashboard snapshot memory limits', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('actively releases expired snapshots without waiting for another dashboard request', () => {
    const pages = require('../src/inventory/dashboard-pages') as typeof import('../src/inventory/dashboard-pages');
    const source = { demand: { topSkus: Array.from({ length: 65 }, (_, id) => ({ id })) }, obsolete: { noSales90dSkus: [] } };
    const first = pages.dashboardFirstPages(source) as any;
    expect(jest.getTimerCount()).toBe(1);
    expect((pages.dashboardFirstPages(source) as any).pagination.snapshotId).toBe(first.pagination.snapshotId);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(10 * 60_000);
    expect(jest.getTimerCount()).toBe(0);
    expect(() => pages.dashboardPage(first.pagination.snapshotId, 'top', '30')).toThrow('过期');
    expect((pages.dashboardFirstPages(source) as any).pagination.snapshotId).not.toBe(first.pagination.snapshotId);
  });

  it('evicts older large snapshots by total row budget and preserves the newest full pagination', () => {
    const pages = require('../src/inventory/dashboard-pages') as typeof import('../src/inventory/dashboard-pages');
    const make = () => ({ demand: { topSkus: Array.from({ length: 60_000 }, (_, id) => ({ id })) }, obsolete: { noSales90dSkus: [] } });
    const first = pages.dashboardFirstPages(make()) as any;
    const second = pages.dashboardFirstPages(make()) as any;
    expect(() => pages.dashboardPage(first.pagination.snapshotId, 'top', '30')).toThrow('过期');
    expect((pages.dashboardPage(second.pagination.snapshotId, 'top', '59970') as any).items).toHaveLength(30);
    expect(jest.getTimerCount()).toBe(1);
  });
});
