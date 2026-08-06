export interface AmazonDashboardFbaOrderRow {
  orderId: string;
  sellerSku: string | null;
  asin: string | null;
  productName: string | null;
  orderStatus: string | null;
  quantityOrdered: number;
  quantityShipped: number;
  itemAmount: number;
  currency: string | null;
  purchaseDate: Date | null;
}

export interface AmazonDashboardFbmOrderRow {
  orderId: string | null;
  sku: string | null;
  productName: string | null;
  orderStatus: string | null;
  quantityPurchased: number | null;
  quantityShipped: number | null;
  quantityToShip: number | null;
  purchaseDateRaw: string | null;
}

export interface AmazonDashboardInventoryRow {
  sellerSku: string;
  asin: string | null;
  productName: string | null;
  fulfillableQty: number;
  inboundWorkingQty: number;
  inboundShippedQty: number;
  inboundReceivingQty: number;
  reservedQty: number;
  unfulfillableQty: number;
  totalQty: number;
  snapshotAt: Date;
}

export interface AmazonDashboardSkuRow {
  sku: string;
  fbmSku: string | null;
  rbSku: string | null;
  asin: string | null;
  fnsku: string | null;
  productId: string | null;
  productName: string | null;
}

interface PeriodMetrics {
  orderCount: number;
  unitCount: number;
  fbaOrderCount: number;
  fbaUnitCount: number;
  fbmOrderCount: number;
  fbmUnitCount: number;
  fbmPendingUnitCount: number;
  fbaSalesAmount: number;
  fbaAverageOrderValue: number;
}

