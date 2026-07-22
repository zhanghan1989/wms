import {
  classifyFbaSalesRows,
  parseFbaSalesBusinessReport,
  parseFbaSalesPeriod,
} from '../src/inventory/fba-sales-report';

describe('FBA sales Business Report', () => {
  it('accepts exactly 90 inclusive calendar days and rejects other periods', () => {
    expect(parseFbaSalesPeriod('2026-04-23', '2026-07-21')).toMatchObject({ periodDays: 90 });
    expect(() => parseFbaSalesPeriod('2026-04-24', '2026-07-21')).toThrow('当前为89天');
    expect(() => parseFbaSalesPeriod('2026-02-30', '2026-05-30')).toThrow('日期格式无效');
  });

  it('parses seller SKU and ordered quantity from the Amazon CSV', () => {
    const csv = [
      '（父）ASIN,（子）ASIN,标题,SKU,已订购商品数量,已订购商品销售额,订单商品总数',
      'P001,B001,"商品,一",amazon-sku-1,"1,200","JP¥3,450",1190',
    ].join('\n');

    expect(parseFbaSalesBusinessReport(Buffer.from(csv, 'utf8'))).toEqual([
      {
        sellerSku: 'amazon-sku-1',
        asin: 'B001',
        productName: '商品,一',
        orderedQty: 1200,
        orderItemQty: 1190,
        salesAmount: 3450,
      },
    ]);
  });

  it('classifies system SKU as FBA and FBMSKU/RBSKU as FBM', () => {
    const reportRows = [
      { sellerSku: 'fba-1', asin: 'B1', productName: '', orderedQty: 10, orderItemQty: 9, salesAmount: 1000 },
      { sellerSku: 'fbm-1', asin: 'B2', productName: '', orderedQty: 20, orderItemQty: 18, salesAmount: 2000 },
      { sellerSku: 'rb-1', asin: 'B3', productName: '', orderedQty: 30, orderItemQty: 27, salesAmount: 3000 },
      { sellerSku: 'unknown', asin: 'B4', productName: '', orderedQty: 40, orderItemQty: 36, salesAmount: 4000 },
    ];
    const systemSkus = [
      { sku: 'fba-1', fbmSku: 'fbm-1', rbSku: 'rb-1', productId: 'P-1' },
    ];

    expect(classifyFbaSalesRows(reportRows, systemSkus)).toMatchObject([
      { sellerSku: 'fba-1', channel: 'fba', productId: 'P-1', matchedBy: 'sku' },
      { sellerSku: 'fbm-1', channel: 'fbm', productId: 'P-1', matchedBy: 'fbmSku' },
      { sellerSku: 'rb-1', channel: 'fbm', productId: 'P-1', matchedBy: 'rbSku' },
      { sellerSku: 'unknown', channel: 'unmatched', productId: null, matchedBy: null },
    ]);
  });

  it('does not choose a product when the same SKU maps to different products', () => {
    const rows = [{ sellerSku: 'same', asin: '', productName: '', orderedQty: 1, orderItemQty: 1, salesAmount: 1 }];
    const systemSkus = [
      { sku: 'same', fbmSku: null, rbSku: null, productId: 'P-1' },
      { sku: 'same', fbmSku: null, rbSku: null, productId: 'P-2' },
    ];

    expect(classifyFbaSalesRows(rows, systemSkus)[0]).toMatchObject({
      channel: 'ambiguous',
      productId: null,
      matchedBy: 'sku',
    });
  });
});
