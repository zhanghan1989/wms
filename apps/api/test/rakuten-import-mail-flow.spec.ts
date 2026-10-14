import 'reflect-metadata';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { RakutenRmsApiService } from '../src/rakuten-rms-api/rakuten-rms-api.service';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';
import { RakutenOrderSchedulerService } from '../src/rakuten-rms-api/rakuten-order-scheduler.service';
import { buildOrderWorkflow } from '../src/rakuten-rms-api/rakuten-order-workflow';

const row = { id: 1n, rmsConnectionId: 7n, orderId: 'ORDER', sourceKind: 'rms_api', createdAt: new Date('2026-10-01T00:00:00Z'),
  productName: '商品', orderQuantity: 1, dispatchMode: 'japan', buyerEmail: 'buyer@example.jp', orderStatusText: '300', rawPayload: {} } as any;
const connection = { id: 7n, status: 1, mailNotificationsEnabled: true, autoShippingEnabled: true, shop: { name: '店铺' } } as any;

function sender(progress: unknown = 300, overrides: Record<string, unknown> = {}) {
  const mail = { id: 1n, connectionId: 7n, orderId: 'ORDER', event: 'new_order', status: 'pending', attempts: 0, connection, ...overrides } as any;
  const update = jest.fn().mockResolvedValue({});
  const prisma = { rakutenOrderMail: { findMany: jest.fn().mockResolvedValue([mail]), update, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([row]) },
    rakutenMailTemplateVersion: { findFirst: jest.fn().mockResolvedValue({ subjectTemplate: '件名', bodyTemplate: '本文' }) } } as any;
  const getOrders = jest.fn().mockResolvedValue([{ orderNumber: 'ORDER', orderProgress: progress }]);
  const service = new RakutenRmsAutomationService(prisma, { getOrders } as any, {} as any);
  jest.spyOn(service as any, 'decryptApiCredentials').mockReturnValue({ serviceSecret: 'test', licenseKey: 'test' });
  jest.spyOn(service as any, 'decryptSmtpCredentials').mockReturnValue({ fromAddress: 'shop@example.jp', fromName: '店铺', bccAddresses: [] });
  const sendMail = jest.fn().mockResolvedValue({ accepted: ['buyer@example.jp'] });
  jest.spyOn(service as any, 'createSmtpTransport').mockReturnValue({ sendMail, close: jest.fn() });
  return { service, mail, prisma, update, getOrders, sendMail };
}

function scheduleControl(enabled = true): any {
  return { enabled: jest.fn().mockResolvedValue(enabled), execute: jest.fn((_key, action) => enabled ? action() : Promise.resolve(undefined)) };
}

