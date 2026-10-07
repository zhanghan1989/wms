import { dashboardCodes, loadDashboardProducts, loadDashboardSkus } from '../src/inventory/dashboard-catalog';

describe('selective dashboard catalog', () => {
  it('loads negative/positive stock plus zero-stock referenced products, excluding inactive and unrelated products', async () => {
    const products = [
      { productId: 'stock', stockQty: 10, status: 1 },
      { productId: 'negative', stockQty: -2, status: 1 },
      { productId: 'sold', stockQty: 0, status: 1 },
      { productId: 'unused', stockQty: 0, status: 1 },
      { productId: 'disabled', stockQty: 10, status: 0 },
    ];
    const findMany = jest.fn(async ({ where }) => products.filter(row => row.status === where.status &&
      (where.stockQty ? row.stockQty !== 0 : where.productId.in.includes(row.productId))));
    const selected = await loadDashboardProducts({ masterProduct: { findMany } } as never,
      dashboardCodes([' sold ', 'disabled', 'stock', 'sold']));
    expect(selected.map(row => row.productId)).toEqual(['stock', 'negative', 'sold']);
    expect(selected.reduce((sum, row) => sum + row.stockQty, 0)).toBe(8);
    expect(findMany.mock.calls[1][0].where.productId.in).toEqual(['sold', 'disabled']);
  });

  it('bounds ID queries and does not read stocked products for the aggregate-only health summary', async () => {
    const findMany = jest.fn(async ({ where }) => where.productId.in.map((productId: string) => ({ productId, stockQty: 0 })));
    const ids = Array.from({ length: 1001 }, (_, n) => String(n));
    expect(await loadDashboardProducts({ masterProduct: { findMany } } as never, ids, false)).toHaveLength(1001);
    expect(findMany.mock.calls.map(([query]) => query.where.productId.in.length)).toEqual([500, 500, 1]);
    expect(await loadDashboardProducts({ masterProduct: { findMany } } as never, [], false)).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it('preserves ambiguous aliases, shop-specific primary SKUs and channel conflicts while deduplicating batches', async () => {
    const rows = [
      { productId: 'P1', sku: 'SKU1', rbSku: 'ALIAS', fbmSku: null, shop: 'A' },
      { productId: 'P2', sku: 'SKU2', rbSku: 'ALIAS', fbmSku: null, shop: 'B' },
      { productId: 'P3', sku: 'ALIAS', rbSku: null, fbmSku: null, shop: 'C' },
      { productId: 'P4', sku: 'SKU1', rbSku: null, fbmSku: null, shop: 'D' },
    ];
    const queryRaw = jest.fn().mockResolvedValue(rows);
    const codes = ['ALIAS', ...Array.from({ length: 500 }, (_, n) => `SKU${n}`)];
    expect(await loadDashboardSkus({ $queryRaw: queryRaw } as never, codes)).toEqual(rows);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const query = queryRaw.mock.calls[0][0];
    expect(query.sql).toContain('TRIM(s.rbSku)');
    expect(query.sql).toContain('TRIM(s.fbmSku)');
    expect(query.sql).toContain('s.status = 1 AND p.status = 1');
    expect(query.values).toHaveLength(1500);
    expect(await loadDashboardSkus({ $queryRaw: queryRaw } as never, [])).toEqual([]);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
