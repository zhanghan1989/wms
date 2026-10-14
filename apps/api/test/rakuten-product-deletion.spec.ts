import { OrdersService } from '../src/orders/orders.service';
import { RakutenRmsApiService } from '../src/rakuten-rms-api/rakuten-rms-api.service';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';
import { mailEventReviewReason, shippingConditionReason } from '../src/rakuten-rms-api/rakuten-order-workflow';

const date = new Date('2026-10-12T02:00:00Z');
const row = (id: bigint, extra = {}) => ({ id, orderId: 'ORDER', rmsConnectionId: 7n, rmsOrderId: null, shopName: '店铺', sourceKind: 'rms_api',
  rmsItemKey: `ITEM-${id}`, skuCode: `SKU-${id}`, deletedAt: null, deletedBy: null, updatedAt: date, createdAt: date,
  orderQuantity: 1, dispatchMode: 'overseas', shipmentNo: 'JP-1', shipmentCompany: 'Yamato', shipmentNoRegisteredAt: date,
  warehouseShippedAt: date, productName: `商品${id}`, buyerEmail: 'buyer@example.jp',
  rawPayload: { rmsOrder: { goodsPrice: 3000, requestPrice: 3000 }, rmsPackage: { basketId: 1 }, rmsItem: { price: 1000 } }, ...extra } as any);
function matches(record: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some((part: any) => matches(record, part));
    if (key === 'AND') return value.every((part: any) => matches(record, part));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(record[key]);
      if ('not' in value) return record[key] !== value.not;
    }
    return record[key] === value;
  });
}
function fixture(records = [row(1n), row(2n), row(3n)]) {
  const exclusions: any[] = [];
  const recordStore = {
    findMany: jest.fn(async ({ where }) => records.filter((record) => matches(record, where))),
    findFirst: jest.fn(async ({ where }) => records.find((record) => matches(record, where)) ?? null),
    updateMany: jest.fn(async ({ where, data }) => {
      const selected = records.filter((record) => matches(record, where));
      selected.forEach((record) => Object.assign(record, data)); return { count: selected.length };
    }),
  };
  const tx = {
    rakutenOrderRecord: recordStore,
    rakutenOrderSyncExclusion: { create: jest.fn(async ({ data }) => { exclusions.push(data); return data; }),
      findMany: jest.fn(async ({ where }) => exclusions.filter((record) => matches(record, where))) },
    rakutenRmsConnection: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    rakutenOrderMail: { updateMany: jest.fn(), findUnique: jest.fn().mockResolvedValue({ id: 10n, connectionId: 7n, orderId: 'ORDER', status: 'failed', event: 'china_delay' }) },
    rakutenOrderShippingReport: { updateMany: jest.fn() },
  };
  const prisma = { ...tx, $transaction: jest.fn(async (callback: any) => typeof callback === 'function' ? callback(tx) : Promise.all(callback)) };
  return { service: new OrdersService(prisma as any), prisma, tx, records, exclusions };
}

