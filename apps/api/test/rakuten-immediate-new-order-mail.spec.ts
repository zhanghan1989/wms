import { RakutenRmsApiService } from '../src/rakuten-rms-api/rakuten-rms-api.service';

function automationClass(paused = false) {
  const name = 'RAKUTEN_RMS_AUTOMATION_SCHEDULED_PAUSED';
  const saved = process.env[name];
  let Class: any;
  try {
    process.env[name] = String(paused);
    jest.isolateModules(() => { Class = require('../src/rakuten-rms-api/rakuten-rms-automation.service').RakutenRmsAutomationService; });
  } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
  return Class;
}
function immediate(paused = false) {
  const connection = { id: 7n, status: 1, mailNotificationsEnabled: true, mailCircuitOpenedAt: null };
  const prisma = {
    rakutenRmsConnection: { findUnique: jest.fn().mockResolvedValue(connection) },
    rakutenOrderMail: { findMany: jest.fn().mockResolvedValue([{ id: 1n }]) },
    rakutenAutomationRun: { create: jest.fn().mockResolvedValue({ id: 9n }), update: jest.fn().mockResolvedValue({}) },
  };
  const service = new (automationClass(paused))(prisma, {}, {});
  const acquire = jest.spyOn(service, 'acquireConnectionLock').mockResolvedValue(true);
  jest.spyOn(service, 'startConnectionLockHeartbeat').mockReturnValue(undefined);
  const release = jest.spyOn(service, 'releaseConnectionLock').mockResolvedValue(undefined);
  const send = jest.spyOn(service, 'processMails').mockResolvedValue({ sent: 1, failed: 0, blocked: 0 });
  return { service, prisma, connection, acquire, release, send };
}
function importing(failSend = false) {
  const events: string[] = [];
  const tx = { $queryRaw: jest.fn().mockResolvedValue([]), rakutenRmsSyncRun: { update: jest.fn().mockResolvedValue({}) },
    rakutenRmsConnection: { update: jest.fn().mockResolvedValue({}) } };
  const prisma = { rakutenRmsSyncRun: { create: jest.fn().mockResolvedValue({ id: 11n, startedAt: new Date() }), update: jest.fn() },
    rakutenRmsConnection: { update: jest.fn() }, $transaction: jest.fn(async (cb: any) => {
      const result = await cb(tx); events.push('committed'); return result;
    }) };
  const send = jest.fn(async () => { events.push('new_order'); if (failSend) throw new Error('SMTP stage unavailable'); return { sent: 1, failed: 0, blocked: 0 }; });
  const automation = { enqueueNewOrderMails: jest.fn(async () => { events.push('queued'); }), sendImportedNewOrderMails: send };
  const service = new RakutenRmsApiService(prisma as any, {} as any, {} as any, automation as any);
  jest.spyOn(service as any, 'planOrderItem').mockResolvedValue({ action: 'create', item: {} });
  jest.spyOn(service as any, 'applyOrderPlan').mockResolvedValue({ action: 'created' });
  const connection = { id: 7n, licenseExpiresAt: null, mailNotificationsEnabled: true, shop: { name: '店铺' } };
  const input = { mappedItems: [{ orderId: 'ORDER' }, { orderId: 'ORDER' }], searchedOrderCount: 1, requestedOrderCount: 1, reconciledOrderCount: 0 };
  return { service, prisma, events, send, connection, input };
}

