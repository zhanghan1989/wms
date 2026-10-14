import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrdersService } from '../src/orders/orders.service';
import { shippingConditionReason } from '../src/rakuten-rms-api/rakuten-order-workflow';

const shippedAt = new Date('2026-10-14T05:36:36.720Z');
const row = (extra: object = {}): any => ({
  id: 1n, deletedAt: null, orderId: 'ORDER', rmsConnectionId: 7n, shopName: '店铺',
  dispatchMode: 'overseas', orderQuantity: 1, shipmentNo: '7671-5060-6515', shipmentCompany: 'Yamato',
  shipmentNoRegisteredAt: new Date('2026-10-14T05:12:00Z'), warehouseShippedAt: shippedAt, warehouseShippedBy: 11n,
  trackingHasCustomsClearance: true, trackingIsDelivered: true, trackingStatusLabel: '配達済み',
  trackingCustomsClearanceDate: shippedAt, trackingCheckedAt: shippedAt,
  rawPayload: { rmsPackage: { basketId: 1 }, rmsItem: { itemDetailId: 1 } }, ...extra,
});
const payload = {
  shipmentNo: '4369-7471-5236', shipmentCompany: 'Yamato', shipmentEditMode: 'correction' as const,
  expectedShipmentNo: '7671-5060-6515', expectedShipmentCompany: 'Yamato', expectedWarehouseShippedAt: shippedAt.toISOString(),
};

function fixture(rows = [row()], options: { busy?: boolean; concurrent?: object } = {}) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    rakutenRmsConnection: { updateMany: jest.fn().mockResolvedValue({ count: options.busy ? 0 : 1 }) },
    rakutenOrderRecord: {
      findUnique: jest.fn(async () => ({ ...rows[0], ...options.concurrent })),
      findMany: jest.fn(async ({ where }) => rows.filter((r) => r.deletedAt === null && r.orderId === where.orderId &&
        r.rmsConnectionId === where.rmsConnectionId && r.shipmentNo === where.shipmentNo && (!where.shopName || r.shopName === where.shopName))),
      update: jest.fn(async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    rakutenOrderShippingReport: { updateMany: jest.fn() }, rakutenOrderMail: { updateMany: jest.fn() },
    overseasPickingBatchItem: { update: jest.fn() },
  };
  const service = new OrdersService({
    rakutenOrderRecord: { findUnique: jest.fn(async () => ({ ...rows[0] })), findUniqueOrThrow: jest.fn(async () => rows[0]) },
    $transaction: jest.fn(async (cb) => cb(tx)),
  } as any);
  jest.spyOn(service as any, 'enrichOrderRows').mockImplementation(async (items) => items);
  return { service, tx, rows };
}

