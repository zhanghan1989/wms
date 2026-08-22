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
      productionDays: 30, transportDays: 15, productionLogisticsDays: 45,
      targetStockDays: 90, minimumAverageDailySalesExclusive: 0.1,
      recommendationCount: 1, totalSuggestedFactoryQty: 14,
    });
    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      productId: 'RB-1', unitCount90d: 14, averageDaily90d: 0.156,
      stockQty: 4, inTransitQty: 3, pendingShipmentQty: 1, effectiveStockQty: 6,
      productionLogisticsDemandQty: 7, remainingQtyAtArrival: 0,
      targetStockQty: 14, suggestedFactoryQty: 14,
    });
  });

  it('returns every natural day in a 90-day sales trend and fills missing days with zero', () => {
    const dashboard = buildRakutenStoreDashboard({
      now: new Date('2026-08-21T12:00:00.000Z'),
      days: 90,
      products: [],
      orders: [{
        orderId: 'current-1', skuCode: 'RB-1', productName: '乐天产品', orderQuantity: 2,
        orderStatusText: '300', orderImportedAtRaw: '2026-08-20 10:00:00', dispatchMode: 'overseas',
        shipmentNo: 'TRACK-1', trackingIsDelivered: false, salesAmount: 2400,
      }],
    }) as any;

    expect(dashboard.daily).toHaveLength(90);
    expect(dashboard.daily[0]).toEqual({
      date: '2026-05-24', orderCount: 0, unitCount: 0, salesAmount: 0,
    });
    expect(dashboard.daily[88]).toEqual({
      date: '2026-08-20', orderCount: 1, unitCount: 2, salesAmount: 2400,
    });
    expect(dashboard.daily[89]).toEqual({
      date: '2026-08-21', orderCount: 0, unitCount: 0, salesAmount: 0,
    });
  });

  it('uses all Rakuten shop orders for factory planning while keeping store metrics selected', () => {
    const dashboard = buildRakutenStoreDashboard({
      now: new Date('2026-08-21T12:00:00.000Z'),
      days: 7,
      orders: [],
      factoryOrders: [
        {
          orderId: 'other-shop-1', skuCode: 'RB-1', productName: '产品', orderQuantity: 10,
          orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
          shipmentNo: 'TRACK-1', trackingIsDelivered: false, salesAmount: 0,
        },
        {
          orderId: 'threshold-product', skuCode: 'RB-2', productName: '阈值产品', orderQuantity: 9,
          orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
          shipmentNo: 'TRACK-2', trackingIsDelivered: false, salesAmount: 0,
        },
      ],
      products: [
        { productId: 'RB-1', productName: '产品', stockQty: 0 },
        { productId: 'RB-2', productName: '阈值产品', stockQty: 0 },
      ],
    }) as any;

    expect(dashboard.summary).toMatchObject({ orderCount: 0, unitCount: 0 });
    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      unitCount90d: 10, averageDaily90d: 0.111, effectiveStockQty: 0,
      productionLogisticsDemandQty: 5, remainingQtyAtArrival: 0,
      targetStockQty: 10, suggestedFactoryQty: 10,
    });
    expect(dashboard.factoryRecommendations.rows).toHaveLength(1);
  });

  it('keeps confirmed in-transit stock and subtracts pending shipments from effective stock', () => {
    const dashboard = buildRakutenStoreDashboard({
      now: new Date('2026-08-21T12:00:00.000Z'),
      days: 90,
      orders: [],
      factoryOrders: [{
        orderId: 'pending-order', skuCode: 'RB-1', productName: '产品', orderQuantity: 18,
        orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
        shipmentNo: null, trackingIsDelivered: false, salesAmount: 0,
      }],
      products: [{ productId: 'RB-1', productName: '产品', stockQty: 20 }],
      inTransit: [{ productId: 'RB-1', inTransitQty: 8 }],
    }) as any;

    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      averageDaily90d: 0.2, stockQty: 20, inTransitQty: 8, pendingShipmentQty: 18,
      effectiveStockQty: 10, productionLogisticsDemandQty: 9, remainingQtyAtArrival: 1,
      targetStockQty: 18, suggestedFactoryQty: 17,
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
        unitCount90d: 20, averageDaily90d: 0.222, pendingShipmentQty: 2,
        stockQty: 5, inTransitQty: 4, effectiveStockQty: 7,
        productionLogisticsDemandQty: 10, remainingQtyAtArrival: 0,
        targetStockQty: 20, suggestedFactoryQty: 20,
      }] } },
    });

    const file = await service.buildStoreFactoryRecommendationsExcel('7');

    expect(file.fileName).toMatch(/^乐天工厂备货建议-全部店铺-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(file.content.length).toBeGreaterThan(100);
  });
});
