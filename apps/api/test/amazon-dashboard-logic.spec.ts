type DashboardLogic = {
  aggregateBusinessRows: (rows: Array<Record<string, string>>) => Array<Record<string, unknown>>;
  buildAnalysis: (
    inventoryRows: Array<Record<string, string>>,
    businessRows: Array<Record<string, string>>,
    systemSkus: Array<Record<string, string>>,
  ) => {
    rows: Array<Record<string, unknown>>;
    source: Record<string, number>;
    totals: Record<string, number>;
  };
  normalizeInventoryRow: (row: Record<string, string>) => Record<string, unknown>;
  calculateOverseasReplenishment: (
    row: Record<string, unknown>,
    overseasStockQty: number,
    pendingFbaQty?: number,
    reservedOverseasStockQty?: number,
  ) => Record<string, unknown>;
  parseCsvText: (text: string) => Array<Record<string, string>>;
  validateUploadReportColumns: (
    inventoryRows: Array<Record<string, string>>,
    businessRows: Array<Record<string, string>>,
  ) => { businessMissing: string[]; inventoryMissing: string[] };
};

const logic = require('../public/amazon-dashboard-logic.js') as DashboardLogic;

describe('Amazon dashboard CSV matching logic', () => {
  it('parses quoted CSV cells and removes the UTF-8 BOM', () => {
    const rows = logic.parseCsvText('\uFEFFasin,标题,销售额\r\nB001,"带,逗号的标题","JP¥1,280"\r\n');

    expect(rows).toEqual([{ asin: 'B001', 标题: '带,逗号的标题', 销售额: 'JP¥1,280' }]);
  });

  it('uses inbound and reserved totals without adding their detail columns twice', () => {
    const row = logic.normalizeInventoryRow({
      sku: 'sku-1',
      asin: 'B001',
      available: '4',
      入库数量: '5',
      '入库-处理中': '0',
      '入库-已发出': '5',
      '入库-已接收': '0',
      预留总数量: '1',
      'Reserved FC Processing': '1',
      亚马逊物流库存供应: '9',
    });

    expect(row.inbound).toBe(5);
    expect(row.reserved).toBe(1);
    expect(row.fbaSupplyQty).toBe(9);
  });

  it('joins business data to inventory by child ASIN and keeps business-only ASINs', () => {
    const analysis = logic.buildAnalysis(
      [{ sku: 'sku-1', FNSKU: 'fn-1', asin: 'B001', available: '3', 商品名称: '库存商品' }],
      [
        {
          '（父）ASIN': 'P001',
          '（子）ASIN': 'B001',
          标题: '业务商品一',
          '会话数 - 总计': '100',
          已订购商品数量: '5',
          已订购商品销售额: 'JP¥5,000',
        },
        {
          '（父）ASIN': 'P002',
          '（子）ASIN': 'B002',
          标题: '业务商品二',
          '会话数 - 总计': '50',
          已订购商品数量: '2',
          已订购商品销售额: 'JP¥2,000',
        },
      ],
      [
        { sku: 'sku-1', fnsku: 'fn-1', asin: 'B001', productId: 'P-100', productName: '系统商品一' },
        { sku: 'other-sku', fnsku: 'fn-2', asin: 'B002', productId: 'P-200', productName: '系统商品二' },
      ],
    );

    expect(analysis.source.joinedAsinCount).toBe(1);
    expect(analysis.rows).toHaveLength(2);
    expect(analysis.totals.businessOrderedUnits).toBe(7);
    expect(analysis.totals.businessSalesAmount).toBe(7000);
    expect(analysis.totals.matchedRows).toBe(2);
    expect(analysis.rows.find((row) => row.asin === 'B002')).toMatchObject({
      sku: 'other-sku',
      matchedProductId: 'P-200',
      matchMode: 'asin',
      hasInventoryData: false,
    });
  });

  it('marks a non-unique system key as ambiguous instead of selecting a product', () => {
    const analysis = logic.buildAnalysis(
      [{ sku: 'same-sku', asin: 'B001' }],
      [{ '（子）ASIN': 'B001', 标题: '商品', 已订购商品数量: '1' }],
      [
        { sku: 'same-sku', asin: 'B001', productId: 'P-1', shop: 'Amazon-A' },
        { sku: 'same-sku', asin: 'B001', productId: 'P-2', shop: 'Amazon-B' },
      ],
    );

    expect(analysis.rows[0]).toMatchObject({ matchStatus: 'ambiguous', matchMode: 'sku', matchedProductId: '' });
    expect(analysis.totals.ambiguousRows).toBe(1);
  });

  it('limits FBA replenishment to overseas warehouse stock and exposes the remaining shortage', () => {
    const result = logic.calculateOverseasReplenishment(
      {
        daily90: 2,
        fbaSupplyQty: 20,
        suggestedShipQty: 0,
        coverageDays: 10,
      },
      50,
      20,
    );

    expect(result).toMatchObject({
      fbaTargetQty: 90,
      grossFbaGapQty: 70,
      fbaGapQty: 50,
      overseasStockQty: 50,
      pendingFbaQty: 20,
      overseasAvailableStockQty: 30,
      overseasReplenishmentQty: 30,
      overseasShortageQty: 20,
      replenishmentPriority: '海外仓库存不足',
    });
  });

  it('marks a fully covered urgent FBA gap as immediate overseas replenishment', () => {
    const result = logic.calculateOverseasReplenishment(
      {
        daily90: 1,
        fbaSupplyQty: 35,
        suggestedShipQty: 0,
        coverageDays: 10,
      },
      20,
    );

    expect(result).toMatchObject({
      fbaTargetQty: 45,
      grossFbaGapQty: 10,
      fbaGapQty: 10,
      overseasReplenishmentQty: 10,
      overseasShortageQty: 0,
      replenishmentPriority: '立即补货',
    });
  });

  it('does not recommend stock already reserved by an active FBA replenishment', () => {
    const result = logic.calculateOverseasReplenishment(
      { daily90: 1, fbaSupplyQty: 25, coverageDays: 10 },
      30,
      15,
    );

    expect(result).toMatchObject({
      grossFbaGapQty: 20,
      fbaGapQty: 5,
      pendingFbaQty: 15,
      overseasAvailableStockQty: 15,
      overseasReplenishmentQty: 5,
      overseasShortageQty: 0,
      replenishmentPriority: '立即补货',
    });
  });

  it('keeps 181-270 day inventory as a warning instead of an automatic removal quantity', () => {
    const row = logic.normalizeInventoryRow({
      sku: 'sku-aged',
      asin: 'B-AGED',
      '库龄 181-270 天': '12',
      '库龄 271-365 天': '3',
      '库龄 365 天以上': '1',
      建议移除数量: '2',
    });

    expect(row).toMatchObject({
      age181To270: 12,
      age270Plus: 4,
      suggestedRemovalQty: 2,
      removalSuggestedQty: 4,
    });
  });

  it('accepts the ASIN sales report and FBA inventory report only in their designated upload fields', () => {
    const result = logic.validateUploadReportColumns(
      [
        {
          sku: 'sku-1',
          FNSKU: 'fn-1',
          asin: 'B001',
          available: '5',
          '配送商品数量（过去 90 天）': '9',
        },
      ],
      [
        {
          '（子）ASIN': 'B001',
          '会话数 - 总计': '100',
          '页面浏览量 - 总计 ': '120',
          已订购商品数量: '3',
        },
      ],
    );

    expect(result).toEqual({ businessMissing: [], inventoryMissing: [] });
  });

  it('reports clear missing fields when the SKU sales report is uploaded as the FBA inventory report', () => {
    const result = logic.validateUploadReportColumns(
      [{ SKU: 'sku-1', '（子）ASIN': 'B001', 已订购商品数量: '3' }],
      [{ SKU: 'sku-1', 已订购商品数量: '3' }],
    );

    expect(result.businessMissing).toEqual(['（子）ASIN', '会话数 - 总计', '页面浏览量 - 总计']);
    expect(result.inventoryMissing).toEqual(['FNSKU', 'ASIN', '可售库存', '过去90天配送数量']);
  });
});
