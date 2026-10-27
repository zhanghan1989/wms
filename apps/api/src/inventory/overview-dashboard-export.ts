import * as XLSX from 'xlsx';

const labels: Record<string, string> = {
  productId: '产品ID', productName: '产品名称', totalStock: '当前库存', availableStock: '可用库存',
  lockedStock: '锁定库存', inTransitStock: '在途库存', arrangedProductionStock: '已安排生产库存',
  arrangedProductionQty: '已安排生产件数', securedStock: '保障库存', activeProductCount: '启用产品数',
  activeUserCount: '启用用户数', masterProductCount: '产品数', shelfCount: '货架数', boxCount: '箱数',
  pendingInboundOrderCount: '待入库单数', totalOrderQty90d: '所选周期合计出单件数',
  systemOrderQty90d: '所选周期系统出单件数', fbmOrderQty90d: '所选周期FBM出单件数',
  rakutenOrderQty90d: '所选周期乐天出单件数', fbaOrderedQty90d: '所选周期FBA出单件数',
  amazonFbmOrderedQty90d: '所选周期Amazon FBM出单件数', rakutenOrderedQty90d: '所选周期乐天出单件数',
  manualOrderedQty90d: '所选周期手动订单件数', outboundQty90d: '所选周期出单件数',
  avgDailyOutbound: '所选周期日均件数', avgDailyOutbound90d: '所选周期日均件数',
  outboundQty30dCalculated: '折算30天月均件数', outboundProductCount90d: '所选周期出单产品数',
  stockCoverageDays: '库存可售天数', securedCoverageDays: '保障库存可售天数',
  totalOrderCount: '订单数', totalItemRowCount: '商品明细行数', totalQuantity: '总件数',
  fbmOrderCount: 'FBM订单数', fbmItemRowCount: 'FBM商品明细行数', fbmQuantity: 'FBM件数',
  rakutenOrderCount: '乐天订单数', amazonOrderCount: 'Amazon订单数', manualOrderCount: '手动订单数',
  channel: '渠道', orderId: '订单号', skuCode: 'SKU', quantity: '件数', registeredAt: '登记时间', reason: '原因',
  suggestedProductionQty: '建议生产件数', targetDemandQty: '目标需求件数', priority: '优先级',
  fbaAvailableQty: 'FBA可用库存', fbaInboundQty: 'FBA在途库存', fbaReservedQty: 'FBA预留库存',
  fbaUnfulfillableQty: 'FBA不可售库存', noSales90dCount: '90天无出单产品数', noSales90dStockQty: '90天无出单库存件数',
  qty7d: '近7天件数', prev7d: '前7天件数', ratio: '变化倍数', delta: '件数变化',
};

export function exportOverviewDashboard(value: unknown): { fileName: string; content: Buffer } {
  const data = value as Record<string, any>;
  const workbook = XLSX.utils.book_new();
  const add = (name: string, rows: Record<string, unknown>[], production = false) => {
    const translated = rows.map(row => Object.fromEntries(Object.entries(row)
      .filter(([, cell]) => cell === null || typeof cell !== 'object')
      .map(([key, cell]) => [production ? (labels[key] || key).replace('所选周期', '近90天') : labels[key] || key, cell])));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(translated), name);
  };
  add('统计说明', [{ 生成时间: data.generatedAt, 月份: data.period.month,
    统计天数: data.period.days, 开始时间: data.period.start, 结束时间不含: data.period.end,
    时区: 'Asia/Tokyo', 说明: '出单统计与排行按所选周期；库存为当前快照，备货及无出单提醒按近90天，异常波动按近7天；未匹配明细最多200条。' }]);
  add('系统汇总', [data.summary]);
  add('库存概况', [data.health]);
  add('出单汇总', [data.demand]);
  add('订单汇总', [data.orders30d]);
  add('商品排行', data.demand.topSkus || []);
  add('未匹配明细', data.demand.unmatchedSystemOrders90d?.details || []);
  add('异常波动（近7天）', data.demand.anomalySkus || []);
  add('备货说明（近90天）', [data.production]);
  add('备货建议（近90天）', data.production.recommendations || [], true);
  add('无出单库存（近90天）', data.obsolete.noSales90dSkus || []);
  return { fileName: `系统看板_${data.period.month || `近${data.period.days}天`}.xlsx`,
    content: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer };
}
