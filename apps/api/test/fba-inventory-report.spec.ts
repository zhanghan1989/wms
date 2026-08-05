import { parseFbaInventoryReport } from '../src/inventory/fba-inventory-report';

describe('FBA inventory report', () => {
  it('parses and groups FBA inventory quantities by seller SKU', () => {
    const csv = [
      '快照日期,sku,asin,商品名称,available,入库数量,预留总数量,不可售数量',
      '2026-07-22,FBA-1,B001,商品一,4,5,2,1',
      '2026-07-22,FBA-1,B001,商品一,3,1,0,2',
    ].join('\n');

    expect(parseFbaInventoryReport(Buffer.from(csv, 'utf8'))).toEqual({
      snapshotDate: '2026-07-22',
      rows: [
        expect.objectContaining({
          sellerSku: 'FBA-1',
          availableQty: 7,
          inboundQty: 6,
          reservedQty: 2,
          unfulfillableQty: 3,
        }),
      ],
    });
  });

  it('rejects a CSV that is not an FBA inventory report', () => {
    const csv = ['SKU,已订购商品数量', 'FBA-1,10'].join('\n');
    expect(() => parseFbaInventoryReport(Buffer.from(csv, 'utf8'))).toThrow('FBA库存报告');
  });
});
