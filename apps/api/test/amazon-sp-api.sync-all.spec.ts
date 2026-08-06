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
    const prisma = {
      amazonSpApiConnection: { findMany },
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
