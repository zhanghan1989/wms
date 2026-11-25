import { BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';

// Export the same aggregates returned to the dashboard, preserving numeric cells.
export function exportStoreDashboard(payload: any, channel: string) {
  if (!payload?.dashboard || !payload?.selectedShop) throw new BadRequestException('请先选择有数据的店铺');
  if (payload.sourceSummary?.sales?.ready === false) throw new BadRequestException('所选周期销售数据尚未完成对账，暂不能导出');
  const workbook = XLSX.utils.book_new();
  const labels: Record<string, string> = {
    date: '日期', orderCount: '订单数', unitCount: '件数', salesAmount: '销售额', fbaSalesAmount: 'FBA销售额',
    productId: '产品ID', productName: '商品名称', sellerSku: '卖家SKU', sku: 'SKU', asin: 'ASIN',
    fbaOrderCount: 'FBA订单数', fbmOrderCount: 'FBM订单数', fbaUnitCount: 'FBA件数', fbmUnitCount: 'FBM件数',
    totalUnitCount: '总件数', stockQty: '库存件数', daysOfCover: '库存可售天数', fbmPendingUnitCount: 'FBM待发货件数',
    pendingShipmentOrderCount: '待发货订单数', overseasUnitCount: '日本仓购买件数', chinaUnitCount: '中国仓购买件数',
    crossWarehouseUnitCount: '跨仓购买件数', unimportedUnitCount: '未导入购买件数', unmatchedFulfillmentUnitCount: '未匹配履约的购买件数',
    start: '开始时间', end: '结束时间（不含）', days: '周期天数', month: '月份', currency: '币种',
    snapshotAt: '库存快照时间', periodDays: '备货统计天数', periodStart: '备货统计开始', periodEnd: '备货统计结束',
  };
  const add = (name: string, rows: any[], overrides: Record<string, string> = {}) => {
    const translated = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [overrides[key] || labels[key] || key, value && typeof value === 'object' ? JSON.stringify(value) : value])));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(translated), name);
  };
  const d = payload.dashboard;
  const salesNote = channel === 'Amazon' ? 'Amazon销售额仅含FBA。'
    : '销售按RMS原订单、原购买SKU统计，已扣优惠券并排除取消。SKU优惠券按商品金额比例分摊。';
  const warehousesNote = d.summary.crossWarehouseUnitCount === undefined ? ''
    : '销量、分仓和SKU排行按原购买的实物明细统计，颜色定制费用计入总销售额与每日趋势。跨仓表示同一购买明细由两仓履约。未导入指无有效WMS订单，未匹配包括缺少对应明细或仓库未定。发货概况按WMS拆套后的履约明细统计，包含待发货明细。';
  add('统计说明', [{ 店铺: payload.selectedShop.shopName, 平台: channel, 生成时间: payload.generatedAt,
    ...d.period, 说明: `统计时间按日本时间。${payload.salesOnly ? '仅统计本公司产品。' : '库存为当前快照，备货建议按独立周期计算。'}商品排行最多100项。${salesNote}${warehousesNote}` }]);
  add('统计汇总', [d.summary]);
  add('同期对比', [{ ...d.comparison, previous: undefined }, { 对比周期: '上一周期', ...d.comparison.previous }]);
  add('每日趋势', d.daily || []);
  add('商品排行', d.topProducts || []);
  if (d.inventory) {
    add('库存汇总', [{ ...d.inventory, noSales90dRows: undefined }]);
    add('90天无销量库存', d.inventory.noSales90dRows || []);
  }
  if (d.fulfillment) add('发货概况', [d.fulfillment], {
    overseasUnitCount: '日本仓履约件数（拆套后）', chinaUnitCount: '中国仓履约件数（拆套后）',
  });
  if (d.orderStatuses) add('订单状态', [d.orderStatuses]);
  if (d.factoryRecommendations && !payload.salesOnly) {
    add('备货说明', [{ ...d.factoryRecommendations, rows: undefined }]);
    add('备货建议', d.factoryRecommendations.rows || []);
  }
  return { fileName: `${channel}看板_${payload.selectedShop.shopName}_${d.period.month || `近${d.period.days}天`}.xlsx`,
    content: XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' }) as Buffer };
}
