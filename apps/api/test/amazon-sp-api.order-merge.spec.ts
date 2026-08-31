import { AmazonOrderRecord } from '@prisma/client';
import { AmazonSpApiClient } from '../src/amazon-sp-api/amazon-sp-api.client';
import { AmazonSpApiCryptoService } from '../src/amazon-sp-api/amazon-sp-api-crypto.service';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Amazon SP-API FBM order reconciliation', () => {
  const service = new AmazonSpApiService(
    {} as PrismaService,
    {} as AmazonSpApiClient,
    {} as AmazonSpApiCryptoService,
  );

  const record = (overrides: Partial<AmazonOrderRecord>): AmazonOrderRecord => ({
    id: 1n,
    rowHash: 'hash',
    orderId: '503-1',
    orderItemId: 'item-1',
    purchaseDateRaw: null,
    paymentsDateRaw: null,
    reportingDateRaw: null,
    promiseDateRaw: null,
    daysPastPromise: null,
    buyerEmail: null,
    buyerName: null,
    buyerPhoneNumber: null,
    sku: 'SKU-1',
    productName: null,
    quantityPurchased: 1,
    quantityShipped: 0,
    quantityToShip: 1,
    shipServiceLevel: null,
    recipientName: null,
    shippingOrigin: null,
    shipAddress1: null,
    shipAddress2: null,
    shipAddress3: null,
    shipCity: null,
    shipState: null,
    shipPostalCode: null,
    shipCountry: null,
    customizedUrl: null,
    customizedPage: null,
    isBusinessOrder: null,
    purchaseOrderNumber: null,
    priceDesignation: null,
    vergeOfCancellation: null,
    vergeOfLateShipment: null,
    mallName: null,
    shopName: null,
    shipmentCompany: null,
    shipmentNo: null,
    shipmentNoRegisteredAt: null,
    dispatchMode: null,
    xiyaExportedAt: null,
    sourceFileName: null,
    sourceFilePath: null,
    rawPayload: null,
    csvImportedAt: new Date('2026-08-06T00:00:00Z'),
    createdAt: new Date('2026-08-06T00:00:00Z'),
    updatedAt: new Date('2026-08-06T00:00:00Z'),
    spApiConnectionId: null,
    orderStatus: null,
    fulfillmentChannel: null,
    amazonLastUpdatedAt: null,
    sourceKind: 'file',
    ...overrides,
  });

  it('reports a strict conflict instead of choosing between duplicate matches', () => {
    const legacy = record({ id: 10n, shipmentNo: '3907-4858-4225' });
    const duplicate = record({ id: 20n, spApiConnectionId: 3n, sourceKind: 'sp_api' });

    const match = (service as any).resolveFbmOrderMatch(
      [duplicate, legacy],
      3n,
      { orderItemId: 'item-1', product: { sellerSku: 'SKU-1' } },
    );

    expect(match.existing).toBeNull();
    expect(match.conflictReason).toContain('匹配到多条');
  });

  it('matches an edited line by the original Amazon order item id in raw payload', () => {
    const edited = record({
      orderItemId: 'manual-item-id',
      rawPayload: { item: { orderItemId: 'amazon-item-id' } },
    });

    const selected = (service as any).selectExistingFbmOrderItem(
      [edited],
      3n,
      { orderItemId: 'amazon-item-id', product: { sellerSku: 'OTHER-SKU' } },
    );

    expect(selected.id).toBe(1n);
  });

  it('does not merge different Amazon order items that share the same SKU', () => {
    const existingApiItem = record({
      id: 10n,
      spApiConnectionId: 3n,
      sourceKind: 'sp_api',
      orderItemId: 'item-1',
      sku: 'SKU-1',
    });

    const match = (service as any).resolveFbmOrderMatch(
      [existingApiItem],
      3n,
      { orderItemId: 'item-2', product: { sellerSku: 'SKU-1' } },
    );

    expect(match).toEqual({ existing: null, conflictReason: null });
  });

  it('keeps manual override metadata when refreshing the raw Amazon payload', () => {
    const merged = (service as any).mergeSpApiRawPayload(
      { _wmsManualOverrideFields: 'sku,recipientName', item: { orderItemId: 'old' } },
      { orderId: '503-1' },
      { orderItemId: 'item-1' },
    );

    expect(merged).toMatchObject({
      _wmsManualOverrideFields: 'sku,recipientName',
      order: { orderId: '503-1' },
      item: { orderItemId: 'item-1' },
    });
  });

  it('does not update an SP-API order at all after it has been manually edited', async () => {
    const update = jest.fn().mockResolvedValue({});
    const observationUpsert = jest.fn().mockResolvedValue({});
    const existing = record({
      spApiConnectionId: 3n,
      sourceKind: 'sp_api',
      sku: 'MANUAL-SKU',
      recipientName: '人工收件人',
      rawPayload: { _wmsManualOverrideFields: 'sku,recipientName' },
    });
    const prisma = {
      amazonOrderSyncExclusion: { findFirst: jest.fn().mockResolvedValue(null) },
      amazonOrderSyncObservation: { upsert: observationUpsert },
      amazonOrderRecord: {
        findMany: jest.fn().mockResolvedValue([existing]),
        update,
      },
    };
    const testService = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await (testService as any).upsertFbmOrderItem(
      { id: 3n },
      'Arcdiary',
      {
        orderId: '503-1',
        createdTime: '2026-08-06T00:00:00Z',
        fulfillment: { fulfillmentStatus: 'UNSHIPPED' },
        recipient: { deliveryAddress: { name: 'Amazon收件人' } },
      },
      {
        orderItemId: 'item-1',
        quantityOrdered: 1,
        product: { sellerSku: 'AMAZON-SKU', title: 'Amazon商品名' },
      },
      'overseas',
    );

    expect(result).toBe('frozen');
    expect(update).not.toHaveBeenCalled();
    expect(observationUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ freezeReason: 'manual_edit', orderStatus: 'UNSHIPPED' }),
    }));
  });

  it.each([
    ['an order with a tracking number', record({ sourceKind: 'sp_api', shipmentNo: 'TRACK-1' })],
    ['an order exported to Xiya', record({ sourceKind: 'sp_api', xiyaExportedAt: new Date('2026-08-07T00:00:00Z') })],
    ['a manually created order', record({ sourceKind: 'file', sourceFilePath: 'manual:amazon-order' })],
  ])('does not update %s', async (_label, existing) => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      amazonOrderSyncExclusion: { findFirst: jest.fn().mockResolvedValue(null) },
      amazonOrderSyncObservation: { upsert: jest.fn().mockResolvedValue({}) },
      amazonOrderRecord: {
        findMany: jest.fn().mockResolvedValue([existing]),
        update,
      },
    };
    const testService = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await (testService as any).upsertFbmOrderItem(
      { id: 3n },
      'Arcdiary',
      {
        orderId: '503-1',
        fulfillment: { fulfillmentStatus: 'SHIPPED' },
      },
      {
        orderItemId: 'item-1',
        quantityOrdered: 1,
        product: { sellerSku: 'SKU-1' },
      },
      'overseas',
    );

    expect(result).toBe('frozen');
    expect(update).not.toHaveBeenCalled();
  });

  it('claims an untouched CSV row when order item id matches exactly', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      amazonOrderSyncExclusion: { findFirst: jest.fn().mockResolvedValue(null) },
      amazonOrderSyncObservation: { upsert: jest.fn().mockResolvedValue({}) },
      amazonOrderRecord: {
        findMany: jest.fn().mockResolvedValue([record({ sourceKind: 'file' })]),
        update,
      },
    };
    const testService = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await (testService as any).upsertFbmOrderItem(
      { id: 3n },
      'Arcdiary',
      { orderId: '503-1', fulfillment: { fulfillmentStatus: 'UNSHIPPED' } },
      { orderItemId: 'item-1', quantityOrdered: 1, product: { sellerSku: 'SKU-1' } },
      'overseas',
    );

    expect(result).toBe('updated');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ spApiConnectionId: 3n, sourceKind: 'sp_api' }),
    }));
  });

  it('does not let an older Amazon event overwrite a newer stored state', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      amazonOrderSyncExclusion: { findFirst: jest.fn().mockResolvedValue(null) },
      amazonOrderSyncObservation: { upsert: jest.fn().mockResolvedValue({}) },
      amazonOrderRecord: {
        findMany: jest.fn().mockResolvedValue([
          record({
            spApiConnectionId: 3n,
            sourceKind: 'sp_api',
            amazonLastUpdatedAt: new Date('2026-08-08T10:00:00Z'),
          }),
        ]),
        update,
      },
    };
    const testService = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await (testService as any).upsertFbmOrderItem(
      { id: 3n },
      'Arcdiary',
      {
        orderId: '503-1',
        lastUpdatedTime: '2026-08-08T09:00:00Z',
        fulfillment: { fulfillmentStatus: 'UNSHIPPED' },
      },
      { orderItemId: 'item-1', quantityOrdered: 1, product: { sellerSku: 'SKU-1' } },
      'overseas',
    );

    expect(result).toBe('unchanged');
    expect(update).not.toHaveBeenCalled();
  });

  it('does not write an unchanged Amazon event back to the database', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      amazonOrderSyncExclusion: { findFirst: jest.fn().mockResolvedValue(null) },
      amazonOrderSyncObservation: { upsert: jest.fn().mockResolvedValue({}) },
      amazonOrderRecord: {
        findMany: jest.fn().mockResolvedValue([
          record({ spApiConnectionId: 3n, sourceKind: 'sp_api' }),
        ]),
        update,
      },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const testService = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );
    jest.spyOn(testService as any, 'changedAmazonFields').mockReturnValue([]);

    const result = await (testService as any).upsertFbmOrderItem(
      { id: 3n },
      'Arcdiary',
      { orderId: '503-1', fulfillment: { fulfillmentStatus: 'UNSHIPPED' } },
      { orderItemId: 'item-1', quantityOrdered: 1, product: { sellerSku: 'SKU-1' } },
      'overseas',
    );

    expect(result).toBe('unchanged');
    expect(update).not.toHaveBeenCalled();
  });

  it('freezes an order that has entered an overseas picking batch', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      amazonOrderSyncExclusion: { findFirst: jest.fn().mockResolvedValue(null) },
      amazonOrderSyncObservation: { upsert: jest.fn().mockResolvedValue({}) },
      amazonOrderRecord: {
        findMany: jest.fn().mockResolvedValue([record({ spApiConnectionId: 3n, sourceKind: 'sp_api' })]),
        update,
      },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue({ id: 99n }) },
    };
    const testService = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await (testService as any).upsertFbmOrderItem(
      { id: 3n },
      'Arcdiary',
      { orderId: '503-1', fulfillment: { fulfillmentStatus: 'UNSHIPPED' } },
      { orderItemId: 'item-1', quantityOrdered: 1, product: { sellerSku: 'SKU-1' } },
      'overseas',
    );

    expect(result).toBe('frozen');
    expect(update).not.toHaveBeenCalled();
  });

  it('does not create another line when the same order number was imported manually first', async () => {
    const create = jest.fn().mockResolvedValue({});
    const prisma = {
      amazonOrderSyncExclusion: { findFirst: jest.fn().mockResolvedValue(null) },
      amazonOrderSyncObservation: { upsert: jest.fn().mockResolvedValue({}) },
      amazonOrderRecord: {
        findMany: jest.fn().mockResolvedValue([
          record({ orderItemId: 'manual-line', sku: 'MANUAL-SKU', sourceKind: 'file' }),
        ]),
        create,
      },
    };
    const testService = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await (testService as any).upsertFbmOrderItem(
      { id: 3n },
      'Arcdiary',
      { orderId: '503-1', fulfillment: { fulfillmentStatus: 'UNSHIPPED' } },
      { orderItemId: 'new-api-line', quantityOrdered: 1, product: { sellerSku: 'NEW-SKU' } },
      'overseas',
    );

    expect(result).toBe('conflicts');
    expect(create).not.toHaveBeenCalled();
  });

  it('retries a stored matching conflict that was not returned in the current API window', async () => {
    const prisma = {
      amazonOrderSyncObservation: {
        findMany: jest.fn().mockResolvedValue([
          {
            orderId: '503-1',
            orderItemId: 'item-1',
            rawPayload: {
              order: { orderId: '503-1', fulfillment: { fulfillmentStatus: 'UNSHIPPED' } },
              item: { orderItemId: 'item-1', quantityOrdered: 1, product: { sellerSku: 'SKU-1' } },
            },
          },
        ]),
      },
    };
    const testService = new AmazonSpApiService(
      prisma as unknown as PrismaService,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );
    const upsert = jest.spyOn(testService as any, 'upsertFbmOrderItem').mockResolvedValue('updated');

    const counters = await (testService as any).retryStoredFbmConflicts(
      { id: 3n },
      'Arcdiary',
      new Map([['SKU-1', 10]]),
      new Set(),
    );

    expect(counters.updated).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
