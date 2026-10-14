import { ConflictException } from '@nestjs/common';
import { OrdersService } from '../src/orders/orders.service';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';
import { RakutenOrderSchedulerService } from '../src/rakuten-rms-api/rakuten-order-scheduler.service';
import { buildOrderWorkflow, mailReviewReason, shippingConditionReason } from '../src/rakuten-rms-api/rakuten-order-workflow';

const date = new Date('2026-10-12T02:00:00Z');
const order = (extra: object = {}) => ({
  id: 1n, orderId: 'ORDER', rmsConnectionId: 7n, rmsOrderId: null, shopName: '旧店名', sourceKind: 'rms_api', createdAt: date,
  deletedAt: null, dispatchMode: 'overseas', orderQuantity: 1, shipmentNo: 'PRINTED-1', shipmentCompany: 'Yamato',
  shipmentNoRegisteredAt: date, warehouseShippedAt: date, warehouseShippedBy: 9n, buyerEmail: 'buyer@example.jp',
  trackingHasCustomsClearance: true, trackingIsDelivered: true, trackingCustomsClearanceDate: date,
  shippingName: '購入者', shippingPostalCode: '123-4567', shippingPrefecture: '東京都', shippingCity: '千代田区', shippingAddress: '1-2-3',
  productName: '商品', skuCode: 'PART', rawPayload: { rmsPackage: { basketId: 1 }, rmsItem: { itemName: 'セット商品', units: 1 } },
  ...extra,
} as any);

function editableOrder() {
  let saved = order();
  const tx = { rakutenOrderRecord: {
    update: jest.fn(async ({ data }) => { saved = { ...saved, ...data }; return saved; }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  } };
  const service = new OrdersService({
    rakutenOrderRecord: { findUnique: jest.fn(async () => saved), findUniqueOrThrow: jest.fn(async () => saved) },
    $transaction: jest.fn(async (cb) => cb(tx)),
  } as any);
  jest.spyOn(service as any, 'enrichOrderRows').mockImplementation(async (rows) => rows);
  return { service, saved: () => saved };
}

function scheduleControl(enabled = true): any {
  return { enabled: jest.fn().mockResolvedValue(enabled), execute: jest.fn((_key, action) => enabled ? action() : Promise.resolve(undefined)) };
}

describe('review fixes: shipment confirmation and whole-order deletion', () => {
  it.each([
    { shipmentNo: 'NEW-UNCONFIRMED', shipmentCompany: 'Yamato' },
    { shipmentNo: 'PRINTED-1', shipmentCompany: 'Sagawa' },
    { shipmentNo: '', shipmentCompany: 'Yamato' },
  ])('invalidates old shipment facts when editing package identity: %j', async (payload) => {
    const { service, saved } = editableOrder();
    await service.updateRakutenOrder('1', payload, 'reviewer');
    expect(saved()).toMatchObject({ warehouseShippedAt: null, warehouseShippedBy: null,
      trackingHasCustomsClearance: false, trackingIsDelivered: false, trackingCustomsClearanceDate: null });
    expect(shippingConditionReason([saved()], 'japan', true)).toContain('仓库');
  });
  it('retains the original dispatch and registration facts for an unchanged package', async () => {
    const { service, saved } = editableOrder();
    await service.updateRakutenOrder('1', { shipmentNo: 'PRINTED-1', shipmentCompany: 'Yamato' }, 'reviewer');
    expect(saved()).toMatchObject({ warehouseShippedAt: date, warehouseShippedBy: 9n,
      shipmentNoRegisteredAt: date, trackingHasCustomsClearance: true, trackingCustomsClearanceDate: date });
  });
  it('deletes every line across a shop rename while preserving other connections', async () => {
    const rows = [order(), order({ id: 2n, shopName: '新店名' }), order({ id: 3n, rmsConnectionId: 8n })];
    const exclusion = jest.fn();
    const tx = {
      rakutenOrderRecord: {
        findMany: jest.fn(async ({ where }) => rows.filter((row) => where.OR.some((group: Record<string, any>) =>
          group.id ? group.id.in.includes(row.id) : group.rmsConnectionId === row.rmsConnectionId && group.OR.some((identity: any) => Object.entries(identity).every(([key, value]) => row[key] === value))))),
        updateMany: jest.fn(async ({ where, data }) => { const affected = rows.filter((row) => where.id.in.includes(row.id));
          affected.forEach((row) => Object.assign(row, data)); return { count: affected.length }; }),
      },
      rakutenRmsConnection: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      rakutenOrderSyncExclusion: { create: exclusion },
      rakutenOrderMail: { updateMany: jest.fn() }, rakutenOrderShippingReport: { updateMany: jest.fn() },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new OrdersService({ rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows.slice(0, 2)) },
      $transaction: jest.fn(async (cb) => cb(tx)) } as any);
    expect(await service.deleteRakutenBatch({ ids: ['1', '2'] }, 9n)).toMatchObject({ deletedCount: 2 });
    expect(rows[0].deletedAt).toBeInstanceOf(Date); expect(rows[1].deletedAt).toBeInstanceOf(Date);
    expect(rows[2].deletedAt).toBeNull(); expect(exclusion).toHaveBeenCalledTimes(1);
  });
});

