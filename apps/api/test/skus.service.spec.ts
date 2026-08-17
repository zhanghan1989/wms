import * as iconv from 'iconv-lite';
import { SkusService } from '../src/skus/skus.service';

describe('SkusService', () => {
  describe('exportAmazonRbLinkStockTxt', () => {
    it('keeps an rbSku containing line breaks in one TSV record', async () => {
      const prisma = {
        sku: {
          findMany: jest.fn().mockResolvedValue([
            {
              rbSku: ' rb-db-brooklyn\r\n-23-hei\t',
              masterProduct: { stockQty: 15 },
            },
          ]),
        },
      };
      const service = new SkusService(prisma as any, {} as any);

      const file = await service.exportAmazonRbLinkStockTxt();
      const lines = iconv.decode(file.content, 'gb18030').replace(/\r\n$/, '').split('\r\n');

      expect(lines).toHaveLength(4);
      expect(lines[3].split('\t')).toEqual([
        'rb-db-brooklyn-23-hei',
        '',
        '15',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ]);
    });
  });
});
