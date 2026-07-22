import {
  getAmazonInventorySnapshotMetadata,
  parseAmazonReplenishmentCsv,
  validateAmazonReplenishmentReports,
} from '../src/inventory/amazon-replenishment-report';

describe('Amazon replenishment report snapshots', () => {
  it('parses and validates the separate child-ASIN and FBA inventory reports', () => {
    const businessRows = parseAmazonReplenishmentCsv(
      Buffer.from('（子）ASIN,会话数 - 总计,页面浏览量 - 总计,已订购商品数量\nB001,10,12,2\n'),
    );
    const inventoryRows = parseAmazonReplenishmentCsv(
      Buffer.from(
        '快照日期,sku,FNSKU,asin,available,配送商品数量（过去 90 天）,store\n2026-07-21,sku-1,fn-1,B001,5,9,Amazon JP\n',
      ),
    );

    expect(() => validateAmazonReplenishmentReports(businessRows, inventoryRows)).not.toThrow();
    expect(getAmazonInventorySnapshotMetadata(inventoryRows)).toEqual({
      store: 'Amazon JP',
      snapshotDate: '2026-07-21',
    });
  });

  it('rejects a SKU sales report in place of the FBA inventory report', () => {
    const businessRows = parseAmazonReplenishmentCsv(
      Buffer.from('（子）ASIN,会话数 - 总计,页面浏览量 - 总计,已订购商品数量\nB001,10,12,2\n'),
    );
    const wrongInventoryRows = parseAmazonReplenishmentCsv(
      Buffer.from('SKU,（子）ASIN,已订购商品数量\nsku-1,B001,2\n'),
    );

    expect(() => validateAmazonReplenishmentReports(businessRows, wrongInventoryRows)).toThrow(
      '第二份文件不是FBA库存报告，缺少字段：FNSKU、ASIN、可售库存、过去90天配送数量',
    );
  });
});
