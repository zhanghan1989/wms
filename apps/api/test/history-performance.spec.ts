import { ReturnRecordsService } from '../src/return-records/return-records.service';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';
import { BatchInboundService } from '../src/batch-inbound/batch-inbound.service';

describe('history query optimizations', () => {
  it('searches database matches rather than limiting recent candidate records', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 1n }]);
    const findMany = jest.fn().mockResolvedValue([{ id: 1n, orderNo: '123-456', createdAt: new Date('2020-01-01') }]);
    const service = new ReturnRecordsService({ $queryRaw: query, returnRecord: { findMany } } as never);
    const result = await service.search('123456');
    expect(result.rows).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [1n] } } }));
    const sql = query.mock.calls[0][0];
    expect(sql.sql).toContain('REGEXP_REPLACE');
    expect(sql.values).toContain('123456');
    expect(sql.sql).not.toContain('123456');
  });

  it('paginates returns in groups of 30', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new ReturnRecordsService({ returnRecord: { findMany } } as never);
    await service.list(2);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 30, take: 30 }));
  });

  it('aggregates batch counts without loading item records and retains active orders', async () => {
    const order = { id: 1n, orderNo: 'B1', status: 'waiting_inbound', expectedBoxCount: 1,
      rangeStart: 1, rangeEnd: 1, collectedBoxCodes: ["001"], createdAt: new Date(), updatedAt: new Date(),
      uploadedFileName: null, creator: { id: 2n, username: 'user' } };
    const findMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([order]);
    const groupBy = jest.fn().mockResolvedValue([
      { orderId: 1n, status: 'pending', _count: { _all: 3 } },
      { orderId: 1n, status: 'confirmed', _count: { _all: 2 } },
    ]);
    const service = new BatchInboundService({ batchInboundOrder: { findMany, count: jest.fn().mockResolvedValue(1) },
      batchInboundItem: { groupBy } } as never, {} as never);
    const result = await service.list('1');
    expect(result.items[0]).toMatchObject({ itemCount: 5, pendingCount: 3, confirmedCount: 2 });
    expect(findMany.mock.calls[0][0].include.items).toBeUndefined();
    expect(result.pendingCount).toBe(1);
  });

  it('shares dashboard calculations and invalidates cached results', async () => {
    const service = new AmazonSpApiService({} as never, {} as never, {} as never);
    const build = jest.spyOn(service as any, 'buildStoreDashboard').mockResolvedValue({ dashboard: {} });
    await Promise.all([service.getStoreDashboard('1', '30'), service.getStoreDashboard('1', '30')]);
    expect(build).toHaveBeenCalledTimes(1);
    (service as any).invalidateDashboardCache();
    await service.getStoreDashboard('1', '30');
    expect(build).toHaveBeenCalledTimes(2);
  });
});

import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import { StocktakePlannerService } from '../src/stocktake-planner/stocktake-planner.service';

describe('history pagination protections', () => {
  it('ignores an old page after a reset and fetches the next page once', async () => {
    const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
    const snippet = source.slice(source.indexOf('const historyPages ='), source.indexOf('async function loadStocktakeTasks'));
    const resolvers: Array<(value: unknown) => void> = [];
    const request = jest.fn().mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    const context: any = { request, state: { token: 'session' } };
    runInNewContext(snippet, context);
    const apply = jest.fn();
    const old = context.loadHistoryPage('test', '/test', true, apply);
    const fresh = context.loadHistoryPage('test', '/test', true, apply);
    resolvers[1]({ items: ['fresh'], hasMore: true });
    await fresh;
    resolvers[0]({ items: ['old'], hasMore: true });
    await old;
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(['fresh'], expect.anything());
    const next = context.loadHistoryPage('test', '/test', false, apply);
    await context.loadHistoryPage('test', '/test', false, apply);
    expect(request).toHaveBeenLastCalledWith('/test?page=2');
    expect(request).toHaveBeenCalledTimes(3);
    resolvers[2]({ items: [], hasMore: false });
    await next;
    expect(context.historyHasMore('test')).toBe(false);
  });

  it('keeps pending and confirming stocktake tasks outside history pagination', async () => {
    const task = { id: 1n, taskNo: 'T1', shelfId: 2n, createdBy: 3n,
      status: 'confirming', plannedDate: new Date(), createdAt: new Date(), updatedAt: new Date() };
    const findMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([task]);
    const service = new StocktakePlannerService({ stocktakePlannerTask: { findMany } } as never, {} as never);
    const result = await service.list('1');
    expect(result.items[0].status).toBe('confirming');
    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 31, skip: 0,
      where: { NOT: { status: { in: ['pending', 'confirming'] } } } });
    expect(findMany.mock.calls[1][0]).toMatchObject({ where: { status: { in: ['pending', 'confirming'] } } });
  });
});
