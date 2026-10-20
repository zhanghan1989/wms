import { buildRakutenStoreDashboard } from '../src/rakuten-rms-api/rakuten-store-dashboard';
import { FactoryProduct } from '../src/rakuten-rms-api/rakuten-factory-materials';

const body: FactoryProduct = { productId: 'BODY', productName: '共用本体', productType: '肩带本体', stockQty: 50, status: 1 };
const hookA: FactoryProduct = { productId: 'HOOK-A', productName: '扣具A', productType: '肩带配件', stockQty: 30, status: 1 };
const hookB: FactoryProduct = { productId: 'HOOK-B', productName: '扣具B', productType: '肩带配件', stockQty: 0, status: 1 };
function strap(id: string, hook: FactoryProduct, stockQty: number): FactoryProduct {
  return { productId: id, productName: id, productType: '肩带', stockQty, bomComponents: [
    { componentProductId: body.productId, quantity: 1, componentProduct: body },
    { componentProductId: hook.productId, quantity: 2, componentProduct: hook },
  ] };
}
function dashboard(products: FactoryProduct[], quantities: number[], extra: Record<string, unknown> = {}) {
  return (buildRakutenStoreDashboard({
    now: new Date('2026-08-21T12:00:00.000Z'), days: 90,
    products: [body, hookA, hookB, ...products],
    orders: products.map((product, index) => ({
      orderId: `order-${index}`, skuCode: product.productId, productName: product.productName,
      orderQuantity: quantities[index], orderStatusText: '300', orderImportedAtRaw: '2026-08-20',
      dispatchMode: 'overseas', shipmentNo: 'TRACK', trackingIsDelivered: false, salesAmount: 0,
    })), ...extra,
  }) as any).factoryRecommendations;
}
const byId = (result: any, id: string) => result.rows.find((row: any) => row.productId === id);

