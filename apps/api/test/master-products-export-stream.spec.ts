import { Writable } from 'stream';
import { ConflictException } from '@nestjs/common';
import { MasterProductsService } from '../src/master-products/master-products.service';

function createOutput(chunks: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
}

function createRow(index: number) {
  return {
    id: BigInt(index + 1),
    productId: `P-${String(index + 1).padStart(5, '0')}`,
    productName: index === 0 ? '=SUM(1,2)' : `产品 ${index + 1}`,
    productType: '包',
    bagBrand: '品牌',
    color: '黑',
    bagName: '包名',
    bagType: '手提',
    zipperStyle: '金属',
    style: '日常',
    pattern: '纯色',
    buckleType: '按扣',
    matchingBagType: '通用',
    length: '10',
    width: '20',
    patternType: '纯色',
    size: 'M',
    yamatoPrinterName: 'Printer',
    stockQty: 1000 - index,
  };
}

describe('master product streaming export', () => {
  it('reads rows in bounded batches and streams Excel-compatible CSV', async () => {
    const firstBatch = Array.from({ length: 500 }, (_, index) => createRow(index));
    const secondBatch = [createRow(500)];
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(secondBatch);
    const service = new MasterProductsService(
      { masterProduct: { findMany } } as never,
      {} as never,
    );
    const chunks: string[] = [];

    const totalRows = await service.streamExportCsv({}, createOutput(chunks));
    const csv = chunks.join('');

    expect(totalRows).toBe(501);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0][0].take).toBe(500);
    expect(findMany.mock.calls[1][0].where.AND[1]).toEqual(
      expect.objectContaining({ OR: expect.any(Array) }),
    );
    expect(csv.startsWith('\uFEFF产品ID,产品名称')).toBe(true);
    expect(csv).toContain(`P-00001,"'=SUM(1,2)"`);
    expect(csv).toContain('P-00501,产品 501');
  });

  it('rejects a second export while one is still running', async () => {
    let resolveRows: ((rows: unknown[]) => void) | undefined;
    const findMany = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveRows = resolve;
      }),
    );
    const service = new MasterProductsService(
      { masterProduct: { findMany } } as never,
      {} as never,
    );
    const first = service.streamExportCsv({}, createOutput([]));

    await expect(service.streamExportCsv({}, createOutput([]))).rejects.toBeInstanceOf(
      ConflictException,
    );
    resolveRows?.([]);
    await expect(first).resolves.toBe(0);
  });
});
