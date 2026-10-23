import { BackupsService } from '../src/backups/backups.service';

describe('backup reconciliation concurrency', () => {
  it('shares concurrent scans and permits another scan after completion', async () => {
    const service = new BackupsService({} as never) as any;
    let finish!: () => void;
    service.performReconciliation = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = service.reconcileBackupRecordsAndFiles();
    const second = service.reconcileBackupRecordsAndFiles();
    expect(first).toBe(second);
    expect(service.performReconciliation).toHaveBeenCalledTimes(1);
    finish();
    await first;
    const next = service.reconcileBackupRecordsAndFiles();
    expect(service.performReconciliation).toHaveBeenCalledTimes(2);
    finish();
    await next;
  });

  it('releases a failed scan so a subsequent check can retry', async () => {
    const service = new BackupsService({} as never) as any;
    service.performReconciliation = jest.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValueOnce(undefined);
    await expect(service.reconcileBackupRecordsAndFiles()).rejects.toThrow('disk unavailable');
    await expect(service.reconcileBackupRecordsAndFiles()).resolves.toBeUndefined();
    expect(service.performReconciliation).toHaveBeenCalledTimes(2);
  });

  it('does not scan a ZIP while a backup is being created', async () => {
    const service = new BackupsService({} as never) as any;
    service.performReconciliation = jest.fn();
    service.isCreating = true;
    await service.reconcileFilesInBackground();
    expect(service.performReconciliation).not.toHaveBeenCalled();
    service.isCreating = false;
    service.performReconciliation.mockResolvedValue(undefined);
    await service.reconcileFilesInBackground();
    expect(service.performReconciliation).toHaveBeenCalledTimes(1);
  });
});