describe('Rakuten factory material recommendations', () => {
  it('combines shared bodies once and multiplies accessory demand by BOM quantity', () => {
    const result = dashboard([strap('STRAP-A', hookA, 20), strap('STRAP-B', hookB, 0)], [90, 90]);
    expect(result.rows.map((row: any) => row.productId).sort()).toEqual(['BODY', 'HOOK-A', 'HOOK-B']);
    expect(byId(result, 'BODY')).toMatchObject({
      productType: '肩带本体', unitCount90d: 180, stockQty: 50,
      sourceProductIds: ['STRAP-A', 'STRAP-B'], finishedStockDeductionQty: 20,
      productionLogisticsDemandQty: 70, remainingQtyAtArrival: 0,
      targetStockQty: 160, suggestedFactoryQty: 110,
    });
    expect(byId(result, 'HOOK-A')).toMatchObject({
      unitCount90d: 180, finishedStockDeductionQty: 40,
      productionLogisticsDemandQty: 50, remainingQtyAtArrival: 0, targetStockQty: 140, suggestedFactoryQty: 110,
    });
    expect(byId(result, 'HOOK-B')).toMatchObject({ unitCount90d: 180, suggestedFactoryQty: 180 });
  });

  it('does not dismantle excess finished inventory to cover another strap variant', () => {
    const result = dashboard([strap('STRAP-A', hookA, 200), strap('STRAP-B', hookB, 0), { ...body, stockQty: 0 }], [90, 90, 0]);
    expect(byId(result, 'BODY')).toMatchObject({
      finishedStockDeductionQty: 90, productionLogisticsDemandQty: 45,
      targetStockQty: 90, remainingQtyAtArrival: 0, suggestedFactoryQty: 90,
    });
    expect(byId(result, 'HOOK-A')).toBeUndefined();
    expect(byId(result, 'HOOK-B').suggestedFactoryQty).toBe(180);
  });

  it('deducts finished stock from pending shipments before projecting material consumption', () => {
    const parent = strap('STRAP-A', hookA, 20);
    const result = dashboard([parent], [90], { factoryOrders: [{
      orderId: 'pending', skuCode: parent.productId, productName: '肩带', orderQuantity: 90,
      orderStatusText: '300', orderImportedAtRaw: '2026-08-20', dispatchMode: 'overseas',
      shipmentNo: null, trackingIsDelivered: false, salesAmount: 0,
    }] });
    expect(byId(result, 'BODY')).toMatchObject({
      pendingShipmentQty: 70, effectiveStockQty: -20, productionLogisticsDemandQty: 45,
      shortageQtyBeforeArrival: 65, suggestedFactoryQty: 110,
    });
    expect(byId(result, 'HOOK-A')).toMatchObject({ pendingShipmentQty: 140 });
  });

  it('combines direct material sales with BOM demand without duplicating material stock', () => {
    const result = dashboard([strap('STRAP-A', hookA, 20), body], [90, 90]);
    expect(byId(result, 'BODY')).toMatchObject({
      unitCount90d: 180, stockQty: 50, productionLogisticsDemandQty: 70,
      remainingQtyAtArrival: 0, targetStockQty: 160, suggestedFactoryQty: 110,
    });
  });

  it('applies the threshold after combining shared material demand', () => {
    const noStockBody = { ...body, stockQty: 0 };
    const parents = [strap('STRAP-A', hookA, 0), strap('STRAP-B', hookB, 0)].map((parent) => ({
      ...parent, bomComponents: parent.bomComponents!.map((item) => item.componentProductId === 'BODY'
        ? { ...item, componentProduct: noStockBody } : item),
    }));
    const result = dashboard([...parents, noStockBody], [3, 3, 0]);
    expect(byId(result, 'BODY')).toMatchObject({ unitCount90d: 6, suggestedFactoryQty: 6 });
  });

  it('uses material transit for the material row on its arrival date', () => {
    const result = dashboard([strap('STRAP-A', hookA, 0)], [90], { inTransit: [
      { productId: 'HOOK-A', inTransitQty: 100, expectedArrivalDate: '2026-09-10' },
    ] });
    expect(byId(result, 'HOOK-A')).toMatchObject({
      inTransitQty: 100, eligibleInTransitQty: 100, stockQty: 30,
      remainingQtyAtArrival: 50, suggestedFactoryQty: 0,
    });
  });

  it('lets dated finished transit cover only that variant after arrival', () => {
    const result = dashboard([strap('STRAP-A', hookA, 0)], [90], { inTransit: [
      { productId: 'STRAP-A', inTransitQty: 90, expectedArrivalDate: '2026-08-31' },
    ] });
    // 10 days of materials are needed before arrival; 55 finished units remain at day 45.
    expect(byId(result, 'HOOK-A')).toBeUndefined();
    expect(result.recommendationCount).toBe(0);
  });

  it('uses registration plus 45 days for finished straps as well as materials', () => {
    const result = dashboard([strap('STRAP-A', hookA, 0)], [90], { inTransit: [
      { productId: 'STRAP-A', inTransitQty: 90, registeredAt: '2026-08-21' },
    ] });
    expect(byId(result, 'HOOK-A')).toMatchObject({ targetStockQty: 90, suggestedFactoryQty: 60 });
    expect(result.recommendationCount).toBe(1);
  });

  it('holds affected material recommendations when finished transit is overdue', () => {
    const result = dashboard([strap('STRAP-A', hookA, 0)], [90], { inTransit: [
      { productId: 'STRAP-A', inTransitQty: 90, registeredAt: '2026-07-06' },
    ] });
    expect(byId(result, 'HOOK-A')).toMatchObject({
      suggestedFactoryQty: null, requiresTransitVerification: true, overdueFinishedInTransitQty: 180,
    });
    expect(result.issues[0].reason).toContain('到货逾期');
    expect(result.totalSuggestedFactoryQty).toBe(0);
  });

  it.each(['missing', 'disabled', 'bad-quantity', 'two-bodies'])(
    'reports invalid %s BOM configuration instead of recommending finished straps', (kind) => {
      const parent = strap('STRAP-A', hookA, 0);
      if (kind === 'missing') parent.bomComponents = [];
      if (kind === 'disabled') parent.bomComponents![0].componentProduct = { ...body, status: 0 };
      if (kind === 'bad-quantity') parent.bomComponents![0].quantity = 0;
      if (kind === 'two-bodies') parent.bomComponents!.push({ componentProductId: 'BODY-2', quantity: 1,
        componentProduct: { ...body, productId: 'BODY-2' } });
      const result = dashboard([parent], [90]);
      expect(result.rows).toEqual([]);
      expect(result.issues[0]).toMatchObject({ productId: 'STRAP-A', reason: expect.stringContaining('组成配置无效') });
    },
  );

  it.each([[25, 0], [24, 46]])('applies the trigger to net material demand after finished stock (body stock %s)', (stockQty, suggested) => {
    const result = dashboard([strap('STRAP-A', hookA, 20), { ...body, stockQty }], [90, 0]);
    if (suggested === 0) expect(byId(result, 'BODY')).toBeUndefined();
    else expect(byId(result, 'BODY')).toMatchObject({ reorderPointQty: 25, targetStockQty: 70, suggestedFactoryQty: suggested });
  });

  it('keeps a warning when finished transit has no usable date', () => {
    const result = dashboard([strap('STRAP-A', hookA, 0)], [90], { inTransit: [
      { productId: 'STRAP-A', inTransitQty: 100 },
    ] });
    expect(byId(result, 'HOOK-A').suggestedFactoryQty).toBe(150);
    expect(result.issues[0].reason).toContain('到仓日期待核实');
  });
});