describe('automatic per-order deletion classification', () => {
  it('deletes multiple selected products while keeping other products and jobs active', async () => {
    const { service, records, tx, exclusions } = fixture();
    expect(await service.deleteRakutenBatch({ ids: ['1', '3'] }, 9n)).toMatchObject({ deletedCount: 2 });
    expect(records[0].deletedAt).toBeInstanceOf(Date); expect(records[2].deletedAt).toBeInstanceOf(Date);
    expect(records[1].deletedAt).toBeNull();
    expect(exclusions.map((entry) => entry.rmsItemKey)).toEqual(['ITEM-1', 'ITEM-3']);
    expect(exclusions.every((entry) => entry.rmsItemKey !== null || entry.skuCode !== null)).toBe(true);
    expect(tx.rakutenOrderMail.updateMany).not.toHaveBeenCalled(); expect(tx.rakutenOrderShippingReport.updateMany).not.toHaveBeenCalled();
    expect(mailEventReviewReason('japan_shipped', [records[1]])).toBe('manual_update');
    expect(mailEventReviewReason('new_order', [records[1]])).toBeNull();
    expect(shippingConditionReason([records[1]], 'japan', true)).toBeNull();
  });
  it('deletes the whole order when all its active products are selected', async () => {
    const { service, records, exclusions, tx } = fixture();
    expect(await service.deleteRakutenBatch({ ids: ['1', '2', '3'] }, 9n)).toMatchObject({ deletedCount: 3, fullOrderCount: 1, partialOrderCount: 0 });
    expect(records.every((record) => record.deletedAt !== null)).toBe(true);
    expect(exclusions).toEqual([expect.objectContaining({ rmsItemKey: null, skuCode: null })]);
    expect(tx.rakutenOrderMail.updateMany).toHaveBeenCalled(); expect(tx.rakutenOrderShippingReport.updateMany).toHaveBeenCalled();
  });
  it('permanently excludes the order when its only remaining product is selected', async () => {
    const { service, exclusions, tx } = fixture([row(1n)]);
    await service.deleteRakutenBatch({ ids: ['1'] }, 9n);
    expect(exclusions).toEqual([expect.objectContaining({ rmsItemKey: null, skuCode: null })]);
    expect(tx.rakutenOrderMail.updateMany).toHaveBeenCalled();
  });
  it('classifies full and partial orders independently in the same batch', async () => {
    const { service, records, exclusions, tx } = fixture([
      row(1n, { orderId: 'ORDER-A' }), row(2n, { orderId: 'ORDER-A' }),
      row(3n, { orderId: 'ORDER-B' }), row(4n, { orderId: 'ORDER-B' }), row(5n, { orderId: 'ORDER-B' }),
    ]);
    expect(await service.deleteRakutenBatch({ ids: ['1', '2', '3'] }, 9n)).toEqual({
      deletedCount: 3, fullOrderCount: 1, partialOrderCount: 1,
    });
    expect(records[3].deletedAt).toBeNull(); expect(records[4].deletedAt).toBeNull();
    expect(exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: 'ORDER-A', rmsItemKey: null, skuCode: null }),
      expect.objectContaining({ orderId: 'ORDER-B', rmsItemKey: 'ITEM-3' }),
    ]));
    expect(tx.rakutenOrderMail.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.rakutenOrderMail.updateMany.mock.calls[0][0].where.orderId).toBe('ORDER-A');
  });
  it('checks every product in the database rather than only the visible selection', async () => {
    const { service, records, exclusions } = fixture([row(1n), row(2n)]);
    expect(await service.deleteRakutenBatch({ ids: ['1'] }, 9n)).toMatchObject({ fullOrderCount: 0, partialOrderCount: 1 });
    expect(records[1].deletedAt).toBeNull(); expect(exclusions[0].rmsItemKey).toBe('ITEM-1');
  });
  it('counts only active products when the last remaining product is selected', async () => {
    const { service, exclusions } = fixture([row(1n, { deletedAt: date }), row(2n)]);
    expect(await service.deleteRakutenBatch({ ids: ['2'] }, 9n)).toMatchObject({ deletedCount: 1, fullOrderCount: 1, partialOrderCount: 0 });
    expect(exclusions[0]).toMatchObject({ rmsItemKey: null, skuCode: null });
  });
  it('keeps records in other shops and connections outside a product deletion', async () => {
    const { service, records } = fixture([row(1n), row(2n, { rmsConnectionId: 8n }), row(3n, { rmsConnectionId: null, shopName: '其他CSV店铺' })]);
    await service.deleteRakutenBatch({ ids: ['1'] }, 9n);
    expect(records[1].deletedAt).toBeNull(); expect(records[2].deletedAt).toBeNull();
  });
  it('checks picking associations only for products being deleted', async () => {
    const { service, tx } = fixture();
    tx.overseasPickingBatchItem.findFirst.mockImplementation(async ({ where }: any) => where.sourceRecordId.in.includes(2n) ? { id: 9n } : null);
    await expect(service.deleteRakutenBatch({ ids: ['1'] }, 9n)).resolves.toMatchObject({ deletedCount: 1 });
    await expect(service.deleteRakutenBatch({ ids: ['2'] }, 9n)).rejects.toThrow('拣货批次');
  });
  it('records a product-level SKU exclusion for CSV records without an API item key', async () => {
    const { service, exclusions } = fixture([row(1n, { rmsConnectionId: null, rmsItemKey: null, skuCode: 'BOX-A' }), row(2n, { rmsConnectionId: null })]);
    await service.deleteRakutenBatch({ ids: ['1'] }, 9n);
    expect(exclusions[0]).toMatchObject({ rmsConnectionId: null, rmsItemKey: null, skuCode: 'box-a' });
  });
  it('allows mail recovery for remaining products but refuses an empty order', async () => {
    const { service, prisma } = fixture();
    await service.deleteRakutenBatch({ ids: ['1'] }, 9n);
    const automation = new RakutenRmsAutomationService(prisma as any, {} as any, {} as any);
    await expect((automation as any).assertOrderNotDeleted(7n, 'ORDER')).resolves.toBeUndefined();
    await service.deleteRakutenBatch({ ids: ['2', '3'] }, 9n);
    await expect((automation as any).assertOrderNotDeleted(7n, 'ORDER')).rejects.toThrow('不能恢复');
  });
  it('excludes only the deleted API line even if another line has the same SKU', async () => {
    const { service, exclusions, prisma } = fixture([row(1n), row(2n, { skuCode: 'SKU-1' })]);
    await service.deleteRakutenBatch({ ids: ['1'] }, 9n);
    const api = new RakutenRmsApiService(prisma as any, {} as any, {} as any);
    const connection = { id: 7n, shop: { name: '店铺已改名' } };
    const check = (key: string) => (api as any).orderItemExclusionReason(prisma, connection, { orderId: 'ORDER', itemKey: key, skuCode: 'SKU-1' });
    expect(exclusions).toHaveLength(1);
    expect(await check('ITEM-1')).toBe('user_delete'); expect(await check('ITEM-2')).toBeNull();
    expect(await (api as any).orderItemExclusionReason(prisma, { id: 8n, shop: { name: '店铺' } }, { orderId: 'ORDER', itemKey: 'ITEM-1' })).toBeNull();
  });
  it('keeps partial-deletion review after the remaining line is resynced', async () => {
    const { service, records, prisma } = fixture();
    await service.deleteRakutenBatch({ ids: ['1'] }, 9n);
    const api = new RakutenRmsApiService(prisma as any, {} as any, {} as any);
    const data = await (api as any).buildOrderWriteData(prisma, { id: 7n, shop: { name: '店铺' } }, {
      orderId: 'ORDER', itemKey: 'ITEM-2', skuCode: 'SKU-2', orderQuantity: 1, rawPayload: { rmsPackage: { basketId: 1 } },
    }, records[1], date);
    expect(data.rawPayload._wmsDeletedItemsAt).toBeTruthy();
    expect(mailEventReviewReason('japan_shipped', [{ ...records[1], ...data }])).toBe('manual_update');
  });
  it('keeps the original import cutoff after the oldest product is deleted', async () => {
    const { service, records, prisma } = fixture([row(1n, { createdAt: new Date('2026-09-29T00:00:00Z') }), row(2n)]);
    await service.deleteRakutenBatch({ ids: ['1'] }, 9n);
    const automation = new RakutenRmsAutomationService(prisma as any, {} as any, {} as any);
    expect(await (automation as any).isAutomationEligibleOrder([records[1]])).toBe(false);
    const keys = await (automation as any).loadEligibleAutomationOrderKeys([{ connectionId: 7n, orderId: 'ORDER' }]);
    expect(keys.size).toBe(0);
  });
  it('shows every remaining combo component instead of deduplicating them as one purchased set', async () => {
    const component = (id: bigint) => row(id, { isComboOrder: true, comboOrderSku: 'SET', setComponentSkuCode: 'SET',
      rawPayload: { rmsPackage: { basketId: 1 }, rmsItem: { itemDetailId: 11, itemName: 'セット商品', price: 3000 } } });
    const { service, records, prisma } = fixture([component(1n), component(2n), component(3n)]);
    await service.deleteRakutenBatch({ ids: ['1'] }, 9n);
    const automation = new RakutenRmsAutomationService(prisma as any, {} as any, {} as any);
    const text = (automation as any).renderOrderSummary(records.filter((record) => !record.deletedAt));
    expect(text.match(/セット商品（構成商品）/g)).toHaveLength(2);
    expect(text.match(/数量: 1/g)).toHaveLength(2);
    for (const name of ['商品1', '商品2', '商品3']) expect(text).not.toContain(name);
    expect(text).not.toContain('3,000');
  });
  it('omits obsolete full-order prices from previews of remaining products', async () => {
    const { service, records, prisma } = fixture();
    await service.deleteRakutenBatch({ ids: ['1'] }, 9n);
    const automation = new RakutenRmsAutomationService(prisma as any, {} as any, {} as any);
    const text = (automation as any).renderOrderSummary(records.filter((record) => !record.deletedAt));
    expect(text).not.toContain('商品1'); expect(text).toContain('商品2'); expect(text).toContain('商品3');
    expect(text).not.toContain('3,000'); expect(text).not.toContain('価格 1,000'); expect(text).toContain('金額は確認が必要');
  });
});
