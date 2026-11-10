import { OrdersService } from '../src/orders/orders.service';

function setup(source = 'rakuten', matchColumn = 'shipment_no') {
  const record = { id: 1n, orderId: 'ORDER-1', shipmentNo: 'ab-1234-5678', shippingName: '田中', recipientName: '田中' };
  const tables: Record<string, string> = { rakuten: 'rakuten_order_records', amazon: 'amazon_order_records', manual: 'manual_order_records' };
  const queryRaw = jest.fn(async (sql: string, value: string) =>
    sql.includes(`FROM ${tables[source]}`) && sql.includes(`COALESCE(${matchColumn}, '')`) && value === 'AB12345678'
      ? [{ id: 1n }] : []);
  const findMany = jest.fn().mockResolvedValue([record]);
  const prisma = { $queryRawUnsafe: queryRaw, rakutenOrderRecord: { findMany }, amazonOrderRecord: { findMany }, manualOrderRecord: { findMany } };
  const service = new OrdersService(prisma as any);
  for (const method of ['enrichOrderRows', 'enrichAmazonOrderRows', 'enrichManualOrderRows']) {
    jest.spyOn(service as any, method).mockImplementation(async (rows) => rows);
  }
  const history = jest.spyOn(service as any, 'findUnifiedOrdersByCustomerKeys').mockResolvedValue([
    { source, id: '1' }, { source: 'manual', id: '99' },
  ]);
  return { service, queryRaw, findMany, history };
}

describe('unified order search', () => {
  it.each(['rakuten', 'amazon', 'manual'])('finds %s orders by normalized tracking number and excludes the match from history', async (source) => {
    const { service, queryRaw, findMany } = setup(source);
    const result = await service.searchOrders(' ab-1234 5678 ');
    expect(result.mode).toBe('tracking');
    expect(result.matches).toEqual([expect.objectContaining({ source, id: '1', shipmentNo: 'ab-1234-5678' })]);
    expect(result.history).toEqual([{ source: 'manual', id: '99' }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: [1n] } }) }));
    const trackingCalls = queryRaw.mock.calls.filter(([sql]) => sql.includes("COALESCE(shipment_no, '')"));
    expect(trackingCalls).toHaveLength(3);
    expect(trackingCalls.find(([sql]) => sql.includes('FROM rakuten_order_records'))?.[0]).toContain('deleted_at IS NULL');
    expect(trackingCalls.find(([sql]) => sql.includes('FROM amazon_order_records'))?.[0]).toContain("source_kind <> 'sp_api'");
  });

  it('preserves order number priority and customer fallback', async () => {
    const { service, queryRaw } = setup('rakuten', 'order_id');
    expect((await service.searchOrders('ab-1234-5678')).mode).toBe('order');
    expect(queryRaw.mock.calls.some(([sql]) => sql.includes("COALESCE(shipment_no, '')"))).toBe(false);
    queryRaw.mockResolvedValue([]);
    const customer = jest.spyOn(service as any, 'findUnifiedOrdersByCustomerQuery').mockResolvedValue([{ id: '2' }]);
    expect(await service.searchOrders('田中')).toMatchObject({ mode: 'customer', matches: [{ id: '2' }], history: [] });
    expect(customer).toHaveBeenCalledWith('田中', 500);
  });

  it('suggests tracking numbers from all sources using partial normalized input', async () => {
    const { service, queryRaw, findMany } = setup();
    findMany.mockResolvedValue([]);
    queryRaw.mockImplementation(async (sql: string) => sql.includes('shipment_no AS value')
      ? [{ value: 'ab-1234-5678' }, { value: 'ab-1234-5678' }] as any : []);
    const suggestions = await service.searchOrderSuggestions('ab-1234');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toEqual({ type: 'shipmentNo', value: 'ab-1234-5678', sourceLabel: '乐天', label: '乐天 追跡番号: ab-1234-5678' });
    const trackingCalls = queryRaw.mock.calls.filter(([sql]) => sql.includes('shipment_no AS value'));
    expect(trackingCalls).toHaveLength(3);
    for (const [sql, value] of trackingCalls) {
      expect(sql).toContain("UPPER(REGEXP_REPLACE(COALESCE(shipment_no, ''), '[^0-9A-Za-z]', '')) LIKE ?");
      expect(value).toBe('%AB1234%');
    }
  });

  it('handles empty input without querying and mentions tracking in validation', async () => {
    const { service, queryRaw } = setup();
    expect(await service.searchOrderSuggestions(' ')).toEqual([]);
    await expect(service.searchOrders(' ')).rejects.toThrow('请输入注文番号、追跡番号、收件人或电话');
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
