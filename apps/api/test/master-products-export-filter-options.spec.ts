import { MasterProductsService } from '../src/master-products/master-products.service';

describe('master product export filter options', () => {
  it('loads every filter field in one query and reuses the cached result', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        productType: ' 包 ',
        bagBrand: 'Brand B',
        color: '黑',
        bagType: '手提',
        zipperStyle: null,
        buckleType: '',
        matchingBagType: '通用',
        patternType: '纯色',
        size: 'M',
      },
      {
        productType: '包',
        bagBrand: 'Brand A',
        color: '白',
        bagType: '手提',
        zipperStyle: '金属',
        buckleType: '按扣',
        matchingBagType: '通用',
        patternType: '纯色',
        size: 'M',
      },
    ]);
    const service = new MasterProductsService(
      { masterProduct: { findMany } } as never,
      {} as never,
    );

    const first = await service.getExportFilterOptions();
    const second = await service.getExportFilterOptions();

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { status: 1 },
      select: expect.objectContaining({
        productType: true,
        bagBrand: true,
        color: true,
        bagType: true,
        zipperStyle: true,
        buckleType: true,
        matchingBagType: true,
        patternType: true,
        size: true,
      }),
    });
    expect(first.productType).toEqual(['包']);
    expect(first.bagBrand).toEqual(['Brand A', 'Brand B']);
    expect(first.zipperStyle).toEqual(['金属']);
    expect(second).toBe(first);
  });

  it('coalesces concurrent cache misses into one database query', async () => {
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

    const first = service.getExportFilterOptions();
    const second = service.getExportFilterOptions();
    resolveRows?.([]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Object),
      expect.any(Object),
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
