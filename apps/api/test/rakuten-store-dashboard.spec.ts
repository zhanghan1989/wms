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
      orders: [
        {
          orderId: 'current-1', skuCode: 'RB-1', productName: '乐天产品', orderQuantity: 13,
          orderStatusText: '300', orderImportedAtRaw: '2026-08-20 10:00:00', dispatchMode: 'overseas',
          shipmentNo: 'TRACK-1', trackingIsDelivered: true,
          rawPayload: { rmsItem: { price: 1200, subtotalPrice: 15600 } },
        },
        {
          orderId: 'previous-1', skuCode: 'RB-1', productName: '系统产品', orderQuantity: 1,
          orderStatusText: '300', orderImportedAtRaw: '2026-08-10 10:00:00', dispatchMode: 'overseas',
          shipmentNo: null, trackingIsDelivered: false, rawPayload: { 単価: '1000' },
        },
        {
          orderId: 'cancelled', skuCode: 'RB-1', productName: '系统产品', orderQuantity: 99,
          orderStatusText: '900', orderImportedAtRaw: '2026-08-20 10:00:00', dispatchMode: 'overseas',
          shipmentNo: null, trackingIsDelivered: false, rawPayload: { 単価: '1000' },
        },
      ],
    }) as any;

    expect(dashboard.summary).toMatchObject({ orderCount: 1, unitCount: 13, salesAmount: 15600 });
    expect(dashboard.fulfillment).toMatchObject({ shippedOrderCount: 1, deliveredOrderCount: 1 });
    expect(dashboard.factoryRecommendations).toMatchObject({
      periodDays: 90, minimumUnitCountExclusive: 10, recommendationCount: 1,
      totalSuggestedFactoryQty: 10,
    });
    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      productId: 'RB-1', unitCount90d: 14, stockQty: 4, suggestedFactoryQty: 10,
    });
  });

  it.each([
    ['乐天-1号店', { OR: [{ rmsConnectionId: 7n }, { rmsConnectionId: null }] }, true],
    ['乐天-2号店', { rmsConnectionId: 7n }, false],
  ])('uses the expected historical scope for %s', async (shopName, expectedWhere, includesLegacyData) => {
    const orderFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([{
        id: 7n, shopId: 3n, shop: { id: 3n, name: shopName }, status: 1, syncOrders: true,
        lastOrdersSyncedAt: null, lastSuccessfulSyncAt: null, lastSyncError: null, licenseExpiresAt: null,
      }]) },
      rakutenOrderRecord: { findMany: orderFindMany },
      masterProduct: { findMany: jest.fn().mockResolvedValue([]) },
      rakutenRmsSyncRun: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(
      prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService,
    );

    const result = await service.getStoreDashboard('7', '30') as any;

    expect(orderFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere }));
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
        unitCount90d: 20, stockQty: 5, suggestedFactoryQty: 15,
      }] } },
    });

    const file = await service.buildStoreFactoryRecommendationsExcel('7');

    expect(file.fileName).toMatch(/^乐天工厂备货建议-乐天-1号店-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(file.content.length).toBeGreaterThan(100);
  });
});
