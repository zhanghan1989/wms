import { ConflictException } from '@nestjs/common';
import { catalogCandidates, catalogExclusion, RakutenInventoryCatalogService } from '../src/rakuten-rms-api/rakuten-inventory-catalog.service';
import { inventoryKey } from '../src/rakuten-rms-api/rakuten-inventory.types';

const variant = (variantId: string, merchantDefinedSkuId: string | null = variantId) => ({ manageNumber: 'item', variantId, merchantDefinedSkuId, title: '商品', hidden: false, unlimitedStock: false, salesStart: null, salesEnd: null });
function fixture() {
  const connection: any = { id: 1n, shop: { name: '店铺A' }, inventoryCatalogVersion: 'old', inventoryCatalogRefreshedAt: new Date() };
  const jobs: any[] = [];
  const catalogRows: any[] = [];
  const mappings: any[] = [];
  const skus: any[] = [];
  const eligibleProducts = new Set<string>();
  const prisma: any = {
    $transaction: jest.fn((action) => Array.isArray(action) ? Promise.all(action) : action(prisma)),
    rakutenRmsConnection: { update: jest.fn(async ({ data }) => Object.assign(connection, data)) },
    rakutenInventoryCatalogJob: {
      findFirst: jest.fn(async ({ where }) => [...jobs].reverse().find((job) => job.connectionId === where.connectionId && (!where.status || where.status.in.includes(job.status))) ?? null),
      create: jest.fn(async ({ data }) => { const job = { productCount: 0, skuCount: 0, ...data }; jobs.push(job); return { ...job }; }),
      update: jest.fn(async ({ where, data }) => { const job = jobs.find((row) => row.id === where.id)!; for (const [key, value] of Object.entries(data)) job[key] = value && typeof value === 'object' && 'increment' in value ? (job[key] ?? 0) + Number(value.increment) : value; return { ...job }; }),
    },
    rakutenInventoryCatalog: {
      createMany: jest.fn(async ({ data }) => { catalogRows.push(...data); return { count: data.length }; }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn(async ({ where }) => catalogRows.filter((row) => row.connectionId === where.connectionId && row.version === where.version)),
    },
    sku: { findMany: jest.fn(async ({ where }) => skus.filter((row) => row.shop === where.shop && row.status === 1 && eligibleProducts.has(row.productId)
      && where.OR.some((condition: any) => Object.entries(condition).some(([key, value]: any) => value.in.includes(row[key]))))) },
    masterProduct: { findMany: jest.fn(async ({ where }) => where.productId.in.filter((id: string) => eligibleProducts.has(id)).map((productId: string) => ({ productId }))) },
    rakutenInventoryMapping: {
      findMany: jest.fn(async ({ where }) => mappings.filter((row) => row.connectionId === where.connectionId && (!where.manageNumber || where.manageNumber.in.includes(row.manageNumber)))),
      createMany: jest.fn(async ({ data }) => { for (const row of data) if (!mappings.some((old) => old.connectionId === row.connectionId && inventoryKey(old) === inventoryKey(row))) mappings.push(row); return { count: data.length }; }),
    },
  };
  const client = { searchCatalogPage: jest.fn() };
  const service = new RakutenInventoryCatalogService(prisma, client as any, { decrypt: () => 'test' } as any);
  const addSku = (sku: string, productId: string, shop = '店铺A') => {
    eligibleProducts.add(productId); skus.push({ sku, rbSku: null, fbmSku: null, productId, shop, status: 1 });
  };
  const page = (cursor: string, variants: any[], itemCount = variants.length) => ({ nextCursorMark: cursor, variants, itemCount, numFound: itemCount });
  return { service, prisma, connection, client, jobs, catalogRows, mappings, addSku, eligibleProducts, page };
}

describe('shop-first Rakuten catalog matching', () => {
  it('prioritizes merchant-defined SKU, uses exact case and falls back to variant ID only without a primary match', () => {
    const index = new Map([['merchant', new Set(['P1'])], ['SkuA', new Set(['P2'])], ['ambiguous', new Set(['P2', 'P1'])]]);
    expect(catalogCandidates(variant('SkuA', 'merchant'), index)).toEqual(['P1']);
    expect(catalogCandidates(variant('SkuA', null), index)).toEqual(['P2']);
    expect(catalogCandidates(variant('skua', null), index)).toEqual([]);
    expect(catalogCandidates(variant('SkuA', 'ambiguous'), index)).toEqual(['P1', 'P2']);
  });

  it('discovers only the shop SKU subset, preserves manual overrides and user-disabled mappings, and does not guess ambiguous matches', async () => {
    const f = fixture();
    f.addSku('unique', 'P'); f.addSku('ambiguous', 'P1'); f.addSku('ambiguous', 'P2');
    f.addSku('other-only', 'OTHER', '另一店'); f.addSku('new-product', 'NEW'); f.eligibleProducts.add('MANUAL');
    f.mappings.push(
      { connectionId: 1n, manageNumber: 'item', variantId: 'disabled', productId: 'P', source: 'auto', safetyStock: 9, enabled: false },
      { connectionId: 1n, manageNumber: 'item', variantId: 'manual', productId: 'MANUAL', source: 'manual', safetyStock: 4, enabled: true },
      { connectionId: 1n, manageNumber: 'item', variantId: 'changed', productId: 'OLD', source: 'auto', safetyStock: 0, enabled: true },
    );
    const variants = [variant('unique'), variant('ambiguous'), variant('other-only'), variant('missing'),
      variant('disabled', 'unique'), variant('manual', 'ambiguous'), variant('changed', 'new-product')];
    f.client.searchCatalogPage.mockResolvedValueOnce(f.page('next', variants)).mockResolvedValueOnce(f.page('next', []));
    await f.service.refresh(f.connection, jest.fn());
    const rows = Object.fromEntries(f.catalogRows.map((row) => [row.variantId, row]));
    expect(rows.unique).toMatchObject({ matchStatus: 'matched', productId: 'P' });
    expect(rows.ambiguous).toMatchObject({ matchStatus: 'ambiguous', productId: null });
    expect(rows['other-only']).toMatchObject({ matchStatus: 'unmatched', productId: null });
    expect(rows.missing.matchStatus).toBe('unmatched');
    expect(rows.manual).toMatchObject({ matchStatus: 'manual', productId: 'MANUAL' });
    expect(rows.changed).toMatchObject({ matchStatus: 'conflict', productId: null });
    expect(f.mappings.find((row) => row.variantId === 'disabled')).toMatchObject({ enabled: false, safetyStock: 9 });
    expect(f.mappings.find((row) => row.variantId === 'unique')).toMatchObject({ enabled: true, source: 'auto', productId: 'P' });
    expect(f.prisma.sku.findMany.mock.calls[0][0].where).toMatchObject({ shop: '店铺A', status: 1 });
    expect(f.prisma.rakutenRmsConnection.update).toHaveBeenCalledTimes(1);
    expect(f.connection.inventoryCatalogVersion).not.toBe('old');
  });

  it('keeps the previous complete scope on a mid-pagination failure', async () => {
    const f = fixture(); f.addSku('new', 'P');
    f.client.searchCatalogPage.mockResolvedValueOnce(f.page('second', [variant('new')])).mockRejectedValueOnce(new Error('API unavailable'));
    await expect(f.service.refresh(f.connection, jest.fn())).rejects.toThrow('API unavailable');
    expect(f.connection.inventoryCatalogVersion).toBe('old');
    expect(f.jobs[0].status).toBe('failed');
    expect(f.catalogRows).toHaveLength(1); // Staging exists but cannot become a live sync target.
    const scope = await f.service.scope(f.connection, f.mappings);
    expect(scope).toEqual([]);
    expect(f.prisma.rakutenRmsConnection.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ inventoryCatalogVersion: expect.any(String) }) }));
  });

  it('uses cursor traversal rather than the ten-thousand offset boundary', async () => {
    const f = fixture();
    for (let i = 0; i < 101; i++) f.client.searchCatalogPage.mockResolvedValueOnce(f.page(`cursor-${i}`, [], 100));
    f.client.searchCatalogPage.mockResolvedValueOnce(f.page('cursor-100', []));
    await f.service.refresh(f.connection, jest.fn());
    expect(f.client.searchCatalogPage.mock.calls[0][2]).toBe('*');
    expect(f.client.searchCatalogPage.mock.calls[101][2]).toBe('cursor-100');
    expect(f.jobs[0]).toMatchObject({ status: 'success', productCount: 10100 });
  });

  it('fails closed on cursor cycles and does not publish an incomplete catalog', async () => {
    const f = fixture();
    f.client.searchCatalogPage.mockResolvedValueOnce(f.page('A', [], 1)).mockResolvedValueOnce(f.page('B', [], 1)).mockResolvedValueOnce(f.page('A', [], 1));
    await expect(f.service.refresh(f.connection, jest.fn())).rejects.toThrow('游标循环');
    expect(f.connection.inventoryCatalogVersion).toBe('old');
  });

  it('excludes hidden, unlimited, time-limited, unmatched and absent SKUs while retaining zero-stock SKUs', async () => {
    const f = fixture();
    const cases = [
      ['zero-stock', {}], ['hidden', { hidden: true }], ['unlimited', { unlimitedStock: true }],
      ['future', { salesStart: new Date(Date.now() + 60000) }], ['ended', { salesEnd: new Date(0) }],
      ['ambiguous', { matchStatus: 'ambiguous' }], ['disabled', {}],
    ] as const;
    const mappings = cases.map(([variantId]) => ({ connectionId: 1n, manageNumber: 'item', variantId: String(variantId), productId: 'P', enabled: variantId !== 'disabled' }));
    mappings.push({ connectionId: 1n, manageNumber: 'item', variantId: 'absent', productId: 'P', enabled: true });
    f.catalogRows.push(...cases.map(([variantId, extra]) => ({ version: 'old', connectionId: 1n, manageNumber: 'item', variantId,
      productId: 'P', matchStatus: 'matched', hidden: false, unlimitedStock: false, salesStart: null, salesEnd: null, ...extra })));
    expect((await f.service.scope(f.connection, mappings as any)).map((row) => row.variantId)).toEqual(['zero-stock']);
    f.connection.inventoryCatalogRefreshedAt = new Date(Date.now() - 25 * 60 * 60_000);
    await expect(f.service.scope(f.connection, mappings as any)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refreshes once per day, or when a queued refresh needs recovery', async () => {
    const f = fixture();
    expect(await f.service.needsRefresh(f.connection)).toBe(false);
    await f.service.queue(1n);
    expect(await f.service.needsRefresh(f.connection)).toBe(true);
    f.connection.inventoryCatalogRefreshedAt = new Date(0);
    expect(f.service.isFresh(f.connection)).toBe(false);
  });

  it('rejects a premature cursor end when fewer products were retrieved than advertised', async () => {
    const f = fixture();
    f.client.searchCatalogPage.mockResolvedValueOnce({ ...f.page('A', [variant('one')]), numFound: 20 })
      .mockResolvedValueOnce({ ...f.page('A', []), numFound: 20 });
    await expect(f.service.refresh(f.connection, jest.fn())).rejects.toThrow('商品数不完整');
    expect(f.connection.inventoryCatalogVersion).toBe('old');
  });

  it('stops automatic mappings when the WMS relationship changes after the daily catalog refresh', async () => {
    const f = fixture(); f.addSku('local', 'NEW');
    const mapping = { connectionId: 1n, manageNumber: 'item', variantId: 'v', productId: 'OLD', enabled: true, source: 'auto' };
    f.mappings.push(mapping);
    f.catalogRows.push({ ...variant('v', 'local'), connectionId: 1n, version: 'old', productId: 'OLD', matchStatus: 'matched' });
    await expect(f.service.scope(f.connection, [mapping] as any)).rejects.toThrow('自动对应关系已有变化');
  });

  it('resumes the persisted cursor of an interrupted job instead of restarting or exposing its staging rows', async () => {
    const f = fixture();
    f.jobs.push({ id: 'resume', connectionId: 1n, status: 'running', cursorMark: 'saved-cursor', productCount: 100, skuCount: 20 });
    f.client.searchCatalogPage.mockResolvedValueOnce(f.page('saved-cursor', []));
    await f.service.refresh(f.connection, jest.fn());
    expect(f.client.searchCatalogPage.mock.calls[0][2]).toBe('saved-cursor');
    expect(f.jobs).toHaveLength(1);
    expect(f.connection.inventoryCatalogVersion).toBe('resume');
  });

  it('evaluates sale dates at sync time, so a cached future listing becomes eligible on schedule', () => {
    const row = { hidden: false, unlimitedStock: false, salesStart: new Date('2026-10-15T09:00:00+09:00'), salesEnd: null };
    expect(catalogExclusion(row, new Date('2026-10-15T08:59:00+09:00'))).toBe('尚未到销售时间');
    expect(catalogExclusion(row, new Date('2026-10-15T09:00:00+09:00'))).toBeNull();
  });
});
