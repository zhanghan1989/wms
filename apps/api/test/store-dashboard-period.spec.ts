import * as XLSX from 'xlsx';
import { storeDashboardPeriod } from '../src/common/store-dashboard-period';
import { exportStoreDashboard } from '../src/common/store-dashboard-export';
import { buildAmazonStoreDashboard } from '../src/amazon-sp-api/amazon-store-dashboard';
import { buildRakutenStoreDashboard } from '../src/rakuten-rms-api/rakuten-store-dashboard';

describe('Monthly store dashboards', () => {
  const now = new Date('2026-10-26T00:00:00Z');
  it('handles leap February, year rollover and invalid months', () => {
    expect(storeDashboardPeriod(now, undefined, '2024-02')).toMatchObject({ days: 29,
      start: new Date('2024-01-31T15:00:00Z'), end: new Date('2024-02-29T15:00:00Z') });
    expect(storeDashboardPeriod(now, undefined, '2026-01').previousStart).toEqual(new Date('2025-11-30T15:00:00Z'));
    for (const month of ['2026-13', '2026-1', 'bad', '2026-11']) expect(() => storeDashboardPeriod(now, undefined, month)).toThrow();
  });
  it.each(['amazon', 'rakuten'])('uses Tokyo month boundaries and the previous calendar month for %s', (channel) => {
    const period = storeDashboardPeriod(now, undefined, '2026-09');
    const dates = ['2026-08-31T14:59:59Z', '2026-08-31T15:00:00Z', '2026-09-30T14:59:59Z', '2026-09-30T15:00:00Z'];
    const dashboard = (channel === 'amazon' ? buildAmazonStoreDashboard({ now, days: period.days, period,
      inventory: [], skus: [], fbmOrders: [], fbaOrders: dates.map((date, index) => ({
        orderId: String(index), sellerSku: 'SKU', asin: null, productName: '商品', orderStatus: 'Shipped',
        quantityOrdered: 1, quantityShipped: 1, itemAmount: 100, currency: 'JPY', purchaseDate: new Date(date),
      })) }) : buildRakutenStoreDashboard({ now, days: period.days, period, products: [],
        orders: dates.map((date, index) => ({ orderId: String(index), skuCode: 'SKU', productName: '商品',
          orderQuantity: 1, orderStatusText: '300', orderImportedAtRaw: date, salesAmount: 100,
          dispatchMode: 'overseas', shipmentNo: null, trackingIsDelivered: false })) })) as any;
    expect(dashboard.summary.orderCount).toBe(2);
    expect(dashboard.comparison.previous.orderCount).toBe(1);
    expect(dashboard.period.month).toBe('2026-09');
    expect(dashboard.daily.reduce((sum: number, row: any) => sum + row.unitCount, 0)).toBe(2);
    if (channel === 'rakuten') {
      expect(dashboard.daily).toHaveLength(30);
      expect(dashboard.daily[0].date).toBe('2026-09-01');
      expect(dashboard.daily[29].date).toBe('2026-09-30');
    }
    const file = exportStoreDashboard({ dashboard, selectedShop: { shopName: '测试店铺' }, generatedAt: now.toISOString() }, channel);
    const workbook = XLSX.read(file.content, { type: 'buffer' });
    expect(workbook.SheetNames).toEqual(expect.arrayContaining(['统计说明', '统计汇总', '每日趋势', '商品排行']));
    expect(XLSX.utils.sheet_to_json(workbook.Sheets['统计汇总'])[0]).toMatchObject({ '订单数': 2 });
    expect(file.fileName).toContain('2026-09');
  });
});
