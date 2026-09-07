import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { OrdersService } from '../src/orders/orders.service';

describe('overseas picking batch splitting', () => {
  const service = new OrdersService({} as any) as any;
  const row = (id: number) => ({
    source: 'rakuten', sourceRecordId: BigInt(id), orderId: `order-${id}`,
    shopName: 'shop', shippingName: 'recipient',
    productId: 'P1', requestedQty: 1, availableStockSnapshot: 200, skuCode: 'SKU',
  });
  const rows = (count: number) => Array.from({ length: count }, (_, i) => row(i));

  it('splits 106 orders into 30, 30, 30, 16 without loss', () => {
    const input = rows(106);
    const result = service.splitOverseasPickingBatches(input);
    expect(result.map((batch: any[]) => batch.length)).toEqual([30, 30, 30, 16]);
    expect(result.flat()).toEqual(input);
  });

  it('allows different orders for the same recipient to cross a batch boundary', () => {
    const result = service.splitOverseasPickingBatches(rows(31));
    expect(result.map((batch: any[]) => batch.length)).toEqual([30, 1]);
  });

  it('keeps nonadjacent lines of the same source and order together regardless of shop labels', () => {
    const input = [...rows(30), row(30), { ...row(29), shopName: null }];
    const result = service.splitOverseasPickingBatches(input);
    expect(result.map((batch: any[]) => batch.length)).toEqual([31, 1]);
    expect(result[0].filter((item: any) => item.orderId === 'order-29')).toHaveLength(2);
  });

  it('counts order numbers rather than product lines and keeps all lines together', () => {
    const input = [...rows(29), ...Array.from({ length: 5 }, () => row(29)), row(30)];
    const result = service.splitOverseasPickingBatches(input);
    expect(result.map((batch: any[]) => batch.length)).toEqual([34, 1]);
  });

  it('keeps an order with more than 30 product lines in one batch', () => {
    const input = Array.from({ length: 35 }, (_, i) => ({ ...row(1), sourceRecordId: BigInt(i) }));
    expect(service.splitOverseasPickingBatches(input)).toEqual([input]);
  });

  it('creates all split batches in one transaction and returns their counts', async () => {
    const tx = { $queryRaw: jest.fn(), overseasPickingBatch: { create: jest.fn().mockImplementation(async ({ data }) => ({ ...data, id: BigInt(tx.overseasPickingBatch.create.mock.calls.length) })) } };
    const prisma = { $transaction: jest.fn(async (work) => work(tx)) };
    const instance = new OrdersService(prisma as any) as any;
    jest.spyOn(instance, 'collectOverseasPickingBatchItemSnapshots').mockResolvedValue(rows(61));
    for (const method of ['attachOverseasPickingPlanSnapshots', 'attachShoulderStrapBomSnapshots', 'attachOverseasPickingRequirementSnapshots', 'assertOverseasPickingBatchDemandWithinStock']) jest.spyOn(instance, method).mockResolvedValue(undefined);
    jest.spyOn(instance, 'findActiveOverseasPickingBatchDuplicates').mockResolvedValue([]);
    const result = await instance.createOverseasPickingBatch({ items: [] });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.batches.map((batch: any) => batch.orderCount)).toEqual([30, 30, 1]);
    expect(tx.overseasPickingBatch.create.mock.calls.map(([args]) => args.data.items.create.length)).toEqual([30, 30, 1]);
  });
  it('deduplicates selected records while preserving distinct sources', async () => {
    const common = { availableStock: 10, fulfillmentMode: 'overseas_warehouse', resolvedProductId: 'P1', shopName: 'shop' };
    const rakuten = { ...common, id: 1n, orderId: 'R1', skuCode: 'SKU', orderQuantity: 1,
      shippingName: '山田', shippingPhone: '090-1234-5678', shippingPostalCode: '123-4567',
      shippingPrefecture: '東京都', shippingCity: '中央区', shippingAddress: '銀座1-2ビル301' };
    const amazon = { ...common, id: 2n, orderId: 'A1', sku: 'SKU', quantityPurchased: 1,
      recipientName: '山田', buyerPhoneNumber: '09012345678', shipCountry: 'Japan', shipPostalCode: '1234567',
      shipState: '東京都', shipCity: '中央区', shipAddress1: '銀座1-2', shipAddress2: 'ビル301' };
    const instance = new OrdersService({
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([rakuten]) },
      amazonOrderRecord: { findMany: jest.fn().mockResolvedValue([amazon]) },
    } as any) as any;
    jest.spyOn(instance, 'enrichOrderRows').mockResolvedValue([rakuten]);
    jest.spyOn(instance, 'enrichAmazonOrderRows').mockResolvedValue([amazon]);
    jest.spyOn(instance, 'enrichManualOrderRows').mockResolvedValue([]);
    const snapshots = await instance.collectOverseasPickingBatchItemSnapshots([
      { source: 'rakuten', id: '1' }, { source: 'amazon', id: '2' }, { source: 'rakuten', id: '1' },
    ]);
    expect(snapshots).toHaveLength(2);
    expect(instance.splitOverseasPickingBatches([...rows(29), ...snapshots]).map((batch: any[]) => batch.length)).toEqual([30, 1]);
  });

  it('lists every unfinished batch when more than 20 were created, without duplicates', async () => {
    const active = Array.from({ length: 25 }, (_, i) => ({ id: BigInt(i + 1), batchNo: `PK-${i}`, status: 'created', createdAt: new Date(0) }));
    const instance = new OrdersService({
      overseasPickingBatch: { findMany: jest.fn().mockImplementation(async (query) => query.take ? active.slice(-20) : active) },
      yamatoShipmentBatch: { findMany: jest.fn().mockResolvedValue([]) },
    } as any);
    const result = await instance.listOverseasPickingBatches();
    expect(result).toHaveLength(25);
    expect(new Set(result.map((batch) => batch.id)).size).toBe(25);
    expect(result[0].id).toBe('25');
    expect(result[24].id).toBe('1');
  });

  it.each(['stock', 'duplicate'])('creates no batches when %s validation fails', async (failure) => {
    const tx = { $queryRaw: jest.fn(), overseasPickingBatch: { create: jest.fn() } };
    const instance = new OrdersService({ $transaction: async (work: any) => work(tx) } as any) as any;
    jest.spyOn(instance, 'collectOverseasPickingBatchItemSnapshots').mockResolvedValue(rows(31));
    for (const method of ['attachOverseasPickingPlanSnapshots', 'attachShoulderStrapBomSnapshots', 'attachOverseasPickingRequirementSnapshots']) jest.spyOn(instance, method).mockResolvedValue(undefined);
    const stock = jest.spyOn(instance, 'assertOverseasPickingBatchDemandWithinStock').mockImplementation(async () => { if (failure === 'stock') throw new Error('stock failed'); });
    jest.spyOn(instance, 'findActiveOverseasPickingBatchDuplicates').mockResolvedValue(failure === 'duplicate' ? ['R1'] : []);
    const split = jest.spyOn(instance, 'splitOverseasPickingBatches');
    await expect(instance.createOverseasPickingBatch({ items: [] })).rejects.toThrow();
    expect(stock).toHaveBeenCalled();
    expect(split).not.toHaveBeenCalled();
    expect(tx.overseasPickingBatch.create).not.toHaveBeenCalled();
  });

  it('returns to the list after multi-batch creation when an older detail was open', async () => {
    const app = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
    const start = app.indexOf('  $("overseasCreatePickingBatchBtn").addEventListener');
    const end = app.indexOf('  $("overseasPickingScanSubmitBtn")', start);
    let click: any;
    const state = { selectedOverseasOrderKeys: new Set(['rakuten:1']), overseasPickingBatchView: 'detail', selectedOverseasPickingBatchId: 'old', selectedOverseasPickingBatchDetail: { id: 'old' } };
    const openDetail = jest.fn();
    const toast = jest.fn();
    runInNewContext(app.slice(start, end), {
      $: () => ({ addEventListener: (_event: string, handler: any) => { click = handler; } }),
      state, withBusyButton: async (_button: any, _label: string, work: any) => work(),
      getSelectedOverseasOrderRows: () => [{ source: 'rakuten', id: '1' }],
      getOverseasPickingBatchStockIssues: () => [],
      createOverseasPickingBatch: async () => ({ id: '1', batches: [{ orderCount: 30 }, { orderCount: 1 }] }),
      loadOverseasOrderProcessingOrders: async () => {}, loadYamatoShipmentBatches: async () => {},
      loadOverseasPickingBatches: async () => { expect(state.overseasPickingBatchView).toBe('list'); },
      switchPanel: jest.fn(), openOverseasPickingBatchDetail: openDetail, showToast: toast,
    });
    await click({ currentTarget: {} });
    expect(state.selectedOverseasPickingBatchId).toBe('');
    expect(state.selectedOverseasPickingBatchDetail).toBeNull();
    expect(openDetail).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('已创建 2 个拣货批次'));
  });

  it('counts identical order numbers in different sources separately', () => {
    const input = [...rows(29),
      { ...row(100), source: 'rakuten' },
      { ...row(100), source: 'amazon' },
      { ...row(100), source: 'manual' },
    ];
    const result = service.splitOverseasPickingBatches(input);
    expect(result.map((batch: any[]) => batch.length)).toEqual([30, 2]);
    expect(result[0][29].source).toBe('rakuten');
  });

});
