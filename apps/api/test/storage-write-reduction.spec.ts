import { nextTrackingCheck } from '../src/orders/rakuten-tracking-checks';
import { RakutenRmsApiService } from '../src/rakuten-rms-api/rakuten-rms-api.service';

describe('storage write reduction', () => {
  it('bounds failures, retries moving parcels promptly, and revisits incomplete delivered parcels', () => {
    const now = new Date('2026-10-28T00:00:00Z');
    const delay = (status: any, failures: number) => (nextTrackingCheck(status, failures, now).getTime() - now.getTime()) / 60000;
    expect(delay({ error: 'offline', isDelivered: false }, 1)).toBe(20);
    expect(delay({ error: 'offline', isDelivered: false }, 2)).toBe(40);
    expect(delay({ error: 'offline', isDelivered: false }, 1000)).toBe(1440);
    expect(delay({ error: null, isDelivered: false }, 0)).toBe(20);
    expect(delay({ error: null, isDelivered: true }, 0)).toBe(1440);
  });

  it('ignores reordered JSON keys without ignoring array order or real payload changes', async () => {
    const api = new RakutenRmsApiService({} as any, {} as any, {} as any) as any;
    const existing = { id: 7n, orderQuantity: 1, rawPayload: { a: 1, nested: { z: [1, 2], b: true } } };
    const update = jest.fn();
    const db = { rakutenOrderRecord: { update } };
    api.buildOrderWriteData = jest.fn().mockResolvedValue({ orderQuantity: 1,
      rawPayload: { nested: { b: true, z: [1, 2] }, a: 1 }, rmsLastSyncedAt: new Date() });
    expect(await api.applyOrderPlan(db, {}, { existing, item: {} }, new Date())).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(api.comparableValue({ a: [1, 2] })).not.toBe(api.comparableValue({ a: [2, 1] }));
    expect(api.comparableValue({ a: 1 })).not.toBe(api.comparableValue({ a: 2 }));
  });

  it('does not rewrite an already-observed manual-action payload solely to refresh its timestamp', async () => {
    const api = new RakutenRmsApiService({} as any, {} as any, {} as any) as any;
    const update = jest.fn();
    await api.recordXiyaManualAction({ rakutenOrderRecord: { update } }, {
      existing: { rmsManualActionObservedHash: 'same' }, manualActionType: 'update', observedHash: 'same',
    }, new Date());
    expect(update).not.toHaveBeenCalled();
  });
});
