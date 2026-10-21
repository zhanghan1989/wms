import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

function fixture() {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const nodes: Record<string, any> = {};
  const get = (id: string) => nodes[id] ??= { textContent: '', innerHTML: '', value: '', disabled: false, checked: false };
  const request = jest.fn();
  const download = jest.fn();
  const api = runInNewContext(`${source.slice(source.indexOf('let rakutenInventoryCatalogTimer;'), source.indexOf('let rakutenScheduleTimer;'))};
    ({downloadCatalog: downloadRakutenInventoryCatalog, parseBulk: parseRakutenInventoryBulk, loadCatalog: loadRakutenInventoryCatalog, load: loadRakutenInventory, job: loadRakutenInventoryJob, issues: loadRakutenInventoryIssues, filter: value => {rakutenInventoryPreviewFilter = value;}, renderCatalog: renderRakutenInventoryCatalog, action: rakutenInventoryAction, setPreview: p => {rakutenInventoryPreview = p;}, preview: () => rakutenInventoryPreview})`, {
    $: get, request, triggerCsvDownload: download, URLSearchParams, setTimeout, clearTimeout, setTextById: (id: string, value: string) => { get(id).textContent = value; },
    escapeHtml: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)),
    formatRakutenOrderDateTime: (value: string) => value, withBusyButton: async (_a: any, _b: any, action: any) => action(), showToast: jest.fn(),
  });
  get('rakutenInventoryShop').value = '1';
  return { api, get, request, download };
}

