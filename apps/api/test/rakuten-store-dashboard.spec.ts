import { PrismaService } from '../src/prisma/prisma.service';
import { RakutenRmsApiClient } from '../src/rakuten-rms-api/rakuten-rms-api.client';
import { RakutenRmsApiCryptoService } from '../src/rakuten-rms-api/rakuten-rms-api-crypto.service';
import { RakutenRmsApiService } from '../src/rakuten-rms-api/rakuten-rms-api.service';
import { buildRakutenStoreDashboard } from '../src/rakuten-rms-api/rakuten-store-dashboard';

describe('Rakuten store dashboard', () => {
  it('calculates sales, fulfillment and factory recommendations', () => {
    const dashboard = buildRakutenStoreDashboard({
      now: new Date('2026-08-21T12:00:00.000Z'),
      days: 7,
      products: [{ productId: 'RB-1', productName: '系统产品', stockQty: 4 }],
      inTransit: [{ productId: 'RB-1', inTransitQty: 3 }],
      orders: [
        {
          orderId: 'current-1', skuCode: 'RB-1', productName: '乐天产品', orderQuantity: 13,
          orderStatusText: '300', orderImportedAtRaw: '2026-08-20 10:00:00', dispatchMode: 'overseas',
          shipmentNo: 'TRACK-1', trackingIsDelivered: true,
          salesAmount: 15600,
        },
        {
          orderId: 'previous-1', skuCode: 'RB-1', productName: '系统产品', orderQuantity: 1,
          orderStatusText: '300', orderImportedAtRaw: '2026-08-10 10:00:00', dispatchMode: 'overseas',
          shipmentNo: null, trackingIsDelivered: false, salesAmount: 1000,
        },
        {
          orderId: 'cancelled', skuCode: 'RB-1', productName: '系统产品', orderQuantity: 99,
          orderStatusText: '900', orderImportedAtRaw: '2026-08-20 10:00:00', dispatchMode: 'overseas',
          shipmentNo: null, trackingIsDelivered: false, salesAmount: 99000,
        },
      ],
    }) as any;

    expect(dashboard.summary).toMatchObject({ orderCount: 1, unitCount: 13, salesAmount: 15600 });
    expect(dashboard.fulfillment).toMatchObject({ shippedOrderCount: 1, deliveredOrderCount: 1 });
    expect(dashboard.factoryRecommendations).toMatchObject({
      channelScope: 'rakuten_all_shops', periodDays: 90,
      productionDays: 30, transportDays: 15, safetyDays: 3, targetCoverDays: 48,
      forecastWeights: { days7: 0.5, days30: 0.3, days90: 0.2 },
      recommendationCount: 1, totalSuggestedFactoryQty: 47,
    });
    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      productId: 'RB-1', unitCount7d: 13, unitCount30d: 14, unitCount90d: 14,
      forecastDailyQty: 1.1, targetDemandQty: 53, pendingShipmentQty: 1,
      stockQty: 4, inTransitQty: 3, suggestedFactoryQty: 47,
    });
  });

  it('uses all Rakuten shop orders for factory planning while keeping store metrics selected', () => {
    const dashboard = buildRakutenStoreDashboard({
      now: new Date('2026-08-21T12:00:00.000Z'),
      days: 7,
      orders: [],
      factoryOrders: [{
        orderId: 'other-shop-1', skuCode: 'RB-1', productName: '产品', orderQuantity: 7,
        orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
        shipmentNo: 'TRACK-1', trackingIsDelivered: false, salesAmount: 0,
      }],
      products: [{ productId: 'RB-1', productName: '产品', stockQty: 0 }],
    }) as any;

    expect(dashboard.summary).toMatchObject({ orderCount: 0, unitCount: 0 });
    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      unitCount7d: 7, unitCount30d: 7, unitCount90d: 7,
      forecastDailyQty: 0.586, targetDemandQty: 29, suggestedFactoryQty: 29,
    });
  });

  it.each([
    ['乐天-1号店', true],
    ['乐天-2号店', false],
  ])('uses the expected optimized scope for %s', async (shopName, includesLegacyData) => {
    const queryRaw = jest.fn().mockResolvedValue([{
      rmsConnectionId: 7n,
      sourceKind: 'rms_api',
      orderId: 'order-1',
      skuCode: 'RB-1',
      productName: '产品',
      orderQuantity: 1,
      orderStatusText: '300',
      orderImportedAtRaw: '2026-08-20 10:00:00',
      dispatchMode: 'overseas',
      shipmentNo: null,
      trackingIsDelivered: 0,
      salesAmount: '1000',
    }]);
    const productFindMany = jest.fn().mockResolvedValue([]);
    const inTransitGroupBy = jest.fn().mockResolvedValue([]);
    const factoryOrderFindMany = jest.fn().mockResolvedValue([{
      rmsConnectionId: 8n, orderId: 'factory-order-1', skuCode: 'RB-1', productName: '产品',
      orderQuantity: 1, orderStatusText: '300', orderImportedDate: new Date('2026-08-20'),
      dispatchMode: 'overseas', shipmentNo: 'TRACK-2', trackingIsDelivered: false,
    }]);
    const prisma = {
      rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([
        {
          id: 7n, shopId: 3n, shop: { id: 3n, name: shopName }, status: 1, syncOrders: true,
          lastOrdersSyncedAt: null, lastSuccessfulSyncAt: null, lastSyncError: null, licenseExpiresAt: null,
        },
        {
          id: 8n, shopId: 4n, shop: { id: 4n, name: '另一家乐天店' }, status: 1, syncOrders: true,
          lastOrdersSyncedAt: null, lastSuccessfulSyncAt: null, lastSyncError: null, licenseExpiresAt: null,
        },
      ]) },
      $queryRaw: queryRaw,
      rakutenOrderRecord: { findMany: factoryOrderFindMany },
      masterProduct: { findMany: productFindMany },
      batchInboundItem: { groupBy: inTransitGroupBy },
      rakutenRmsSyncRun: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(
      prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService,
    );

    const result = await service.getStoreDashboard('7', '30') as any;

    const sql = queryRaw.mock.calls[0][0];
    const queryText = sql.strings.join(' ');
    expect(queryText).toContain('order_imported_date >=');
    expect(queryText).not.toContain('order_imported_at_raw >=');
    expect(queryText).toContain('MAX_EXECUTION_TIME(15000)');
    expect(queryText).not.toContain('raw_payload AS');
    expect(queryText.includes('rms_connection_id IS NULL')).toBe(includesLegacyData);
    expect(factoryOrderFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { rmsConnectionId: { in: [7n, 8n] } },
          { rmsConnectionId: null },
        ],
        orderImportedDate: expect.objectContaining({ gte: expect.any(Date), lt: expect.any(Date) }),
      }),
    }));
    expect(productFindMany).toHaveBeenCalledWith({
      where: { productId: { in: ['RB-1'] } },
      select: { productId: true, productName: true, stockQty: true },
    });
    expect(inTransitGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['productId'],
      where: expect.objectContaining({
        productId: { in: ['RB-1'] },
        status: 'pending',
        order: {
          domesticOrderNo: { not: '' },
          status: { in: ['waiting_upload', 'waiting_inbound'] },
        },
      }),
      _sum: { qty: true },
    }));
    expect(result.sourceSummary.includesLegacyData).toBe(includesLegacyData);
  });

  it('exports factory recommendations as Excel', async () => {
    const service = new RakutenRmsApiService(
      {} as PrismaService, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService,
    );
    jest.spyOn(service, 'getStoreDashboard').mockResolvedValue({
      selectedShop: { shopName: '乐天-1号店' },
      dashboard: { factoryRecommendations: { rows: [{
        skuCode: 'RB-1', productId: 'RB-1', productName: '测试产品',
        unitCount7d: 3, unitCount30d: 10, unitCount90d: 20,
        forecastDailyQty: 0.4, targetDemandQty: 20, pendingShipmentQty: 2,
        stockQty: 5, inTransitQty: 4, suggestedFactoryQty: 13,
      }] } },
    });

    const file = await service.buildStoreFactoryRecommendationsExcel('7');

    expect(file.fileName).toMatch(/^乐天工厂备货建议-全部店铺-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(file.content.length).toBeGreaterThan(100);
  });
});
