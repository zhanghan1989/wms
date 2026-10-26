import { OrdersService } from '../src/orders/orders.service';

describe('overdue order reminder', () => {
  it('uses a strict 72 hour cutoff, scopes sources and groups outstanding lines', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T03:00:00Z'));
    try {
      const createdAt = new Date('2026-10-22T03:00:00Z');
      const rakuten = jest.fn().mockResolvedValue([
        { id: 1n, orderId: 'R1', createdAt, shipmentNo: null },
        { id: 2n, orderId: 'R1', createdAt, shipmentNo: '  ' },
        { id: 3n, orderId: 'shipped', createdAt, shipmentNo: '123' },
      ]);
      const amazon = jest.fn().mockResolvedValue([{ id: 4n, orderId: 'A1', createdAt, shipmentNo: '' }]);
      const manual = jest.fn().mockResolvedValue([{ id: 5n, orderId: null, createdAt, shipmentNo: null }]);
      const service = new OrdersService({ $queryRaw: jest.fn().mockResolvedValue([
        { source: 'rakuten', id: 1n, orderId: 'R1' }, { source: 'rakuten', id: 2n, orderId: 'R1' },
        { source: 'amazon', id: 4n, orderId: 'A1' }, { source: 'manual', id: 5n, orderId: null },
      ]), rakutenOrderRecord: { findMany: rakuten },
        amazonOrderRecord: { findMany: amazon }, manualOrderRecord: { findMany: manual } } as any);
      jest.spyOn(service as any, 'enrichOrderRows').mockImplementation(async (rows: any) =>
        rows.map((row: any) => ({ ...row, fulfillmentMode: row.id === 2n ? 'xiya_api' : 'overseas_warehouse' })));
      jest.spyOn(service as any, 'enrichAmazonOrderRows').mockImplementation(async (rows: any) =>
        rows.map((row: any) => ({ ...row, fulfillmentMode: 'xiya_api' })));
      jest.spyOn(service as any, 'enrichManualOrderRows').mockImplementation(async (rows: any) =>
        rows.map((row: any) => ({ ...row, fulfillmentMode: 'overseas_warehouse' })));
      const result = await service.getOverdueOrders();
      expect(result.count).toBe(3);
      expect(result.items[0]).toMatchObject({ source: 'rakuten', id: '1', lineCount: 2, waitingHours: 96, fulfillmentModes: ['overseas_warehouse', 'xiya_api'] });
      expect(result.items[1].fulfillmentModes).toEqual(['xiya_api']);
      expect(result.items[2].fulfillmentModes).toEqual(['overseas_warehouse']);
      expect(rakuten).toHaveBeenCalledWith(expect.objectContaining({ where: {
        deletedAt: null, createdAt: { lt: new Date('2026-10-23T03:00:00Z') }, id: { in: [1n, 2n] },
      } }));
      expect(amazon).toHaveBeenCalledWith(expect.objectContaining({ where: {
        sourceKind: { not: 'sp_api' }, createdAt: { lt: new Date('2026-10-23T03:00:00Z') }, id: { in: [4n] },
      } }));
      expect(JSON.stringify(result)).toContain('R1');
    } finally { jest.useRealTimers(); }
  });

  it('returns zero when all sources have no outstanding orders', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new OrdersService({ $queryRaw: jest.fn().mockResolvedValue([]), rakutenOrderRecord: { findMany },
      amazonOrderRecord: { findMany }, manualOrderRecord: { findMany } } as any);
    expect(await service.getOverdueOrders()).toMatchObject({ count: 0, items: [] });
  });
});

describe('daily overdue snapshot', () => {
  it('shares one snapshot across requests and refreshes only on schedule or explicit refresh', async () => {
    const service = new OrdersService({} as any);
    const build = jest.spyOn(service as any, 'buildOverdueOrders').mockResolvedValue({ count: 2, checkedAt: '2026-10-26T00:30:00Z', items: [] });
    const results = await Promise.all([service.getOverdueOrderSummary(), service.getOverdueOrders()]);
    expect(results[0].count).toBe(2);
    expect(build).toHaveBeenCalledTimes(1);
    await service.getOverdueOrderSummary();
    await service.getOverdueOrders();
    expect(build).toHaveBeenCalledTimes(1);
    build.mockResolvedValue({ count: 0, checkedAt: '2026-10-27T00:30:00Z', items: [] });
    await service.runScheduledOverdueOrders();
    expect((await service.getOverdueOrderSummary()).count).toBe(0);
    expect(build).toHaveBeenCalledTimes(2);
    await service.getOverdueOrders(true);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('retains the last successful snapshot if scheduled refresh fails and permits immediate retry', async () => {
    const service = new OrdersService({} as any);
    const build = jest.spyOn(service as any, 'buildOverdueOrders').mockResolvedValueOnce({ count: 1, checkedAt: '2026-10-26T00:30:00Z', items: [] })
      .mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ count: 0, checkedAt: '2026-10-27T01:00:00Z', items: [] });
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
    await service.getOverdueOrders();
    await service.runScheduledOverdueOrders();
    expect((await service.getOverdueOrderSummary()).count).toBe(1);
    expect((await service.getOverdueOrders(true)).count).toBe(0);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('runs the daily job at 09:30 in Asia/Tokyo', () => {
    const options = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', OrdersService.prototype.runScheduledOverdueOrders);
    expect(options).toMatchObject({ cronTime: '0 30 9 * * *', timeZone: 'Asia/Tokyo' });
  });
});
