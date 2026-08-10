import { classifyNoSalesInventoryAge } from '../src/inventory/inventory-dashboard';
import { InventoryService } from '../src/inventory/inventory.service';

describe('inventory dashboard no-sales age classification', () => {
  const now = new Date('2026-07-22T12:00:00.000Z');

  it('keeps newly stocked products in observation until 90 complete days', () => {
    expect(classifyNoSalesInventoryAge(new Date('2026-07-21T12:00:00.000Z'), now)).toEqual({
      status: 'observing',
      observedDays: 1,
      remainingDays: 89,
    });
    expect(classifyNoSalesInventoryAge(new Date('2026-04-23T12:00:01.000Z'), now)).toEqual({
      status: 'observing',
      observedDays: 89,
      remainingDays: 1,
    });
  });

  it('marks a product obsolete only after 90 complete days without sales', () => {
    expect(classifyNoSalesInventoryAge(new Date('2026-04-23T12:00:00.000Z'), now)).toEqual({
      status: 'obsolete',
      observedDays: 90,
      remainingDays: 0,
    });
  });

  it('does not treat products with an unknown first-stock date as obsolete', () => {
    expect(classifyNoSalesInventoryAge(null, now)).toEqual({
      status: 'unknown',
      observedDays: null,
      remainingDays: null,
    });
  });

  it('rejects an invalid explicit FBA snapshot id before loading dashboard data', async () => {
    const service = new InventoryService({} as never, {} as never);
    await expect(service.getOverviewDashboard({ fbaSnapshotId: 'invalid' })).rejects.toThrow(
      'FBA销量快照编号无效',
    );
  });

  it('splits legacy Rakuten combo rows without expanding already-split rows again', async () => {
    const registeredAt = new Date();
    registeredAt.setDate(registeredAt.getDate() - 1);
    const prisma = {
      user: { count: jest.fn().mockResolvedValue(0) },
      shelf: { count: jest.fn().mockResolvedValue(0) },
      box: { count: jest.fn().mockResolvedValue(0) },
      batchInboundOrder: { count: jest.fn().mockResolvedValue(0) },
      masterProduct: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([
          { productId: 'P1', productName: '产品1', stockQty: 10, firstStockedAt: null },
          { productId: 'P2', productName: '产品2', stockQty: 10, firstStockedAt: null },
        ]),
      },
      sku: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1n, sku: 'FBA-P1', fbmSku: 'CHANNEL-CONFLICT', rbSku: null, productId: 'P1' },
          { id: 2n, sku: 'CHANNEL-CONFLICT', fbmSku: 'FBM-P2', rbSku: null, productId: 'P2' },
        ]),
      },
      fbaReplenishment: { findMany: jest.fn().mockResolvedValue([]) },
      batchInboundItem: { groupBy: jest.fn().mockResolvedValue([]) },
      rakutenOrderRecord: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1n,
            orderId: 'legacy-combo',
            skuCode: 'zh-old',
            isComboOrder: false,
            comboOrderSku: null,
            setComponentSkuCode: null,
            orderQuantity: 2,
            shipmentNoRegisteredAt: registeredAt,
          },
          {
            id: 2n,
            orderId: 'expanded-combo',
            skuCode: 'P1',
            isComboOrder: true,
            comboOrderSku: 'zh-new',
            setComponentSkuCode: 'zh-new',
            orderQuantity: 3,
            shipmentNoRegisteredAt: registeredAt,
          },
        ]),
      },
      amazonOrderRecord: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 10n,
            orderId: 'fbm-1',
            orderItemId: 'item-1',
            sku: 'FBM-P2',
            rawPayload: { item: { orderItemId: 'item-1' } },
            quantityPurchased: 2,
            shipmentNoRegisteredAt: null,
            purchaseDateRaw: registeredAt.toISOString(),
            amazonLastUpdatedAt: registeredAt,
            orderStatus: 'SHIPPED',
            sourceKind: 'sp_api',
          },
          {
            id: 11n,
            orderId: 'fbm-1',
            orderItemId: 'manual-item-1',
            sku: 'FBM-P2',
            rawPayload: { item: { orderItemId: 'item-1' } },
            quantityPurchased: 3,
            shipmentNoRegisteredAt: registeredAt,
            purchaseDateRaw: registeredAt.toISOString(),
            amazonLastUpdatedAt: null,
            orderStatus: null,
            sourceKind: 'file',
          },
          {
            id: 12n,
            orderId: 'fbm-2',
            orderItemId: 'item-2',
            sku: 'FBM-P2',
            rawPayload: { item: { orderItemId: 'item-2' } },
            quantityPurchased: 4,
            shipmentNoRegisteredAt: null,
            purchaseDateRaw: registeredAt.toISOString(),
            amazonLastUpdatedAt: registeredAt,
            orderStatus: 'SHIPPED',
            sourceKind: 'sp_api',
          },
        ]),
      },
      manualOrderRecord: { findMany: jest.fn().mockResolvedValue([]) },
      rakutenComboProduct: {
        findMany: jest.fn().mockResolvedValue([
          { comboName: 'zh-old', items: [{ productId: 'P1' }, { productId: 'P2' }] },
          { comboName: 'zh-new', items: [{ productId: 'P1' }, { productId: 'P2' }] },
        ]),
      },
      fbaSalesSnapshot: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({
          id: 10n,
          fileName: 'fba.csv',
          inventoryFileName: 'fba-inventory.csv',
          inventorySnapshotDate: new Date('2026-07-22T00:00:00.000Z'),
          inventoryRows: 3,
          periodDays: 90,
          periodStart: new Date('2026-04-24T00:00:00.000Z'),
          periodEnd: new Date('2026-07-22T00:00:00.000Z'),
          totalRows: 3,
          fbaRows: 0,
          fbmRows: 1,
          unmatchedRows: 1,
          ambiguousRows: 0,
          fbaOrderedQty: 10,
          fbaAvailableQty: 4,
          fbaInboundQty: 2,
          fbaReservedQty: 1,
          fbaUnfulfillableQty: 3,
          createdAt: registeredAt,
          items: [
            {
              sellerSku: 'FBA-P1', productId: null, channel: 'unmatched', orderedQty: 10,
              fbaAvailableQty: 4, fbaInboundQty: 2, fbaReservedQty: 1, fbaUnfulfillableQty: 3,
            },
            {
              sellerSku: 'FBM-P2', productId: 'P2', channel: 'fbm', orderedQty: 99,
              fbaAvailableQty: 99, fbaInboundQty: 99, fbaReservedQty: 0, fbaUnfulfillableQty: 0,
            },
            {
              sellerSku: 'CHANNEL-CONFLICT', productId: 'P2', channel: 'fba', orderedQty: 77,
              fbaAvailableQty: 77, fbaInboundQty: 77, fbaReservedQty: 0, fbaUnfulfillableQty: 0,
            },
          ],
        }),
      },
    };
    const service = new InventoryService(prisma as never, {} as never);

    const dashboard = (await service.getOverviewDashboard()) as any;

    expect(prisma.sku.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 1,
          productId: { not: null },
          masterProduct: { is: { status: 1 } },
        },
      }),
    );

    expect(dashboard.demand.systemOrderQty90d).toBe(14);
    expect(dashboard.demand.rakutenOrderedQty90d).toBe(7);
    expect(dashboard.demand.amazonFbmOrderedQty90d).toBe(7);
    expect(dashboard.demand.manualOrderedQty90d).toBe(0);
    expect(dashboard.demand.outboundProductCount90d).toBe(2);
    expect(dashboard.demand.unmatchedSystemOrderRowCount90d).toBe(0);
    expect(dashboard.demand.topSkus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: 'P1', systemOrderQty90d: 5 }),
        expect.objectContaining({ productId: 'P2', systemOrderQty90d: 9 }),
      ]),
    );
    expect(dashboard.dataSources.fbm).toEqual(expect.objectContaining({ apiRows90d: 1, manualRows90d: 1 }));

    const dashboardWithFba = (await service.getOverviewDashboard({
      includeFba: true,
      fbaSnapshotId: '10',
    })) as any;
    expect(dashboardWithFba.demand.fbaOrderedQty90d).toBe(10);
    expect(dashboardWithFba.demand.outboundQty30dCalculated).toBeCloseTo(
      dashboardWithFba.demand.outboundQty90d / 3,
    );
    expect(dashboardWithFba.obsolete.noSales90dCount).toBe(
      dashboardWithFba.obsolete.noSales90dSkus.length,
    );
    expect(dashboardWithFba.obsolete.noSales90dStockQty).toBe(
      dashboardWithFba.obsolete.noSales90dSkus.reduce(
        (sum: number, item: { totalStock: number }) => sum + item.totalStock,
        0,
      ),
    );
    expect(dashboardWithFba.production.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: 'P1',
          systemOrderQty90d: 5,
          fbaOrderedQty90d: 10,
          totalOrderQty90d: 15,
          fbaAvailableQty: 4,
          fbaInboundQty: 2,
          fbaReservedQty: 1,
          fbaUnfulfillableQty: 3,
          suggestedProductionQty: 4,
        }),
      ]),
    );
  });
});
