import { MasterProductsService } from '../src/master-products/master-products.service';

describe('master product export filter options', () => {
  it('loads only grouped database values and reuses the cached result', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ value: ' 包 ' }, { value: '包' }])
      .mockResolvedValueOnce([{ value: 'Brand B' }, { value: 'Brand A' }])
      .mockResolvedValueOnce([{ value: '黑' }, { value: '白' }])
      .mockResolvedValueOnce([{ value: '手提' }])
      .mockResolvedValueOnce([{ value: '纯色' }])
      .mockResolvedValueOnce([{ value: 'M' }]);
    const service = new MasterProductsService(
      { $queryRaw: queryRaw } as never,
      {} as never,
    );

    const first = await service.getExportFilterOptions();
    const second = await service.getExportFilterOptions();

    expect(queryRaw).toHaveBeenCalledTimes(6);
    expect(first.productType).toEqual(['包']);
    expect(first.bagBrand).toEqual(['Brand A', 'Brand B']);
    expect(first.zipperStyle).toEqual([]);
    expect(second).toBe(first);
  });

  it('coalesces concurrent cache misses into one filter-options load', async () => {
    let resolveRows: ((rows: unknown[]) => void) | undefined;
    const queryRaw = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveRows = resolve;
      }),
    );
    const service = new MasterProductsService(
      { $queryRaw: queryRaw } as never,
      {} as never,
    );

    const first = service.getExportFilterOptions();
    const second = service.getExportFilterOptions();
    resolveRows?.([]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.any(Object),
      expect.any(Object),
    ]);
    expect(queryRaw).toHaveBeenCalledTimes(6);
  });
});
