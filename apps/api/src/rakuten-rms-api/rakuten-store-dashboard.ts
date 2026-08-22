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

export interface RakutenDashboardProductRow {
  productId: string;
  productName: string | null;
  stockQty: number;
}

export interface RakutenDashboardInTransitRow {
  productId: string;
  inTransitQty: number;
}

const CANCELLED_STATUSES = new Set(['800', '900']);
const FACTORY_RECOMMENDATION_DAYS = 90;
const FACTORY_PRODUCTION_DAYS = 30;
const FACTORY_TRANSPORT_DAYS = 15;
const FACTORY_PRODUCTION_LOGISTICS_DAYS = FACTORY_PRODUCTION_DAYS + FACTORY_TRANSPORT_DAYS;
const FACTORY_TARGET_STOCK_DAYS = 60;
const FACTORY_MIN_AVERAGE_DAILY_SALES_EXCLUSIVE = 0.1;

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
  products: RakutenDashboardProductRow[];
  inTransit?: RakutenDashboardInTransitRow[];
}): unknown {
  const { now, days, orders, factoryOrders = orders, products, inTransit = [] } = input;
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
  const inTransitLookup = new Map(inTransit.map((row) => [
    normalize(row.productId), nonNegative(row.inTransitQty),
  ]));
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
      inTransitQty: inTransitLookup.get(key) ?? 0,
    };
    const quantity = nonNegative(row.orderQuantity);
    metric.unitCount90d += quantity;
    if (!row.shipmentNo) metric.pendingShipmentQty += quantity;
    factoryMetrics.set(key, metric);
  }
  const factoryRows = Array.from(factoryMetrics.values()).map((row) => {
    const averageDaily90d = row.unitCount90d / 90;
    const effectiveStockQty = row.stockQty + row.inTransitQty - row.pendingShipmentQty;
    const productionLogisticsDemandQty = averageDaily90d * FACTORY_PRODUCTION_LOGISTICS_DAYS;
    const remainingQtyAtArrival = Math.max(0, effectiveStockQty - productionLogisticsDemandQty);
    const targetStockQtyRaw = averageDaily90d * FACTORY_TARGET_STOCK_DAYS;
    const suggestedFactoryQty = averageDaily90d > FACTORY_MIN_AVERAGE_DAILY_SALES_EXCLUSIVE
      ? Math.max(0, Math.ceil(targetStockQtyRaw - remainingQtyAtArrival))
      : 0;
    return {
      ...row,
      averageDaily90d: Math.round(averageDaily90d * 1000) / 1000,
      effectiveStockQty,
      productionLogisticsDemandQty: Math.round(productionLogisticsDemandQty * 1000) / 1000,
      remainingQtyAtArrival: Math.round(remainingQtyAtArrival * 1000) / 1000,
      targetStockQty: Math.ceil(targetStockQtyRaw),
      suggestedFactoryQty,
    };
  }).filter((row) => row.suggestedFactoryQty > 0)
    .sort((left, right) => right.suggestedFactoryQty - left.suggestedFactoryQty
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
      periodDays: FACTORY_RECOMMENDATION_DAYS,
      periodStart: factoryPeriodStart.toISOString(),
      periodEnd: now.toISOString(),
      productionDays: FACTORY_PRODUCTION_DAYS,
      transportDays: FACTORY_TRANSPORT_DAYS,
      productionLogisticsDays: FACTORY_PRODUCTION_LOGISTICS_DAYS,
      targetStockDays: FACTORY_TARGET_STOCK_DAYS,
      minimumAverageDailySalesExclusive: FACTORY_MIN_AVERAGE_DAILY_SALES_EXCLUSIVE,
      recommendationCount: factoryRows.length,
      totalSuggestedFactoryQty: factoryRows.reduce((sum, row) => sum + row.suggestedFactoryQty, 0),
      rows: factoryRows,
    },
  };
}
