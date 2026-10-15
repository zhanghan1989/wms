import { Prisma } from '@prisma/client';
import { AmazonSpApiClient } from '../src/amazon-sp-api/amazon-sp-api.client';
import { AmazonSpApiCryptoService } from '../src/amazon-sp-api/amazon-sp-api-crypto.service';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Amazon scheduled dashboard snapshot', () => {
  function setup() {
    const connections = ['A', 'B', 'C'].map((name, index) => ({
      id: BigInt(index + 1), shop: { name }, lastSuccessfulSyncAt: new Date(), lastSyncError: null,
    }));
    const skus = [
      ...Array.from({ length: 403 }, (_, index) => ({
        id: BigInt(index + 1), shop: 'Other shop', sku: `unused-${index}`, productId: 'UNUSED',
      })),
      { id: 1001n, shop: ' A ', sku: ' SAME ', productId: 'P1' },
      { id: 1002n, shop: 'B', sku: 'SAME', productId: 'P2' },
      { id: 1003n, shop: 'C', sku: 'OTHER', productId: 'P1' },
    ];
    const orders = [
      ...Array.from({ length: 401 }, (_, index) => ({
        id: BigInt(index * 3 + 1), connectionId: 1n, sellerSku: 'SAME', asin: null,
        productName: null, quantityShipped: 2, itemAmount: new Prisma.Decimal('1.25'),
      })),
      { id: 2001n, connectionId: 3n, sellerSku: 'OTHER', asin: 'ASIN1',
        productName: 'First product', quantityShipped: -2, itemAmount: new Prisma.Decimal('2.50') },
      { id: 2002n, connectionId: 2n, sellerSku: 'SAME', asin: 'ASIN2',
        productName: 'Second product', quantityShipped: 3, itemAmount: new Prisma.Decimal('3') },
    ];
    const inventory = [
      { id: 1n, connectionId: 1n, sellerSku: 'SAME', fulfillableQty: 4,
        inboundWorkingQty: 1, inboundShippedQty: 2, inboundReceivingQty: 3, reservedQty: 7, unfulfillableQty: 8 },
      { id: 2n, connectionId: 3n, sellerSku: 'OTHER', fulfillableQty: 5, reservedQty: 1, unfulfillableQty: 2 },
      { id: 3n, connectionId: 2n, sellerSku: 'SAME', fulfillableQty: 6 },
      ...Array.from({ length: 401 }, (_, index) => ({
        id: BigInt(index + 4), connectionId: BigInt(index % 3 + 1), sellerSku: `UNMATCHED-${index}`,
        fulfillableQty: 999,
      })),
      { id: 9999n, connectionId: 1n, sellerSku: ' ', fulfillableQty: 999 },
    ].map((row) => ({
      asin: null, productName: null, inboundWorkingQty: 0, inboundShippedQty: 0,
      inboundReceivingQty: 0, reservedQty: 0, unfulfillableQty: 0, ...row,
    }));
    const reads: string[] = [];
    function paged(name: string, rows: Array<{ id: bigint }>) {
      return jest.fn(async (query: any) => {
        reads.push(name);
        expect(query.take).toBeLessThanOrEqual(200);
        expect(query.orderBy).toEqual({ id: 'asc' });
        expect(query.include).toBeUndefined();
        expect(query.select.rawPayload).toBeUndefined();
        const after = query.where.id?.gt ?? 0n;
        return rows.filter((row) => row.id > after).slice(0, query.take);
      });
    }
    const create = jest.fn().mockResolvedValue({ id: 100n });
    const createMany = jest.fn().mockResolvedValue({ count: 200 });
    const expired = jest.fn().mockResolvedValue([{ id: 1n }]);
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      fbaSalesSnapshot: { create, findMany: expired, deleteMany },
      fbaSalesSnapshotItem: { createMany },
    };
    const prisma = {
      amazonSpApiConnection: { findMany: jest.fn().mockResolvedValue(connections) },
      sku: { findMany: paged('sku', skus) },
      amazonFbaOrderItem: { findMany: paged('orders', orders) },
      amazonFbaInventoryItem: { findMany: paged('inventory', inventory) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const service = new AmazonSpApiService(prisma as unknown as PrismaService,
      {} as AmazonSpApiClient, {} as AmazonSpApiCryptoService);
    return { service, prisma, connections, reads, create, createMany, expired, deleteMany };
  }

  it('preserves cross-store product totals, unmatched items and atomic batched writes across multiple pages', async () => {
    const { service, prisma, reads, create, createMany, deleteMany } = setup();

    await (service as any).materializeDashboardSnapshotIfComplete();

    expect(reads).toEqual(['sku', 'sku', 'sku', 'orders', 'orders', 'orders', 'inventory', 'inventory', 'inventory']);
    expect(prisma.amazonFbaOrderItem.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ id: { gt: 598n } }),
    }));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inventoryRows: 405, totalRows: 403, fbaRows: 2, unmatchedRows: 401,
        fbaOrderedQty: 805, fbaAvailableQty: 15, fbaInboundQty: 6,
        fbaReservedQty: 8, fbaUnfulfillableQty: 10,
      }),
      select: { id: true },
    });
    expect(create.mock.calls[0][0].data).not.toHaveProperty('items');
    expect(createMany.mock.calls.map(([query]) => query.data.length)).toEqual([200, 200, 3]);
    const items = createMany.mock.calls.flatMap(([query]) => query.data);
    expect(items.every((row) => row.snapshotId === 100n)).toBe(true);
    expect(items.find((row) => row.productId === 'P1')).toMatchObject({
      orderedQty: 802, orderItemQty: 402, salesAmount: 503.75,
      asin: 'ASIN1', productName: 'First product', fbaAvailableQty: 9,
    });
    expect(items.find((row) => row.productId === 'P2')).toMatchObject({
      orderedQty: 3, salesAmount: 3, fbaAvailableQty: 6,
    });
    expect(items.filter((row) => row.channel === 'unmatched')).toHaveLength(401);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1n] } } });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000 });
  });

  it('fails the transaction before retention cleanup if any detail batch fails', async () => {
    const { service, createMany, expired, deleteMany } = setup();
    createMany.mockResolvedValueOnce({ count: 200 }).mockRejectedValueOnce(new Error('write failed'));

    await expect((service as any).materializeDashboardSnapshotIfComplete()).rejects.toThrow('write failed');

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(expired).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('retains the last snapshot without loading inputs when a store is stale or has an error', async () => {
    const { service, connections, reads, prisma } = setup();
    connections[1].lastSuccessfulSyncAt = new Date(Date.now() - 7 * 60 * 60 * 1000);

    await (service as any).materializeDashboardSnapshotIfComplete();

    expect(reads).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
