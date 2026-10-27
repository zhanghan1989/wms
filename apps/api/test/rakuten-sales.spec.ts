import { parseRakutenSalesOrder, rakutenSalesRows } from '../src/rakuten-rms-api/rakuten-sales';
import { RakutenSalesService } from '../src/rakuten-rms-api/rakuten-sales.service';
import { buildRakutenStoreDashboard } from '../src/rakuten-rms-api/rakuten-store-dashboard';
import { storeDashboardPeriod } from '../src/common/store-dashboard-period';

function order(id = '421951-20260901-1', changes: any = {}) {
  return { orderNumber: id, orderDatetime: '2026-09-01T00:01:00+0900', orderProgress: 600,
    goodsPrice: 3000, couponAllTotalPrice: 500,
    PackageModelList: [{ basketId: 1, ItemModelList: [
      { itemDetailId: 1, price: 1000, units: 1, itemName: '组合', SkuModelList: [{ variantId: 'zh-combo' }] },
      { itemDetailId: 2, price: 2000, units: 1, itemName: '附加商品', SkuModelList: [{ variantId: 'cd-01' }] },
    ] }], ...changes };
}

describe('RMS original-order financial facts', () => {
  it('counts purchased combos and items excluded from warehouse processing once, and allocates coupons exactly', () => {
    const snapshot = parseRakutenSalesOrder(order());
    expect(snapshot.items.map((row) => row.salesAmount)).toEqual([833, 1667]);
    expect(snapshot.items.reduce((a, row) => a + row.salesAmount, 0)).toBe(2500);
    expect(snapshot.items.map((row) => row.skuCode)).toEqual(['zh-combo', 'cd-01']);
    const now = new Date('2026-10-01T09:00:00Z');
    const d: any = buildRakutenStoreDashboard({ now, days: 30, period: storeDashboardPeriod(now, undefined, '2026-09'),
      orders: rakutenSalesRows([snapshot, parseRakutenSalesOrder(order('cancelled', { orderProgress: 900 }))]),
      fulfillmentOrders: ['parent', 'a-parent', 'b-parent'].map((id) => ({ orderId: id, skuCode: 'part', productName: '',
        orderImportedAtRaw: snapshot.orderedAt, orderQuantity: 1, orderStatusText: '600', salesAmount: 3000,
        shipmentNo: 'TRACK', dispatchMode: 'overseas', trackingIsDelivered: true })), products: [] });
    expect(d.summary).toMatchObject({ orderCount: 1, unitCount: 2, salesAmount: 2500, averageOrderValue: 2500 });
    expect(d.daily[0]).toMatchObject({ date: '2026-09-01', salesAmount: 2500, orderCount: 1 });
    expect(d.topProducts.reduce((a: number, row: any) => a + row.salesAmount, 0)).toBe(2500);
  });
  it('uses current RMS quantity and price, not manually changed warehouse quantities', () => {
    const snapshot = parseRakutenSalesOrder(order('qty', { goodsPrice: 2000, couponAllTotalPrice: 1000,
      PackageModelList: [{ basketId: 1, ItemModelList: [{ itemDetailId: 1, units: 2, price: 1000,
        SkuModelList: [{ variantId: 'SKU' }] }] }] }));
    expect(snapshot.items[0]).toMatchObject({ quantity: 2, salesAmount: 1000 });
  });
  it.each([{ goodsPrice: null }, { couponAllTotalPrice: null }, { goodsPrice: 3001 }, { couponAllTotalPrice: 3001 }])(
    'rejects incomplete or inconsistent monetary facts instead of treating missing data as zero: %j', (changes) => {
      expect(() => parseRakutenSalesOrder(order('bad', changes))).toThrow();
    });
  it('rejects duplicate original items but allows item identifiers in different baskets', () => {
    const o = order();
    o.PackageModelList[0].ItemModelList.push(o.PackageModelList[0].ItemModelList[0]);
    expect(() => parseRakutenSalesOrder(o)).toThrow('重复');
    const good = order('basket', { goodsPrice: 6000, couponAllTotalPrice: 500 });
    good.PackageModelList.push({ ...good.PackageModelList[0], basketId: 2 });
    expect(parseRakutenSalesOrder(good).items).toHaveLength(4);
  });
  it('ignores RMS removed zero-quantity lines while validating the remaining order total', () => {
    const o = order();
    o.PackageModelList[0].ItemModelList.push({ itemDetailId: 3, price: 0, units: 0,
      itemName: 'Removed', SkuModelList: [{ variantId: 'removed' }] });
    expect(parseRakutenSalesOrder(o).items.map(x => x.skuCode)).toEqual(['zh-combo', 'cd-01']);
    expect(() => parseRakutenSalesOrder({ ...o, goodsPrice: 3001 })).toThrow('不一致');
  });
  it('stores no customer information in financial snapshots', () => {
    const snapshot = parseRakutenSalesOrder(order('private', { OrdererModel: { emailAddress: 'private@example.test' }, remarks: 'private' }));
    expect(JSON.stringify(snapshot)).not.toContain('private@example.test');
    expect(JSON.stringify(snapshot)).not.toContain('remarks');
  });
});

