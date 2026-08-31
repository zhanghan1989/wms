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

  it('advances the main order watermark while retaining FBM conflicts for retry', async () => {
    const updateRun = jest.fn().mockResolvedValue({});
    const updateConnection = jest.fn().mockResolvedValue({});
    const prisma = {
      amazonSpApiSyncRun: {
        create: jest.fn().mockResolvedValue({ id: 9n }),
        update: updateRun,
      },
      amazonSpApiConnection: { update: updateConnection },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(
      prisma,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );
    jest.spyOn(service as any, 'getAccessToken').mockResolvedValue('token');
    jest.spyOn(service as any, 'syncFbmOrders').mockResolvedValue({
      fetched: 1,
      created: 0,
      updated: 0,
      unchanged: 0,
      frozen: 0,
      excluded: 0,
      conflicts: 1,
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

    expect(result.status).toBe(AmazonSpApiSyncStatus.partial);
    expect(updateConnection).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastOrdersSyncedAt: expect.any(Date) }),
    }));
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
});
