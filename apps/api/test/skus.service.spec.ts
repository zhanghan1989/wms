import JSZip = require('jszip');
import * as XLSX from 'xlsx';
import { SkusService } from '../src/skus/skus.service';

describe('SkusService', () => {
  describe('exportAmazonRbLinkStockExcel', () => {
    it('populates the current Amazon XLSM template without changing valid SKU spaces', async () => {
      const prisma = {
        sku: {
          findMany: jest.fn().mockResolvedValue([
            {
              rbSku: 'rb-db-brooklyn -23-hei',
              masterProduct: { stockQty: 15 },
            },
            {
              rbSku: ' rb-wrapped\r\n-sku\t ',
              masterProduct: { stockQty: 9 },
            },
          ]),
        },
      };
      const service = new SkusService(prisma as any, {} as any);

      const file = await service.exportAmazonRbLinkStockExcel();
      const workbook = XLSX.read(file.content, { type: 'buffer' });
      const worksheet = workbook.Sheets['テンプレート'];
      const archive = await JSZip.loadAsync(file.content);
      const worksheetXml = await archive
        .file('xl/worksheets/sheet5.xml')
        ?.async('string');

      expect(file.fileName).toMatch(/^亚马逊更新价格和数量模板-\d{8}-\d{6}\.xlsm$/);
      expect(workbook.SheetNames).toContain('テンプレート');
      expect(worksheet?.A7?.v).toBe('rb-db-brooklyn -23-hei');
      expect(worksheet?.B7?.v).toBe('出品者出荷（デフォルト）');
      expect(worksheet?.C7?.v).toBe(15);
      expect(worksheet?.A8?.v).toBe('rb-wrapped-sku');
      expect(worksheet?.C8?.v).toBe(9);
      expect(worksheetXml).toContain('<dimension ref="A1:AF8"/>');
      expect(worksheetXml).toContain('<dataValidations count="64">');
      expect(worksheetXml).not.toContain('rb-db-belt');
    });
  });
});
