import { InboundArrivalDates, resolveInboundExpectedArrivalDate } from '../common/inbound-expected-arrival';

export interface FactoryProduct {
  productId: string;
  productName: string | null;
  productType?: string | null;
  stockQty: number;
  status?: number;
  bomComponents?: Array<{
    componentProductId: string;
    quantity: number;
    componentProduct: FactoryProduct;
  }>;
}

export interface FactorySalesMetric {
  skuCode: string;
  productId: string;
  productName: string | null;
  unitCount90d: number;
  pendingShipmentQty: number;
  stockQty: number;
  inTransitQty: number;
}

export interface FactoryMaterialMetric extends FactorySalesMetric {
  productType: string | null;
  sourceProductIds: string[];
  finishedStockDeductionQty: number;
  overdueFinishedInTransitQty: number;
  dailyDemandQty: number[];
  targetDemandQty: number;
}

export interface FactoryPlanningIssue {
  productId: string;
  reason: string;
}

const keyOf = (value: string) => value.trim().toLowerCase();
const qtyOf = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

// A finished strap only covers its own orders/forecast. It is never dismantled
// into fungible material stock that could incorrectly cover a different variant.
export function buildFactoryMaterialMetrics(input: {
  sales: FactorySalesMetric[];
  products: FactoryProduct[];
  inTransit: Array<InboundArrivalDates & { productId: string; inTransitQty: number }>;
  todayKey: string;
  leadDays: number;
  targetDays: number;
}): { rows: FactoryMaterialMetric[]; issues: FactoryPlanningIssue[] } {
  const { sales, products, inTransit, todayKey, leadDays, targetDays } = input;
  const productLookup = new Map(products.map((product) => [keyOf(product.productId), product]));
  const result = new Map<string, FactoryMaterialMetric>();
  const issues: FactoryPlanningIssue[] = [];
  const arrivalsByProduct = new Map<string, typeof inTransit>();
  for (const arrival of inTransit) {
    const key = keyOf(arrival.productId);
    const rows = arrivalsByProduct.get(key) ?? [];
    rows.push(arrival);
    arrivalsByProduct.set(key, rows);
  }
  const ensure = (product: FactoryProduct): FactoryMaterialMetric => {
    const key = keyOf(product.productId);
    let metric = result.get(key);
    if (!metric) {
      metric = {
        skuCode: product.productId, productId: product.productId, productName: product.productName,
        productType: product.productType ?? null, sourceProductIds: [], unitCount90d: 0,
        pendingShipmentQty: 0, stockQty: qtyOf(product.stockQty),
        inTransitQty: (arrivalsByProduct.get(key) ?? []).reduce((sum, row) => sum + qtyOf(row.inTransitQty), 0),
        finishedStockDeductionQty: 0, overdueFinishedInTransitQty: 0, dailyDemandQty: Array(leadDays).fill(0), targetDemandQty: 0,
      };
      result.set(key, metric);
    }
    return metric;
  };
  for (const sale of sales) {
    const product = productLookup.get(keyOf(sale.productId));
    if (!product) continue;
    const daily = sale.unitCount90d / 90;
    if (product.productType?.trim() !== '肩带') {
      const metric = ensure(product);
      metric.skuCode = sale.skuCode;
      metric.unitCount90d += sale.unitCount90d;
      metric.pendingShipmentQty += sale.pendingShipmentQty;
      metric.dailyDemandQty = metric.dailyDemandQty.map((qty) => qty + daily);
      metric.targetDemandQty += daily * targetDays;
      continue;
    }
    const bom = product.bomComponents ?? [];
    const valid = bom.length > 0
      && bom.filter((item) => item.componentProduct.productType?.trim() === '肩带本体').length === 1
      && new Set(bom.map((item) => keyOf(item.componentProductId))).size === bom.length
      && bom.every((item) => Number.isInteger(item.quantity) && item.quantity > 0
        && item.componentProduct.status === 1
        && ['肩带本体', '肩带配件'].includes(item.componentProduct.productType?.trim() ?? '')
        && keyOf(item.componentProductId) === keyOf(item.componentProduct.productId));
    if (!valid) {
      issues.push({ productId: product.productId, reason: '肩带组成配置无效：须包含一个本体，组成产品须启用、用量为正整数，其他组成须为肩带配件。未生成该成品的材料建议。' });
      continue;
    }
    let finished = qtyOf(product.stockQty);
    const coveredPending = Math.min(finished, sale.pendingShipmentQty);
    finished -= coveredPending;
    const pendingMaterials = sale.pendingShipmentQty - coveredPending;
    let finishedDeduction = coveredPending;
    const finishedArrivals = new Map<number, number>();
    let unverifiedFinishedQty = 0;
    let laterFinishedQty = 0;
    let overdueFinishedQty = 0;
    for (const arrival of arrivalsByProduct.get(keyOf(product.productId)) ?? []) {
      const date = resolveInboundExpectedArrivalDate(arrival) ?? '';
      const time = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
      const day = (time - Date.parse(`${todayKey}T00:00:00.000Z`)) / 86400000;
      if (!Number.isFinite(day) || new Date(time).toISOString().slice(0, 10) !== date) {
        unverifiedFinishedQty += qtyOf(arrival.inTransitQty);
      } else if (day < 0) {
        overdueFinishedQty += qtyOf(arrival.inTransitQty);
      } else if (day <= leadDays) {
        finishedArrivals.set(day, (finishedArrivals.get(day) ?? 0) + qtyOf(arrival.inTransitQty));
      } else {
        laterFinishedQty += qtyOf(arrival.inTransitQty);
      }
    }
    if (unverifiedFinishedQty > 0) {
      issues.push({ productId: product.productId, reason: `成品在途${unverifiedFinishedQty}件到仓日期待核实，未抵扣材料需求。` });
    }
    if (overdueFinishedQty > 0) {
      issues.push({ productId: product.productId, reason: `成品在途${overdueFinishedQty}件到货逾期、需核实，相关材料暂不自动建议重复订货。` });
    }
    if (laterFinishedQty > 0) {
      issues.push({ productId: product.productId, reason: `成品在途${laterFinishedQty}件预计在新备货到仓后到仓，未自动抵扣材料需求，请在下单前核对。` });
    }
    const demands: number[] = [];
    for (let day = 0; day < Math.max(leadDays, targetDays); day += 1) {
      finished += finishedArrivals.get(day) ?? 0;
      const covered = Math.min(finished, daily);
      finished -= covered;
      finishedDeduction += covered;
      demands.push(Math.max(0, daily - covered));
    }
    for (const item of bom) {
      const material = productLookup.get(keyOf(item.componentProductId)) ?? item.componentProduct;
      const metric = ensure(material);
      if (!metric.sourceProductIds.includes(product.productId)) metric.sourceProductIds.push(product.productId);
      metric.unitCount90d += sale.unitCount90d * item.quantity;
      metric.pendingShipmentQty += pendingMaterials * item.quantity;
      metric.finishedStockDeductionQty += finishedDeduction * item.quantity;
      metric.overdueFinishedInTransitQty += overdueFinishedQty * item.quantity;
      metric.dailyDemandQty = metric.dailyDemandQty.map((qty, day) => qty + demands[day] * item.quantity);
      metric.targetDemandQty += demands.slice(0, targetDays).reduce((sum, qty) => sum + qty, 0) * item.quantity;
    }
  }
  return { rows: [...result.values()].map((row) => ({ ...row, sourceProductIds: row.sourceProductIds.sort() })), issues };
}