describe('immediate new-order mail after API import', () => {
  it.each([undefined, 'confirmed-preview'])('fires after commit for scheduled/manual imports: %s', async (previewToken) => {
    const { service, events, send, connection, input } = importing();
    if (previewToken) (service as any).prisma.$transaction.mockImplementation(async (cb: any) => {
      const tx = { $queryRaw: jest.fn(), rakutenRmsSyncPreview: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        rakutenRmsSyncRun: { update: jest.fn() }, rakutenRmsConnection: { update: jest.fn() } };
      const result = await cb(tx); events.push('committed'); return result;
    });
    const result = await (service as any).runSync(connection, { ...input, previewToken });
    expect(events).toEqual(['queued', 'committed', 'new_order']);
    expect(send).toHaveBeenCalledWith(7n, ['ORDER'], previewToken ? 'manual' : 'scheduled');
    expect(result.newOrderMail.sent).toBe(1);
  });
  it('keeps a committed import successful when the immediate mail stage fails', async () => {
    const { service, prisma, connection, input } = importing(true);
    const result = await (service as any).runSync(connection, input);
    expect(result).toMatchObject({ created: 2, newOrderMail: { deferred: true, error: 'SMTP stage unavailable' } });
    expect(prisma.rakutenRmsSyncRun.update).not.toHaveBeenCalled();
  });
  it('does not send if the import transaction fails', async () => {
    const { service, prisma, send, connection, input } = importing();
    prisma.$transaction.mockImplementation(async (cb: any) => {
      if (typeof cb !== 'function') return Promise.all(cb);
      throw new Error('commit failed');
    });
    await expect((service as any).runSync(connection, input)).rejects.toThrow('commit failed');
    expect(send).not.toHaveBeenCalled();
  });
  it('does not fire when syncing existing order rows', async () => {
    const { service, send, connection, input } = importing();
    (service as any).planOrderItem.mockResolvedValue({ action: 'update', item: {}, changedFields: [] });
    await (service as any).runSync(connection, input);
    expect(send).not.toHaveBeenCalled();
  });
  it('only selects imported new-order tasks, respects holds and retry times, and releases its lock', async () => {
    const { service, prisma, send, release } = immediate();
    expect(await service.sendImportedNewOrderMails(7n, ['ORDER', 'ORDER'], 'manual')).toMatchObject({ sent: 1 });
    const where = prisma.rakutenOrderMail.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ connectionId: 7n, orderId: { in: ['ORDER'] }, event: 'new_order' });
    expect(where.AND[0].OR[1].failureCategory.notIn).not.toContain('import_review');
    expect(where.OR[1].nextAttemptAt.lte).toBeInstanceOf(Date);
    expect(send).toHaveBeenCalledWith(7n, [1n]);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('handles every imported order beyond the first hundred in bounded batches', async () => {
    const { service, prisma, send } = immediate();
    await service.sendImportedNewOrderMails(7n, Array.from({ length: 205 }, (_, i) => `ORDER-${i}`), 'scheduled');
    expect(prisma.rakutenOrderMail.findMany.mock.calls.map((call) => call[0].where.orderId.in.length)).toEqual([100, 100, 5]);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('keeps import-triggered sending paused under the existing pause setting', async () => {
    const { service, acquire, send } = immediate(true);
    expect(await service.sendImportedNewOrderMails(7n, ['ORDER'], 'manual')).toMatchObject({ deferred: true });
    expect(acquire).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'circuit', 'busy'])('defers without sending when the shop is %s', async (condition) => {
    const { service, connection, acquire, send } = immediate();
    if (condition === 'disabled') connection.mailNotificationsEnabled = false;
    if (condition === 'circuit') connection.mailCircuitOpenedAt = new Date() as any;
    if (condition === 'busy') acquire.mockResolvedValue(false);
    expect(await service.sendImportedNewOrderMails(7n, ['ORDER'], 'scheduled')).toMatchObject({ deferred: true });
    expect(send).not.toHaveBeenCalled();
  });
  it('stops later batches if an SMTP failure opens the shop circuit', async () => {
    const { service, prisma, send, connection } = immediate();
    send.mockImplementation(async () => { connection.mailCircuitOpenedAt = new Date() as any; return { sent: 0, failed: 1, blocked: 0 }; });
    await service.sendImportedNewOrderMails(7n, Array.from({ length: 205 }, (_, i) => `ORDER-${i}`), 'scheduled');
    expect(prisma.rakutenOrderMail.findMany).toHaveBeenCalledTimes(1);
  });
  it('releases the lock when mail processing or run recording fails', async () => {
    const { service, send, release } = immediate();
    send.mockRejectedValue(new Error('execution failed'));
    await expect(service.sendImportedNewOrderMails(7n, ['ORDER'], 'manual')).rejects.toThrow('execution failed');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