describe('review fixes: complete combo recipients and honest mail values', () => {
  const sender = new RakutenRmsAutomationService({} as any, {} as any, {} as any);
  const combo = (extra = {}) => order({ isComboOrder: true, comboOrderSku: 'SET', setComponentSkuCode: 'SET', ...extra });
  it.each(['shippingName', 'shippingPostalCode', 'shippingPrefecture', 'shippingCity', 'shippingAddress'])('requires review when %s is missing', (field) => {
    const row = combo({ [field]: null });
    expect(mailReviewReason([row])).toBe('combo_order');
    const result = buildOrderWorkflow({ rows: [row], connection: { status: 1, mailNotificationsEnabled: true,
      autoShippingEnabled: true, id: 7n, shop: { name: '店铺' } } as any,
      report: { id: 20n, status: 'sent' } as any,
      mails: [{ id: 10n, event: 'new_order', status: 'sent' }, { id: 11n, event: 'japan_shipped', status: 'pending' }] as any,
      templateVersions: new Map([['new_order', 1], ['japan_shipped', 1]]) });
    expect(result.steps.find((step) => step.event === 'japan_shipped')).toMatchObject({ state: 'manual', executable: false, requiresManualReview: true });
  });
  it('continues to automate complete combos', () => expect(mailReviewReason([combo()])).toBeNull());
  it.each([null, 0, -1, 1.5, NaN])('does not invent a quantity for %s', (quantity) => {
    const row = order({ orderQuantity: quantity });
    expect(mailReviewReason([row])).toBe('manual_update');
    const text = (sender as any).renderOrderSummary([row]);
    expect(text).toContain('数量: 要確認'); expect(text).not.toContain('合計商品数');
    expect(text).not.toContain('数量: 1');
  });
  it('omits missing prices and never displays a partial subtotal as a whole-order total', () => {
    const first = order({ rawPayload: { rmsPackage: { basketId: 1 }, rmsItem: { itemDetailId: 1, price: 1000 } } });
    const second = order({ id: 2n, rawPayload: { rmsPackage: { basketId: 1 }, rmsItem: { itemDetailId: 2 } } });
    const text = (sender as any).renderOrderSummary([first, second]);
    for (const label of ['送料(税込)', '商品価格計(税込)', '商品小計(税込)', 'お支払い金額(税込)', '[クーポン利用]', '[ポイント利用]']) expect(text).not.toContain(label);
  });
  it('preserves explicitly supplied zero shipping charges', () => {
    const text = (sender as any).renderOrderSummary([order({ rawPayload: { rmsPackage: { basketId: 1 }, rmsOrder: { postagePrice: 0 } } })]);
    expect(text).toContain('送料(税込)   0(円)');
  });
});

describe('review fixes: stage outcomes', () => {
  const summary = { trackingNoCount: 2, customsClearanceCount: 1, failedCount: 0 };
  function scheduler(tracking: any, automation: any) {
    return new RakutenOrderSchedulerService({ syncRakutenTrackingStatuses: tracking } as any,
      { runScheduledAutomation: automation } as any, { syncAllConnections: jest.fn().mockResolvedValue({ results: [] }) } as any, scheduleControl());
  }
  it('returns both stage failures instead of success, and still runs the later stage', async () => {
    const automation = jest.fn().mockResolvedValue({ status: 'failed', error: 'processing outage' });
    const result = await scheduler(jest.fn().mockRejectedValue(new Error('tracking outage')), automation).runNow();
    expect(result).toMatchObject({ checked: false, status: 'partial', stages: {
      tracking: { status: 'failed', errors: ['tracking outage'] }, automation: { status: 'failed', errors: ['processing outage'] },
    } });
    expect(automation).toHaveBeenCalledTimes(2);
  });
  it('distinguishes a busy tracking lock from an outage and reports a paused sender', async () => {
    const result = await scheduler(jest.fn().mockRejectedValue(new ConflictException('tracking busy')),
      jest.fn().mockResolvedValue({ status: 'paused' })).runNow();
    expect(result).toMatchObject({ checked: false, stages: { tracking: { status: 'busy' }, automation: { status: 'paused' } } });
  });
  it('reports parcel failures even when tracking resolves normally', async () => {
    const result = await scheduler(jest.fn().mockResolvedValue({ ...summary, failedCount: 1 }),
      jest.fn().mockResolvedValue({ status: 'paused' })).runNow();
    expect(result).toMatchObject({ checked: false, stages: { tracking: { status: 'partial', errors: ['1 个快递单号查询失败'] } } });
  });
  it('propagates task failures and skipped busy shops from an otherwise completed run', async () => {
    const result = await scheduler(jest.fn().mockResolvedValue(summary), jest.fn().mockResolvedValue({ status: 'completed', result: {
      alreadyRunning: false, lockedConnections: 1, shipping: { sent: 0, skipped: 0, failed: 1 }, mail: { sent: 0, failed: 0, blocked: 0 },
      connectionRuns: [{ errors: ['shop outage'] }],
    } })).runNow();
    expect(result).toMatchObject({ checked: false, stages: { automation: { status: 'partial', errors: expect.arrayContaining(['shop outage', '1 项回传或邮件任务失败', '1 个店铺正在执行其他任务']) } } });
  });
  it('preserves the real automation executor failure in its return value', async () => {
    const previous = process.env.RAKUTEN_RMS_AUTOMATION_SCHEDULED_PAUSED;
    let automation: RakutenRmsAutomationService;
    try {
      process.env.RAKUTEN_RMS_AUTOMATION_SCHEDULED_PAUSED = 'false';
      jest.isolateModules(() => {
        const Service = require('../src/rakuten-rms-api/rakuten-rms-automation.service').RakutenRmsAutomationService;
        automation = new Service({}, {}, {});
      });
    } finally {
      if (previous === undefined) delete process.env.RAKUTEN_RMS_AUTOMATION_SCHEDULED_PAUSED;
      else process.env.RAKUTEN_RMS_AUTOMATION_SCHEDULED_PAUSED = previous;
    }
    jest.spyOn(automation!, 'runAutomation').mockRejectedValue(new Error('DB unavailable'));
    await expect(automation!.runScheduledAutomation()).resolves.toEqual({ status: 'failed', error: 'DB unavailable' });
  });
});
