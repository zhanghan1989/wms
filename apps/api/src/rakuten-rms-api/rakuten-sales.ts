import { createHash } from 'crypto';
import { RakutenJsonObject } from './rakuten-rms-api.types';
import { RakutenDashboardOrderRow } from './rakuten-store-dashboard';

export interface RakutenSalesItem {
  itemId: string;
  skuCode: string;
  productName: string;
  quantity: number;
  salesAmount: number;
}

function money(value: unknown, field: string): number {
  if (value === null || value === undefined || String(value).trim() === '') throw new Error(`RMS销售数据缺少${field}`);
  const parsed = Number(String(value).replace(/,/g, ''));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`RMS销售数据${field}无效`);
  return parsed;
}

export function parseRakutenSalesOrder(order: RakutenJsonObject) {
  const orderId = String(order.orderNumber ?? '').trim();
  const orderedAt = new Date(String(order.orderDatetime ?? ''));
  const orderProgress = String(order.orderProgress ?? '').trim();
  if (!orderId || Number.isNaN(orderedAt.getTime()) || !/^\d+$/.test(orderProgress)) throw new Error('RMS销售订单标识、日期或状态无效');
  const cancelled = ['800', '900'].includes(orderProgress);
  const goodsAmount = money(order.goodsPrice ?? (cancelled ? 0 : undefined), '商品总额');
  const couponAmount = money(order.couponAllTotalPrice ?? (cancelled ? 0 : undefined), '优惠券金额');
  if (!cancelled && couponAmount > goodsAmount) throw new Error(`RMS销售订单${orderId}优惠券超过商品总额`);
  const items: RakutenSalesItem[] = [];
  const gross: number[] = [];
  const seen = new Set<string>();
  for (const [pi, pkg] of ((order.PackageModelList ?? []) as RakutenJsonObject[]).entries()) {
    for (const [ii, item] of ((pkg.ItemModelList ?? []) as RakutenJsonObject[]).entries()) {
      const itemId = `${pkg.basketId ?? pi}:${item.itemDetailId ?? ii}`;
      if (seen.has(itemId)) throw new Error(`RMS销售订单${orderId}商品明细重复`);
      seen.add(itemId);
      const quantity = money(item.units, '购买数量');
      // RMS retains removed order lines with units=0; they contribute no sale.
      if (!quantity) continue;
      const sku = ((item.SkuModelList ?? []) as RakutenJsonObject[])[0];
      items.push({ itemId, skuCode: String(sku?.variantId ?? item.manageNumber ?? item.itemNumber ?? '').trim(),
        productName: String(item.itemName ?? ''), quantity, salesAmount: 0 });
      gross.push(money(item.price, '商品单价') * quantity);
    }
  }
  const totalGross = gross.reduce((a, b) => a + b, 0);
  if ((!items.length || totalGross !== goodsAmount) && !cancelled) {
    throw new Error(`RMS销售订单${orderId}商品明细与商品总额不一致`);
  }
  const net = cancelled ? 0 : goodsAmount - couponAmount;
  // Allocate discounts in whole yen; the SKU amounts must sum exactly to order net sales.
  const shares = gross.map((value, i) => ({ i, value: totalGross ? net * value / totalGross : 0 }));
  for (const share of shares) items[share.i].salesAmount = Math.floor(share.value);
  let remainder = net - items.reduce((sum, item) => sum + item.salesAmount, 0);
  for (const share of [...shares].sort((a, b) => (b.value % 1) - (a.value % 1) || a.i - b.i)) {
    if (remainder-- <= 0) break;
    items[share.i].salesAmount += 1;
  }
  const facts = { orderId, orderedAt: orderedAt.toISOString(), orderProgress, goodsAmount, couponAmount, items };
  return { ...facts, orderedAt, contentHash: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
}

export function rakutenSalesRows(snapshots: Array<{ orderId: string; orderedAt: Date; orderProgress: string; items: unknown }>): RakutenDashboardOrderRow[] {
  return snapshots.flatMap((order) => (order.items as RakutenSalesItem[]).map((item) => ({
    orderId: order.orderId, skuCode: item.skuCode, productName: item.productName,
    orderQuantity: item.quantity, orderStatusText: order.orderProgress, orderImportedAtRaw: order.orderedAt,
    salesAmount: item.salesAmount, dispatchMode: null, shipmentNo: null, trackingIsDelivered: false,
  })));
}
