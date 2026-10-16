import { RakutenRmsApiClient } from '../src/rakuten-rms-api/rakuten-rms-api.client';

const key = { manageNumber: 'item', variantId: 'SkuA' };
describe('InventoryAPI 2.1 client', () => {
  let client: RakutenRmsApiClient;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    client = new RakutenRmsApiClient();
    (client as any).proxyDispatcher = null;
    fetchMock = jest.spyOn(global, 'fetch');
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => { now += 5000; return now; });
  });
  afterEach(() => jest.restoreAllMocks());
  it('reads quantities and delivery settings, strips plan fields from the request, and uses ESA auth', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ inventories: [{ ...key, quantity: 0,
      operationLeadTime: { normalDeliveryTimeId: 4, backOrderDeliveryTimeId: 5 }, shipFromIds: [3], created: 'ignored' }] }), { status: 200 }));
    const result = await client.getInventory('secret', 'license', [{ ...key, extra: 'must-not-send' } as any]);
    expect(result).toEqual([{ ...key, quantity: 0, operationLeadTime: { normalDeliveryTimeId: 4, backOrderDeliveryTimeId: 5 }, shipFromIds: [3] }]);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.rms.rakuten.co.jp/es/2.1/inventories/bulk-get');
    expect(JSON.parse(request.body)).toEqual({ inventories: [key] });
    expect(request.headers.authorization).toBe(`ESA ${Buffer.from('secret:license').toString('base64')}`);
  });
  it('accepts a 204 empty response as successful update', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.upsertInventory('secret', 'license', [{ ...key, mode: 'ABSOLUTE', quantity: 0 }])).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toContain('/es/2.1/inventories/bulk-upsert');
  });
  it('does not retry network failures on writes', async () => {
    fetchMock.mockRejectedValue(new Error('network failure'));
    await expect(client.upsertInventory('secret', 'license', [{ ...key, mode: 'ABSOLUTE', quantity: 1 }])).rejects.toThrow('结果未知');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not retry rejected writes and exposes only sanitized error codes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ code: 'IE0004', message: 'private remote response' }] }), { status: 400 }));
    await expect(client.upsertInventory('secret', 'license', [{ ...key, mode: 'ABSOLUTE', quantity: 1 }])).rejects.toThrow('IE0004');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([{ inventories: [{}] }, { inventories: [{ ...key, quantity: '0' }] }, { inventories: [{ ...key, quantity: 0, shipFromIds: ['bad'] }] }, {}])('fails closed on malformed read data: %j', async (payload) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    await expect(client.getInventory('secret', 'license', [key])).rejects.toThrow();
  });
  it('validates batch and quantity bounds before sending a write', async () => {
    for (const quantity of [-1, 100000, 1.5]) {
      await expect(client.upsertInventory('secret', 'license', [{ ...key, mode: 'ABSOLUTE', quantity }])).rejects.toThrow('不合法');
    }
    await expect(client.upsertInventory('secret', 'license', Array.from({ length: 401 }, () => ({ ...key, mode: 'ABSOLUTE', quantity: 1 })))).rejects.toThrow('不合法');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('searches a shop catalog by cursor without excluding zero stock, and filters states from each variant', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ numFound: 12000, nextCursorMark: 'next+token', results: [
      { item: { manageNumber: 'ITEM', title: '商品', hideItem: false, unlimitedInventoryFlag: false,
        variants: { SkuA: { merchantDefinedSkuId: 'LOCAL', hidden: false }, skua: { hidden: true } } } },
      { item: { manageNumber: 'deleted-only' } },
    ] }), { status: 200 }));
    const result = await client.searchCatalogPage('secret', 'license', '*');
    expect(result.variants).toEqual([
      { manageNumber: 'item', variantId: 'SkuA', merchantDefinedSkuId: 'LOCAL', title: '商品', hidden: false, unlimitedStock: false, salesStart: null, salesEnd: null },
      { manageNumber: 'item', variantId: 'skua', merchantDefinedSkuId: null, title: '商品', hidden: true, unlimitedStock: false, salesStart: null, salesEnd: null },
    ]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/es/2.0/items/search');
    expect(url.searchParams.get('cursorMark')).toBe('*');
    expect(url.searchParams.get('hits')).toBe('100');
    expect(url.searchParams.get('isHiddenItem')).toBe('false');
    expect(url.searchParams.has('offset')).toBe(false);
    expect(url.searchParams.has('isItemStockout')).toBe(false);
    expect(url.searchParams.has('isVariantStockout')).toBe(false);
  });
  it.each([
    { numFound: 1, results: [], nextCursorMark: null },
    { numFound: 1, results: [{ item: { manageNumber: 'item', title: 'partial', variants: {} } }], nextCursorMark: 'n' },
    { numFound: 1, results: [{ item: { manageNumber: 'item', title: 'bad-state', hideItem: 'false', unlimitedInventoryFlag: false, variants: { v: {} } } }], nextCursorMark: 'n' },
  ])('rejects partial/malformed catalog data rather than publishing an empty scope: %j', async (payload) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    await expect(client.searchCatalogPage('secret', 'license', '*')).rejects.toThrow();
  });

  it('bulk-validates actual products using the official direct results array, excluding hidden and expired variants', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ manageNumber: 'item', title: '商品', hideItem: false, unlimitedInventoryFlag: false,
      variants: { SkuA: {}, skua: { hidden: true } } }, { manageNumber: 'expired', title: '到期', hideItem: false, unlimitedInventoryFlag: false,
      purchasablePeriod: { end: '2020-01-01T00:00:00+09:00' }, variants: { v: {} } }] }), { status: 200 }));
    const values = await client.getItemsVariantIds('secret', 'license', ['item', 'expired']);
    expect(values.get('item')).toEqual(['SkuA']); expect(values.get('expired')).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.rms.rakuten.co.jp/es/2.0/items/bulk-get');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ manageNumbers: ['item', 'expired'] });
  });
  it.each([{ keys: [] }, { keys: ['item', 'item'] }, { keys: Array.from({ length: 51 }, (_, i) => `item${i}`) }])('rejects invalid bulk product requests before sending', async ({ keys }) => {
    await expect(client.getItemsVariantIds('secret', 'license', keys)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([{ results: [] }, { results: [{ manageNumber: 'other' }] }, { results: [{ manageNumber: 'item', variants: {} }] }])('fails closed on missing or malformed bulk results', async (payload) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    await expect(client.getItemsVariantIds('secret', 'license', ['item'])).rejects.toThrow();
  });
  it('allows authoritative missing products only for explicit isolation callers, while still rejecting duplicates and unknown items', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    expect((await client.getItemsVariantIds('secret', 'license', ['item'], true)).get('item')).toEqual([]);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ manageNumber: 'other' }] }), { status: 200 }));
    await expect(client.getItemsVariantIds('secret', 'license', ['item'], true)).rejects.toThrow('未知或重复');
  });
  it('gets variant IDs from actual product data rather than orphan inventory records', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ variants: { SkuA: {}, skua: {} } }), { status: 200 }));
    await expect(client.getItemVariantIds('secret', 'license', 'item')).resolves.toEqual(['SkuA', 'skua']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.rms.rakuten.co.jp/es/2.0/items/manage-numbers/item');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });
});
