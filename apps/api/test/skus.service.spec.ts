import JSZip = require('jszip');
import * as XLSX from 'xlsx';
import { SkusService } from '../src/skus/skus.service';

describe('SkusService', () => {
  describe('exportAmazonRbLinkStockExcel', () => {
    it('returns only the requested account XLSM with that shop data', async () => {
      const prisma = {
        sku: {
          findMany: jest.fn().mockResolvedValue([
            {
              rbSku: 'rb-arc-sku',
              masterProduct: { stockQty: 15 },
              shop: 'Arcdiary',
            },
            {
              rbSku: 'rb-db-brooklyn -23-hei',
              masterProduct: { stockQty: 9 },
              shop: '1号店 DGAZ',
            },
            {
              rbSku: ' rb-wrapped\r\n-sku\t ',
              masterProduct: { stockQty: 5 },
              shop: '2号店-DGAZ store',
            },
          ]),
        },
      };
      const service = new SkusService(prisma as any, {} as any);
      const contributorIds = new Set<string>();
      const cases = [
        {
          storeKey: 'store-1',
          fileName: /^amazon-rb-stock-store-1-\d{8}-\d{6}\.xlsm$/,
          rbSku: 'rb-db-brooklyn -23-hei',
          stockQty: 9,
        },
        {
          storeKey: 'store-2',
          fileName: /^amazon-rb-stock-store-2-\d{8}-\d{6}\.xlsm$/,
          rbSku: 'rb-wrapped-sku',
          stockQty: 5,
        },
        {
          storeKey: 'arc',
          fileName: /^amazon-rb-stock-arc-\d{8}-\d{6}\.xlsm$/,
          rbSku: 'rb-arc-sku',
          stockQty: 15,
        },
      ];

      for (const testCase of cases) {
        const file = await service.exportAmazonRbLinkStockExcel(testCase.storeKey);
        expect(file.fileName).toMatch(testCase.fileName);
        const workbook = XLSX.read(file.content, { type: 'buffer' });
        const worksheet = workbook.Sheets['テンプレート'];
        const archive = await JSZip.loadAsync(file.content);
        const worksheetXml = await archive
          .file('xl/worksheets/sheet5.xml')
          ?.async('string');

        expect(workbook.SheetNames).toContain('テンプレート');
        expect(worksheet?.A7?.v).toBe(testCase.rbSku);
        expect(worksheet?.B7?.v).toBe('出品者出荷（デフォルト）');
        expect(worksheet?.C7?.v).toBe(testCase.stockQty);
        expect(worksheet?.A8).toBeUndefined();
        expect(worksheetXml).toContain('<dimension ref="A1:AF7"/>');
        expect(worksheetXml).toContain('<dataValidations count="64">');

        const settings = String(worksheet?.A1?.v ?? '');
        const contributorId = settings.match(/contributorId=([^&]+)/)?.[1];
        expect(contributorId).toBeDefined();
        contributorIds.add(contributorId as string);
      }
      expect(contributorIds.size).toBe(3);
    });

    it('rejects unmapped shops instead of putting their SKU in the wrong template', async () => {
      const prisma = {
        sku: {
          findMany: jest.fn().mockResolvedValue([
            {
              rbSku: 'rb-unknown-shop',
              masterProduct: { stockQty: 3 },
              shop: '未配置店铺',
            },
          ]),
        },
      };
      const service = new SkusService(prisma as any, {} as any);

      await expect(service.exportAmazonRbLinkStockExcel('arc')).rejects.toThrow(
        '以下SKU店铺无法匹配亚马逊账号模板：未配置店铺（1条）',
      );
    });

    it('rejects an invalid Amazon store parameter before querying SKU data', async () => {
      const prisma = { sku: { findMany: jest.fn() } };
      const service = new SkusService(prisma as any, {} as any);

      await expect(service.exportAmazonRbLinkStockExcel('invalid')).rejects.toThrow(
        '亚马逊店铺参数无效',
      );
      expect(prisma.sku.findMany).not.toHaveBeenCalled();
    });
  });
});
