import { InboundArrivalDates, resolveInboundExpectedArrivalDate } from '../common/inbound-expected-arrival';
import { buildFactoryMaterialMetrics, FactoryProduct } from './rakuten-factory-materials';

export interface RakutenDashboardOrderRow {
  orderId: string | null;
  skuCode: string | null;
  productName: string | null;
  orderQuantity: number | null;
  orderStatusText: string | null;
  orderImportedAtRaw: string | Date | null;
  dispatchMode: string | null;
  shipmentNo: string | null;
  trackingIsDelivered: boolean;
  salesAmount: number;
}

export type RakutenDashboardProductRow = FactoryProduct;

export interface RakutenDashboardInTransitRow extends InboundArrivalDates {
  productId: string;
  inTransitQty: number;
}

const CANCELLED_STATUSES = new Set(['800', '900']);
const FACTORY_RECOMMENDATION_DAYS = 90;
const FACTORY_PRODUCTION_DAYS = 30;
const FACTORY_TRANSPORT_DAYS = 15;
const FACTORY_PRODUCTION_LOGISTICS_DAYS = FACTORY_PRODUCTION_DAYS + FACTORY_TRANSPORT_DAYS;
const FACTORY_TARGET_STOCK_DAYS = 90;
const FACTORY_MIN_AVERAGE_DAILY_SALES_EXCLUSIVE = 0.05;

function nonNegative(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const source = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(source)
    ? `${source.replace(' ', 'T')}+09:00`
    : source;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isCancelled(status: string | null): boolean {
  const normalized = String(status ?? '').trim().toLowerCase();
  return CANCELLED_STATUSES.has(normalized)
    || normalized.includes('キャンセル')
    || normalized.includes('cancel')
    || normalized.includes('取消');
}

function tokyoDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${record.year}-${record.month}-${record.day}`;
}

function recentTokyoDateKeys(now: Date, days: number): string[] {
  const endDate = new Date(`${tokyoDateKey(now)}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(endDate.getTime() - (days - index - 1) * 24 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 10);
  });
}

