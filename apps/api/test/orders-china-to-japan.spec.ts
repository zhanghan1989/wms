import { OrdersService } from '../src/orders/orders.service';

describe('China pending orders switch to Japan', () => {
  function setup(source: string, overrides = {}) {
    const row = { id: 1n, orderId: 'A', dispatchMode: 'china_no_stock', shipmentNo: null,
      xiyaExportedAt: null, sendStatus: 'unsent', orderRemark: '[配送日時指定:]', ...overrides };
    const model = { findFirst: jest.fn().mockResolvedValue(row), findMany: jest.fn().mockResolvedValue([row, { ...row, id: 2n }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const db: any = { [`${source}OrderRecord`]: model };
    db.$transaction = async (fn: any) => fn(db);
    const service: any = new OrdersService(db);
    jest.spyOn(service, 'loadActiveOverseasPickingBatchRefs').mockResolvedValue(new Set());
    for (const method of ['enrichOrderRows', 'enrichAmazonOrderRows', 'enrichManualOrderRows']) {
      jest.spyOn(service, method).mockResolvedValue([{ ...row, fulfillmentMode: 'xiya_api' }]);
    }
    jest.spyOn(service, 'syncManualOrderIdsToXyjgBestEffort').mockResolvedValue(undefined);
    return { service, model };
  }
  it.each(['rakuten'])('sets an explicit Japan route for %s without stock', async source => {
    const { service, model } = setup(source);
    const result = await service.switchChinaOrderToJapan(source, '1');
    expect(result.updatedIds).toEqual(['1']);
    expect(model.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { dispatchMode: 'overseas' } }));
  });
  it.each(['rakuten'])('rejects %s with a tracking number', async source => {
    const { service, model } = setup(source, { shipmentNo: 'TRACK' });
    await expect(service.switchChinaOrderToJapan(source, '1')).rejects.toThrow('无法切日本发');
    expect(model.updateMany).not.toHaveBeenCalled();
  });
  it.each(['amazon', 'manual'])('rejects unsupported source %s before writing', async source => {
    const { service, model } = setup(source);
    await expect(service.switchChinaOrderToJapan(source, '1')).rejects.toThrow('仅支持待 Xiya 拉取的乐天订单');
    expect(model.findFirst).not.toHaveBeenCalled();
    expect(model.updateMany).not.toHaveBeenCalled();
  });
  it('rejects an acknowledged Xiya order even without tracking', async () => {
    const { service, model } = setup('rakuten', { xiyaExportedAt: new Date() });
    await expect(service.switchChinaOrderToJapan('rakuten', '1')).rejects.toThrow('Xiya 已拉取');
    expect(model.updateMany).not.toHaveBeenCalled();
  });
  it('requires Xiya to remain unacknowledged at write time', async () => {
    const { service, model } = setup('rakuten');
    model.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.switchChinaOrderToJapan('rakuten', '1')).rejects.toThrow('订单状态已变化');
    expect(model.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ xiyaExportedAt: null }),
    }));
  });
  it('rejects an active picking order', async () => {
    const { service, model } = setup('rakuten');
    service.loadActiveOverseasPickingBatchRefs.mockResolvedValue(new Set(['rakuten:1']));
    await expect(service.switchChinaOrderToJapan('rakuten', '1')).rejects.toThrow('无法切日本发');
    expect(model.updateMany).not.toHaveBeenCalled();
  });
  it('rejects a concurrent tracking update', async () => {
    const { service, model } = setup('rakuten');
    model.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.switchChinaOrderToJapan('rakuten', '1')).rejects.toThrow('订单状态已变化');
  });
});
