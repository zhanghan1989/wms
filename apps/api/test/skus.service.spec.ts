import JSZip = require('jszip');
import * as XLSX from 'xlsx';
import { SkusService } from '../src/skus/skus.service';
import { companyContext } from '../src/company-scope/company-context';

describe('SkusService', () => {
  describe.each(['exportExcel', 'exportUnmatchedExcel'] as const)('%s company isolation', (method) => {
    it.each([1n, 2n])('exports only the account company, including SKUs without products (case %#)', async (companyId) => {
      const rows = [1n, 2n].map((id) => ({
        companyId: id, sku: `company-${id}-sku`, productId: null, masterProduct: null,
      }));
      const prisma = { sku: { findMany: jest.fn().mockImplementation(async ({ where }) => {
        expect(where.companyId).toBe(companyId);
        if (method === 'exportUnmatchedExcel') {
          expect(where.OR).toEqual([{ productId: null }, { productId: '' }, { masterProduct: null }]);
        }
        return rows.filter((row) => row.companyId === where.companyId);
      }) } };
      const service = new SkusService(prisma as any, {} as any);
      const file = await companyContext.run({ companyId, systemAdmin: false, warehouse: false, userId: 9n }, () => service[method]());
      const workbook = XLSX.read(file.content, { type: 'buffer' });
      const exported = XLSX.utils.sheet_to_json(workbook.Sheets['SKU列表']);
      expect(exported).toEqual([expect.objectContaining({ SKU: `company-${companyId}-sku`, '产品ID': '' })]);
    });

    it.each([
      { systemAdmin: true, warehouse: false, userId: 1n, companyId: 2n },
      { systemAdmin: true, warehouse: false, userId: 1n },
      { systemAdmin: false, warehouse: true, userId: 1n },
    ])('retains administrator selection and shared warehouse access (case %#)', async (scope) => {
      const prisma = { sku: { findMany: jest.fn().mockResolvedValue([]) } };
      const service = new SkusService(prisma as any, {} as any);
      await companyContext.run(scope, () => service[method]());
      expect(prisma.sku.findMany.mock.calls[0][0].where.companyId).toBe(scope.companyId);
    });

    it('rejects missing account scope or unassigned Chinese company accounts before querying', async () => {
      const prisma = { sku: { findMany: jest.fn() } };
      const service = new SkusService(prisma as any, {} as any);
      await expect(service[method]()).rejects.toThrow('账号尚未分配公司');
      await companyContext.run({ systemAdmin: false, warehouse: false, userId: 1n }, async () => {
        await expect(service[method]()).rejects.toThrow('账号尚未分配公司');
      });
      expect(prisma.sku.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listPage', () => {
    it('returns one page plus the total without loading the entire SKU table', async () => {
      const rows = [
        { id: 3n, sku: 'sku-3', masterProduct: { productName: '产品三' } },
        { id: 2n, sku: 'sku-2', masterProduct: null },
        { id: 1n, sku: 'sku-1', masterProduct: { productName: '产品一' } },
      ];
      const prisma = {
        sku: {
          findMany: jest.fn().mockResolvedValue(rows),
          count: jest.fn().mockResolvedValue(12554),
        },
      };
      const service = new SkusService(prisma as any, {} as any);

      const result = await service.listPage('rb-db', 2, 2);

      expect(prisma.sku.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 2, take: 3 }),
      );
      expect(prisma.sku.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ status: 1, OR: expect.any(Array) }),
      });
      expect(result).toEqual({
        items: [
          expect.objectContaining({ id: 3n, productName: '产品三' }),
          expect.objectContaining({ id: 2n, productName: null }),
        ],
        page: 2,
        pageSize: 2,
        hasMore: true,
        total: 12554,
      });
    });
  });

  describe('exportAmazonRbLinkStockExcel', () => {
    it.each(['store-1', 'store-2', 'arc'])('denies other companies before querying data: %s', async (store) => {
      const prisma = { sku: { findMany: jest.fn() } };
      const service = new SkusService(prisma as any, {} as any);
      await companyContext.run({ companyId: 2n, systemAdmin: false, warehouse: false, userId: 8n }, async () => {
        await expect(service.exportAmazonRbLinkStockExcel(store)).rejects.toThrow('仅供XYJG公司');
      });
      expect(prisma.sku.findMany).not.toHaveBeenCalled();
    });

    it.each([
      { companyId: 1n, systemAdmin: false, warehouse: false, userId: 1n },
      { companyId: 2n, systemAdmin: true, warehouse: false, userId: 2n },
      { systemAdmin: false, warehouse: true, userId: 3n },
    ])('queries only XYJG data for authorized scope %#', async (scope) => {
      const stopped = new Error('query reached');
      const prisma = { sku: { findMany: jest.fn().mockImplementation(() => {
        expect(companyContext.getStore()?.companyId).toBe(1n);
        return Promise.reject(stopped);
      }) } };
      const service = new SkusService(prisma as any, {} as any);
      await companyContext.run(scope, async () => {
        await expect(service.exportAmazonRbLinkStockExcel('arc')).rejects.toBe(stopped);
        expect(companyContext.getStore()).toBe(scope);
      });
      expect(prisma.sku.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ companyId: 1n }),
      }));
    });

    it.each([
      ['legacy names', 'Arcdiary', '1号店 DGAZ', '2号店-DGAZ store'],
      ['renamed shops', 'ArcDiary亚马逊日本站', 'DGAZ亚马逊日本站', 'DGAZ Store亚马逊日本站'],
      ['normalized names', 'ＡｒｃＤｉａｒｙ 亚马逊日本站', ' dgaz 亚马逊日本站 ', 'DGAZ_Store-亚马逊日本站'],
      ['names without station suffix', 'ArcDiary亚马逊日本', 'DGAZ亚马逊日本', 'DGAZ Store亚马逊日本'],
    ])('returns only the requested account XLSM with that shop data: %s', async (_label, arcShop, store1Shop, store2Shop) => {
      const prisma = {
        sku: {
          findMany: jest.fn().mockResolvedValue([
            {
              rbSku: 'rb-arc-sku',
              masterProduct: { stockQty: 15 },
              shop: arcShop,
            },
            {
              rbSku: 'rb-db-brooklyn -23-hei',
              masterProduct: { stockQty: 9 },
              shop: store1Shop,
            },
            {
              rbSku: ' rb-wrapped\r\n-sku\t ',
              masterProduct: { stockQty: 5 },
              shop: store2Shop,
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
        expect(worksheet?.AF7?.v).toBe('日本乐天发货');
        expect(worksheet?.A8).toBeUndefined();
        expect(worksheet?.AF8).toBeUndefined();
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
