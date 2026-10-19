import { rakutenOrderRemarkNeedsConfirmation } from '../src/common/rakuten-order-remark';
import { OrdersService } from '../src/orders/orders.service';

const confirmed = { _wmsRemarkConfirmedAt: '2026-10-19T00:00:00Z', _wmsRemarkConfirmedValue: '请周末配送' };

describe('Rakuten remark confirmation', () => {
  it.each([null, '', '请周末配送', '[配送日時指定:午前]'])('requires review for %s', (orderRemark) => {
    expect(rakutenOrderRemarkNeedsConfirmation({ orderRemark })).toBe(true);
  });
  it('allows the default remark and a saved confirmation, but invalidates changed remarks', () => {
    expect(rakutenOrderRemarkNeedsConfirmation({ orderRemark: ' [配送日時指定:] ' })).toBe(false);
    expect(rakutenOrderRemarkNeedsConfirmation({ orderRemark: '请周末配送', rawPayload: confirmed })).toBe(false);
    expect(rakutenOrderRemarkNeedsConfirmation({ orderRemark: '请平日配送', rawPayload: confirmed })).toBe(true);
    expect(rakutenOrderRemarkNeedsConfirmation({ orderRemark: null, rawPayload: { ...confirmed, _wmsRemarkConfirmedValue: '' } })).toBe(false);
    expect(rakutenOrderRemarkNeedsConfirmation({ orderRemark: '请周末配送', rawPayload: { _wmsRemarkConfirmedValue: '请周末配送' } })).toBe(true);
  });

  function setup(rows: any[]) {
    const service = new OrdersService({
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
      amazonOrderRecord: { findMany: jest.fn().mockResolvedValue([]) },
      manualOrderRecord: { findMany: jest.fn().mockResolvedValue([]) },
    } as never);
    jest.spyOn(service as any, 'enrichOrderRows').mockImplementation(async (items) => items);
    jest.spyOn(service as any, 'enrichAmazonOrderRows').mockResolvedValue([]);
    jest.spyOn(service as any, 'enrichManualOrderRows').mockResolvedValue([]);
    jest.spyOn(service as any, 'loadActiveOverseasPickingBatchRefs').mockResolvedValue(new Set());
    return service;
  }
  const base = { fulfillmentMode: 'overseas_warehouse', availableStock: 10, assemblableStock: 0, orderId: 'R-1' };

  it.each([false, true])('excludes unconfirmed remarks from overseas lists (includeAll=%s)', async (includeAll) => {
    const service = setup([
      { ...base, id: 1n, orderRemark: '请周末配送' },
      { ...base, id: 2n, orderRemark: '请周末配送', rawPayload: confirmed },
      { ...base, id: 3n, orderRemark: '[配送日時指定:]' },
    ]);
    const result = await service.listOverseasWarehouse('200', includeAll);
    expect(result.map((row) => row.id)).toEqual(['2', '3']);
  });

  it('records confirmation when saving an edit without changing the original remark', async () => {
    const current = { id: 1n, orderId: 'R-1', orderRemark: '请周末配送', rawPayload: { original: 'preserved' } };
    const record = {
      findUnique: jest.fn().mockResolvedValue(current),
      findUniqueOrThrow: jest.fn().mockResolvedValue(current),
      update: jest.fn().mockResolvedValue(current),
      updateMany: jest.fn(),
    };
    const tx = { rakutenOrderRecord: record };
    const db = { ...tx, $transaction: jest.fn(async (work) => work(tx)) };
    const service = new OrdersService(db as never);
    jest.spyOn(service as any, 'assertEditableOrderNotInActiveOverseasPickingBatch').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'assertEditedOrderIdentityDoesNotConflict').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'resolveDispatchModeForProductId').mockResolvedValue('overseas');
    jest.spyOn(service as any, 'enrichOrderRows').mockResolvedValue([current]);
    await service.updateRakutenOrder('1', { orderId: 'R-1', orderRemark: '请周末配送' }, 'reviewer');
    const data = (record.update.mock.calls[0] as any)[0].data;
    expect(data.orderRemark).toBe('请周末配送');
    expect(data.rawPayload.original).toBe('preserved');
    expect(rakutenOrderRemarkNeedsConfirmation(data)).toBe(false);
  });

  it('counts unique blocked orders, excluding shipped, no-stock and active picking rows', async () => {
    const rows = [
      { ...base, id: 1n, orderRemark: '请周末配送' },
      { ...base, id: 2n, orderRemark: '请周末配送' },
      { ...base, id: 3n, orderId: 'R-2', orderRemark: '请周末配送' },
      { ...base, id: 4n, orderId: 'R-3', orderRemark: '请周末配送', shipmentNo: 'TRACK' },
      { ...base, id: 5n, orderId: 'R-4', orderRemark: '请周末配送', availableStock: 0 },
      { ...base, id: 6n, orderId: 'R-5', orderRemark: '请周末配送' },
      { ...base, id: 7n, orderId: 'R-6', orderRemark: '请周末配送', rawPayload: confirmed },
    ];
    const service = setup(rows);
    (service as any).loadActiveOverseasPickingBatchRefs.mockResolvedValue(new Set(['rakuten:6']));
    await expect(service.getOverseasUnconfirmedOrderCount()).resolves.toEqual({ count: 2 });
  });

  it('blocks unconfirmed China orders but preserves shipment history', async () => {
    const service = setup([
      { ...base, id: 1n, dispatchMode: 'china_pending', orderRemark: '请周末配送' },
      { ...base, id: 2n, dispatchMode: 'china_pending', orderRemark: '请周末配送', rawPayload: confirmed },
      { ...base, id: 3n, dispatchMode: 'china_pending', orderRemark: '请周末配送', shipmentNo: 'TRACK' },
    ]);
    const result = await service.listChinaOrderProcessing('200', 'all');
    expect(result.map((row) => row.id)).toEqual(['2', '3']);
  });

  it('counts unconfirmed China orders by order number including explicitly routed orders', async () => {
    const service = setup([
      { ...base, id: 1n, dispatchMode: 'china_pending', orderRemark: '请周末配送' },
      { ...base, id: 2n, dispatchMode: 'china_pending', orderRemark: '请周末配送' },
      { ...base, id: 3n, orderId: 'R-2', fulfillmentMode: 'xiya_api', orderRemark: '请周末配送' },
      { ...base, id: 4n, orderId: 'R-3', orderRemark: '请周末配送' },
    ]);
    await expect(service.getOverseasUnconfirmedOrderCount('china')).resolves.toEqual({ count: 2 });
  });

  it('prevents Xiya pulling unconfirmed orders', async () => {
    const service = setup([
      { ...base, id: 1n, dispatchMode: 'china_pending', orderRemark: '请周末配送' },
      { ...base, id: 2n, dispatchMode: 'china_pending', orderRemark: '请周末配送', rawPayload: confirmed },
    ]);
    jest.spyOn(service as any, 'toThirdPartyRow').mockImplementation((row: any) => ({ id: row.id.toString() }));
    const result = await service.exportForThirdParty();
    expect(result.total).toBe(1);
    expect(result.rows).toEqual([{ id: '2' }]);
  });

  it('rejects directly selecting an unconfirmed order for picking', async () => {
    const service = setup([{ ...base, id: 1n, orderRemark: '请周末配送' }]);
    await expect((service as any).collectOverseasPickingBatchItemSnapshots([{ source: 'rakuten', id: '1' }]))
      .rejects.toThrow('备注待确认');
  });
});
