import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

function fixture() {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const nodes: Record<string, any> = {};
  const get = (id: string) => nodes[id] ??= { textContent: '', innerHTML: '', classList: { toggle: jest.fn() } };
  const request = jest.fn().mockResolvedValue({ items: [], total: 0, pageSize: 50, failedCount: 0, ignoredCount: 0 });
  const confirmation = jest.fn().mockResolvedValue(true);
  const api = runInNewContext(`${source.slice(source.indexOf('let rakutenTrackingFailuresPage ='), source.indexOf('let rakutenWorkflowPage ='))};
    ({load: loadRakutenTrackingFailures, change: updateRakutenTrackingIgnores, render: renderRakutenTrackingFailures,
      selected: rakutenTrackingFailuresSelected, setView: value => { rakutenTrackingFailuresView = value; },
      setPage: value => { rakutenTrackingFailuresPage = value; }, result: () => rakutenTrackingFailuresResult})`, {
    URLSearchParams, $: get, document: { querySelectorAll: () => [] }, request,
    setTextById: (id: string, text: string) => { get(id).textContent = text; },
    escapeHtml: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)),
    formatDate: (value: string) => value, openActionConfirmModal: confirmation,
    withBusyButton: (_button: unknown, _text: string, fn: () => unknown) => fn(), showToast: jest.fn(),
  });
  return { api, request, confirmation, get };
}

describe('tracking failure review UI', () => {
  it('does not ignore anything when the confirmation is dismissed', async () => {
    const f = fixture(); f.confirmation.mockResolvedValue(false);
    await f.api.change(['OLD-A'], true, {});
    expect(f.confirmation).toHaveBeenCalledWith(expect.stringContaining('不代表已通关或送达'), '人工忽略物流查询', '确认忽略');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('submits only chosen tracking numbers and reloads after ignore or restore', async () => {
    const f = fixture(); f.request.mockResolvedValueOnce({ changedCount: 2 });
    f.api.selected.add('OLD-A'); f.api.selected.add('OLD-B');
    await f.api.change(['OLD-A', 'OLD-B'], true, {});
    expect(JSON.parse(f.request.mock.calls[0][1].body)).toEqual({ trackingNos: ['OLD-A', 'OLD-B'], ignored: true });
    expect(f.api.selected.size).toBe(0);
    expect(f.request.mock.calls[1][0]).toContain('view=failed');
    f.api.setView('ignored'); f.request.mockResolvedValueOnce({ changedCount: 1 });
    await f.api.change(['OLD-A'], false, {});
    expect(JSON.parse(f.request.mock.calls[2][1].body)).toEqual({ trackingNos: ['OLD-A'], ignored: false });
    expect(f.request.mock.calls[3][0]).toContain('view=ignored');
  });

  it('discards late failure-list responses after switching to ignored', async () => {
    const f = fixture(); let finishFailed!: (result: any) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finishFailed = resolve; }))
      .mockResolvedValueOnce({ items: [{ trackingNo: 'IGNORED', ignoredAt: '2026-10-14', ignoredBy: 'human' }], total: 1 });
    const old = f.api.load(); f.api.setView('ignored'); await f.api.load();
    finishFailed({ items: [{ trackingNo: 'FAILED' }], total: 1 }); await old;
    expect(f.api.result().items[0].trackingNo).toBe('IGNORED');
    expect(f.get('rakutenTrackingFailuresBody').innerHTML).toContain('恢复查询');
    expect(f.get('rakutenTrackingFailuresBody').innerHTML).not.toContain('FAILED');
  });

  it('escapes untrusted errors and order identifiers before rendering', () => {
    const f = fixture();
    f.api.render({ items: [{ trackingNo: '" onclick="bad()', orderIds: ['<img src=x>'], error: '<script>bad()</script>', recordCount: 2 }], total: 1 });
    const html = f.get('rakutenTrackingFailuresBody').innerHTML;
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('" onclick="bad()');
  });

  it('clears stale selections and disables actions when reading fails', async () => {
    const f = fixture(); f.api.selected.add('OLD-A'); f.request.mockRejectedValueOnce(new Error('Network failed'));
    await f.api.load();
    expect(f.api.selected.size).toBe(0);
    expect(f.get('rakutenTrackingFailuresBatch').disabled).toBe(true);
    expect(f.get('rakutenTrackingFailuresSummary').textContent).toContain('读取失败');
  });
});
