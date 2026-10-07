import * as XLSX from 'xlsx';
import { ConflictException } from '@nestjs/common';
import { MasterProductsService } from '../src/master-products/master-products.service';

const product = (id: number, productId: string, productType: string | null, stockQty: number) => ({
  id: BigInt(id), productId, productName: productId, productType, stockQty,
});
const component = (componentProductId: string, productType: string, quantity = 1, status = 1) => ({
  componentProductId, quantity, componentProduct: { productType, status },
});
const readRows = (content: Buffer) => {
  const workbook = XLSX.read(content, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(workbook.Sheets['海外仓库存'], { header: 1 });
};

describe('overseas warehouse stock export', () => {
  it('exports finished plus assemblable straps and excludes materials', async () => {
    const findMany = jest.fn()
      .mockResolvedValueOnce([
        product(1, 'STRAP', '肩带', 999), product(2, 'ASSEMBLY-ONLY', '肩带', 0),
        product(3, 'BAG', null, 30), product(4, 'NO-BOM', '肩带', 2),
        product(5, 'DISABLED-MATERIAL', '肩带', 3), product(6, 'ZERO', '肩带', 0),
      ])
      .mockResolvedValueOnce([
        { productId: 'STRAP', bomComponents: [component('BODY', '肩带本体'), component('HOOK', '肩带配件', 2)] },
        { productId: 'ASSEMBLY-ONLY', bomComponents: [component('BODY2', '肩带本体')] },
        { productId: 'NO-BOM', bomComponents: [] },
        { productId: 'DISABLED-MATERIAL', bomComponents: [component('DISABLED', '肩带本体', 1, 0)] },
        { productId: 'ZERO', bomComponents: [] },
      ]);
    const groupBy = jest.fn().mockResolvedValue([
      ['STRAP', 10], ['BODY', 100], ['HOOK', 150], ['BODY2', 20],
      ['NO-BOM', 2], ['DISABLED-MATERIAL', 3], ['DISABLED', 20],
    ].map(([productId, qty]) => ({ productId, _sum: { qty } })));
    const service = new MasterProductsService({ masterProduct: { findMany }, masterProductBoxInventory: { groupBy } } as never, {} as never);
    const file = await service.exportOverseasWarehouseStockExcel();
    expect(readRows(file.content)).toEqual([
      ['产品ID', '产品名称', '在库数'], ['STRAP', 'STRAP', 85], ['BAG', 'BAG', 30],
      ['ASSEMBLY-ONLY', 'ASSEMBLY-ONLY', 20], ['DISABLED-MATERIAL', 'DISABLED-MATERIAL', 3], ['NO-BOM', 'NO-BOM', 2],
    ]);
    expect(file.totalRows).toBe(5);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { AND: [
        { OR: [{ productType: null }, { productType: { notIn: ['肩带本体', '肩带配件'] } }] },
        { OR: [{ stockQty: { gt: 0 } }, { productType: '肩带' }] },
      ] },
      take: 500, orderBy: { id: 'asc' },
    });
    expect(findMany.mock.calls[0][0].select).not.toHaveProperty('boxInventories');
    expect(findMany.mock.calls[0][0].select).not.toHaveProperty('bomComponents');
  });

  it('paginates without losing rows and only aggregates shared materials once', async () => {
    const firstBatch = Array.from({ length: 500 }, (_, i) => product(i + 1, `P-${i}`, i === 0 ? '肩带' : '包', 1));
    const findMany = jest.fn()
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce([{ productId: 'P-0', bomComponents: [component('SHARED', '肩带本体')] }])
      .mockResolvedValueOnce([product(501, 'STRAP-2', '肩带', 0)])
      .mockResolvedValueOnce([{ productId: 'STRAP-2', bomComponents: [component('SHARED', '肩带本体', 2)] }]);
    const groupBy = jest.fn()
      .mockResolvedValueOnce([{ productId: 'SHARED', _sum: { qty: 20 } }])
      .mockResolvedValueOnce([]);
    const service = new MasterProductsService({ masterProduct: { findMany }, masterProductBoxInventory: { groupBy } } as never, {} as never);
    const file = await service.exportOverseasWarehouseStockExcel();
    const rows = readRows(file.content);
    expect(file.totalRows).toBe(501);
    expect(rows).toHaveLength(502);
    expect(rows.slice(1, 3)).toEqual([['P-0', 'P-0', 20], ['STRAP-2', 'STRAP-2', 10]]);
    expect(findMany.mock.calls[2][0].where.AND).toContainEqual({ id: { gt: 500n } });
    expect(groupBy.mock.calls[1][0].where.productId.in).toEqual(['STRAP-2']);
  });

  it('keeps headers on an empty export and skips material queries for ordinary products', async () => {
    const findMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([product(1, 'BAG', '包', 5)]);
    const groupBy = jest.fn();
    const service = new MasterProductsService({ masterProduct: { findMany }, masterProductBoxInventory: { groupBy } } as never, {} as never);
    const file = await service.exportOverseasWarehouseStockExcel();
    expect(readRows(file.content)).toEqual([['产品ID', '产品名称', '在库数']]);
    expect(file.totalRows).toBe(0);
    await expect(service.exportOverseasWarehouseStockExcel()).resolves.toMatchObject({ totalRows: 1 });
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('bounds material aggregation requests even when a batch has many distinct materials', async () => {
    const products = Array.from({ length: 500 }, (_, i) => product(i + 1, `STRAP-${i}`, '肩带', 0));
    const shoulders = products.map((row, i) => ({
      productId: row.productId, bomComponents: [component(`BODY-${i}`, '肩带本体')],
    }));
    const findMany = jest.fn().mockResolvedValueOnce(products).mockResolvedValueOnce(shoulders).mockResolvedValueOnce([]);
    const groupBy = jest.fn().mockResolvedValue([]);
    const service = new MasterProductsService({ masterProduct: { findMany }, masterProductBoxInventory: { groupBy } } as never, {} as never);
    await expect(service.exportOverseasWarehouseStockExcel()).resolves.toMatchObject({ totalRows: 0 });
    expect(groupBy).toHaveBeenCalledTimes(2);
    const requestedIds = groupBy.mock.calls.flatMap(([query]) => {
      expect(query.where.productId.in).toHaveLength(500);
      expect(query.where.qty).toEqual({ gt: 0 });
      return query.where.productId.in;
    });
    expect(new Set(requestedIds).size).toBe(1000);
  });

  it('limits concurrent exports and releases the guard after success or failure', async () => {
    let resolveRows!: (rows: unknown[]) => void;
    const findMany = jest.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveRows = resolve; }))
      .mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce([]);
    const service = new MasterProductsService({ masterProduct: { findMany } } as never, {} as never);
    const first = service.exportOverseasWarehouseStockExcel();
    await expect(service.exportOverseasWarehouseStockExcel()).rejects.toBeInstanceOf(ConflictException);
    resolveRows([]);
    await expect(first).resolves.toMatchObject({ totalRows: 0 });
    await expect(service.exportOverseasWarehouseStockExcel()).rejects.toThrow('database unavailable');
    await expect(service.exportOverseasWarehouseStockExcel()).resolves.toMatchObject({ totalRows: 0 });
  });
});
