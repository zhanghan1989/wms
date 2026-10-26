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
      const service = new OrdersService({ rakutenOrderRecord: { findMany: rakuten },
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
        deletedAt: null, createdAt: { lt: new Date('2026-10-23T03:00:00Z') },
      } }));
      expect(amazon).toHaveBeenCalledWith(expect.objectContaining({ where: {
        sourceKind: { not: 'sp_api' }, createdAt: { lt: new Date('2026-10-23T03:00:00Z') },
      } }));
      expect(JSON.stringify(result)).toContain('R1');
    } finally { jest.useRealTimers(); }
  });

  it('returns zero when all sources have no outstanding orders', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new OrdersService({ rakutenOrderRecord: { findMany },
      amazonOrderRecord: { findMany }, manualOrderRecord: { findMany } } as any);
    expect(await service.getOverdueOrders()).toMatchObject({ count: 0, items: [] });
  });
});
