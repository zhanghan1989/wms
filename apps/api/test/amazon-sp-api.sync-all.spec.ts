import { AmazonSpApiSyncStatus, AmazonSpApiSyncType } from '@prisma/client';
import { AmazonSpApiClient } from '../src/amazon-sp-api/amazon-sp-api.client';
import { AmazonSpApiCryptoService } from '../src/amazon-sp-api/amazon-sp-api-crypto.service';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Amazon all-store synchronization', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('synchronizes every active connection and aggregates partial results', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 1n, status: 1, shop: { name: 'Arcdiary' } },
      { id: 2n, status: 1, shop: { name: '1号店 DGAZ' } },
    ]);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      amazonSpApiConnection: { findMany, updateMany },
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(
      prisma,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );
    jest.spyOn(service as any, 'runSync')
      .mockResolvedValueOnce({
        runId: '10',
        status: AmazonSpApiSyncStatus.partial,
        syncType: AmazonSpApiSyncType.full,
        fetchedCount: 6,
        createdCount: 1,
        updatedCount: 2,
        errors: ['FBA库存权限不足'],
      })
      .mockResolvedValueOnce({
        runId: '11',
        status: AmazonSpApiSyncStatus.success,
        syncType: AmazonSpApiSyncType.full,
        fetchedCount: 20,
        createdCount: 5,
        updatedCount: 3,
        errors: [],
      });
    jest.spyOn(service as any, 'materializeDashboardSnapshotIfComplete').mockResolvedValue(undefined);

    const result = await service.syncAllConnections();

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 1 } }));
    expect(result).toMatchObject({
      connectionCount: 2,
      completedCount: 2,
      skippedCount: 0,
      partialCount: 1,
      failedCount: 0,
      fetchedCount: 26,
      createdCount: 6,
      updatedCount: 5,
    });
    expect(result.results.map((row) => row.shopName)).toEqual(['Arcdiary', '1号店 DGAZ']);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ syncLockToken: expect.any(String), syncLockedAt: expect.any(Date) }),
    }));
  });

  it('skips a connection when another instance owns its database lease', async () => {
    const prisma = {
      amazonSpApiConnection: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1n, status: 1, shop: { name: 'Arcdiary' } },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(
      prisma,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );
    jest.spyOn(service as any, 'materializeDashboardSnapshotIfComplete').mockResolvedValue(undefined);
    const runSync = jest.spyOn(service as any, 'runSync');

    const result = await service.syncAllConnections();

    expect(result.skippedCount).toBe(1);
    expect(runSync).not.toHaveBeenCalled();
  });

  it('establishes the independent FBM watermark without requesting historical orders', async () => {
    const updateRun = jest.fn().mockResolvedValue({});
    const updateConnection = jest.fn().mockResolvedValue({});
    const prisma = {
      amazonSpApiSyncRun: {
        create: jest.fn().mockResolvedValue({ id: 9n }),
        update: updateRun,
      },
      amazonSpApiConnection: {
        update: updateConnection,
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(
      prisma,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );
    jest.spyOn(service as any, 'getAccessToken').mockResolvedValue('token');
    const syncFbmOrders = jest.spyOn(service as any, 'syncFbmOrders').mockResolvedValue({
      fetched: 1,
      created: 0,
      updated: 0,
      unchanged: 0,
      frozen: 0,
      excluded: 0,
      conflicts: 0,
    });

    const result = await (service as any).runSync(
      {
        id: 3n,
        region: 'FE',
        marketplaceIds: ['A1VC38T7YXB528'],
        syncFbmOrders: true,
        syncFbaOrders: false,
        syncFbaInventory: false,
        lastOrdersSyncedAt: new Date('2026-08-30T00:00:00.000Z'),
      },
      AmazonSpApiSyncType.fbm_orders,
      7,
    );

    expect(result.status).toBe(AmazonSpApiSyncStatus.success);
    expect(updateConnection).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastFbmOrdersSyncedAt: expect.any(Date) }),
    }));
    expect(updateConnection.mock.calls[0][0].data).not.toHaveProperty('lastOrdersSyncedAt');
    expect(syncFbmOrders).not.toHaveBeenCalled();
  });

  it('queues manual syncs and rejects duplicate requests for the same store', async () => {
    const prisma = {
      amazonSpApiConnection: {
        findUnique: jest.fn().mockResolvedValue({ id: 3n, status: 1 }),
      },
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(
      prisma,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );
    let finishSync: ((value: unknown) => void) | undefined;
    jest.spyOn(service, 'syncConnection').mockImplementation(() => new Promise((resolve) => {
      finishSync = resolve;
    }));

    const accepted = await service.enqueueConnectionSync('3', { syncType: 'full' });

    expect(accepted).toMatchObject({ accepted: true, connectionId: '3', queuePosition: 1 });
    await expect(service.enqueueConnectionSync('3', { syncType: 'full' }))
      .rejects.toThrow('正在运行或排队');
    finishSync?.({ status: 'success' });
  });

  it('rejects repeated all-store pulls within 60 seconds', async () => {
    const prisma = {
      amazonSpApiConnection: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(
      prisma,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );
    jest.spyOn(service as any, 'materializeDashboardSnapshotIfComplete').mockResolvedValue(undefined);

    await service.syncAllConnections();
    await expect(service.syncAllConnections()).rejects.toThrow('订单拉取操作过于频繁');
  });

  it('keeps three stores sequential, rejects overlap and builds one snapshot after all finish', async () => {
    const prisma = {
      amazonSpApiConnection: {
        findMany: jest.fn().mockResolvedValue([1n, 2n, 3n].map((id) => ({ id, shop: { name: `Shop ${id}` } }))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(prisma, {} as AmazonSpApiClient, {} as AmazonSpApiCryptoService);
    const result = { status: 'success', fetchedCount: 1, createdCount: 0, updatedCount: 0, errors: [] };
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    const runSync = jest.spyOn(service as any, 'runSync').mockResolvedValue(result)
      .mockImplementationOnce(() => { entered(); return pending; });
    const snapshot = jest.spyOn(service as any, 'materializeDashboardSnapshotIfComplete').mockResolvedValue(undefined);

    const running = service.syncAllConnections(true, 'scheduled');
    await started;
    try {
      expect(runSync).toHaveBeenCalledTimes(1);
      expect(snapshot).not.toHaveBeenCalled();
      await expect(service.syncAllConnections(true, 'scheduled')).rejects.toThrow('正在运行');
    } finally {
      release(result);
    }
    const summary = await running;

    expect(runSync.mock.calls.map(([connection]) => (connection as { id: bigint }).id)).toEqual([1n, 2n, 3n]);
    expect(summary).toMatchObject({ completedCount: 3, fetchedCount: 3, failedCount: 0 });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('continues the other stores after a failure and preserves the last snapshot', async () => {
    const prisma = {
      amazonSpApiConnection: {
        findMany: jest.fn().mockResolvedValue([1n, 2n, 3n].map((id) => ({ id, shop: { name: `Shop ${id}` } }))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(prisma, {} as AmazonSpApiClient, {} as AmazonSpApiCryptoService);
    const runSync = jest.spyOn(service as any, 'runSync')
      .mockRejectedValueOnce(new Error('store unavailable'))
      .mockResolvedValue({ status: 'success', fetchedCount: 1, createdCount: 0, updatedCount: 0, errors: [] });
    const snapshot = jest.spyOn(service as any, 'materializeDashboardSnapshotIfComplete').mockResolvedValue(undefined);

    expect(await service.syncAllConnections(true, 'scheduled')).toMatchObject({ completedCount: 3, failedCount: 1 });
    expect(runSync).toHaveBeenCalledTimes(3);
    expect(snapshot).not.toHaveBeenCalled();
    // The running flag must also be released on failure/partial completion.
    await service.syncAllConnections(true, 'scheduled');
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});
