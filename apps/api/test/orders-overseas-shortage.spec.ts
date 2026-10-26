import { OrdersService } from '../src/orders/orders.service';

// Regression: 6454 kept its Japan routing after other batches consumed product 13872.
describe('overseas orders whose stock was consumed by another batch', () => {
  const row = {
    id: 6454n, orderId: '421951-20261016-0600311491', skuCode: '13872',
    dispatchMode: 'overseas', sendStatus: 'unsent', shipmentNo: null,
    orderQuantity: 1, quantityPurchased: 1, orderRemark: '[配送日時指定:]',
    csvImportedAt: new Date('2026-10-16T14:40:09Z'), createdAt: new Date('2026-10-16T14:40:09Z'),
    availableStock: 0, assemblableStock: 0, fulfillmentMode: 'overseas_warehouse',
    resolvedProductId: '13872', rawPayload: {},
  };
  function setup(source: string, active = false) {
    const model = { findMany: jest.fn().mockResolvedValue([row]),
      findFirst: jest.fn().mockResolvedValue(row), update: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const empty = () => ({ findMany: jest.fn().mockResolvedValue([]) });
    const db = { rakutenOrderRecord: empty(), amazonOrderRecord: empty(), manualOrderRecord: empty(),
      [`${source}OrderRecord`]: model };
    const service = new OrdersService(db as any) as any;
    for (const method of ['enrichOrderRows', 'enrichAmazonOrderRows', 'enrichManualOrderRows']) {
      jest.spyOn(service, method).mockImplementation(async (rows: any) => rows);
    }
    jest.spyOn(service, 'loadActiveOverseasPickingBatchRefs').mockResolvedValue(
      new Set(active ? [`${source}:6454`] : []));
    jest.spyOn(service, 'syncManualOrderIdsToXyjgBestEffort').mockResolvedValue(undefined);
    return { service, model };
  }

  it.each(['rakuten', 'amazon', 'manual'])('keeps zero-stock %s orders visible without changing their routing', async source => {
    const { service, model } = setup(source);
    expect(await service.listOverseasWarehouse()).toEqual([
      expect.objectContaining({ id: '6454', source, availableStock: 0, assemblableStock: 0 }),
    ]);
    expect(model.update).not.toHaveBeenCalled();
    expect(model.updateMany).not.toHaveBeenCalled();
  });

  it.each(['rakuten', 'amazon', 'manual'])('allows explicit China switching for a zero-stock %s order', async source => {
    const { service, model } = setup(source);
    expect(await service.switchOverseasWarehouseOrderToChina(source, '6454')).toEqual(
      expect.objectContaining({ success: true, dispatchMode: 'china_pending' }));
    expect(source === 'amazon' ? model.updateMany : model.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { dispatchMode: 'china_pending' } }));
  });

  it.each(['rakuten', 'amazon', 'manual'])('keeps batched %s orders out of the list and blocks pending-order switching', async source => {
    const { service, model } = setup(source, true);
    expect(await service.listOverseasWarehouse()).toEqual([]);
    await expect(service.switchOverseasWarehouseOrderToChina(source, '6454')).rejects.toThrow('无法切中国发');
    expect(model.update).not.toHaveBeenCalled();
    expect(model.updateMany).not.toHaveBeenCalled();
  });

  it('still rejects zero-stock orders when collecting a new batch', async () => {
    const { service } = setup('rakuten');
    await expect(service.collectOverseasPickingBatchItemSnapshots([{ source: 'rakuten', id: '6454' }]))
      .rejects.toThrow();
  });

  it('includes zero-stock Japan orders in the remark-confirmation reminder', async () => {
    const { service, model } = setup('rakuten');
    model.findMany.mockResolvedValue([{ ...row, orderRemark: '请确认配送要求' }]);
    expect(await service.getOverseasUnconfirmedOrderCount()).toEqual({ count: 1 });
  });
});