function setup() {
  const connection = { id: 7n, encryptedServiceSecret: 's', serviceSecretIv: '', serviceSecretAuthTag: '',
    encryptedLicenseKey: 'l', licenseKeyIv: '', licenseKeyAuthTag: '', salesCoverageStart: null, salesCoverageEnd: null,
    lastSalesSyncedAt: null, lastSalesSyncError: null };
  const snapshots: any[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 7n }]),
    rakutenRmsConnection: { findUniqueOrThrow: jest.fn().mockResolvedValue(connection), update: jest.fn().mockResolvedValue(connection) },
    rakutenSalesSnapshot: {
      findMany: jest.fn(({ where }) => Promise.resolve(snapshots.filter((row) => !where.orderId || where.orderId.in.includes(row.orderId)))),
      createMany: jest.fn(({ data }) => { snapshots.push(...data.map((r: any, i: number) => ({ ...r, id: BigInt(i + 1) }))); return Promise.resolve({ count: data.length }); }),
      update: jest.fn(({ data }) => { const index = snapshots.findIndex(r => r.orderId === data.orderId); snapshots[index] = { ...snapshots[index], ...data }; return Promise.resolve(snapshots[index]); }),
    },
    operationAuditLog: { createMany: jest.fn().mockResolvedValue({ count: 1 }), create: jest.fn().mockResolvedValue({}) },
  };
  const db: any = { ...tx, $transaction: jest.fn((work) => work(tx)), user: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 5n }) } };
  const client: any = { searchOrders: jest.fn().mockResolvedValue(['421951-20260901-1']), getOrders: jest.fn().mockResolvedValue([order()]) };
  const service = new RakutenSalesService(db, client, { decrypt: jest.fn().mockReturnValue('credential') } as any);
  return { service, client, db, tx, connection, snapshots };
}

describe('Sales-only reconciliation', () => {
  const start = new Date('2026-08-31T15:00:00Z');
  const end = new Date('2026-09-30T15:00:00Z');
  it('searches all statuses by purchase date and dry-runs without writing', async () => {
    const { service, client, db, tx } = setup();
    await expect(service.reconcile(7n, start, end, 5n, true)).resolves.toMatchObject({ orderCount: 1, salesAmount: 2500, dryRun: true });
    expect(client.searchOrders).toHaveBeenCalledWith('credential', 'credential', { start, end: new Date(end.getTime() - 1), dateType: 1 });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.rakutenSalesSnapshot.createMany).not.toHaveBeenCalled();
  });
  it('atomically records financial changes and audit snapshots, and is idempotent', async () => {
    const { service, tx } = setup();
    await service.reconcile(7n, start, end, 5n);
    await service.reconcile(7n, start, end, 5n);
    expect(tx.rakutenSalesSnapshot.createMany).toHaveBeenCalledTimes(1);
    expect(tx.rakutenSalesSnapshot.update).not.toHaveBeenCalled();
    expect(tx.operationAuditLog.createMany).toHaveBeenCalledTimes(1);
    expect(tx.operationAuditLog.createMany.mock.calls[0][0].data[0]).toMatchObject({ entityType: 'rakuten_sales_snapshot', action: 'create', operatorId: 5n });
    expect(tx.rakutenRmsConnection.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ salesCoverageStart: start, salesCoverageEnd: end }) }));
  });
  it('updates a shipped order cancellation without invoking warehouse services', async () => {
    const { service, client, snapshots, tx } = setup();
    await service.reconcile(7n, start, end, 5n);
    client.getOrders.mockResolvedValue([order(undefined, { orderProgress: 900 })]);
    await expect(service.reconcile(7n, start, end, 5n)).resolves.toMatchObject({ orderCount: 0, salesAmount: 0 });
    expect(snapshots[0].orderProgress).toBe('900');
    expect(tx.operationAuditLog.createMany.mock.calls[1][0].data[0]).toMatchObject({ action: 'update', beforeData: expect.objectContaining({ orderProgress: '600' }), afterData: expect.objectContaining({ orderProgress: '900' }) });
  });
  it('does not advance coverage or write facts when RMS omits a requested order', async () => {
    const { service, client, tx } = setup();
    client.getOrders.mockResolvedValue([]);
    await expect(service.reconcile(7n, start, end, 5n)).rejects.toThrow('不完整');
    expect(tx.rakutenSalesSnapshot.createMany).not.toHaveBeenCalled();
    expect(tx.rakutenRmsConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: { lastSalesSyncError: expect.any(String) } }));
  });
  it('rejects an older concurrent response after a newer reconciliation commits', async () => {
    const { service, connection, tx } = setup();
    (connection as any).lastSalesSyncedAt = new Date(Date.now() + 10000);
    await expect(service.reconcile(7n, start, end, 5n)).rejects.toThrow('较新');
    expect(tx.rakutenSalesSnapshot.createMany).not.toHaveBeenCalled();
  });
});
