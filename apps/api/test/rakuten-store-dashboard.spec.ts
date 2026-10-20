import * as XLSX from 'xlsx';
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
      targetStockDays: 90, minimumAverageDailySalesExclusive: 0.05,
      recommendationCount: 1, totalSuggestedFactoryQty: 11,
    });
    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      productId: 'RB-1', unitCount90d: 14, averageDaily90d: 0.156,
      stockQty: 4, inTransitQty: 3, pendingShipmentQty: 1, effectiveStockQty: 3,
      productionLogisticsDemandQty: 7, remainingQtyAtArrival: 0,
      targetStockQty: 14, suggestedFactoryQty: 11,
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
          orderId: 'threshold-product', skuCode: 'RB-2', productName: '阈值产品', orderQuantity: 4,
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

  it.each([
    [4, false],
    [4.5, false],
    [5, true],
    [9, true],
  ])('applies the strict daily sales threshold to %s units in 90 days', (quantity, included) => {
    const dashboard = buildRakutenStoreDashboard({
      now: new Date('2026-08-21T12:00:00.000Z'),
      days: 90,
      products: [{ productId: 'RB-1', productName: '产品', stockQty: 0 }],
      orders: [{
        orderId: 'threshold-order', skuCode: 'RB-1', productName: '产品', orderQuantity: quantity,
        orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
        shipmentNo: 'TRACK-1', trackingIsDelivered: false, salesAmount: 0,
      }],
    }) as any;

    expect(dashboard.factoryRecommendations.rows).toHaveLength(included ? 1 : 0);
  });

  it('excludes confirmed in-transit stock and subtracts pending shipments from effective stock', () => {
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
      effectiveStockQty: 2, productionLogisticsDemandQty: 9, remainingQtyAtArrival: 0,
      targetStockQty: 18, suggestedFactoryQty: 16,
    });
  });

  it.each([
    ['2026-08-21', 90, 45, 0, null],
    ['2026-08-31', 90, 55, 10, '2026-08-21'],
    ['2026-10-05', 90, 90, 45, '2026-08-21'],
    ['2026-10-06', 90, 0, 45, '2026-08-21'],
    [null, 90, 0, 45, '2026-08-21'],
    ['2026-08-20', 90, 0, 45, '2026-08-21'],
    ['2026-02-30', 90, 0, 45, '2026-08-21'],
  ])('applies transit on %s without covering earlier shortages', (date, qty, remaining, shortage, stockoutDate) => {
    const dashboard = buildRakutenStoreDashboard({
      now: new Date('2026-08-20T23:00:00.000Z'), days: 90,
      products: [{ productId: 'RB-1', productName: '产品', stockQty: 0 }],
      orders: [{
        orderId: 'sale', skuCode: 'RB-1', productName: '产品', orderQuantity: 90,
        orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
        shipmentNo: 'TRACK', trackingIsDelivered: false, salesAmount: 0,
      }],
      inTransit: [{ productId: 'RB-1', inTransitQty: qty, expectedArrivalDate: date }],
    }) as any;
    if (date === '2026-08-21') {
      expect(dashboard.factoryRecommendations.rows).toHaveLength(0);
      expect(dashboard.factoryRecommendations.recommendationCount).toBe(0);
      return;
    }
    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      effectiveStockQty: 0, remainingQtyAtArrival: remaining,
      shortageQtyBeforeArrival: shortage, expectedStockoutDate: stockoutDate,
      factoryArrivalDate: '2026-10-05', suggestedFactoryQty: date === '2026-08-20' ? null : (date && date >= '2026-08-21' && date <= '2026-10-05' ? 0 : 90),
    });
    expect(dashboard.factoryRecommendations.recommendationCount).toBe((!date || date === '2026-02-30' || date === '2026-10-06') ? 1 : 0);
  });

  it('aggregates multiple arrivals and separately reports unverified and later transit', () => {
    const dashboard = buildRakutenStoreDashboard({
      now: new Date('2026-08-21T12:00:00.000Z'), days: 90,
      products: [{ productId: 'RB-1', productName: '产品', stockQty: 10 }],
      orders: [{
        orderId: 'sale', skuCode: 'RB-1', productName: '产品', orderQuantity: 90,
        orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
        shipmentNo: 'TRACK', trackingIsDelivered: false, salesAmount: 0,
      }],
      inTransit: [
        { productId: 'RB-1', inTransitQty: 20, expectedArrivalDate: '2026-08-31' },
        { productId: 'RB-1', inTransitQty: 10, expectedArrivalDate: '2026-08-31' },
        { productId: 'RB-1', inTransitQty: 10, expectedArrivalDate: '2026-09-30' },
        { productId: 'RB-1', inTransitQty: 7 },
        { productId: 'RB-1', inTransitQty: 8, expectedArrivalDate: '2026-10-06' },
      ],
    }) as any;
    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      inTransitQty: 55, eligibleInTransitQty: 40, unverifiedInTransitQty: 7,
      laterInTransitQty: 8, remainingQtyAtArrival: 5, shortageQtyBeforeArrival: 0,
      expectedStockoutDate: null, suggestedFactoryQty: 0,
    });
  });

  it('uses arriving goods to fill existing pending shipment reservations first', () => {
    const dashboard = buildRakutenStoreDashboard({
      now: new Date('2026-08-21T12:00:00.000Z'), days: 90,
      products: [{ productId: 'RB-1', productName: '产品', stockQty: 0 }],
      orders: [{
        orderId: 'pending', skuCode: 'RB-1', productName: '产品', orderQuantity: 90,
        orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
        shipmentNo: null, trackingIsDelivered: false, salesAmount: 0,
      }],
      inTransit: [{ productId: 'RB-1', inTransitQty: 100, expectedArrivalDate: '2026-08-21' }],
    }) as any;
    expect(dashboard.factoryRecommendations.rows[0]).toMatchObject({
      effectiveStockQty: -90, remainingQtyAtArrival: 0, suggestedFactoryQty: 80,
      shortageQtyBeforeArrival: 125, expectedStockoutDate: '2026-08-21',
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
    const productFindMany = jest.fn().mockResolvedValue([{
      productId: 'RB-1', productName: '肩带成品', productType: '肩带', stockQty: 0,
      bomComponents: [
        { componentProductId: 'BODY', quantity: 1, componentProduct: {
          productId: 'BODY', productName: '本体', productType: '肩带本体', stockQty: 20, status: 1,
        } },
        { componentProductId: 'HOOK', quantity: 2, componentProduct: {
          productId: 'HOOK', productName: '配件', productType: '肩带配件', stockQty: 30, status: 1,
        } },
      ],
    }]);
    const inTransitFindMany = jest.fn().mockResolvedValue([]);
    const factoryOrderFindMany = jest.fn().mockResolvedValue([{
      rmsConnectionId: 8n, orderId: 'factory-order-1', skuCode: 'RB-1', productName: '产品',
      orderQuantity: 90, orderStatusText: '300', orderImportedDate: new Date(Date.now() - 86400000),
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
      batchInboundItem: { findMany: inTransitFindMany },
      batchInboundOrder: { findMany: jest.fn().mockResolvedValue([{
        expectedArrivalDate: null, createdAt: new Date(),
        plannedItems: [{ productId: 'BODY', qty: 60 }],
        items: [{ productId: 'BODY', qty: 20 }],
      }]) },
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
      select: expect.objectContaining({ productId: true, productName: true, productType: true, stockQty: true,
        bomComponents: expect.any(Object),
      }),
    });
    expect(inTransitFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        productId: { in: ['BODY', 'HOOK', 'RB-1'] },
        status: 'pending',
        order: {
          isPreRegistered: false,
          domesticOrderNo: { not: '' },
          status: { in: ['waiting_upload', 'waiting_inbound'] },
        },
      }),
      select: { productId: true, qty: true, order: { select: { expectedArrivalDate: true, createdAt: true } } },
    }));
    expect(result.sourceSummary.includesLegacyData).toBe(includesLegacyData);
    expect(result.dashboard.factoryRecommendations.rows.find((row: any) => row.productId === 'BODY')).toMatchObject({
      inTransitQty: 40, suggestedFactoryQty: 0,
    });
  });

  it('exports an overdue verification notice instead of a numeric order quantity', async () => {
    const service = new RakutenRmsApiService(
      {} as PrismaService, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService,
    );
    jest.spyOn(service, 'getStoreDashboard').mockResolvedValue({
      selectedShop: { shopName: '乐天-1号店' },
      dashboard: { factoryRecommendations: { rows: [{
        productId: '8699', overdueInTransitQty: 60, unverifiedInTransitQty: 60,
        requiresTransitVerification: true, suggestedFactoryQty: null,
      }] } },
    });
    const file = await service.buildStoreFactoryRecommendationsExcel('7');
    const workbook = XLSX.read(file.content, { type: 'buffer' });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['乐天工厂备货建议'])[0]).toMatchObject({
      '逾期在途': 60, '建议工厂备货数量': '到货逾期、需核实',
    });
  });

  it('exports factory recommendations as Excel', async () => {
    const service = new RakutenRmsApiService(
      {} as PrismaService, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService,
    );
    jest.spyOn(service, 'getStoreDashboard').mockResolvedValue({
      selectedShop: { shopName: '乐天-1号店' },
      dashboard: { factoryRecommendations: { rows: [{
        skuCode: 'RB-1', productId: 'RB-1', productName: '测试产品',
        productType: '肩带本体', sourceProductIds: ['STRAP-A', 'STRAP-B'], finishedStockDeductionQty: 10,
        unitCount90d: 20, averageDaily90d: 0.222, pendingShipmentQty: 2,
        stockQty: 5, inTransitQty: 4, effectiveStockQty: 3,
        productionLogisticsDemandQty: 10, remainingQtyAtArrival: 0,
        targetStockQty: 20, suggestedFactoryQty: 20,
        eligibleInTransitQty: 0, unverifiedInTransitQty: 4, laterInTransitQty: 0,
        expectedStockoutDate: '2026-08-30', factoryArrivalDate: '2026-10-05', shortageQtyBeforeArrival: 7,
      }], issues: [{ productId: 'STRAP-C', reason: '肩带组成配置无效' }] } },
    });

    const file = await service.buildStoreFactoryRecommendationsExcel('7');

    expect(file.fileName).toMatch(/^乐天工厂备货建议-全部店铺-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const workbook = XLSX.read(file.content, { type: 'buffer' });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['乐天工厂备货建议'])[0]).toMatchObject({
      '待核实在途': 4, '预计缺货日期': '2026-08-30', '到货前缺口': 7,
      '新备货到仓日': '2026-10-05', '建议工厂备货数量': 20,
      '产品类型': '肩带本体', '需求来源成品': 'STRAP-A、STRAP-B', '成品抵扣需求': 10,
    });
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['待核实事项'])).toEqual([
      { '产品ID': 'STRAP-C', '待核实事项': '肩带组成配置无效' },
    ]);
  });
});
