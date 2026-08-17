import JSZip = require('jszip');
import * as XLSX from 'xlsx';
import { SkusService } from '../src/skus/skus.service';

describe('SkusService', () => {
  describe('exportAmazonRbLinkStockExcel', () => {
    it('returns three account-specific populated XLSM templates in one ZIP', async () => {
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
      const archive = await JSZip.loadAsync(file.content);

      expect(file.fileName).toMatch(/^亚马逊rb链接库存-\d{8}-\d{6}\.zip$/);
      const xlsmFiles = Object.keys(archive.files).filter((name) =>
        name.endsWith('.xlsm'),
      );
      expect(xlsmFiles).toHaveLength(3);
      expect(xlsmFiles).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^amazon-rb-stock-arc-\d{8}-\d{6}\.xlsm$/),
          expect.stringMatching(/^amazon-rb-stock-store-1-\d{8}-\d{6}\.xlsm$/),
          expect.stringMatching(/^amazon-rb-stock-store-2-\d{8}-\d{6}\.xlsm$/),
        ]),
      );

      const contributorIds = new Set<string>();
      for (const xlsmFile of xlsmFiles) {
        const xlsmContent = await archive.file(xlsmFile)?.async('nodebuffer');
        expect(xlsmContent).toBeDefined();
        const workbook = XLSX.read(xlsmContent as Buffer, { type: 'buffer' });
        const worksheet = workbook.Sheets['テンプレート'];
        const innerArchive = await JSZip.loadAsync(xlsmContent as Buffer);
        const worksheetXml = await innerArchive
          .file('xl/worksheets/sheet5.xml')
          ?.async('string');

        expect(workbook.SheetNames).toContain('テンプレート');
        expect(worksheet?.A7?.v).toBe('rb-db-brooklyn -23-hei');
        expect(worksheet?.B7?.v).toBe('出品者出荷（デフォルト）');
        expect(worksheet?.C7?.v).toBe(15);
        expect(worksheet?.A8?.v).toBe('rb-wrapped-sku');
        expect(worksheet?.C8?.v).toBe(9);
        expect(worksheetXml).toContain('<dimension ref="A1:AF8"/>');
        expect(worksheetXml).toContain('<dataValidations count="64">');

        const settings = String(worksheet?.A1?.v ?? '');
        const contributorId = settings.match(/contributorId=([^&]+)/)?.[1];
        expect(contributorId).toBeDefined();
        contributorIds.add(contributorId as string);
      }
      expect(contributorIds.size).toBe(3);
    });
  });
});