function percentageChange(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function metrics(rows: RakutenDashboardOrderRow[]) {
  const orderIds = new Set(rows.map((row) => row.orderId).filter(Boolean));
  const unitCount = rows.reduce((sum, row) => sum + nonNegative(row.orderQuantity), 0);
  const salesAmount = rows.reduce(
    (sum, row) => sum + nonNegative(row.salesAmount), 0,
  );
  return {
    orderCount: orderIds.size,
    unitCount,
    salesAmount: Math.round(salesAmount),
    averageOrderValue: orderIds.size ? Math.round(salesAmount / orderIds.size) : 0,
    pendingShipmentOrderCount: new Set(rows.filter((row) => !row.shipmentNo).map((row) => row.orderId).filter(Boolean)).size,
    overseasUnitCount: rows.filter((row) => row.dispatchMode === 'overseas').reduce((sum, row) => sum + nonNegative(row.orderQuantity), 0),
    chinaUnitCount: rows.filter((row) => row.dispatchMode !== 'overseas').reduce((sum, row) => sum + nonNegative(row.orderQuantity), 0),
  };
}

export function buildRakutenStoreDashboard(input: {
  now: Date;
  days: number;
  orders: RakutenDashboardOrderRow[];
  factoryOrders?: RakutenDashboardOrderRow[];
  minimumAverageDailySalesExclusive?: number;
  products: RakutenDashboardProductRow[];
  inTransit?: RakutenDashboardInTransitRow[];
}): unknown {
  const { now, days, orders, factoryOrders = orders, products, inTransit = [] } = input;
  const threshold = input.minimumAverageDailySalesExclusive;
  const minimumAverageDailySalesExclusive = typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0
    ? threshold : FACTORY_MIN_AVERAGE_DAILY_SALES_EXCLUSIVE;
  const periodMs = days * 24 * 60 * 60 * 1000;
  const periodStart = new Date(now.getTime() - periodMs);
  const previousStart = new Date(periodStart.getTime() - periodMs);
  const activeRows = orders.filter((row) => !isCancelled(row.orderStatusText));
  const datedRows = activeRows.map((row) => ({ row, date: parseDate(row.orderImportedAtRaw) }));
  const currentRows = datedRows.filter(({ date }) => date && date >= periodStart && date < now).map(({ row }) => row);
  const previousRows = datedRows.filter(({ date }) => date && date >= previousStart && date < periodStart).map(({ row }) => row);
  const current = metrics(currentRows);
  const previous = metrics(previousRows);
  const productLookup = new Map(products.map((row) => [normalize(row.productId), row]));
  const todayKey = tokyoDateKey(now);
  const todayMs = Date.parse(`${todayKey}T00:00:00.000Z`);
  const dateAfterDays = (days: number) => new Date(todayMs + days * 86400000).toISOString().slice(0, 10);
  const factoryArrivalDate = dateAfterDays(FACTORY_PRODUCTION_LOGISTICS_DAYS);
  const inTransitLookup = new Map<string, RakutenDashboardInTransitRow[]>();
  for (const row of inTransit) {
    const key = normalize(row.productId);
    const rows = inTransitLookup.get(key) ?? [];
    rows.push(row);
    inTransitLookup.set(key, rows);
  }
  const factoryPeriodStart = new Date(now.getTime() - FACTORY_RECOMMENDATION_DAYS * 24 * 60 * 60 * 1000);
  const factoryMetrics = new Map<string, {
    skuCode: string; productId: string; productName: string | null;
    unitCount90d: number;
    pendingShipmentQty: number; stockQty: number; inTransitQty: number;
  }>();
  const factoryDatedRows = factoryOrders
    .filter((row) => !isCancelled(row.orderStatusText))
    .map((row) => ({ row, date: parseDate(row.orderImportedAtRaw) }));
  for (const { row, date } of factoryDatedRows) {
    if (!date || date < factoryPeriodStart || date >= now) continue;
    const product = productLookup.get(normalize(row.skuCode));
    if (!product) continue;
    const key = normalize(product.productId);
    const metric = factoryMetrics.get(key) ?? {
      skuCode: String(row.skuCode ?? '').trim() || product.productId,
      productId: product.productId,
      productName: product.productName || row.productName || null,
      unitCount90d: 0,
      pendingShipmentQty: 0,
      stockQty: nonNegative(product.stockQty),
      inTransitQty: (inTransitLookup.get(key) ?? []).reduce((sum, item) => sum + nonNegative(item.inTransitQty), 0),
    };
    const quantity = nonNegative(row.orderQuantity);
    metric.unitCount90d += quantity;
    if (!row.shipmentNo) metric.pendingShipmentQty += quantity;
    factoryMetrics.set(key, metric);
  }
  const materialPlanning = buildFactoryMaterialMetrics({
    sales: Array.from(factoryMetrics.values()), products, inTransit, todayKey,
    leadDays: FACTORY_PRODUCTION_LOGISTICS_DAYS, targetDays: FACTORY_TARGET_STOCK_DAYS,
  });
  const factoryRows = materialPlanning.rows.map((row) => {
    const averageDaily90d = row.unitCount90d / 90;
    // Confirmed in-transit goods are not available warehouse stock yet.
    const effectiveStockQty = row.stockQty - row.pendingShipmentQty;
    const productionLogisticsDemandQty = row.dailyDemandQty.reduce((sum, qty) => sum + qty, 0);
    const arrivals = new Map<string, number>();
    let eligibleInTransitQty = 0;
    let unverifiedInTransitQty = 0;
    let overdueInTransitQty = 0;
    let laterInTransitQty = 0;
    for (const item of inTransitLookup.get(normalize(row.productId)) ?? []) {
      const date = resolveInboundExpectedArrivalDate(item);
      const qty = nonNegative(item.inTransitQty);
      const parsed = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        unverifiedInTransitQty += qty;
      } else if (date! < todayKey) {
        unverifiedInTransitQty += qty;
        overdueInTransitQty += qty;
      } else if (date! > factoryArrivalDate) {
        laterInTransitQty += qty;
      } else {
        eligibleInTransitQty += qty;
        arrivals.set(date!, (arrivals.get(date!) ?? 0) + qty);
      }
    }
    // Arrivals become usable at the beginning of their Tokyo calendar day.
    // Unfulfilled forecast sales are recorded as shortages, not future backorders.
    let remainingQtyAtArrival = Math.max(0, effectiveStockQty);
    let pendingBacklogQty = Math.max(0, -effectiveStockQty);
    let shortageQtyBeforeArrival = pendingBacklogQty;
    let expectedStockoutDate: string | null = effectiveStockQty < 0 ? todayKey : null;
    for (let day = 0; day <= FACTORY_PRODUCTION_LOGISTICS_DAYS; day += 1) {
      const date = dateAfterDays(day);
      const arrivingQty = arrivals.get(date) ?? 0;
      const reservedForPending = Math.min(pendingBacklogQty, arrivingQty);
      pendingBacklogQty -= reservedForPending;
      remainingQtyAtArrival += arrivingQty - reservedForPending;
      if (day === FACTORY_PRODUCTION_LOGISTICS_DAYS) break;
      const demand = row.dailyDemandQty[day];
      const shortage = Math.max(0, demand - remainingQtyAtArrival);
      if (shortage > 1e-9) {
        expectedStockoutDate ??= date;
        shortageQtyBeforeArrival += shortage;
      }
      remainingQtyAtArrival = Math.max(0, remainingQtyAtArrival - demand);
    }
    const targetStockQtyRaw = row.targetDemandQty;
    const requiresTransitVerification = overdueInTransitQty > 0 || row.overdueFinishedInTransitQty > 0;
    // Inventory position triggers ordering only below the lead-time demand.
    // The dated simulation above is for shortage warnings, not an extra 45-day buffer.
    const planningStockQty = effectiveStockQty + eligibleInTransitQty;
    const reorderPointQty = productionLogisticsDemandQty;
    const restockRequired = planningStockQty < reorderPointQty - 1e-9;
    const suggestedFactoryQty = requiresTransitVerification ? null
      : averageDaily90d > minimumAverageDailySalesExclusive && restockRequired
        ? Math.max(0, Math.ceil(targetStockQtyRaw - planningStockQty - 1e-9)) : 0;
    const { dailyDemandQty: _dailyDemand, targetDemandQty: _targetDemand, ...displayRow } = row;
    return {
      ...displayRow,
      finishedStockDeductionQty: Math.round(row.finishedStockDeductionQty * 1000) / 1000,
      factoryArrivalDate,
      planningStockQty: Math.round(planningStockQty * 1000) / 1000,
      reorderPointQty: Math.round(reorderPointQty * 1000) / 1000,
      restockRequired,
      eligibleInTransitQty,
      unverifiedInTransitQty,
      overdueInTransitQty,
      requiresTransitVerification,
      laterInTransitQty,
      expectedStockoutDate,
      shortageQtyBeforeArrival: Math.ceil(Math.max(0, shortageQtyBeforeArrival - 1e-9)),
      averageDaily90d: Math.round(averageDaily90d * 1000) / 1000,
      effectiveStockQty,
      productionLogisticsDemandQty: Math.round(productionLogisticsDemandQty * 1000) / 1000,
      remainingQtyAtArrival: Math.round(remainingQtyAtArrival * 1000) / 1000,
      targetStockQty: Math.ceil(targetStockQtyRaw - 1e-9),
      suggestedFactoryQty,
    };
  }).filter((row) => row.unitCount90d / 90 > minimumAverageDailySalesExclusive
    && ((row.suggestedFactoryQty ?? 0) > 0 || row.shortageQtyBeforeArrival > 0 || row.unverifiedInTransitQty > 0 || row.requiresTransitVerification))
    .sort((left, right) => (right.suggestedFactoryQty ?? 0) - (left.suggestedFactoryQty ?? 0)
      || right.unitCount90d - left.unitCount90d
      || left.productId.localeCompare(right.productId, 'en', { numeric: true }));

  const productMetrics = new Map<string, {
    skuCode: string; productId: string | null; productName: string | null; stockQty: number | null;
    orders: Set<string>; units: number; salesAmount: number; shippedUnits: number;
  }>();
  for (const row of currentRows) {
    const skuCode = String(row.skuCode ?? '').trim() || '(无SKU)';
    const product = productLookup.get(normalize(skuCode));
    const key = product ? `product:${normalize(product.productId)}` : `sku:${normalize(skuCode)}`;
    let metric = productMetrics.get(key);
    if (!metric) {
      metric = {
        skuCode, productId: product?.productId ?? null,
        productName: product?.productName || row.productName || null,
        stockQty: product ? nonNegative(product.stockQty) : null,
        orders: new Set(), units: 0, salesAmount: 0, shippedUnits: 0,
      };
      productMetrics.set(key, metric);
    }
    if (row.orderId) metric.orders.add(row.orderId);
    const quantity = nonNegative(row.orderQuantity);
    metric.units += quantity;
    metric.salesAmount += nonNegative(row.salesAmount);
    if (row.shipmentNo) metric.shippedUnits += quantity;
  }
  const topProducts = Array.from(productMetrics.values()).map((row) => ({
    skuCode: row.skuCode,
    productId: row.productId,
    productName: row.productName,
    orderCount: row.orders.size,
    unitCount: row.units,
    salesAmount: Math.round(row.salesAmount),
    shippedUnitCount: row.shippedUnits,
    stockQty: row.stockQty,
    daysOfCover: row.stockQty === null || row.units <= 0 ? null : Math.round((row.stockQty / (row.units / days)) * 10) / 10,
  })).sort((left, right) => right.salesAmount - left.salesAmount || right.unitCount - left.unitCount).slice(0, 100);

  const dailyMap = new Map<string, { orderIds: Set<string>; units: number; salesAmount: number }>();
  for (const row of currentRows) {
    const date = parseDate(row.orderImportedAtRaw);
    if (!date) continue;
    const key = tokyoDateKey(date);
    const daily = dailyMap.get(key) ?? { orderIds: new Set<string>(), units: 0, salesAmount: 0 };
    if (row.orderId) daily.orderIds.add(row.orderId);
    const quantity = nonNegative(row.orderQuantity);
    daily.units += quantity;
    daily.salesAmount += nonNegative(row.salesAmount);
    dailyMap.set(key, daily);
  }

  return {
    period: { days, start: periodStart.toISOString(), end: now.toISOString(), currency: 'JPY' },
    summary: current,
    comparison: {
      previous,
      orderCountChangePct: percentageChange(current.orderCount, previous.orderCount),
      unitCountChangePct: percentageChange(current.unitCount, previous.unitCount),
      salesAmountChangePct: percentageChange(current.salesAmount, previous.salesAmount),
    },
    daily: recentTokyoDateKeys(now, days).map((date) => {
      const row = dailyMap.get(date);
      return {
        date,
        orderCount: row?.orderIds.size ?? 0,
        unitCount: row?.units ?? 0,
        salesAmount: Math.round(row?.salesAmount ?? 0),
      };
    }),
    topProducts,
    matchCoverage: {
      productCount: topProducts.length,
      matchedCount: topProducts.filter((row) => row.productId).length,
      unmatchedCount: topProducts.filter((row) => !row.productId).length,
    },
    fulfillment: {
      pendingShipmentOrderCount: current.pendingShipmentOrderCount,
      shippedOrderCount: new Set(currentRows.filter((row) => row.shipmentNo).map((row) => row.orderId).filter(Boolean)).size,
      deliveredOrderCount: new Set(currentRows.filter((row) => row.trackingIsDelivered).map((row) => row.orderId).filter(Boolean)).size,
      overseasUnitCount: current.overseasUnitCount,
      chinaUnitCount: current.chinaUnitCount,
    },
    factoryRecommendations: {
      channelScope: 'rakuten_all_shops',
      issues: materialPlanning.issues,
      periodDays: FACTORY_RECOMMENDATION_DAYS,
      periodStart: factoryPeriodStart.toISOString(),
      periodEnd: now.toISOString(),
      productionDays: FACTORY_PRODUCTION_DAYS,
      transportDays: FACTORY_TRANSPORT_DAYS,
      productionLogisticsDays: FACTORY_PRODUCTION_LOGISTICS_DAYS,
      targetStockDays: FACTORY_TARGET_STOCK_DAYS,
      minimumAverageDailySalesExclusive,
      recommendationCount: factoryRows.filter((row) => (row.suggestedFactoryQty ?? 0) > 0).length,
      shortageProductCount: factoryRows.filter((row) => row.shortageQtyBeforeArrival > 0).length,
      unverifiedTransitProductCount: factoryRows.filter((row) => row.unverifiedInTransitQty > 0 || row.requiresTransitVerification).length,
      totalSuggestedFactoryQty: factoryRows.reduce((sum, row) => sum + (row.suggestedFactoryQty ?? 0), 0),
      rows: factoryRows,
    },
  };
}
