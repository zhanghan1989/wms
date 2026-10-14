import { BadRequestException } from '@nestjs/common';
import { RakutenAutomationRunTrigger } from '@prisma/client';
import { RakutenScheduleControlService } from '../src/rakuten-rms-api/rakuten-schedule-control.service';
import { RakutenOrderSchedulerService } from '../src/rakuten-rms-api/rakuten-order-scheduler.service';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';

function fixture() {
  const rows = new Map<string, any>();
  const table = {
    upsert: jest.fn(async ({ where, create, update }) => {
      const row = rows.get(where.key) ?? { runToken: null, heartbeatAt: null, startedAt: null, finishedAt: null, lastStatus: null, lastMessage: null, ...create };
      Object.assign(row, rows.has(where.key) ? update : {});
      rows.set(where.key, row);
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const row = rows.get(where.key);
      if (!row || where.enabled !== undefined && row.enabled !== where.enabled || where.runToken !== undefined && row.runToken !== where.runToken) return { count: 0 };
      if (where.OR && row.runToken !== null && !(row.heartbeatAt < where.OR[1].heartbeatAt.lt)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const nextDate = jest.fn(() => ({ toJSDate: () => new Date('2026-10-14T00:20:00Z') }));
  const job = { isActive: true, nextDate };
  const registry = { getCronJobs: () => new Map([['rakuten-order-processing', job]]) };
  const prisma = { rakutenScheduleControl: table };
  const service = new RakutenScheduleControlService(prisma as any, registry as any);
  return { service, rows, table, prisma, registry, job, nextDate };
}
const success = () => ({ status: 'success' as const, errors: [] });

describe('persistent Rakuten schedule controls', () => {
  it('preserves enabled tracking by default and returns the actual timer next date only for enabled tasks', async () => {
    const f = fixture();
    const initial = await f.service.status();
    expect(initial.tasks).toHaveLength(4);
    expect(initial.tasks.filter((row) => row.key !== 'tracking').every((row) => !row.enabled && row.status === 'paused' && row.nextRunAt === null)).toBe(true);
    expect(initial.tasks.find((row) => row.key === 'tracking')).toMatchObject({ enabled: true, status: 'waiting', nextRunAt: '2026-10-14T00:20:00.000Z' });
    const changed = await f.service.update('shipping', true);
    expect(changed.tasks.find((row) => row.key === 'shipping')).toMatchObject({ enabled: true, status: 'waiting', nextRunAt: '2026-10-14T00:20:00.000Z' });
    expect(changed.tasks.filter((row) => !['shipping', 'tracking'].includes(row.key)).every((row) => !row.enabled)).toBe(true);
    f.job.isActive = false;
    expect((await f.service.status()).tasks.every((row) => row.nextRunAt === null)).toBe(true);
    expect((await f.service.status()).tasks.find((row) => row.key === 'shipping')?.status).toBe('stopped');
  });
  it('keeps independently saved choices when the service restarts', async () => {
    const f = fixture();
    await f.service.update('mail', true);
    const restarted = new RakutenScheduleControlService(f.prisma as any, f.registry as any);
    expect(await restarted.enabled('mail')).toBe(true);
    expect(await restarted.enabled('import')).toBe(false);
    await f.service.update('tracking', false);
    expect(await restarted.enabled('tracking')).toBe(false);
  });
  it('does not execute a disabled task', async () => {
    const f = fixture(); const action = jest.fn();
    expect(await f.service.execute('import', action, success)).toBeUndefined();
    expect(action).not.toHaveBeenCalled();
  });
  it('shows a running task immediately, prevents overlapping runs, and lets an active run finish after disabling', async () => {
    const f = fixture(); await f.service.update('shipping', true);
    let finish!: () => void;
    const running = f.service.execute('shipping', () => new Promise<void>((resolve) => { finish = resolve; }), success);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await f.service.status()).tasks.find((row) => row.key === 'shipping')).toMatchObject({ status: 'running' });
    const second = jest.fn();
    await f.service.execute('shipping', second, success);
    expect(second).not.toHaveBeenCalled();
    const disabled = await f.service.update('shipping', false);
    expect(disabled.tasks.find((row) => row.key === 'shipping')).toMatchObject({ status: 'running', enabled: false, nextRunAt: null });
    finish(); await running;
    expect((await f.service.status()).tasks.find((row) => row.key === 'shipping')).toMatchObject({ status: 'paused', lastStatus: 'success' });
  });
  it('persists failures and releases the task so the next round can retry', async () => {
    const f = fixture(); await f.service.update('import', true);
    await expect(f.service.execute('import', async () => { throw new Error('RMS unavailable'); }, success)).rejects.toThrow('RMS unavailable');
    expect(f.rows.get('import')).toMatchObject({ runToken: null, lastStatus: 'failed', lastMessage: 'RMS unavailable' });
    await f.service.execute('import', async () => 'retried', success);
    expect(f.rows.get('import').lastStatus).toBe('success');
  });
  it('detects stale interrupted execution and recovers it in the next round', async () => {
    const f = fixture(); await f.service.update('mail', true);
    Object.assign(f.rows.get('mail'), { runToken: 'old', heartbeatAt: new Date(Date.now() - 31 * 60_000) });
    expect((await f.service.status()).tasks.find((row) => row.key === 'mail')).toMatchObject({ status: 'interrupted', lastStatus: 'interrupted' });
    await f.service.execute('mail', async () => 'recovered', success);
    expect(f.rows.get('mail')).toMatchObject({ runToken: null, lastStatus: 'success' });
  });
  it('rejects unknown tasks and non-boolean switch values', async () => {
    const f = fixture();
    await expect(f.service.update('unknown', true)).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.service.update('mail', 'false' as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('independent scheduled stages', () => {
  it.each(['import', 'tracking', 'shipping', 'mail'] as const)('only starts the independently enabled %s stage', async (enabled) => {
    const f = fixture(); await f.service.update('tracking', false); await f.service.update(enabled, true);
    const api = { runScheduledSync: jest.fn().mockResolvedValue({ results: [] }) };
    const orders = { syncRakutenTrackingStatuses: jest.fn().mockResolvedValue({ failedCount: 0 }) };
    const automation = { runScheduledAutomation: jest.fn().mockResolvedValue({ status: 'completed' }) };
    await new RakutenOrderSchedulerService(orders as any, automation as any, api as any, f.service).runScheduledOrderProcessing();
    expect(orders.syncRakutenTrackingStatuses).toHaveBeenCalledTimes(enabled === 'tracking' ? 1 : 0);
    expect(api.runScheduledSync).toHaveBeenCalledTimes(enabled === 'import' ? 1 : 0);
    expect(automation.runScheduledAutomation).toHaveBeenCalledTimes(['import', 'tracking'].includes(enabled) ? 0 : 1);
    if (enabled === 'shipping' || enabled === 'mail') expect(automation.runScheduledAutomation).toHaveBeenCalledWith(RakutenAutomationRunTrigger.scheduled, enabled);
  });
  it('persists tracking failures while still running enabled shipping and mail stages', async () => {
    const f = fixture();
    await f.service.update('shipping', true); await f.service.update('mail', true);
    const orders = { syncRakutenTrackingStatuses: jest.fn().mockResolvedValue({ trackingNoCount: 3, failedCount: 1 }) };
    const automation = { runScheduledAutomation: jest.fn().mockResolvedValue({ status: 'completed' }) };
    const scheduler = new RakutenOrderSchedulerService(orders as any, automation as any, {} as any, f.service);
    const result = await scheduler.runNow();
    expect(result).toMatchObject({ stages: { tracking: { status: 'partial', errors: ['1 个快递单号查询失败'] } } });
    expect(f.rows.get('tracking')).toMatchObject({ lastStatus: 'partial', lastMessage: '1 个快递单号查询失败', runToken: null });
    expect(automation.runScheduledAutomation).toHaveBeenCalledTimes(2);
  });
  it('keeps tracking running through an in-flight disable and pauses the next round', async () => {
    const f = fixture();
    let finish!: (value: any) => void;
    const orders = { syncRakutenTrackingStatuses: jest.fn(() => new Promise<any>((resolve) => { finish = resolve; })) };
    const scheduler = new RakutenOrderSchedulerService(orders as any, {} as any, {} as any, f.service);
    const running = scheduler.runNow();
    await new Promise((resolve) => setImmediate(resolve));
    const disabled = await f.service.update('tracking', false);
    expect(disabled.tasks.find((row) => row.key === 'tracking')).toMatchObject({ enabled: false, status: 'running', nextRunAt: null });
    finish({ trackingNoCount: 2, failedCount: 0 }); await running;
    expect((await f.service.status()).tasks.find((row) => row.key === 'tracking')).toMatchObject({ status: 'paused', lastStatus: 'success' });
    const result = await scheduler.runNow();
    expect(result).toMatchObject({ stages: { tracking: { status: 'paused' } } });
    expect(orders.syncRakutenTrackingStatuses).toHaveBeenCalledTimes(1);
  });
  it.each(['shipping', 'mail'] as const)('%s phase does not execute the other outbound phase', async (stage) => {
    const connection = { id: 7n, shop: { name: 'shop' }, autoShippingEnabled: true, mailNotificationsEnabled: true };
    const prisma = { rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([connection]) }, rakutenAutomationRun: { create: jest.fn().mockResolvedValue({ id: 1n }), update: jest.fn().mockResolvedValue({}) } };
    const service = new RakutenRmsAutomationService(prisma as any, {} as any, {} as any);
    jest.spyOn(service as any, 'recoverStaleJobs').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'acquireConnectionLock').mockResolvedValue(true);
    jest.spyOn(service as any, 'startConnectionLockHeartbeat').mockReturnValue(undefined);
    jest.spyOn(service as any, 'releaseConnectionLock').mockResolvedValue(undefined);
    const shipping = jest.spyOn(service as any, 'prepareShippingReports').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'processShippingReports').mockResolvedValue({ sent: 0, skipped: 0, failed: 0 });
    const mail = jest.spyOn(service as any, 'prepareTrackingMails').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'prepareCustomsMails').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'refreshMailHolds').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'processMails').mockResolvedValue({ sent: 0, failed: 0, blocked: 0 });
    await service.runScheduledAutomation(RakutenAutomationRunTrigger.scheduled, stage);
    expect(shipping).toHaveBeenCalledTimes(stage === 'shipping' ? 1 : 0);
    expect(mail).toHaveBeenCalledTimes(stage === 'mail' ? 1 : 0);
  });
  it('keeps imported new-order mails queued while the mail switch is off', async () => {
    const f = fixture();
    const client = { getOrders: jest.fn() };
    const service = new RakutenRmsAutomationService(f.prisma as any, client as any, {} as any, undefined, f.service);
    expect(await service.sendImportedNewOrderMails(7n, ['ORDER'], RakutenAutomationRunTrigger.scheduled)).toMatchObject({ deferred: true, sent: 0 });
    expect(client.getOrders).not.toHaveBeenCalled();
  });
  it('enables imported new-order mail processing independently of the legacy paused default', async () => {
    const f = fixture(); await f.service.update('mail', true);
    const service = new RakutenRmsAutomationService(f.prisma as any, {} as any, {} as any, undefined, f.service);
    const send = jest.spyOn(service as any, 'sendImportedNewOrderMailsNow').mockResolvedValue({ sent: 1, failed: 0, blocked: 0 });
    expect(await service.sendImportedNewOrderMails(7n, ['ORDER'], RakutenAutomationRunTrigger.scheduled)).toMatchObject({ sent: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.rows.get('mail')).toMatchObject({ lastStatus: 'success', runToken: null });
  });
});
