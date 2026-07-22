import {
  getAmazonInventorySnapshotMetadata,
  parseAmazonReplenishmentCsv,
  validateAmazonReplenishmentReports,
} from '../src/inventory/amazon-replenishment-report';
import { InventoryService } from '../src/inventory/inventory.service';

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

  it('loads the latest large snapshot without sorting its JSON columns', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 9n });
    const snapshot = {
      id: 9n,
      businessFileName: 'business.csv',
      inventoryFileName: 'inventory.csv',
      businessRowCount: 1,
      inventoryRowCount: 1,
      businessRows: [{ ASIN: 'B001' }],
      inventoryRows: [{ sku: 'sku-1' }],
      store: 'Amazon JP',
      snapshotDate: '2026-07-21',
      createdAt: new Date('2026-07-22T00:00:00.000Z'),
    };
    const findUnique = jest.fn().mockResolvedValue(snapshot);
    const service = new InventoryService(
      { amazonReplenishmentSnapshot: { findFirst, findUnique } } as never,
      {} as never,
    );

    await expect(service.getLatestAmazonReplenishmentReports()).resolves.toMatchObject({
      id: '9',
      businessRows: snapshot.businessRows,
      inventoryRows: snapshot.inventoryRows,
    });
    expect(findFirst).toHaveBeenCalledWith({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 9n } });
  });

  it('returns compact Amazon dashboard support data in one service call', async () => {
    const service = new InventoryService(
      {
        sku: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 2n,
              sku: 'sku-1',
              fnsku: 'fn-1',
              asin: 'B001',
              productId: 'P-1',
              masterProduct: { productName: '商品一' },
            },
          ]),
        },
        masterProduct: {
          findMany: jest.fn().mockResolvedValue([{ productId: 'P-1', productName: '商品一', stockQty: 25 }]),
        },
        fbaReplenishment: {
          findMany: jest.fn().mockResolvedValue([
            { skuId: 2n, status: 'pending_confirm', requestedQty: 3, actualQty: null },
            { skuId: 2n, status: 'pending_outbound', requestedQty: 4, actualQty: 2 },
          ]),
        },
      } as never,
      {} as never,
    );

    await expect(service.getAmazonReplenishmentSupportData()).resolves.toEqual({
      skus: [
        {
          id: '2',
          sku: 'sku-1',
          fnsku: 'fn-1',
          asin: 'B001',
          productId: 'P-1',
          productName: '商品一',
        },
      ],
      masterProducts: [{ productId: 'P-1', productName: '商品一', stockQty: 25 }],
      pendingConfirmCount: 2,
      pendingBySku: { '2': 5 },
    });
  });
});