describe('same shipped parcel tracking correction', () => {
  it('keeps actual dispatch evidence, resets obsolete tracking and records old/new values', async () => {
    const { service, tx, rows } = fixture();
    await service.updateRakutenOrder('1', payload, 'wangjingxun');
    expect(rows[0]).toMatchObject({ shipmentNo: payload.shipmentNo, warehouseShippedAt: shippedAt, warehouseShippedBy: 11n,
      trackingHasCustomsClearance: false, trackingIsDelivered: false, trackingStatusLabel: null, trackingCheckedAt: null });
    expect(rows[0].rawPayload).toMatchObject({ rmsPackage: { basketId: 1 }, rmsItem: { itemDetailId: 1 },
      _wmsShipmentCorrectionHistory: [{ operator: 'wangjingxun', previousShipmentNo: payload.expectedShipmentNo,
        shipmentNo: payload.shipmentNo, warehouseShippedAt: shippedAt.toISOString() }] });
    expect(shippingConditionReason(rows, 'japan', true)).toBeNull();
    expect(tx.rakutenOrderShippingReport.updateMany).not.toHaveBeenCalled();
    expect(tx.rakutenOrderMail.updateMany).not.toHaveBeenCalled();
    expect(tx.overseasPickingBatchItem.update).not.toHaveBeenCalled();
    expect(tx.rakutenRmsConnection.updateMany).toHaveBeenCalledTimes(2);
  });

  it('corrects every item of the parcel while preserving other baskets, child parcels and shops', async () => {
    const { service, rows, tx } = fixture([row(), row({ id: 2n }),
      row({ id: 3n, rawPayload: { rmsPackage: { basketId: 2 } } }), row({ id: 4n, orderId: 'ORDERa' }),
      row({ id: 5n, rmsConnectionId: 8n }), row({ id: 6n, shipmentNo: 'OTHER' }), row({ id: 7n, dispatchMode: 'china_pending' })]);
    await service.updateRakutenOrder('1', { ...payload, shipmentCompany: 'Sagawa' }, 'operator');
    expect(tx.rakutenOrderRecord.update).toHaveBeenCalledTimes(2);
    expect(rows.slice(0, 2).every((r) => r.shipmentNo === payload.shipmentNo && r.shipmentCompany === 'Sagawa')).toBe(true);
    expect(rows.slice(2).map((r) => r.shipmentNo)).toEqual([payload.expectedShipmentNo, payload.expectedShipmentNo,
      payload.expectedShipmentNo, 'OTHER', payload.expectedShipmentNo]);
  });

  it.each([
    { warehouseShippedAt: null }, { dispatchMode: 'china_pending' }, { shipmentNo: null },
  ])('rejects correction without a confirmed Japan parcel: %j', async (extra) => {
    const { service, tx } = fixture([row(extra)]);
    await expect(service.updateRakutenOrder('1', { ...payload, expectedWarehouseShippedAt: undefined, expectedShipmentNo: undefined })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
  });
  it.each([{ shipmentNo: '' }, { shipmentCompany: '' }, { shipmentCompany: 'unknown' }])('rejects incomplete or unsupported shipment data: %j', async (extra) => {
    const { service, tx } = fixture();
    await expect(service.updateRakutenOrder('1', { ...payload, ...extra })).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
  });
  it.each([
    { expectedShipmentNo: 'stale' }, { expectedShipmentCompany: 'Sagawa' }, { expectedWarehouseShippedAt: '2026-10-13T00:00:00Z' },
  ])('rejects an outdated editor snapshot: %j', async (extra) => {
    const { service, tx } = fixture();
    await expect(service.updateRakutenOrder('1', { ...payload, ...extra })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
  });
  it.each([{ warehouseShippedAt: null }, { shipmentNo: 'CONCURRENT' }, { orderQuantity: 2 }, { rmsConnectionId: 8n },
    { rawPayload: { rmsPackage: { basketId: 2 } } }])('rechecks dispatch evidence under the row lock (case %#)', async (concurrent) => {
    const { service, tx } = fixture([row()], { concurrent });
    await expect(service.updateRakutenOrder('1', payload)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
  });
  it('does not edit while an external automation holds the shop lock', async () => {
    const { service, tx } = fixture([row()], { busy: true });
    await expect(service.updateRakutenOrder('1', payload)).rejects.toThrow('店铺正在');
    expect(tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
  });
  it('refuses a parcel with contradictory dispatch confirmations before updating any item', async () => {
    const { service, tx } = fixture([row(), row({ id: 2n, warehouseShippedAt: null })]);
    await expect(service.updateRakutenOrder('1', payload)).rejects.toThrow('同包裹明细');
    expect(tx.rakutenOrderRecord.update).not.toHaveBeenCalled();
  });
  it('keeps replacement behavior requiring new physical dispatch confirmation', async () => {
    const { service, rows } = fixture();
    await service.updateRakutenOrder('1', { ...payload, shipmentEditMode: 'replacement' });
    expect(rows[0]).toMatchObject({ warehouseShippedAt: null, warehouseShippedBy: null });
    expect(shippingConditionReason(rows, 'japan', true)).toContain('仓库');
  });
});
