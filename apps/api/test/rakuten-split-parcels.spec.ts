import { OrdersService } from '../src/orders/orders.service';
import { Prisma } from '@prisma/client';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';
import { RakutenRmsApiService } from '../src/rakuten-rms-api/rakuten-rms-api.service';
import { originalRakutenOrderId } from '../src/common/rakuten-order-identity';
import { buildOrderWorkflow, shippingConditionReason, shippingFingerprint, shippingTargetRows } from '../src/rakuten-rms-api/rakuten-order-workflow';

const date = new Date('2026-10-12T02:00:00Z');
const connection = { id: 7n, status: 1, autoShippingEnabled: true, mailNotificationsEnabled: true, shop: { id: 9n, name: '店铺' } } as any;
const row = (id: bigint, extra = {}) => ({
  id, rmsConnectionId: 7n, rmsOrderId: '12345678', orderId: '12345678', rmsItemKey: `12345678|ITEM-${id}`,
  deletedAt: null, updatedAt: date, createdAt: date, sourceKind: 'rms_api', dispatchMode: 'overseas',
  orderQuantity: 1, productName: `商品${id}`, skuCode: `SKU-${id}`, buyerEmail: 'buyer@example.jp',
  shipmentCompany: 'Yamato', shipmentNo: null, shipmentNoRegisteredAt: null, warehouseShippedAt: null,
  rawPayload: { rmsOrder: { orderNumber: '12345678' }, rmsPackage: { basketId: 1 }, rmsItem: { itemDetailId: String(id), units: 1 } }, ...extra,
} as any);
function matches(record: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some((part: any) => matches(record, part));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(record[key]);
      if ('notIn' in value) return !value.notIn.includes(record[key]);
      if ('not' in value) return record[key] !== value.not;
    }
    return record[key] === value;
  });
}
function fixture(records = [row(1n), row(2n), row(3n), row(4n)]) {
  const exclusions: any[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rakutenRmsConnection: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    rakutenOrderRecord: {
      findMany: jest.fn(async ({ where }) => records.filter((record) => matches(record, where))),
      findFirst: jest.fn(async ({ where }) => records.find((record) => matches(record, where)) ?? null),
      update: jest.fn(async ({ where, data }) => { const found = records.find((record) => matches(record, where)); Object.assign(found, data); return found; }),
      updateMany: jest.fn(async ({ where, data }) => { const found = records.filter((record) => matches(record, where)); found.forEach((record) => Object.assign(record, data)); return { count: found.length }; }),
    },
    overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    rakutenOrderSyncExclusion: { create: jest.fn(async ({ data }) => { exclusions.push(data); return data; }) },
    rakutenOrderMail: { findUnique: jest.fn().mockResolvedValue({ status: 'sent' }), upsert: jest.fn(), updateMany: jest.fn() },
    rakutenOrderShippingReport: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = { ...tx, $transaction: jest.fn(async (callback: any) => typeof callback === 'function' ? callback(tx) : Promise.all(callback)) };
  return { records, prisma, tx, exclusions, orders: new OrdersService(prisma as any) };
}
async function split(f: ReturnType<typeof fixture>) {
  await f.orders.changeRakutenOrderIdBatch({ ids: ['3', '4'], newOrderId: '12345678A' }, 'operator');
}
function register(f: ReturnType<typeof fixture>) {
  f.records.forEach((record) => Object.assign(record, { shipmentNo: record.orderId === '12345678' ? 'TRACK-BASE' : 'TRACK-A',
    shipmentNoRegisteredAt: date, warehouseShippedAt: date }));
}

describe('split parcels keep their original Rakuten order identity', () => {
  it('changes only the selected internal references and preserves source order and item keys', async () => {
    const f = fixture(); await split(f);
    expect(f.records.map((record) => record.orderId)).toEqual(['12345678', '12345678', '12345678A', '12345678A']);
    expect(f.records.every((record) => originalRakutenOrderId(record) === '12345678')).toBe(true);
    expect(f.records[2].rawPayload.rmsOrder.orderNumber).toBe('12345678');
    expect(f.records[2].rmsItemKey).toBe('12345678|ITEM-3');
    expect(f.tx.rakutenRmsConnection.updateMany).toHaveBeenCalledTimes(2);
  });
  it('keeps the same original order when a split reference is renamed again', async () => {
    const f = fixture(); await split(f);
    await f.orders.changeRakutenOrderIdBatch({ ids: ['3', '4'], newOrderId: '12345678B' }, 'operator');
    expect(f.records[2]).toMatchObject({ orderId: '12345678B', rmsOrderId: '12345678' });
  });
  it('supports separate A, B and C parcels while retaining one original Rakuten order', async () => {
    const f = fixture();
    for (const [id, suffix] of [['2', 'A'], ['3', 'B'], ['4', 'C']]) {
      await f.orders.changeRakutenOrderIdBatch({ ids: [id], newOrderId: `12345678${suffix}` });
    }
    expect(f.records.map((record) => record.orderId)).toEqual(['12345678', '12345678A', '12345678B', '12345678C']);
    expect(f.records.every((record) => originalRakutenOrderId(record) === '12345678')).toBe(true);
  });
  it.each([
    { name: 'same shop', rmsConnectionId: 7n, shopName: 'shop' },
    { name: 'another shop', rmsConnectionId: 8n, shopName: 'another shop' },
    { name: 'CSV import', rmsConnectionId: null, shopName: 'CSV' },
  ])('rejects a target number taken after the preflight check: $name', async ({ rmsConnectionId, shopName }) => {
    const f = fixture([row(1n, { rmsConnectionId, shopName })]);
    // Preflight sees no target. A competitor commits it before the transaction's locking read.
    f.tx.$queryRaw.mockResolvedValueOnce([{ id: 99n }]);
    await expect(f.orders.changeRakutenOrderIdBatch({ ids: ['1'], newOrderId: '12345678A' })).rejects.toThrow('已存在');
    expect(f.tx.rakutenOrderRecord.findFirst).toHaveReturned();
    expect(f.tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
    expect(f.records[0].orderId).toBe('12345678');
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    }));
  });
  it.each([
    { code: 'P2034', meta: undefined },
    { code: 'P2010', meta: { code: '1213' } },
    { code: 'P2010', meta: { code: '1205' } },
  ])('reports an absent-target lock collision as a recoverable conflict: $code $meta', async ({ code, meta }) => {
    const f = fixture();
    f.tx.$queryRaw.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('lock collision', {
      code, clientVersion: '6.19.3', meta,
    }));
    await expect(split(f)).rejects.toMatchObject({ message: expect.stringContaining('并发冲突'), status: 409 });
    expect(f.tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
  });
  it('does not hide unrelated database failures as number collisions', async () => {
    const f = fixture(); const error = new Error('database unavailable');
    f.tx.$queryRaw.mockRejectedValueOnce(error);
    await expect(split(f)).rejects.toBe(error);
    expect(f.tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
  });
  it('refuses splitting while the parent shop is executing an outbound task', async () => {
    const f = fixture(); f.tx.rakutenRmsConnection.updateMany.mockResolvedValue({ count: 0 });
    await expect(split(f)).rejects.toThrow('暂不能拆分');
    expect(f.tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
  });
  it('does not infer a parent by removing an A suffix from a legitimate order number', () => {
    expect(originalRakutenOrderId({ orderId: '12345678A', rmsOrderId: null, rawPayload: null })).toBe('12345678A');
  });
  it('shows one workflow and waits for the split parcel before any shipping return', async () => {
    const f = fixture(); await split(f);
    Object.assign(f.records[0], { shipmentNo: 'TRACK-BASE', shipmentNoRegisteredAt: date, warehouseShippedAt: date });
    Object.assign(f.records[1], { shipmentNo: 'TRACK-BASE', shipmentNoRegisteredAt: date, warehouseShippedAt: date });
    const automation = new RakutenRmsAutomationService(f.prisma as any, {} as any, {} as any);
    const records = await (automation as any).loadOrderRows(7n, '12345678');
    expect(records).toHaveLength(4);
    expect(shippingConditionReason(records, 'japan', true)).toContain('仓库');
    const flow = buildOrderWorkflow({ rows: records, connection, report: null,
      mails: [{ id: 1n, event: 'new_order', status: 'sent' }] as any, templateVersions: new Map([['japan_shipped', 1]]) });
    expect(flow).toMatchObject({ orderId: '12345678', internalOrderIds: ['12345678', '12345678A'] });
    expect(flow.steps.find((step) => step.event === 'shipping')?.executable).toBe(false);
  });
  it('returns both parcel numbers to the real RMS number and creates only one Japan mail', async () => {
    const f = fixture(); await split(f); register(f);
    f.tx.rakutenOrderShippingReport.findMany.mockResolvedValue([{ id: 20n, connectionId: 7n, orderId: '12345678',
      fulfillmentType: 'japan', status: 'pending', attempts: 0, connection, fingerprint: shippingFingerprint(f.records) }] as any);
    const getOrders = jest.fn().mockResolvedValue([{ orderNumber: '12345678', orderProgress: 300, PackageModelList: [] }]);
    const updateOrderShipping = jest.fn().mockResolvedValue({ MessageModelList: [] });
    const automation = new RakutenRmsAutomationService(f.prisma as any, { getOrders, updateOrderShipping } as any, {} as any);
    jest.spyOn(automation as any, 'assertExecutionLock').mockResolvedValue(undefined);
    jest.spyOn(automation as any, 'decryptApiCredentials').mockReturnValue({ serviceSecret: 'secret', licenseKey: 'key' });
    expect(await (automation as any).processShippingReports(7n)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(getOrders).toHaveBeenCalledWith('secret', 'key', ['12345678']);
    expect(updateOrderShipping).toHaveBeenCalledWith('secret', 'key', '12345678', [{ basketId: 1,
      ShippingModelList: [
        { shippingNumber: 'TRACK-BASE', deliveryCompany: '1001', shippingDate: '2026-10-12', shippingDeleteFlag: 0 },
        { shippingNumber: 'TRACK-A', deliveryCompany: '1001', shippingDate: '2026-10-12', shippingDeleteFlag: 0 },
      ],
    }]);
    expect(f.tx.rakutenOrderMail.upsert).toHaveBeenCalledTimes(1);
    expect(f.tx.rakutenOrderMail.upsert.mock.calls[0][0].create.orderId).toBe('12345678');
  });
  it('does not generate a second acknowledgement for the internal A reference', async () => {
    const f = fixture(); await split(f);
    const createMany = jest.fn(); (f.prisma.rakutenOrderMail as any).createMany = createMany;
    const automation = new RakutenRmsAutomationService(f.prisma as any, {} as any, {} as any);
    await automation.enqueueNewOrderMails(f.prisma as any, 7n, ['12345678']);
    expect(createMany).toHaveBeenCalledWith({ data: [{ connectionId: 7n, orderId: '12345678', event: 'new_order' }], skipDuplicates: true });
    await automation.enqueueNewOrderMails(f.prisma as any, 7n, ['12345678A']);
    expect(createMany).toHaveBeenCalledTimes(1);
  });
  it('renders all parcel numbers under the original customer order number', async () => {
    const f = fixture(); await split(f); register(f);
    const automation = new RakutenRmsAutomationService(f.prisma as any, {} as any, {} as any);
    const rendered = (automation as any).renderTemplate({ subjectTemplate: '注文 {{order_number}}',
      bodyTemplate: '{{order_summary}}\n{{tracking_sections}}' }, f.records, 'japan_shipped');
    expect(rendered.subject).toBe('注文 12345678');
    expect(rendered.body).toContain('TRACK-BASE'); expect(rendered.body).toContain('TRACK-A');
    expect(rendered.body).toContain('[受注番号] 12345678');
  });
  it('preserves the internal parcel reference when preparing an RMS synchronization update', async () => {
    const f = fixture(); await split(f);
    const api = new RakutenRmsApiService(f.prisma as any, {} as any, {} as any);
    const data = await (api as any).buildOrderWriteData(f.prisma, connection, {
      orderId: '12345678', itemKey: '12345678|ITEM-3', skuCode: 'SKU-3', orderQuantity: 1, rawPayload: f.records[2].rawPayload,
    }, f.records[2], date);
    expect(data).toMatchObject({ orderId: '12345678A', rmsOrderId: '12345678', rmsItemKey: '12345678|ITEM-3' });
  });
  it('treats deletion of one internal parcel as partial deletion of the original order', async () => {
    const f = fixture(); await split(f);
    expect(await f.orders.deleteRakutenBatch({ ids: ['3', '4'] }, 9n)).toEqual({ deletedCount: 2, fullOrderCount: 0, partialOrderCount: 1 });
    expect(f.records[0].deletedAt).toBeNull(); expect(f.records[1].deletedAt).toBeNull();
    expect(f.exclusions.every((entry) => entry.orderId === '12345678')).toBe(true);
    expect(f.exclusions.some((entry) => entry.rmsItemKey === null && entry.skuCode === null)).toBe(false);
    expect(await f.orders.deleteRakutenBatch({ ids: ['1', '2'] }, 9n)).toMatchObject({ fullOrderCount: 1 });
    expect(f.exclusions.some((entry) => entry.orderId === '12345678' && entry.rmsItemKey === null && entry.skuCode === null)).toBe(true);
  });
  it('includes all split mixed-origin parcels, waiting for Japan dispatch and China clearance', () => {
    const records = [row(1n, { shipmentNo: 'JP', shipmentNoRegisteredAt: date, warehouseShippedAt: date }),
      row(2n, { orderId: '12345678A', dispatchMode: 'china_pending', shipmentCompany: 'Sagawa', shipmentNo: 'CN',
        shipmentNoRegisteredAt: date, trackingHasCustomsClearance: true, trackingCustomsClearanceDate: date })];
    expect(shippingTargetRows(records, 'mixed')).toHaveLength(2);
    expect(shippingConditionReason(records, 'mixed', true)).toBeNull();
    expect(shippingConditionReason([{ ...records[0], warehouseShippedAt: null }, records[1]], 'mixed', true)).toContain('仓库');
    expect(shippingConditionReason([records[0], { ...records[1], trackingCustomsClearanceDate: null }], 'mixed', true)).toContain('清关日期');
    const unsplit = records.map((record) => ({ ...record, orderId: '12345678' }));
    expect(shippingTargetRows(unsplit, 'mixed')).toEqual([unsplit[1]]);
  });
});
