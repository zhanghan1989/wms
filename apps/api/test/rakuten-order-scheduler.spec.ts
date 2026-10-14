import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { OrdersService } from '../src/orders/orders.service';
import { RakutenOrderSchedulerService } from '../src/rakuten-rms-api/rakuten-order-scheduler.service';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';

const summary = { trackingNoCount: 2, customsClearanceCount: 1, failedCount: 0 };

function scheduleControl(enabled = true): any {
  return { enabled: jest.fn((key) => Promise.resolve(key === 'tracking' || enabled)), execute: jest.fn((key, action) => key === 'tracking' || enabled ? action() : Promise.resolve(undefined)) };
}

describe('Rakuten twenty-minute order scheduler', () => {
  it('waits for tracking persistence before checking orders in the same round', async () => {
    let finishTracking!: (value: typeof summary) => void;
    const orders = { syncRakutenTrackingStatuses: jest.fn(() => new Promise<typeof summary>((resolve) => { finishTracking = resolve; })) };
    const automation = { runScheduledAutomation: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new RakutenOrderSchedulerService(orders as any, automation as any, { runScheduledSync: jest.fn().mockResolvedValue(undefined) } as any, scheduleControl());
    const running = scheduler.runScheduledOrderProcessing();
    await new Promise((resolve) => setImmediate(resolve));
    expect(orders.syncRakutenTrackingStatuses).toHaveBeenCalledTimes(1);
    expect(automation.runScheduledAutomation).not.toHaveBeenCalled();
    finishTracking(summary);
    await running;
    expect(automation.runScheduledAutomation).toHaveBeenCalledTimes(2);
  });
  it.each([new Error('tracking provider unavailable'), new ConflictException('tracking already running')])(
    'continues order processing using saved data after a tracking failure: %s', async (error) => {
      const orders = { syncRakutenTrackingStatuses: jest.fn().mockRejectedValue(error) };
      const automation = { runScheduledAutomation: jest.fn().mockResolvedValue(undefined) };
      const scheduler = new RakutenOrderSchedulerService(orders as any, automation as any, { runScheduledSync: jest.fn().mockResolvedValue(undefined) } as any, scheduleControl());
      await expect(scheduler.runScheduledOrderProcessing()).resolves.toBeUndefined();
      expect(automation.runScheduledAutomation).toHaveBeenCalledTimes(2);
    },
  );
  it('keeps tracking active while outbound automation is paused', async () => {
    const orders = { syncRakutenTrackingStatuses: jest.fn().mockResolvedValue(summary) };
    const automation = new RakutenRmsAutomationService({} as any, {} as any, {} as any);
    const runAutomation = jest.spyOn(automation, 'runAutomation');
    await new RakutenOrderSchedulerService(orders as any, automation, { runScheduledSync: jest.fn().mockResolvedValue(undefined) } as any, scheduleControl(false)).runScheduledOrderProcessing();
    expect(orders.syncRakutenTrackingStatuses).toHaveBeenCalledTimes(1);
    expect(runAutomation).not.toHaveBeenCalled();
  });
  it('registers one twenty-minute Tokyo schedule with overlap prevention', () => {
    const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, RakutenOrderSchedulerService.prototype.runScheduledOrderProcessing);
    expect(options).toMatchObject({ cronTime: '0 */20 * * * *', timeZone: 'Asia/Tokyo', waitForCompletion: true });
    expect(Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, RakutenRmsAutomationService.prototype.runScheduledAutomation)).toBeUndefined();
    expect((OrdersService.prototype as any).runScheduledRakutenTrackingStatusSync).toBeUndefined();
  });
});

describe('Rakuten tracking candidate selection', () => {
  afterEach(() => jest.restoreAllMocks());

  it('includes incomplete delivered parcels and errors, deduplicates, and retains bounded oldest-first selection', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new OrdersService({ rakutenOrderRecord: { findMany },
      rakutenTrackingQueryIgnore: { findMany: jest.fn().mockResolvedValue([]) } } as any);
    jest.spyOn(service as any, 'acquireRakutenTrackingSyncLock').mockResolvedValue(true);
    jest.spyOn(service as any, 'startRakutenTrackingSyncLockHeartbeat').mockReturnValue(undefined);
    const release = jest.spyOn(service as any, 'releaseRakutenTrackingSyncLock').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'refreshRakutenTrackingStatusesForRows').mockResolvedValue(new Map());
    jest.spyOn(service, 'getRakutenTrackingStatusSummary').mockResolvedValue({ latestCheckedAt: null, pendingTrackingNoCount: 0, uncheckedTrackingNoCount: 0 });
    await service.syncRakutenTrackingStatuses();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        shipmentNo: { not: null, notIn: [''] },
        OR: [ { trackingIsDelivered: false }, { trackingHasCustomsClearance: false },
          { trackingCustomsClearanceDate: null }, { trackingError: { not: null } } ],
      }),
      distinct: ['shipmentNo'], orderBy: [{ trackingCheckedAt: 'asc' }, { shipmentNoRegisteredAt: 'desc' }, { id: 'desc' }],
      take: 500,
    }));
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not requery a delivered parcel with complete clearance information', async () => {
    const service = new OrdersService({} as any);
    const fetchStatus = jest.spyOn(service as any, 'fetchUofTrackingClearanceStatus');
    await (service as any).refreshRakutenTrackingStatusesForRows([{
      shipmentNo: 'COMPLETE', trackingIsDelivered: true, trackingHasCustomsClearance: true,
      trackingCustomsClearanceDate: new Date('2026-10-12T00:00:00Z'), trackingError: null,
    }]);
    expect(fetchStatus).not.toHaveBeenCalled();
  });
  it.each([
    { trackingCustomsClearanceDate: null, trackingHasCustomsClearance: true, trackingError: null },
    { trackingCustomsClearanceDate: new Date('2026-10-12T00:00:00Z'), trackingHasCustomsClearance: true, trackingError: 'query failed' },
    { trackingCustomsClearanceDate: new Date('2026-10-12T00:00:00Z'), trackingHasCustomsClearance: false, trackingError: null },
  ])('requeries delivered parcels when required data is incomplete or erroneous: %j', async (fields) => {
    const service = new OrdersService({} as any);
    const fetchStatus = jest.spyOn(service as any, 'fetchUofTrackingClearanceStatus').mockResolvedValue({
      trackingNo: 'RECHECK', label: '配達完了', hasCustomsClearance: true, isDelivered: true,
      customsClearanceDate: '2026-10-12', error: null,
    });
    jest.spyOn(service as any, 'persistRakutenTrackingStatus').mockResolvedValue(undefined);
    await (service as any).refreshRakutenTrackingStatusesForRows([{ shipmentNo: 'RECHECK', trackingIsDelivered: true, ...fields }]);
    expect(fetchStatus).toHaveBeenCalledWith('RECHECK');
  });
});
