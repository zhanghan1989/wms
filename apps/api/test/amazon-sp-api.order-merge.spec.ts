import { AmazonSpApiClient } from '../src/amazon-sp-api/amazon-sp-api.client';
import { AmazonSpApiCryptoService } from '../src/amazon-sp-api/amazon-sp-api-crypto.service';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Amazon SP-API FBM order isolation', () => {
  const order = {
    orderId: '503-1',
    createdTime: '2026-09-14T01:00:00.000Z',
    lastUpdatedTime: '2026-09-14T02:00:00.000Z',
    salesChannel: { marketplaceId: 'A1VC38T7YXB528' },
    fulfillment: { fulfillmentStatus: 'UNSHIPPED' },
  };
  const item = {
    orderItemId: 'item-1',
    quantityOrdered: 3,
    fulfillment: { quantityFulfilled: 1, quantityUnfulfilled: 2 },
    product: { sellerSku: 'FBM-SKU-1', asin: 'ASIN-1', title: 'Item 1' },
  };

  it('creates new API data only in the dedicated FBM table', async () => {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      amazonFbmOrderItem: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert,
      },
      amazonOrderRecord: {
        create: jest.fn(() => { throw new Error('must not write to the manual order table'); }),
        update: jest.fn(() => { throw new Error('must not write to the manual order table'); }),
      },
    };
    const service = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await (service as any).upsertFbmOrderItem(3n, order, item);

    expect(result).toBe('created');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        connectionId_amazonOrderId_amazonOrderItemId: {
          connectionId: 3n,
          amazonOrderId: '503-1',
          amazonOrderItemId: 'item-1',
        },
      },
      create: expect.objectContaining({
        connectionId: 3n,
        sellerSku: 'FBM-SKU-1',
        quantityOrdered: 3,
        quantityShipped: 1,
        quantityUnfulfilled: 2,
      }),
    }));
    expect(prisma.amazonOrderRecord.create).not.toHaveBeenCalled();
    expect(prisma.amazonOrderRecord.update).not.toHaveBeenCalled();
  });

  it('does not rewrite an unchanged or older FBM API item', async () => {
    const upsert = jest.fn();
    const prisma = {
      amazonFbmOrderItem: {
        findUnique: jest.fn().mockResolvedValue({
          lastUpdateDate: new Date('2026-09-14T02:00:00.000Z'),
        }),
        upsert,
      },
    };
    const service = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await (service as any).upsertFbmOrderItem(3n, order, item);

    expect(result).toBe('unchanged');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('processes FBA inventory page-by-page with one existing-row lookup per page', async () => {
    const findMany = jest.fn().mockResolvedValue([{
      sellerSku: 'SKU-OLD',
      fnSku: null,
      asin: null,
      productName: null,
      fulfillableQty: 4,
      inboundWorkingQty: 0,
      inboundShippedQty: 0,
      inboundReceivingQty: 0,
      reservedQty: 0,
      unfulfillableQty: 0,
      totalQty: 5,
    }]);
    const upsert = jest.fn().mockResolvedValue({});
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      amazonFbaInventoryItem: { findMany, upsert, deleteMany },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    };
    const client = {
      forEachInventorySummaryPage: jest.fn(async (_options, onPage) => {
        await onPage([
          { sellerSku: 'SKU-OLD', totalQuantity: 5, inventoryDetails: { fulfillableQuantity: 4 } },
          { sellerSku: 'SKU-NEW', totalQuantity: 3, inventoryDetails: { fulfillableQuantity: 3 } },
        ]);
      }),
    };
    const service = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      client as unknown as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await (service as any).syncFbaInventory(
      { id: 3n },
      'token',
      'FE',
      ['A1VC38T7YXB528'],
      new Date('2026-09-14T03:00:00.000Z'),
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fetched: 2, created: 1, updated: 0, unchanged: 1 });
    expect(deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sellerSku: { notIn: ['SKU-OLD', 'SKU-NEW'] } }),
    }));
  });
});