describe('unified import and new-order mail flow', () => {
  it('waits for import and its immediate new-order phase before tracking and follow-up mail', async () => {
    const calls: string[] = [];
    let commit!: () => void;
    const api = { runScheduledSync: jest.fn(() => new Promise<void>((resolve) => { commit = () => { calls.push('import'); calls.push('new_order'); resolve(); }; })) };
    const orders = { syncRakutenTrackingStatuses: jest.fn(async () => { calls.push('tracking'); return {}; }) };
    const automation = { runScheduledAutomation: jest.fn(async () => { calls.push('outbound'); }) };
    const scheduler = new RakutenOrderSchedulerService(orders as any, automation as any, api as any, scheduleControl());
    const running = scheduler.runScheduledOrderProcessing();
    expect(orders.syncRakutenTrackingStatuses).not.toHaveBeenCalled();
    await expect(scheduler.runNow()).rejects.toThrow('正在执行');
    commit(); await running;
    expect(calls).toEqual(['import', 'new_order', 'tracking', 'outbound', 'outbound']);
    expect(Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, RakutenRmsApiService.prototype.runScheduledSync)).toBeUndefined();
  });
  it('uses the same stages for manual checks and keeps existing tasks running after import failure', async () => {
    const api = { syncAllConnections: jest.fn().mockRejectedValue(new Error('unavailable')) };
    const orders = { syncRakutenTrackingStatuses: jest.fn().mockResolvedValue({}) };
    const automation = { runScheduledAutomation: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new RakutenOrderSchedulerService(orders as any, automation as any, api as any, scheduleControl());
    const result = await scheduler.runNow();
    expect(result).toMatchObject({ imported: { error: 'unavailable' }, checked: false, stages: { import: { status: 'failed' } } });
    expect(orders.syncRakutenTrackingStatuses).toHaveBeenCalledTimes(1);
    expect(automation.runScheduledAutomation).toHaveBeenCalledTimes(2);
    await scheduler.runNow(); // the lock is released after a failed stage
    expect(api.syncAllConnections).toHaveBeenCalledTimes(2);
  });
  it.each([null, new Date(Date.now() - 41 * 60_000), new Date()])('does not impose content review based on initial/recovery import timing: %s', async (lastOrdersSyncedAt) => {
    const service = new RakutenRmsApiService({ rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([{ ...connection, lastOrdersSyncedAt }]) } } as any, {} as any, {} as any);
    jest.spyOn(service as any, 'fetchSyncItems').mockResolvedValue({ mappedItems: [] });
    const run = jest.spyOn(service as any, 'runSync').mockResolvedValue({});
    await service.syncAllConnections();
    expect(run).toHaveBeenCalledWith(expect.anything(), { mappedItems: [] });
  });
  it.each([true, false])('records new-order tasks during import even when notificationsEnabled=%s', async (enabled) => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]), rakutenRmsSyncRun: { update: jest.fn().mockResolvedValue({}) }, rakutenRmsConnection: { update: jest.fn().mockResolvedValue({}) } };
    const prisma = { rakutenRmsSyncRun: { create: jest.fn().mockResolvedValue({ id: 1n, startedAt: new Date() }) },
      $transaction: jest.fn(async (callback: any) => callback(tx)) } as any;
    const enqueueNewOrderMails = jest.fn().mockResolvedValue(undefined);
    const service = new RakutenRmsApiService(prisma, {} as any, {} as any, { enqueueNewOrderMails, sendImportedNewOrderMails: jest.fn().mockResolvedValue({ sent: 0 }) } as any);
    jest.spyOn(service as any, 'planOrderItem').mockResolvedValue({ action: 'create', item: row });
    jest.spyOn(service as any, 'applyOrderPlan').mockResolvedValue({ action: 'created' });
    await (service as any).runSync({ ...connection, mailNotificationsEnabled: enabled, licenseExpiresAt: null }, { mappedItems: [row], searchedOrderCount: 1, reconciledOrderCount: 0, requestedOrderCount: 1 });
    expect(enqueueNewOrderMails).toHaveBeenCalledWith(tx, 7n, new Set(['ORDER']));
  });
  it('records a unique ordinary task without changing existing tasks on reimport', async () => {
    const createMany = jest.fn().mockResolvedValue({});
    const db = { rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([row]) }, rakutenOrderMail: { createMany } } as any;
    const service = new RakutenRmsAutomationService({} as any, {} as any, {} as any);
    await service.enqueueNewOrderMails(db, 7n, ['ORDER', 'ORDER']);
    expect(createMany).toHaveBeenCalledWith({ data: [{ connectionId: 7n, orderId: 'ORDER', event: 'new_order' }], skipDuplicates: true });
  });
  it('does not create a content-review requirement after notification is re-enabled', () => {
    const mail = { id: 1n, event: 'new_order', status: 'pending', resolutionNote: null } as any;
    const flow = buildOrderWorkflow({ rows: [row], connection, report: null, mails: [mail], templateVersions: new Map([['new_order', 1]]) });
    expect(flow.steps[0]).toMatchObject({ state: 'ready', executable: true, requiresManualReview: false, manualReviewReason: null });
    expect(flow.steps[0].reason).toBeNull();
  });
  it('sends a regular new-order mail with no tracking number after live verification', async () => {
    const { service, sendMail, getOrders } = sender();
    expect(await (service as any).processMails(7n)).toEqual({ sent: 1, failed: 0, blocked: 0 });
    expect(getOrders).toHaveBeenCalledWith('test', 'test', ['ORDER']);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(getOrders.mock.invocationCallOrder[0]).toBeLessThan(sendMail.mock.invocationCallOrder[0]);
  });
  it.each([800, 900, 400, null, 'unknown'])('prevents stale new-order mail for live status %s', async (progress) => {
    const { service, sendMail, update } = sender(progress);
    expect(await (service as any).processMails(7n)).toEqual({ sent: 0, failed: 0, blocked: 1 });
    expect(sendMail).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'dead_letter', failureCategory: 'order_changed' }) }));
  });
  it.each(['error', 'unknown_error', 'missing', 'wrong_order', 'missing_id'])('does not send or consume SMTP attempts when verification is %s', async (condition) => {
    const { service, getOrders, sendMail, update } = sender();
    if (condition === 'error') getOrders.mockRejectedValue(new Error('timeout'));
    else if (condition === 'unknown_error') getOrders.mockRejectedValue(new Error('unexpected result'));
    else getOrders.mockResolvedValue(condition === 'missing' ? [] : condition === 'missing_id' ? [{ orderProgress: 300 }] : [{ orderNumber: 'OTHER', orderProgress: 300 }]);
    await (service as any).processMails(7n);
    expect(sendMail).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: condition === 'error' ? 'pending' : 'dead_letter', attempts: { decrement: 1 },
      failureCategory: condition === 'error' ? 'live_check' : 'order_changed',
      nextAttemptAt: condition === 'error' ? expect.any(Date) : null,
    }) }));
  });
  it('keeps a shop paused when one mail is retried', async () => {
    const connectionUpdate = jest.fn();
    const mail = { id: 1n, connectionId: 7n, status: 'dead_letter', event: 'new_order' };
    const prisma = { rakutenOrderMail: { findUnique: jest.fn().mockResolvedValue(mail), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      rakutenRmsConnection: { update: connectionUpdate }, $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)) } as any;
    const service = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(service as any, 'assertOrderNotDeleted').mockResolvedValue(undefined);
    await service.retryMail('1', 9n);
    expect(connectionUpdate).not.toHaveBeenCalled();
  });

  it('automatically sends fixed new-order acknowledgement despite product edits and unresolved product-change reminders', async () => {
    const { service, prisma, sendMail } = sender();
    prisma.rakutenOrderRecord.findMany.mockResolvedValue([{ ...row, rmsManualOverrideAt: new Date(),
      orderRemark: '内部の商品交換メモ', orderQuantity: 99, isComboOrder: true,
      rmsManualActionDetectedAt: new Date(), rmsManualActionResolvedAt: null }]);
    expect(await (service as any).processMails(7n)).toMatchObject({ sent: 1, blocked: 0 });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
  it('keeps new-order preview stable after product changes but detects a recipient change', () => {
    const { service } = sender();
    const original = (service as any).mailOrderFingerprint([row], 'new_order');
    expect((service as any).mailOrderFingerprint([{ ...row, productName: '変更', orderQuantity: 5, shipmentNo: 'NEW' }], 'new_order')).toBe(original);
    expect((service as any).mailOrderFingerprint([{ ...row, buyerEmail: 'changed@example.jp' }], 'new_order')).not.toBe(original);
  });
  it('rejects product variables in new-order templates instead of silently rendering them', async () => {
    const { service, prisma, sendMail, update } = sender();
    prisma.rakutenMailTemplateVersion.findFirst.mockResolvedValue({ subjectTemplate: '件名', bodyTemplate: '{{order_summary}}' });
    expect(await (service as any).processMails(7n)).toMatchObject({ blocked: 1, sent: 0 });
    expect(sendMail).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failureCategory: 'template_missing', lastError: expect.stringContaining('order_summary') }) }));
    expect(() => (service as any).validateMailTemplate({ subjectTemplate: '受理', bodyTemplate: '{{japan_items}}' }, 'new_order')).toThrow('不支持');
  });
  it('stops a pending Japan mail when its prerequisite was cancelled instead of repeatedly waiting', async () => {
    const { service, mail, prisma, update, sendMail } = sender();
    mail.event = 'japan_shipped';
    prisma.rakutenOrderMail.findUnique = jest.fn().mockResolvedValue({ status: 'cancelled', resolutionNote: '用户取消邮件' });
    await (service as any).processMails(7n);
    expect(sendMail).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled', nextAttemptAt: null }) }));
  });
  it('requires an identified live order and treats missing progress as unknown', () => {
    const { service } = sender();
    expect((service as any).resolveCurrentOrder([{ orderProgress: 300 }], 'ORDER')).toBeNull();
    expect((service as any).resolveCurrentOrder([{ orderNumber: 'OTHER', orderProgress: 300 }], 'ORDER')).toBeNull();
    for (const value of [undefined, null, '']) expect((service as any).resolveOrderProgress({ orderProgress: value })).toBeNull();
  });

});

