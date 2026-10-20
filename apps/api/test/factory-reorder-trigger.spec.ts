import { buildRakutenStoreDashboard } from '../src/rakuten-rms-api/rakuten-store-dashboard';

function recommendations(sales = 25, stock = 0, transit = 20, arrival = '2026-09-05', pending = 0) {
  return (buildRakutenStoreDashboard({
    now: new Date('2026-08-21T12:00:00Z'), days: 90,
    products: [{ productId: '8784', productName: '内胆包', stockQty: stock }],
    orders: [
      { orderId: 'sales', skuCode: '8784', productName: '内胆包', orderQuantity: sales - pending,
        orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
        shipmentNo: 'TRACK', trackingIsDelivered: false, salesAmount: 0 },
      ...(pending ? [{ orderId: 'pending', skuCode: '8784', productName: '内胆包', orderQuantity: pending,
        orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
        shipmentNo: null, trackingIsDelivered: false, salesAmount: 0 }] : []),
    ],
    inTransit: transit ? [{ productId: '8784', inTransitQty: transit, expectedArrivalDate: arrival }] : [],
  }) as any).factoryRecommendations;
}

describe('factory reorder trigger', () => {
  it('recommends zero for the pictured 25 sales and 20 in transit, while retaining the shortage warning', () => {
    const result = recommendations();
    expect(result.rows[0]).toMatchObject({
      planningStockQty: 20, reorderPointQty: 12.5, restockRequired: false,
      remainingQtyAtArrival: 11.667, shortageQtyBeforeArrival: 5,
      targetStockQty: 25, suggestedFactoryQty: 0,
    });
    expect(result.totalSuggestedFactoryQty).toBe(0);
    expect(result.recommendationCount).toBe(0);
    expect(result.shortageProductCount).toBe(1);
  });

  it('tops up to 90 days only when supply is below 45 days, without adding another 45 days of demand', () => {
    const result = recommendations(25, 0, 10);
    expect(result.rows[0]).toMatchObject({ planningStockQty: 10, reorderPointQty: 12.5, restockRequired: true, suggestedFactoryQty: 15 });
  });

  it.each([[44, 46], [45, 0], [46, 0]])('handles stock %s around the exact 45-day trigger', (stock, expected) => {
    const result = recommendations(90, stock, 0);
    expect(result.totalSuggestedFactoryQty).toBe(expected);
    expect(result.recommendationCount).toBe(expected > 0 ? 1 : 0);
  });

  it('subtracts pending shipments when determining supply and order quantity', () => {
    const result = recommendations(25, 10, 0, '2026-09-05', 1);
    expect(result.rows[0]).toMatchObject({ planningStockQty: 9, targetStockQty: 25, suggestedFactoryQty: 16 });
  });

  it('does not let a late shipment cover the current 45-day waiting period', () => {
    const result = recommendations(25, 0, 20, '2026-10-06');
    expect(result.rows[0]).toMatchObject({ planningStockQty: 0, laterInTransitQty: 20, suggestedFactoryQty: 25 });
  });

  it('retains overdue verification instead of making a definite order recommendation', () => {
    const result = recommendations(25, 0, 20, '2026-08-20');
    expect(result.rows[0]).toMatchObject({ requiresTransitVerification: true, suggestedFactoryQty: null });
    expect(result.totalSuggestedFactoryQty).toBe(0);
  });
});
