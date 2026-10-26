import { OrdersService } from '../src/orders/orders.service';

describe('Rakuten Xiya pull ownership', () => {
  function setup() {
    const row: any = { id: 1n, dispatchMode: 'china_pending', sendStatus: 'unsent',
      orderRemark: '[配送日時指定:]', shipmentNo: null, xiyaExportedAt: null,
      xiyaPulledAt: null, createdAt: new Date(), fulfillmentMode: 'xiya_api' };
    const model = {
      findMany: jest.fn(async () => [{ ...row }]), findFirst: jest.fn(async () => ({ ...row })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.dispatchMode !== row.dispatchMode ||
            (where.xiyaPulledAt === null && row.xiyaPulledAt !== null)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    };
    (model as any).update = jest.fn(async ({ data }: any) => { Object.assign(row, data); return { ...row }; });
    const db: any = { rakutenOrderRecord: model,
      amazonOrderRecord: { findMany: async () => [] }, manualOrderRecord: { findMany: async () => [] } };
    db.$transaction = async (fn: any) => fn(db);
    const service: any = new OrdersService(db);
    for (const method of ['enrichOrderRows', 'enrichAmazonOrderRows', 'enrichManualOrderRows']) {
      jest.spyOn(service, method).mockImplementation(async (rows: any) => rows);
    }
    jest.spyOn(service, 'loadActiveOverseasPickingBatchRefs').mockResolvedValue(new Set());
    jest.spyOn(service, 'toThirdPartyRow').mockImplementation((value: any) => ({ id: value.id.toString() }));
    return { service, row, model };
  }
  it('allows waiting-for-stock orders to switch Japan then China before Xiya pulls', async () => {
    const { service, row } = setup();
    service.enrichOrderRows.mockImplementation(async (rows: any[]) => rows.map(item => ({
      ...item, availableStock: 0,
      fulfillmentMode: item.dispatchMode === 'overseas' ? 'overseas_warehouse' : 'xiya_api',
    })));
    await service.switchChinaOrderToJapan('rakuten', '1');
    expect(row.dispatchMode).toBe('overseas');
    expect(row.xiyaPulledAt).toBeNull();
    await service.switchOverseasWarehouseOrderToChina('rakuten', '1');
    expect(row.dispatchMode).toBe('china_pending');
    expect(row.xiyaPulledAt).toBeNull();
    expect((await service.exportForThirdParty()).rows).toEqual([{ id: '1' }]);
    expect(row.xiyaPulledAt).toBeInstanceOf(Date);
    await expect(service.switchChinaOrderToJapan('rakuten', '1')).rejects.toThrow('Xiya 已拉取');
  });
  it('locks before returning data and blocks switching without an acknowledgement or tracking', async () => {
    const { service, row } = setup();
    expect((await service.exportForThirdParty()).rows).toEqual([{ id: '1' }]);
    expect(row.xiyaPulledAt).toBeInstanceOf(Date);
    expect(row.xiyaExportedAt).toBeNull();
    await expect(service.switchChinaOrderToJapan('rakuten', '1')).rejects.toThrow('Xiya 已拉取');
    expect((await service.exportForThirdParty()).rows).toEqual([{ id: '1' }]);
  });
  it('excludes a row switched to Japan after the pull read but before its claim', async () => {
    const { service, row, model } = setup();
    model.updateMany.mockImplementationOnce(async () => {
      row.dispatchMode = 'overseas';
      return { count: 0 };
    });
    expect((await service.exportForThirdParty()).rows).toEqual([]);
    expect(row.xiyaPulledAt).toBeNull();
  });
  it('blocks switching when Xiya claims after the switch read', async () => {
    const { service, row } = setup();
    service.enrichOrderRows.mockImplementationOnce(async (rows: any) => {
      row.xiyaPulledAt = new Date();
      return rows;
    });
    await expect(service.switchChinaOrderToJapan('rakuten', '1')).rejects.toThrow('订单状态已变化');
    expect(row.dispatchMode).toBe('china_pending');
  });
});