describe('inventory sync configuration UI', () => {
  it('parses bounded explicit batch mappings without dropping disabled/safety settings and rejects duplicate targets', () => {
    const f = fixture();
    const parsed = f.api.parseBulk('P1\tItem\tSkuA\t8\t0\nP2\titem\tSkuB\t0\t1');
    expect(parsed.rows).toEqual([
      { productId: 'P1', manageNumber: 'Item', variantId: 'SkuA', safetyStock: 8, enabled: false },
      { productId: 'P2', manageNumber: 'item', variantId: 'SkuB', safetyStock: 0, enabled: true },
    ]);
    expect(() => f.api.parseBulk('P1\tItem\tSkuA\t0\t1\nP2\titem\tSkuA\t0\t1')).toThrow('SKU重复');
    expect(() => f.api.parseBulk('P1\titem\tSkuA')).toThrow('格式不正确');
    expect(() => f.api.parseBulk(Array(101).fill('P\titem\tv\t0\t1').join('\n'))).toThrow('100行');
  });
  it('starts with unresolved rows and sends the bounded search to the server', async () => {
    const f = fixture(); f.get('rakutenInventoryCatalogSearch').value = '117305';
    f.request.mockResolvedValue({ rows: [], counts: {}, total: 0, page: 1, pageSize: 50 });
    await f.api.loadCatalog();
    expect(f.request).toHaveBeenCalledWith(expect.stringContaining('issuesOnly=true&search=117305'));
  });

  it('downloads all filtered catalog pages, keeps identifiers and neutralizes spreadsheet formulas', async () => {
    const f = fixture(); f.get('rakutenInventoryCatalogFilter').value = 'unmatched';
    f.get('rakutenInventoryCatalogSearch').value = 'zh-';
    const row = { title: '=HYPERLINK("bad")', variantId: '00123', manageNumber: 'item', matchStatus: 'unmatched' };
    f.request.mockResolvedValueOnce({ version: 'v1', total: 2, rows: [row] })
      .mockResolvedValueOnce({ version: 'v1', total: 2, rows: [{ ...row, variantId: 'zh-set' }] });
    await f.api.downloadCatalog('1');
    expect(f.request.mock.calls[0][0]).toContain('pageSize=500&issuesOnly=true&search=zh-&matchStatus=unmatched&page=1');
    expect(f.request.mock.calls[1][0]).toContain('page=2');
    expect(f.download).toHaveBeenCalledTimes(1);
    const rows = f.download.mock.calls[0][1];
    expect(rows).toHaveLength(3);
    expect(rows[1][0]).toBe(`'=HYPERLINK("bad")`);
    expect(rows[1][2]).toBe('00123');
    expect(rows[2][2]).toBe('zh-set');
  });
  it('does not download a partial catalog when its version changes mid-export', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ version: 'v1', total: 2, rows: [{}] })
      .mockResolvedValueOnce({ version: 'v2', total: 2, rows: [{}] });
    await expect(f.api.downloadCatalog('1')).rejects.toThrow('已变化');
    expect(f.download).not.toHaveBeenCalled();
  });

  it('clears an old preview before reading configuration and ignores late responses from another shop', async () => {
    const f = fixture(); let resolveFirst!: (value: any) => void;
    f.request.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ enabled: true, mappings: [{ id: '2', productId: 'SHOP-2' }], runs: [] });
    f.api.setPreview({ previewId: 'old' });
    const first = f.api.load();
    expect(f.api.preview()).toBeNull();
    expect(f.get('rakutenInventoryExecute').disabled).toBe(true);
    f.get('rakutenInventoryShop').value = '2'; await f.api.load();
    resolveFirst({ enabled: false, mappings: [{ productId: 'SHOP-1' }], runs: [] }); await first;
    expect(f.get('rakutenInventoryMappingBody').innerHTML).toContain('SHOP-2');
    expect(f.get('rakutenInventoryMappingBody').innerHTML).not.toContain('SHOP-1');
  });
  it('escapes identifiers and error messages before rendering', async () => {
    const f = fixture(); f.request.mockResolvedValue({ enabled: false,
      mappings: [{ id: '1', productId: '<script>bad()</script>', manageNumber: '<img>', variantId: '" onclick="bad', safetyStock: 0, enabled: true }],
      runs: [{ status: 'failed', message: '<img src=x onerror=bad()>' }],
    });
    await f.api.load();
    expect(f.get('rakutenInventoryMappingBody').innerHTML).not.toContain('<script>');
    expect(f.get('rakutenInventoryRunsBody').innerHTML).not.toContain('<img');
  });
  it('prevents concurrent UI actions and leaves confirmation disabled when its preview was consumed', async () => {
    const f = fixture(); let finish!: () => void;
    const first = f.api.action({}, () => new Promise<void>((resolve) => { finish = resolve; }));
    const second = jest.fn(); await f.api.action({}, second); expect(second).not.toHaveBeenCalled();
    finish(); await first;
    expect(f.get('rakutenInventoryShop').disabled).toBe(false);
    expect(f.get('rakutenInventoryExecute').disabled).toBe(true);
  });
  it('renders matching issues with escaped catalog fields and preserves per-SKU settings beyond the 200-row mapping list', () => {
    const f = fixture();
    f.api.renderCatalog({ page: 1, pageSize: 50, total: 1, fresh: true, refreshedAt: '2026-10-15', counts: { ambiguous: 1 }, rows: [{
      id: '999', title: '<script>bad()</script>', manageNumber: 'item', variantId: 'SKU', merchantDefinedSkuId: '<img>',
      productId: null, matchStatus: 'ambiguous', candidates: ['<bad>'], mapping: { safetyStock: 9, enabled: false },
    }] });
    const html = f.get('rakutenInventoryCatalogBody').innerHTML;
    expect(html).toContain('多个产品'); expect(html).toContain('已停用'); expect(html).not.toContain('<script>'); expect(html).not.toContain('<img>');
    expect(f.get('rakutenInventoryCatalogBody')._rows[0].mapping.safetyStock).toBe(9);
  });

  it('renders one preview page with its full summary and warns about stock being zeroed', async () => {
    const f = fixture();
    f.request.mockResolvedValue({ status: 'preview', jobId: 'job', previewId: 'job', page: 2, pageSize: 50, total: 101, changedCount: 90,
      zeroedCount: 20, expiresAt: new Date(Date.now() + 60000).toISOString(), rows: [{ productId: '<script>', manageNumber: 'item', variantId: 'v', currentQuantity: 3, quantity: 0 }] });
    await f.api.job('job', '1', 2);
    expect(f.get('rakutenInventoryPreviewMeta').textContent).toContain('20 个将从有库存改为0');
    expect(f.get('rakutenInventoryPreviewPage').textContent).toContain('2 / 3');
    expect(f.get('rakutenInventoryPreviewBody').innerHTML).not.toContain('<script>');
    expect(f.get('rakutenInventoryExecute').disabled).toBe(false);
    expect(f.get('rakutenInventoryPreviewNext').disabled).toBe(false);
    expect(f.request).toHaveBeenCalledWith(expect.stringContaining('/jobs/job?page=2'));
  });
  it('ignores late background-job progress from the previously selected shop', async () => {
    const f = fixture(); let finish!: (value: any) => void;
    f.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const progress = f.api.job('old', '1');
    f.get('rakutenInventoryShop').value = '2';
    f.request.mockResolvedValueOnce({ enabled: false, mappings: [], runs: [], pauseReason: '店铺2已暂停' });
    await f.api.load();
    finish({ status: 'preview', page: 1, total: 1, rows: [{ productId: 'wrong-shop' }] }); await progress;
    expect(f.api.preview()).toBeNull();
    expect(f.get('rakutenInventoryPreviewBody').innerHTML).not.toContain('wrong-shop');
    expect(f.get('rakutenInventoryAlert').textContent).toContain('店铺2已暂停');
  });
  it('polls a running job and enables confirmation only after a completed unexpired preview', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture(); f.get('rakutenWorkflowModal').classList = { contains: () => false };
      f.request.mockResolvedValueOnce({ status: 'planning', page: 1, pageSize: 50, total: 0, rows: [], message: '正在计算预占' })
        .mockResolvedValueOnce({ status: 'preview', previewId: 'job', page: 1, pageSize: 50, total: 1, changedCount: 1,
          expiresAt: new Date(Date.now() + 60000).toISOString(), rows: [] });
      await f.api.job('job', '1');
      expect(f.get('rakutenInventoryExecute').disabled).toBe(true);
      await jest.advanceTimersByTimeAsync(2500);
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.get('rakutenInventoryExecute').disabled).toBe(false);
      f.request.mockResolvedValueOnce({ status: 'preview', page: 1, pageSize: 50, total: 1, changedCount: 1, expiresAt: '2000-01-01', rows: [] });
      await f.api.job('job', '1');
      expect(f.get('rakutenInventoryExecute').disabled).toBe(true);
    } finally { jest.useRealTimers(); }
  });

  it('shows elapsed time and the latest heartbeat for a running preview', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      f.request.mockResolvedValue({ status: 'planning', page: 1, pageSize: 50, total: 0, rows: [],
        startedAt: '2026-10-21T08:00:00Z', serverTime: '2026-10-21T08:05:00Z',
        heartbeatAt: '2026-10-21T08:04:58Z', lastProgressAt: '2026-10-21T08:04:50Z', message: '正在计算库存' });
      await f.api.job('job', '1');
      expect(f.get('rakutenInventoryPreviewMeta').textContent).toContain('已执行 300 秒');
      expect(f.get('rakutenInventoryPreviewMeta').textContent).toContain('最近心跳');
      expect(f.get('rakutenInventoryPreviewMeta').textContent).toContain('最近进展');
    } finally { jest.useRealTimers(); }
  });

  it('uses filtered page counts but keeps the complete preview eligible for confirmation', async () => {
    const f = fixture(); f.api.filter('zero');
    f.request.mockResolvedValue({ status: 'preview', previewId: 'job', page: 1, pageSize: 50, total: 101, filteredTotal: 1, changedCount: 90, zeroedCount: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(), rows: [{ productId: 'P', stock: { finishedStock: 10, assemblableStock: null, pendingReserved: 4 }, safetyStock: 6, quantity: 0, currentQuantity: 2 }] });
    await f.api.job('job', '1');
    expect(f.request).toHaveBeenCalledWith(expect.stringContaining('filter=zero'));
    expect(f.get('rakutenInventoryPreviewPage').textContent).toContain('1 / 1');
    expect(f.get('rakutenInventoryExecute').disabled).toBe(false);
    expect(f.get('rakutenInventoryPreviewNext').disabled).toBe(true);
    expect(f.get('rakutenInventoryPreviewBody').innerHTML).toContain('<td>4</td>');
    expect(f.get('rakutenInventoryPreviewBody').innerHTML).toContain('<td>—</td>');
  });
  it('escapes quarantined SKU diagnostics and scopes issue requests to the current shop', async () => {
    const f = fixture(); f.get('rakutenInventoryIssuesPanel').classList = { toggle: jest.fn() };
    f.request.mockResolvedValue({ total: 1, pageSize: 50, rows: [{ mappingId: '11', productId: '<img>', reason: '<script>bad()</script>' }] });
    await f.api.issues();
    expect(f.request).toHaveBeenCalledWith(expect.stringContaining('/connections/1/inventory/issues?page=1'));
    expect(f.get('rakutenInventoryIssuesBody').innerHTML).not.toContain('<script>');
    expect(f.get('rakutenInventoryIssuesBody').innerHTML).not.toContain('<img>');
  });

  it('places a default-off inventory task in the existing automation center', () => {
    const html = readFileSync(join(__dirname, '../public/index.html'), 'utf8');
    expect(html).toContain('data-schedule-toggle="inventory"');
    expect(html).toContain('aria-label="库存自动同步"');
    expect(html).toContain('每个SKU独立使用全量可用库存');
    expect(html).toContain('每天17:30独立检查');
    expect(html).toContain('按当天完整核对状态校验商品');
    expect(html).not.toContain('每20分钟跟随自动处理流程执行');
  });
});
