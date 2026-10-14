import { OrdersService } from '../src/orders/orders.service';

describe('Xiya tracking sync with current shop settings', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const logisticsRow = (storeName: string, orderId: string, trackingNo: string) => ({
    store_name: storeName,
    sales_order_id: orderId,
    logistics_order_id: trackingNo,
    tracking_number: trackingNo,
    shipping_method: 'SAGAWA-01',
    created_at: '2026-10-14T14:49:31+08:00',
  });

  const response = (rows: ReturnType<typeof logisticsRow>[]) => ({
    ok: true,
    json: async () => ({ code: 0, data: { rows } }),
  } as Response);

  const orderRow = (id: bigint, orderId: string) => ({
    id,
    orderId,
    sourceKind: 'file',
    dispatchMode: 'china_no_stock',
    fulfillmentMode: 'xiya_api',
    shipmentNo: null as string | null,
  });

  const orderModel = (rows: ReturnType<typeof orderRow>[]) => ({
    findMany: jest.fn(async ({ where }: { where: { orderId: { in: string[] } } }) =>
      rows.filter((row) => where.orderId.in.includes(row.orderId) && !row.shipmentNo)),
    updateMany: jest.fn(async ({ where, data }: {
      where: { id: { in: bigint[] } };
      data: { shipmentNo: string };
    }) => {
      const targets = rows.filter((row) => where.id.in.includes(row.id) && !row.shipmentNo);
      targets.forEach((row) => { row.shipmentNo = data.shipmentNo; });
      return { count: targets.length };
    }),
  });

  it('queries configured Amazon and custom-platform shops and writes their eligible order rows', async () => {
    const amazonRows = [orderRow(3805n, '503-7162883-7862238')];
    const manualRows = [orderRow(486n, 'tk0000003'), orderRow(487n, 'tk0000003')];
    const rakutenRows = [orderRow(1n, 'RAKUTEN-1')];
    const prisma = {
      shop: { findMany: jest.fn().mockResolvedValue([
        { name: 'DGAZ Store亚马逊日本', platform: 'amazon', status: 1 },
        { name: 'DGAZ Tiktok日本', platform: 'custom-tiktok-key', status: 1 },
        { name: '乐天-1号店', platform: 'rakuten', status: 1 },
        { name: '停用店铺', platform: 'amazon', status: 0 },
      ]) },
      amazonOrderRecord: orderModel(amazonRows),
      manualOrderRecord: orderModel(manualRows),
      rakutenOrderRecord: orderModel(rakutenRows),
    };
    const service = new OrdersService(prisma as any);
    for (const method of ['enrichAmazonOrderRows', 'enrichManualOrderRows', 'enrichOrderRows']) {
      jest.spyOn(service as any, method).mockImplementation(async (rows: any) => rows);
    }
    jest.spyOn(service as any, 'loadActiveOverseasPickingBatchRefs').mockResolvedValue(new Set());
    const manualPush = jest.spyOn(service as any, 'syncManualOrderIdsToXyjgBestEffort').mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(response([
      logisticsRow('DGAZ Store亚马逊日本', '503-7162883-7862238', '369003071636'),
      logisticsRow('DGAZ Tiktok日本', 'tk0000003', '369003071640'),
      logisticsRow('DGAZ乐天日本', 'RAKUTEN-1', '369003071641'),
      logisticsRow('停用店铺', '503-7162883-7862238', 'WRONG-NUMBER'),
    ]));

    await expect(service.syncXiyaTrackingNumbers()).resolves.toMatchObject({
      fetchedCount: 4,
      validCount: 3,
      amazonUpdatedCount: 1,
      manualUpdatedCount: 2,
      rakutenUpdatedCount: 1,
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    const names = url.searchParams.get('storeName')!.split(',');
    expect(names).toEqual(expect.arrayContaining([
      'DGAZ Store亚马逊日本', 'DGAZ Tiktok日本', '乐天-1号店', 'DGAZ乐天日本',
    ]));
    expect(names).not.toContain('停用店铺');
    expect(url.searchParams.get('days')).toBe('5');
    expect(amazonRows[0].shipmentNo).toBe('369003071636');
    expect(manualRows.map((row) => row.shipmentNo)).toEqual(['369003071640', '369003071640']);
    expect(rakutenRows[0].shipmentNo).toBe('369003071641');
    expect(prisma.amazonOrderRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceKind: { not: 'sp_api' } }),
    }));
    expect(prisma.amazonOrderRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ shipmentNo: null }, { shipmentNo: '' }] }),
    }));
    expect(manualPush).toHaveBeenCalledWith([486n, 487n]);

    // A repeat run must preserve already registered numbers and update no rows.
    await expect(service.syncXiyaTrackingNumbers()).resolves.toMatchObject({
      amazonUpdatedCount: 0, manualUpdatedCount: 0, rakutenUpdatedCount: 0,
    });
    expect(prisma.amazonOrderRecord.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.manualOrderRecord.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.rakutenOrderRecord.updateMany).toHaveBeenCalledTimes(1);
  });

  it('reloads renamed and newly added shops on the next run using one snapshot per run', async () => {
    const shopFindMany = jest.fn()
      .mockResolvedValueOnce([{ name: '原店铺', platform: 'amazon', status: 1 }])
      .mockResolvedValueOnce([
        { name: '新店铺名', platform: 'amazon', status: 1 },
        { name: '新增店铺', platform: 'another-custom-platform', status: 1 },
      ]);
    const service = new OrdersService({ shop: { findMany: shopFindMany } } as any);
    const apply = jest.spyOn(service as any, 'applyXiyaTrackingCandidates')
      .mockResolvedValue({ updatedCount: 0, skippedUnmatchedCount: 0 });
    fetchMock.mockResolvedValueOnce(response([logisticsRow('原店铺', 'A-1', 'T-1')]))
      .mockResolvedValueOnce(response([
        logisticsRow('新店铺名', 'A-1', 'T-1'),
        logisticsRow('新增店铺', 'CUSTOM-1', 'T-2'),
        logisticsRow('原店铺', 'A-1', 'STALE-NUMBER'),
      ]));

    await expect(service.syncXiyaTrackingNumbers()).resolves.toMatchObject({ validCount: 1 });
    apply.mockClear();
    await expect(service.syncXiyaTrackingNumbers()).resolves.toMatchObject({ validCount: 2 });

    const firstNames = new URL(fetchMock.mock.calls[0][0]).searchParams.get('storeName')!.split(',');
    const secondNames = new URL(fetchMock.mock.calls[1][0]).searchParams.get('storeName')!.split(',');
    expect(firstNames).toContain('原店铺');
    expect(secondNames).toEqual(expect.arrayContaining(['新店铺名', '新增店铺']));
    expect(secondNames).not.toContain('原店铺');
    expect(shopFindMany).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith('amazon', [expect.objectContaining({
      storeName: '新店铺名', orderId: 'A-1', trackingNo: 'T-1', source: 'amazon',
    })]);
    expect(apply).toHaveBeenCalledWith('manual', expect.arrayContaining([
      expect.objectContaining({ storeName: '新增店铺', source: 'manual', orderId: 'CUSTOM-1' }),
    ]));
  });

  it('excludes explicitly disabled legacy names and cannot treat object property names as shops', async () => {
    const service = new OrdersService({ shop: { findMany: jest.fn().mockResolvedValue([
      { name: '当前店铺', platform: 'amazon', status: 1 },
      { name: 'DGAZ亚马逊日本站', platform: 'amazon', status: 0 },
    ]) } } as any);
    jest.spyOn(service as any, 'applyXiyaTrackingCandidates')
      .mockResolvedValue({ updatedCount: 0, skippedUnmatchedCount: 0 });
    fetchMock.mockResolvedValue(response([
      logisticsRow('DGAZ亚马逊日本站', 'A-1', 'T-1'),
      logisticsRow('toString', 'A-2', 'T-2'),
    ]));

    await expect(service.syncXiyaTrackingNumbers()).resolves.toMatchObject({ validCount: 0 });
    const names = new URL(fetchMock.mock.calls[0][0]).searchParams.get('storeName')!.split(',');
    expect(names).not.toContain('DGAZ亚马逊日本站');
  });

  it.each([
    { shops: [] },
    { shops: [{ name: 'DGAZ亚马逊日本站', platform: 'amazon', status: 0 }] },
  ])('does not query the Xiya default shop when no shops are enabled ($shops)', async ({ shops }) => {
    const service = new OrdersService({ shop: { findMany: jest.fn().mockResolvedValue(shops) } } as any);

    await expect(service.syncXiyaTrackingNumbers()).resolves.toMatchObject({
      fetchedCount: 0, validCount: 0, amazonUpdatedCount: 0, manualUpdatedCount: 0, rakutenUpdatedCount: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
