import { resolveInboundExpectedArrivalDate } from '../src/common/inbound-expected-arrival';
import { buildRakutenStoreDashboard } from '../src/rakuten-rms-api/rakuten-store-dashboard';

describe('inbound arrival estimate', () => {
  it.each([
    ['2026-08-21T00:00:00.000Z', '2026-10-05'],
    ['2026-08-20T16:00:00.000Z', '2026-10-05'],
    ['2026-12-20T00:00:00.000Z', '2027-02-03'],
    ['2028-02-01T00:00:00.000Z', '2028-03-17'],
  ])('adds 45 days to the Tokyo registration date of %s', (registeredAt, expected) => {
    expect(resolveInboundExpectedArrivalDate({ registeredAt })).toBe(expected);
  });

  it('prioritizes a manually maintained date', () => {
    expect(resolveInboundExpectedArrivalDate({ registeredAt: '2026-08-21', expectedArrivalDate: '2026-09-01' })).toBe('2026-09-01');
  });

  it.each([undefined, null, 'invalid'])('does not invent a date without valid registration data (%s)', (registeredAt) => {
    expect(resolveInboundExpectedArrivalDate({ registeredAt })).toBeNull();
  });
});

function recommendations(now: string, registeredAt: string) {
  return (buildRakutenStoreDashboard({
    now: new Date(now), days: 90,
    products: [{ productId: '8699', productName: '内胆包', stockQty: 0 }],
    orders: [52, 1].map((qty, i) => ({
      orderId: `sale-${i}`, skuCode: '8699', productName: '内胆包', orderQuantity: qty,
      orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
      shipmentNo: i ? null : 'TRACK', trackingIsDelivered: false, salesAmount: 0,
    })),
    inTransit: [{ productId: '8699', inTransitQty: 60, registeredAt }],
  }) as any).factoryRecommendations;
}

describe('factory planning with default inbound dates', () => {
  it('does not reorder the pictured 60 units against 53 units of 90-day demand', () => {
    const result = recommendations('2026-08-21T12:00:00.000Z', '2026-08-21T00:00:00.000Z');
    expect(result.rows[0]).toMatchObject({
      inTransitQty: 60, eligibleInTransitQty: 60, unverifiedInTransitQty: 0,
      pendingShipmentQty: 1, remainingQtyAtArrival: 59, targetStockQty: 53,
      suggestedFactoryQty: 0, shortageQtyBeforeArrival: 28, requiresTransitVerification: false,
    });
    expect(result.recommendationCount).toBe(0);
  });

  it('keeps the registration-based date when the dashboard advances', () => {
    const first = recommendations('2026-08-21T12:00:00.000Z', '2026-08-21');
    const next = recommendations('2026-08-22T12:00:00.000Z', '2026-08-21');
    expect(next.rows[0].remainingQtyAtArrival).toBeLessThan(first.rows[0].remainingQtyAtArrival);
    expect(next.rows[0].eligibleInTransitQty).toBe(60);
  });

  it('shows overdue transit for verification without asserting a new order quantity', () => {
    const result = recommendations('2026-08-21T12:00:00.000Z', '2026-07-06');
    expect(result.rows[0]).toMatchObject({
      overdueInTransitQty: 60, unverifiedInTransitQty: 60, eligibleInTransitQty: 0,
      suggestedFactoryQty: null, requiresTransitVerification: true,
    });
    expect(result.totalSuggestedFactoryQty).toBe(0);
    expect(result.unverifiedTransitProductCount).toBe(1);
  });
});
