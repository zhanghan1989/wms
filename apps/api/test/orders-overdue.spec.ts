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

describe('overdue summary cache', () => {
  it('coalesces concurrent requests, groups order lines and expires after five minutes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T03:00:00Z'));
    try {
      const query = jest.fn().mockResolvedValue([
        { source: 'rakuten', id: 1n, orderId: 'R1' },
        { source: 'rakuten', id: 2n, orderId: 'R1' },
        { source: 'manual', id: 3n, orderId: null },
      ]);
      const service = new OrdersService({ $queryRaw: query } as any);
      const results = await Promise.all([service.getOverdueOrderSummary(), service.getOverdueOrderSummary()]);
      expect(results[0].count).toBe(2);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, ...params] = query.mock.calls[0];
      expect(sql.join('?')).toContain("source_kind <> 'sp_api'");
      expect(sql.join('?')).toContain('deleted_at IS NULL');
      expect(sql.join('?')).toContain("REGEXP '^[[:space:]]*$'");
      expect(params).toEqual(Array(3).fill(new Date('2026-10-23T03:00:00Z')));
      jest.advanceTimersByTime(299999);
      await service.getOverdueOrderSummary();
      expect(query).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      query.mockResolvedValue([]);
      expect((await service.getOverdueOrderSummary()).count).toBe(0);
      expect(query).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  it('allows retry after a failed summary query', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([]);
    const service = new OrdersService({ $queryRaw: query } as any);
    await expect(service.getOverdueOrderSummary()).rejects.toThrow('unavailable');
    await expect(service.getOverdueOrderSummary()).resolves.toMatchObject({ count: 0 });
  });
});
