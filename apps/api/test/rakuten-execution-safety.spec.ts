import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';

describe('execution ownership and recovery', () => {
  it('stops when ownership is absent or taken over', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const service = new RakutenRmsAutomationService({ rakutenRmsConnection: { updateMany } } as any, {} as any, {} as any) as any;
    await expect(service.assertExecutionLock(7n)).rejects.toThrow('执行锁');
    service.ownedLocks.set(7n, { token: 'old', lost: false });
    await expect(service.assertExecutionLock(7n)).rejects.toThrow('执行锁');
    expect(service.ownedLocks.get(7n).lost).toBe(true);
    const calls = updateMany.mock.calls.length;
    await expect(service.assertExecutionLock(7n)).rejects.toThrow('执行锁');
    expect(updateMany).toHaveBeenCalledTimes(calls);
  });
  it('renews only its own token before continuing', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new RakutenRmsAutomationService({ rakutenRmsConnection: { updateMany } } as any, {} as any, {} as any) as any;
    service.ownedLocks.set(7n, { token: 'mine', lost: false });
    await service.assertExecutionLock(7n);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7n, automationLockToken: 'mine' } }));
  });
  it('requires completed or explicitly ignored new-order mail before return', async () => {
    const findUnique = jest.fn().mockResolvedValue({ status: 'pending' });
    const service = new RakutenRmsAutomationService({ rakutenOrderMail: { findUnique } } as any, {} as any, {} as any) as any;
    expect(await service.shippingPrerequisiteSatisfied(7n, 'ORDER')).toBe(false);
    findUnique.mockResolvedValue({ status: 'sent' });
    expect(await service.shippingPrerequisiteSatisfied(7n, 'ORDER')).toBe(true);
    findUnique.mockResolvedValue({ status: 'cancelled', resolutionNote: '用户人工忽略邮件' });
    expect(await service.shippingPrerequisiteSatisfied(7n, 'ORDER')).toBe(true);
    findUnique.mockResolvedValue({ status: 'cancelled' });
    expect(await service.shippingPrerequisiteSatisfied(7n, 'ORDER')).toBe(false);
  });
  it('recovers old runs and jobs only when the owner is disconnected', async () => {
    const job = { updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
    const runs = { updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
    const service = new RakutenRmsAutomationService({ rakutenOrderShippingReport: job, rakutenOrderMail: job,
      rakutenAutomationRun: runs, rakutenRmsConnection: { updateMany: jest.fn() }, $transaction: jest.fn() } as any, {} as any, {} as any) as any;
    await service.recoverStaleJobs();
    for (const call of [...job.updateMany.mock.calls, ...runs.updateMany.mock.calls]) {
      expect(call[0].where.connection.OR).toEqual(expect.arrayContaining([{ automationLockToken: null }, { automationLockedAt: null }]));
      expect(call[0].where.connection.OR[2].automationLockedAt.lt).toBeInstanceOf(Date);
    }
  });
});
