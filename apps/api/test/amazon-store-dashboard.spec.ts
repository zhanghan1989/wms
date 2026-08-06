import { buildAmazonStoreDashboard } from '../src/amazon-sp-api/amazon-store-dashboard';

describe('Amazon store dashboard analytics', () => {
  const now = new Date('2026-08-06T12:00:00.000Z');

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
});