// These unit fixtures bypass orchestration; lock ownership is tested separately.
beforeEach(() => {
  jest.spyOn(RakutenRmsAutomationService.prototype as any, "assertExecutionLock").mockResolvedValue(undefined);
  jest.spyOn(RakutenRmsAutomationService.prototype as any, "shippingPrerequisiteSatisfied").mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe('final mail safeguards', () => {
  it('does not mark a BCC-only acceptance as buyer delivery', async () => {
    const { service, sendMail, update } = sender();
    sendMail.mockResolvedValue({ accepted: ['archive@example.jp'], rejected: ['buyer@example.jp'] });
    expect(await (service as any).processMails(7n)).toMatchObject({ sent: 0, failed: 0, blocked: 1 });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'uncertain', nextAttemptAt: null }) }));
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'sent' }) }));
  });
  it('rechecks deletion after claiming and never connects SMTP for a deleted row', async () => {
    const { service, prisma, sendMail } = sender();
    prisma.rakutenOrderRecord.findMany.mockResolvedValueOnce([row]).mockResolvedValue([{ ...row, deletedAt: new Date() }]);
    expect(await (service as any).processMails(7n)).toMatchObject({ sent: 0, blocked: 1 });
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('per-order failure isolation and template cleanup', () => {
  it('continues with the next mail after an order read fails', async () => {
    const { service, prisma, sendMail } = sender();
    const first = (await prisma.rakutenOrderMail.findMany())[0];
    prisma.rakutenOrderMail.findMany.mockResolvedValue([first, { ...first, id: 2n }]);
    prisma.rakutenOrderRecord.findMany.mockRejectedValueOnce(new Error('temporary DB failure')).mockResolvedValue([row]);
    expect(await (service as any).processMails(7n)).toMatchObject({ sent: 1, failed: 1 });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
  it('rejects contradictory stored templates during validation', () => {
    const { service } = sender();
    for (const event of ['japan_shipped', 'china_customs', 'mixed_customs']) {
      expect(() => (service as any).validateMailTemplate({ subjectTemplate: '件名', bodyTemplate: '本日発送' }, event)).toThrow('旧発送');
    }
    expect(() => (service as any).validateMailTemplate({ subjectTemplate: '件名', bodyTemplate: '最短お届け日を設定' }, 'china_customs')).toThrow('旧発送');
  });
});