const SUCCESS_FBA_STATUSES = new Set(['SHIPPED', 'PARTIALLY_SHIPPED']);
const EXCLUDED_FBM_STATUSES = new Set(['CANCELLED', 'UNFULFILLABLE']);

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function nonNegative(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inRange(value: Date | string | null | undefined, start: Date, end: Date): boolean {
  const date = parseDate(value);
  return Boolean(date && date >= start && date < end);
}

function tokyoDateKey(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${record.year}-${record.month}-${record.day}`;
}

function percentageChange(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function calculateMetrics(
  fbaRows: AmazonDashboardFbaOrderRow[],
  fbmRows: AmazonDashboardFbmOrderRow[],
  start: Date,
  end: Date,
): PeriodMetrics {
  const fba = fbaRows.filter((row) => SUCCESS_FBA_STATUSES.has(String(row.orderStatus ?? '').toUpperCase())
    && inRange(row.purchaseDate, start, end));
  const fbm = fbmRows.filter((row) => !EXCLUDED_FBM_STATUSES.has(String(row.orderStatus ?? '').toUpperCase())
    && inRange(row.purchaseDateRaw, start, end));
  const fbaOrders = new Set(fba.map((row) => row.orderId).filter(Boolean));
  const fbmOrders = new Set(fbm.map((row) => row.orderId).filter(Boolean));
  const fbaSalesAmount = fba.reduce((sum, row) => sum + nonNegative(row.itemAmount), 0);
  const fbaUnitCount = fba.reduce((sum, row) => sum + nonNegative(row.quantityShipped), 0);
  const fbmUnitCount = fbm.reduce((sum, row) => sum + nonNegative(row.quantityPurchased), 0);
  return {
    orderCount: fbaOrders.size + fbmOrders.size,
    unitCount: fbaUnitCount + fbmUnitCount,
    fbaOrderCount: fbaOrders.size,
    fbaUnitCount,
    fbmOrderCount: fbmOrders.size,
    fbmUnitCount,
    fbmPendingUnitCount: fbm.reduce((sum, row) => sum + nonNegative(row.quantityToShip), 0),
    fbaSalesAmount,
    fbaAverageOrderValue: fbaOrders.size ? Math.round(fbaSalesAmount / fbaOrders.size) : 0,
  };
}

export function buildAmazonStoreDashboard(input: {
  now: Date;
  days: number;
  fbaOrders: AmazonDashboardFbaOrderRow[];
  fbmOrders: AmazonDashboardFbmOrderRow[];
  inventory: AmazonDashboardInventoryRow[];
  skus: AmazonDashboardSkuRow[];
}): unknown {
  const { now, days, fbaOrders, fbmOrders, inventory, skus } = input;
  const periodMs = days * 24 * 60 * 60 * 1000;
  const periodStart = new Date(now.getTime() - periodMs);
  const previousStart = new Date(periodStart.getTime() - periodMs);
  const current = calculateMetrics(fbaOrders, fbmOrders, periodStart, now);
  const previous = calculateMetrics(fbaOrders, fbmOrders, previousStart, periodStart);

  const skuLookup = new Map<string, AmazonDashboardSkuRow>();
  for (const sku of skus) {
    for (const candidate of [sku.sku, sku.fbmSku, sku.rbSku, sku.asin, sku.fnsku]) {
      const key = normalize(candidate);
      if (key && !skuLookup.has(key)) skuLookup.set(key, sku);
    }
  }

  const inventoryLookup = new Map<string, AmazonDashboardInventoryRow>();
  for (const row of inventory) {
    for (const candidate of [row.sellerSku, row.asin]) {
      const key = normalize(candidate);
      if (key && !inventoryLookup.has(key)) inventoryLookup.set(key, row);
    }
  }

  type ProductMetric = {
    sellerSku: string;
    asin: string | null;
    productName: string | null;
    productId: string | null;
    fbaOrders: Set<string>;
    fbaUnits: number;
    fbmOrders: Set<string>;
    fbmUnits: number;
    fbaSalesAmount: number;
    availableQty: number | null;
    inboundQty: number | null;
    reservedQty: number | null;
    unfulfillableQty: number | null;
  };
  const products = new Map<string, ProductMetric>();
  const productFor = (sellerSkuRaw: string | null, asin: string | null, name: string | null): ProductMetric => {
    const sellerSku = String(sellerSkuRaw ?? '').trim() || '(无SKU)';
    const matchedSku = skuLookup.get(normalize(sellerSku)) ?? skuLookup.get(normalize(asin));
    const key = matchedSku?.productId
      ? `product:${matchedSku.productId}`
      : `sku:${normalize(sellerSku)}:${normalize(asin)}`;
    let metric = products.get(key);
    if (!metric) {
      const inventoryRow = inventoryLookup.get(normalize(sellerSku)) ?? inventoryLookup.get(normalize(asin));
      metric = {
        sellerSku,
        asin: asin || matchedSku?.asin || null,
        productName: matchedSku?.productName || name || null,
        productId: matchedSku?.productId || null,
        fbaOrders: new Set<string>(),
        fbaUnits: 0,
        fbmOrders: new Set<string>(),
        fbmUnits: 0,
        fbaSalesAmount: 0,
        availableQty: inventoryRow ? nonNegative(inventoryRow.fulfillableQty) : null,
        inboundQty: inventoryRow
          ? nonNegative(inventoryRow.inboundWorkingQty)
            + nonNegative(inventoryRow.inboundShippedQty)
            + nonNegative(inventoryRow.inboundReceivingQty)
          : null,
        reservedQty: inventoryRow ? nonNegative(inventoryRow.reservedQty) : null,
        unfulfillableQty: inventoryRow ? nonNegative(inventoryRow.unfulfillableQty) : null,
      };
      products.set(key, metric);
    }
    return metric;
  };

  const currentFbaRows = fbaOrders.filter((row) => SUCCESS_FBA_STATUSES.has(String(row.orderStatus ?? '').toUpperCase())
    && inRange(row.purchaseDate, periodStart, now));
  for (const row of currentFbaRows) {
    const metric = productFor(row.sellerSku, row.asin, row.productName);
    metric.fbaOrders.add(row.orderId);
    metric.fbaUnits += nonNegative(row.quantityShipped);
    metric.fbaSalesAmount += nonNegative(row.itemAmount);
  }
  const currentFbmRows = fbmOrders.filter((row) => !EXCLUDED_FBM_STATUSES.has(String(row.orderStatus ?? '').toUpperCase())
    && inRange(row.purchaseDateRaw, periodStart, now));
  for (const row of currentFbmRows) {
    const metric = productFor(row.sku, null, row.productName);
    if (row.orderId) metric.fbmOrders.add(row.orderId);
    metric.fbmUnits += nonNegative(row.quantityPurchased);
  }

  const topProducts = Array.from(products.values())
    .map((row) => {
      const totalUnits = row.fbaUnits + row.fbmUnits;
      const dailyUnits = totalUnits / days;
      const stockQty = row.availableQty === null ? null : row.availableQty + (row.inboundQty ?? 0);
      return {
        sellerSku: row.sellerSku,
        asin: row.asin,
        productId: row.productId,
        productName: row.productName,
        fbaOrderCount: row.fbaOrders.size,
        fbaUnitCount: row.fbaUnits,
        fbmOrderCount: row.fbmOrders.size,
        fbmUnitCount: row.fbmUnits,
        totalUnitCount: totalUnits,
        fbaSalesAmount: Math.round(row.fbaSalesAmount * 100) / 100,
        availableQty: row.availableQty,
        inboundQty: row.inboundQty,
        reservedQty: row.reservedQty,
        unfulfillableQty: row.unfulfillableQty,
        daysOfCover: stockQty === null || dailyUnits <= 0 ? null : Math.round((stockQty / dailyUnits) * 10) / 10,
      };
    })
    .sort((left, right) => right.fbaSalesAmount - left.fbaSalesAmount || right.totalUnitCount - left.totalUnitCount)
    .slice(0, 100);

  const dailyMap = new Map<string, { date: string; orderIds: Set<string>; units: number; fbaSalesAmount: number }>();
  const dailyFor = (date: Date): { date: string; orderIds: Set<string>; units: number; fbaSalesAmount: number } => {
    const key = tokyoDateKey(date);
    let row = dailyMap.get(key);
    if (!row) {
      row = { date: key, orderIds: new Set<string>(), units: 0, fbaSalesAmount: 0 };
      dailyMap.set(key, row);
    }
    return row;
  };
  for (const row of currentFbaRows) {
    const date = parseDate(row.purchaseDate);
    if (!date) continue;
    const daily = dailyFor(date);
    daily.orderIds.add(`fba:${row.orderId}`);
    daily.units += nonNegative(row.quantityShipped);
    daily.fbaSalesAmount += nonNegative(row.itemAmount);
  }
  for (const row of currentFbmRows) {
    const date = parseDate(row.purchaseDateRaw);
    if (!date) continue;
    const daily = dailyFor(date);
    if (row.orderId) daily.orderIds.add(`fbm:${row.orderId}`);
    daily.units += nonNegative(row.quantityPurchased);
  }

  const currencies = Array.from(new Set(currentFbaRows.map((row) => row.currency).filter(Boolean)));
  return {
    period: {
      days,
      start: periodStart.toISOString(),
      end: now.toISOString(),
      currency: currencies.length === 1 ? currencies[0] : currencies.join('/') || 'JPY',
    },
    summary: current,
    comparison: {
      previous,
      orderCountChangePct: percentageChange(current.orderCount, previous.orderCount),
      unitCountChangePct: percentageChange(current.unitCount, previous.unitCount),
      fbaSalesAmountChangePct: percentageChange(current.fbaSalesAmount, previous.fbaSalesAmount),
    },
    inventory: {
      available: inventory.length > 0,
      skuCount: inventory.length,
      fulfillableQty: inventory.reduce((sum, row) => sum + nonNegative(row.fulfillableQty), 0),
      inboundQty: inventory.reduce((sum, row) => sum
        + nonNegative(row.inboundWorkingQty)
        + nonNegative(row.inboundShippedQty)
        + nonNegative(row.inboundReceivingQty), 0),
      reservedQty: inventory.reduce((sum, row) => sum + nonNegative(row.reservedQty), 0),
      unfulfillableQty: inventory.reduce((sum, row) => sum + nonNegative(row.unfulfillableQty), 0),
      snapshotAt: inventory.reduce<Date | null>((latest, row) => !latest || row.snapshotAt > latest ? row.snapshotAt : latest, null)?.toISOString() ?? null,
    },
    orderStatuses: {
      fba: fbaOrders.filter((row) => inRange(row.purchaseDate, periodStart, now)).reduce<Record<string, number>>((result, row) => {
        const key = String(row.orderStatus || 'UNKNOWN').toUpperCase();
        result[key] = (result[key] ?? 0) + 1;
        return result;
      }, {}),
      fbm: fbmOrders.filter((row) => inRange(row.purchaseDateRaw, periodStart, now)).reduce<Record<string, number>>((result, row) => {
        const key = String(row.orderStatus || 'UNKNOWN').toUpperCase();
        result[key] = (result[key] ?? 0) + 1;
        return result;
      }, {}),
    },
    daily: Array.from(dailyMap.values())
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((row) => ({
        date: row.date,
        orderCount: row.orderIds.size,
        unitCount: row.units,
        fbaSalesAmount: Math.round(row.fbaSalesAmount * 100) / 100,
      })),
    topProducts,
    matchCoverage: {
      productCount: topProducts.length,
      matchedCount: topProducts.filter((row) => row.productId).length,
      unmatchedCount: topProducts.filter((row) => !row.productId).length,
    },
  };
}
