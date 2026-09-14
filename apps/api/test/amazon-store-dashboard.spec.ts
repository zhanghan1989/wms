import { buildAmazonStoreDashboard } from '../src/amazon-sp-api/amazon-store-dashboard';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';

describe('Amazon store dashboard analytics', () => {
  const now = new Date('2026-08-06T12:00:00.000Z');

  it('loads FBM dashboard rows exclusively from SP-API for the selected connection', async () => {
    const amazonOrderFindMany = jest.fn().mockResolvedValue([]);
    const service = new AmazonSpApiService({
      amazonSpApiConnection: { findMany: jest.fn().mockResolvedValue([{
        id: 3n,
        shopId: 7n,
        shop: { id: 7n, name: 'Amazon JP', status: 1 },
        marketplaceIds: ['A1VC38T7YXB528'],
        syncFbaInventory: true,
        lastSyncError: null,
      }]) },
      amazonFbaOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
      amazonOrderRecord: { findMany: amazonOrderFindMany },
      amazonFbaInventoryItem: { findMany: jest.fn().mockResolvedValue([]) },
      sku: { findMany: jest.fn().mockResolvedValue([]) },
      amazonSpApiSyncRun: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any, {} as any, {} as any);

    await service.getStoreDashboard('3', '30');

    expect(amazonOrderFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        spApiConnectionId: 3n,
        sourceKind: 'sp_api',
        spApiDashboardVisibleAt: { not: null },
      },
    }));
  });

  it('combines FBA and FBM units while keeping revenue explicitly FBA-only', () => {
    const dashboard = buildAmazonStoreDashboard({
      now,
      days: 30,
      fbaOrders: [
        {
          orderId: 'FBA-1',
          sellerSku: 'SKU-1',
          asin: 'ASIN-1',
          productName: 'Item 1',
          orderStatus: 'SHIPPED',
          quantityOrdered: 2,
          quantityShipped: 2,
          itemAmount: 6000,
          currency: 'JPY',
          purchaseDate: new Date('2026-08-01T03:00:00.000Z'),
        },
        {
          orderId: 'FBA-OLD',
          sellerSku: 'SKU-1',
          asin: 'ASIN-1',
          productName: 'Item 1',
          orderStatus: 'SHIPPED',
          quantityOrdered: 1,
          quantityShipped: 1,
          itemAmount: 3000,
          currency: 'JPY',
          purchaseDate: new Date('2026-06-20T03:00:00.000Z'),
        },
        {
          orderId: 'FBA-CANCELLED',
          sellerSku: 'SKU-1',
          asin: 'ASIN-1',
          productName: 'Item 1',
          orderStatus: 'CANCELLED',
          quantityOrdered: 1,
          quantityShipped: 0,
          itemAmount: 3000,
          currency: 'JPY',
          purchaseDate: new Date('2026-08-02T03:00:00.000Z'),
        },
      ],
      fbmOrders: [
        {
          orderId: 'FBM-1',
          sku: 'FBM-1',
          productName: 'Item 2',
          orderStatus: 'UNSHIPPED',
          quantityPurchased: 1,
          quantityShipped: 0,
          quantityToShip: 1,
          purchaseDateRaw: '2026-08-03T03:00:00.000Z',
        },
      ],
      inventory: [],
      skus: [
        {
          sku: 'SKU-1',
          fbmSku: null,
          rbSku: null,
          asin: 'ASIN-1',
          fnsku: null,
          productId: 'P-1',
          productName: 'Matched item 1',
        },
        {
          sku: 'SKU-2',
          fbmSku: 'FBM-1',
          rbSku: null,
          asin: null,
          fnsku: null,
          productId: 'P-2',
          productName: 'Matched item 2',
        },
      ],
    }) as any;

    expect(dashboard.summary).toMatchObject({
      orderCount: 2,
      unitCount: 3,
      fbaOrderCount: 1,
      fbaUnitCount: 2,
      fbmOrderCount: 1,
      fbmUnitCount: 1,
      fbmPendingUnitCount: 1,
      fbaSalesAmount: 6000,
      fbaAverageOrderValue: 6000,
    });
    expect(dashboard.comparison.previous.fbaSalesAmount).toBe(3000);
    expect(dashboard.orderStatuses.fba).toEqual({ SHIPPED: 1, CANCELLED: 1 });
    expect(dashboard.inventory.available).toBe(false);
    expect(dashboard.topProducts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: 'P-1', fbaUnitCount: 2, fbaSalesAmount: 6000 }),
        expect.objectContaining({ productId: 'P-2', fbmUnitCount: 1 }),
      ]),
    );
  });

  it('calculates available inventory and days of cover when inventory permission is working', () => {
    const dashboard = buildAmazonStoreDashboard({
      now,
      days: 30,
      fbaOrders: [{
        orderId: 'FBA-1', sellerSku: 'SKU-1', asin: 'ASIN-1', productName: 'Item 1', orderStatus: 'SHIPPED',
        quantityOrdered: 3, quantityShipped: 3, itemAmount: 9000, currency: 'JPY',
        purchaseDate: new Date('2026-08-01T03:00:00.000Z'),
      }],
      fbmOrders: [],
      inventory: [{
        sellerSku: 'SKU-1', asin: 'ASIN-1', productName: 'Item 1', fulfillableQty: 12,
        inboundWorkingQty: 1, inboundShippedQty: 1, inboundReceivingQty: 1,
        reservedQty: 2, unfulfillableQty: 1, totalQty: 18, snapshotAt: now,
      }],
      skus: [{
        sku: 'SKU-1', fbmSku: null, rbSku: null, asin: 'ASIN-1', fnsku: null,
        productId: 'P-1', productName: 'Item 1',
      }],
    }) as any;

    expect(dashboard.inventory).toMatchObject({
      available: true,
      skuCount: 1,
      fulfillableQty: 12,
      inboundQty: 3,
      reservedQty: 2,
      unfulfillableQty: 1,
    });
    expect(dashboard.topProducts[0].daysOfCover).toBe(150);
  });

  it('calculates factory-to-FBA recommendations per store using a fixed 90-day FBA and FBM demand window', () => {
    const dashboard = buildAmazonStoreDashboard({
      now,
      days: 7,
      fbaOrders: [{
        orderId: 'FBA-1', sellerSku: 'FBA-SKU-1', asin: 'ASIN-1', productName: 'Item 1',
        orderStatus: 'SHIPPED', quantityOrdered: 8, quantityShipped: 8, itemAmount: 8000,
        currency: 'JPY', purchaseDate: new Date('2026-06-15T03:00:00.000Z'),
      }],
      fbmOrders: [{
        orderId: 'FBM-1', sku: 'FBM-SKU-1', productName: 'Item 1', orderStatus: 'SHIPPED',
        quantityPurchased: 5, quantityShipped: 5, quantityToShip: 0,
        purchaseDateRaw: '2026-06-20T03:00:00.000Z',
      }],
      inventory: [{
        sellerSku: 'FBA-SKU-1', asin: 'ASIN-1', productName: 'Item 1', fulfillableQty: 2,
        inboundWorkingQty: 1, inboundShippedQty: 1, inboundReceivingQty: 1,
        reservedQty: 20, unfulfillableQty: 30, totalQty: 55, snapshotAt: now,
      }],
      skus: [{
        sku: 'FBA-SKU-1', fbmSku: 'FBM-SKU-1', rbSku: null, asin: 'ASIN-1', fnsku: null,
        productId: 'P-1', productName: 'Item 1',
      }],
    }) as any;

    expect(dashboard.summary.unitCount).toBe(0);
    expect(dashboard.factoryRecommendations).toMatchObject({
      periodDays: 90,
      minimumTotalUnitCountExclusive: 10,
      inventoryAvailable: true,
      recommendationCount: 1,
      totalSuggestedFbaShipmentQty: 8,
    });
    expect(dashboard.factoryRecommendations.rows).toEqual([
      expect.objectContaining({
        productId: 'P-1',
        sellerSku: 'FBA-SKU-1',
        fbaUnitCount90d: 8,
        fbmUnitCount90d: 5,
        totalUnitCount90d: 13,
        availableQty: 2,
        inboundQty: 3,
        suggestedFbaShipmentQty: 8,
      }),
    ]);
  });

  it('flags FBA sellable inventory with no Amazon sales in the last 90 days', () => {
    const dashboard = buildAmazonStoreDashboard({
      now,
      days: 30,
      fbaOrders: [],
      fbmOrders: [],
      inventory: [{
        sellerSku: 'STALE-SKU', asin: 'STALE-ASIN', productName: 'Slow item', fulfillableQty: 12,
        inboundWorkingQty: 1, inboundShippedQty: 0, inboundReceivingQty: 0,
        reservedQty: 2, unfulfillableQty: 3, totalQty: 18, snapshotAt: now,
      }],
      skus: [{
        sku: 'STALE-SKU', fbmSku: null, rbSku: null, asin: 'STALE-ASIN', fnsku: null,
        productId: 'P-STALE', productName: 'Slow item',
      }],
    }) as any;

    expect(dashboard.inventory).toMatchObject({
      noSales90dSkuCount: 1,
      noSales90dQty: 12,
      noSales90dRows: [expect.objectContaining({
        sellerSku: 'STALE-SKU',
        productId: 'P-STALE',
        totalUnitCount90d: 0,
        availableQty: 12,
      })],
    });
  });
});
