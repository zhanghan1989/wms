import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

describe('Rakuten order progress UI', () => {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('function renderRakutenWorkflowStep(');
  const end = source.indexOf('async function loadRakutenOrderWorkflows(', start);
  const render = runInNewContext(`${source.slice(start, end)}; renderRakutenWorkflowStep`, {
    escapeHtml: (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)),
    formatDate: (value: string) => value,
  });
  const order = { connectionId: '7', orderId: 'ORDER' };
  it('offers review for special content without an automatic-send control', () => {
    const html = render({ event: 'mixed_partial', label: '混発1', kind: 'mail', id: '1', status: 'pending',
      state: 'manual', canReviewBody: true, requiresManualReview: true, reason: '订单有特殊说明，请确认正文', executable: false }, order);
    expect(html).toContain('确认正文');
    expect(html).not.toContain('预览并发送');
  });
  it('uses body-review eligibility independently of the displayed wording', () => {
    const step = { event: 'japan_shipped', label: '日本発', kind: 'mail', id: '1', status: 'pending',
      state: 'manual', requiresManualReview: true, reason: '需要核对商品信息', executable: false };
    expect(render({ ...step, canReviewBody: true }, order)).toContain('workflowExecute');
    expect(render({ ...step, canReviewBody: false, reason: '订单已取消，请确认正文' }, order)).not.toContain('workflowExecute');
  });
  it('requires explicit human recovery for an unknown external-mail result', () => {
    const html = render({ event: 'japan_shipped', label: '日本発', kind: 'mail', id: '2', status: 'uncertain',
      state: 'manual', executable: false }, order);
    expect(html).toContain('确认已发送');
    expect(html).toContain('确认重发');
    expect(html).not.toContain('workflowExecute');
  });
  it('provides an explicit decision for missing new-order tasks', () => {
    const html = render({ event: 'new_order', label: '新規', kind: 'mail', id: null, state: 'manual',
      reason: '缺少新規任务，请人工核对后补发或确认无需发送' }, order);
    expect(html).toContain('生成新規任务');
    expect(html).toContain('确认无需发送');
  });
  it('escapes order identifiers and workflow reasons', () => {
    const html = render({ event: 'new_order', label: '新規', kind: 'mail', id: '1', state: 'ready',
      executable: true, reason: '<img src=x onerror=alert(1)>' }, { ...order, orderId: '\"><script>bad()</script>' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
  it('does not offer a resend for completed mail', () => {
    const html = render({ event: 'new_order', label: '新規', kind: 'mail', id: '1', status: 'sent', state: 'done', executable: false }, order);
    expect(html).toContain('查看');
    expect(html).not.toContain('workflowExecute');
    expect(html).not.toContain('workflowRetry');
  });
  it.each(['pending', 'failed', 'processing', 'dead_letter', 'uncertain'])('shows terminated %s mail as history without recovery actions', (status) => {
    const html = render({ event: 'china_customs', label: '中国発2', kind: 'mail', id: '1', status,
      state: 'done', outcome: 'terminated', executable: false, canReviewBody: false, reason: '订单已取消，流程已终止' }, order);
    expect(html).toContain('流程已终止');
    expect(html).toContain('workflowView');
    for (const action of ['workflowExecute', 'workflowRetry', 'workflowIgnore', 'workflowMarkSent']) expect(html).not.toContain(action);
    expect(html).not.toContain('执行中');
  });
  it.each(['pending', 'failed', 'dead_letter', 'skipped'])('hides recovery actions for terminated %s shipping', (status) => {
    const html = render({ event: 'shipping', label: '单号回传', kind: 'shipping', id: '84', status,
      state: 'done', outcome: 'terminated', executable: false }, order);
    expect(html).toContain('流程已终止');
    for (const action of ['workflowExecute', 'workflowRetry', 'workflowIgnoreShipping', 'workflowVerifyShipping']) expect(html).not.toContain(action);
  });
  it.each(['sent', 'skipped'])('offers verification for a changed %s shipment', status => {
    const html = render({ event: 'shipping', label: '单号回传', kind: 'shipping', id: '84', status,
      state: 'manual', executable: false }, order);
    expect(html).toContain('已人工回传，忽略提醒');
    expect(html).toContain('workflowVerifyShipping');
    expect(html).toContain('处理后重试');
  });
  it('keeps ordinary pending ignores separate from verified completed shipments', () => {
    const pending = render({ event: 'shipping', label: '单号回传', kind: 'shipping', id: '84', status: 'pending', state: 'waiting' }, order);
    expect(pending).toContain('忽略回传');
    expect(pending).not.toContain('workflowVerifyShipping');
    expect(render({ event: 'shipping', label: '单号回传', kind: 'shipping', id: '84', status: 'sent', state: 'done' }, order))
      .not.toContain('workflowVerifyShipping');
  });
});

describe('completed-shipping verification action', () => {
  it.each([true, false])('only verifies after human confirmation (%s)', async confirmed => {
    const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
    const start = source.indexOf('$("rakutenWorkflowModal")?.addEventListener("click", async (event) => {');
    const end = source.indexOf('$("rakutenWorkflowPrepare")?.addEventListener', start);
    let handler!: (event: any) => Promise<void>;
    const request = jest.fn().mockResolvedValue({ verified: true });
    const refresh = jest.fn();
    const confirmation = jest.fn().mockResolvedValue(confirmed);
    runInNewContext(source.slice(start, end), {
      $: () => ({ addEventListener: (_name: string, callback: typeof handler) => { handler = callback; } }),
      rakutenWorkflowResult: { items: [{ connectionId: '7', orderId: 'ORDER', steps: [{ id: '84', event: 'shipping', kind: 'shipping' }] }] },
      encodeURIComponent, openActionConfirmModal: confirmation, request,
      withBusyButton: (_button: unknown, _text: string, fn: () => unknown) => fn(),
      refreshRakutenProcessingCenter: refresh, showToast: jest.fn(),
    });
    await handler({ target: { closest: () => ({ dataset: { action: 'workflowVerifyShipping', key: '7:ORDER:shipping' } }) } });
    expect(confirmation).toHaveBeenCalledWith(expect.stringContaining('全部包裹'), '核实人工回传', '核实并忽略');
    if (confirmed) {
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith('/rakuten-rms-api/automation/manual-actions/shipping/84/verify-completed', { method: 'POST', body: '{}' });
      expect(refresh).toHaveBeenCalledTimes(1);
    } else {
      expect(request).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    }
  });
});

describe('single Rakuten processing center', () => {
  const html = readFileSync(join(__dirname, '../public/index.html'), 'utf8');
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  it('removes standalone shipping and mail entry buttons while preserving import and bulk actions', () => {
    const toolbar = html.slice(html.indexOf('<h3>乐天订单列表一览</h3>'), html.indexOf('<div id="rakutenOrdersTableWrap"'));
    expect(toolbar).toContain('自动处理中心');
    expect(toolbar).toContain('openRakutenApiImportModal');
    expect(toolbar).not.toContain('openRakutenOrderImportModal');
    expect(toolbar).toContain('rakutenBatchChangeOrderIdBtn');
    expect(toolbar).toContain('rakutenBatchDeleteBtn');
    expect(toolbar).not.toContain('<summary>批量操作</summary>');
    expect(toolbar).not.toContain('openRakutenManualShippingModal');
    expect(toolbar).not.toContain('openRakutenManualMailModal');
    expect(toolbar).not.toContain('downloadRakutenShipmentConfirmation');
  });
  it('removes Rakuten CSV upload and outbound CSV paths while retaining RMS API import', () => {
    const controller = readFileSync(join(__dirname, '../src/orders/orders.controller.ts'), 'utf8');
    const service = readFileSync(join(__dirname, '../src/orders/orders.service.ts'), 'utf8');
    expect(html).not.toContain('rakutenCenterCsv');
    expect(source).not.toContain('downloadRakutenShipmentConfirmation');
    expect(source).not.toContain("data-action='syncRakutenTrackingStatuses'");
    expect(source).not.toContain('/orders/rakuten/sync-tracking-statuses');
    expect(controller).not.toContain("@Post('rakuten/sync-tracking-statuses')");
    expect(controller).not.toContain('rakuten/shipment-confirmation-csv');
    expect(service).not.toContain('buildRakutenShipmentConfirmationCsv');
    expect(controller).not.toContain('rakuten/import-csv');
    expect(service).not.toContain('importUploadedCsv');
    expect(source).not.toContain('importOrdersFile');
    expect(html).not.toContain('rakutenOrderImportModal');
    const apiController = readFileSync(join(__dirname, '../src/rakuten-rms-api/rakuten-rms-api.controller.ts'), 'utf8');
    expect(apiController).toContain("@Post('connections/:id/sync')");
  });
  it('places existing record and template forms inside the center without duplicating IDs', () => {
    const center = html.slice(html.indexOf('<div id="rakutenWorkflowModal"'), html.indexOf('<div id="rakutenManualMailPreviewModal"'));
    for (const id of ['rakutenMailManagementBody', 'rakutenShippingManagementBody', 'rakutenAutomationRunsBody', 'rakutenMailTemplateForm', 'rakutenAutomationHealthBody']) {
      expect(center).toContain(`id="${id}"`);
      expect(html.split(`id="${id}"`)).toHaveLength(2);
    }
    expect(center).toContain('data-center-view="manual"');
    expect(center).toContain('data-center-view="processing"');
    expect(center).toContain('data-center-view="records"');
    expect(center).toContain('data-center-view="settings"');
  });
  it('renders only human steps in the manual inbox, with actionable review controls', () => {
    const elements: Record<string, any> = Object.fromEntries(['rakutenWorkflowBody', 'rakutenWorkflowHead', 'rakutenCenterViewDescription',
      'rakutenWorkflowPage', 'rakutenWorkflowPrev', 'rakutenWorkflowNext'].map((id) => [id, { innerHTML: '', textContent: '', disabled: false }]));
    const start = source.indexOf('function renderRakutenWorkflowStep(');
    const end = source.indexOf('async function loadRakutenOrderWorkflows(', start);
    const context = {
      $: (id: string) => elements[id], document: { querySelectorAll: () => [] },
      setTextById: (id: string, text: string) => { elements[id].textContent = text; },
      escapeHtml: (value: unknown) => String(value ?? ''), formatDate: (value: unknown) => String(value),
      rakutenWorkflowPage: 1, rakutenCenterView: 'manual',
    };
    const render = runInNewContext(`${source.slice(start, end)}; renderRakutenCenterWorkflows`, context);
    render({ items: [{ connectionId: '7', orderId: 'ORDER', shopName: '店铺', fulfillmentType: 'mixed', steps: [
      { id: '1', event: 'new_order', label: '新規', kind: 'mail', state: 'done', status: 'sent' },
      { id: '2', event: 'mixed_partial', label: '混発1', kind: 'mail', state: 'manual', status: 'pending',
        reason: '订单有特殊说明，请确认正文', requiresManualReview: true, canReviewBody: true },
    ] }], total: 1, pageSize: 30 }, 'manual');
    expect(elements.rakutenWorkflowBody.innerHTML).toContain('确认正文');
    expect(elements.rakutenWorkflowBody.innerHTML.split('<details')[0]).not.toContain('新規');
    expect(elements.rakutenWorkflowBody.innerHTML).toContain('查看完整流程');
    expect(elements.rakutenWorkflowHead.innerHTML).toContain('需要处理');
    expect(elements.rakutenWorkflowHead.innerHTML).not.toContain('单号回传');
  });
});

describe('center navigation and selections', () => {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const setup = () => {
    const nodes: Record<string, any> = {};
    const get = (id: string) => nodes[id] ?? (nodes[id] = {
      value: '', innerHTML: '', textContent: '', dataset: {}, disabled: false, classes: new Set<string>(),
      classList: { toggle: (name: string, hidden: boolean) => hidden ? nodes[id].classes.add(name) : nodes[id].classes.delete(name) },
      querySelector: () => ({ dataset: {} }),
    });
    const request = jest.fn().mockResolvedValue({ items: [], total: 0, pageSize: 30 });
    const mails = jest.fn(); const templates = jest.fn(); const health = jest.fn(); const shipping = jest.fn(); const runs = jest.fn();
    const context = {
      URLSearchParams, $: get, document: { querySelectorAll: () => [] }, setTextById: (id: string, text: string) => { get(id).textContent = text; },
      escapeHtml: (value: unknown) => String(value ?? ''), formatDate: (value: unknown) => String(value), request: (path: string, ...args: any[]) => path.includes('/import-issues')
        ? Promise.resolve({ items: [], total: 0, pageSize: 30 }) : request(path, ...args),
      loadRakutenMails: mails, loadRakutenMailTemplates: templates, loadRakutenAutomationHealth: health,
      loadRakutenShippingManagementActions: shipping, loadRakutenAutomationRuns: runs,
      loadRakutenTrackingFailures: jest.fn().mockResolvedValue(undefined),
      openActionConfirmModal: jest.fn().mockResolvedValue(true), withBusyButton: (_button: unknown, _text: string, fn: () => unknown) => fn(),
      showToast: jest.fn(),
    };
    const start = source.indexOf('let rakutenWorkflowPage =');
    const end = source.indexOf('async function previewRakutenManualMailAction(', start);
    const api = runInNewContext(`${source.slice(start, end)}; ({ select: selectRakutenCenterView, execute: executeRakutenCenterSelection,
      setResult: (value) => { rakutenWorkflowResult = value; }, selected: rakutenCenterSelected })`, context);
    return { api, nodes, get, request, mails, templates, health, shipping, runs, context };
  };
  it('shows records and settings inside the same center and loads only the selected content', async () => {
    const { api, get, mails, templates, health, shipping } = setup();
    await api.select('records', 'mail');
    expect(get('rakutenCenterWorkflowContent').classes.has('hidden')).toBe(true);
    expect(get('rakutenMailManagement').classes.has('hidden')).toBe(false);
    expect(get('rakutenShippingManagement').classes.has('hidden')).toBe(true);
    expect(mails).toHaveBeenCalledTimes(1);
    expect(shipping).not.toHaveBeenCalled();
    await api.select('settings');
    expect(get('rakutenCenterRecords').classes.has('hidden')).toBe(true);
    expect(get('rakutenCenterSettings').classes.has('hidden')).toBe(false);
    expect(templates).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenCalledTimes(1);
  });
  it('ignores an old manual response after switching to processing', async () => {
    const { api, get, request } = setup();
    let finishManual!: (value: unknown) => void;
    let finishProcessing!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finishManual = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishProcessing = resolve; }));
    const manual = api.select('manual');
    const processing = api.select('processing');
    finishProcessing({ items: [], total: 4, pageSize: 30 });
    await processing;
    finishManual({ items: [], total: 99, pageSize: 30 });
    await manual;
    expect(get('rakutenCenterViewDescription').textContent).toContain('处理中 4');
    expect(get('rakutenWorkflowHead').innerHTML).toContain('单号回传');
  });
  it('preserves batch actions but excludes mails requiring individual body review', async () => {
    const { api, request, context } = setup();
    api.setResult({ items: [{ connectionId: '7', orderId: 'ORDER', steps: [
      { id: '1', kind: 'shipping', event: 'shipping', executable: true },
      { id: '2', kind: 'mail', event: 'new_order', executable: true, templateVersion: 3 },
      { id: '3', kind: 'mail', event: 'mixed_partial', executable: true, requiresManualReview: true, templateVersion: 3 },
    ] }] });
    for (const key of ['7:ORDER:shipping', '7:ORDER:new_order', '7:ORDER:mixed_partial']) api.selected.add(key);
    request.mockResolvedValueOnce({ results: [] }).mockResolvedValueOnce({ items: [], total: 0, pageSize: 30 });
    await api.execute({});
    expect(context.openActionConfirmModal).toHaveBeenCalledWith(expect.stringContaining('回传 1 项单号并发送 1 封邮件'), '确认批量执行', '确认执行');
    const execution = request.mock.calls[0];
    expect(execution[0]).toBe('/rakuten-rms-api/automation/manual-actions/execute');
    expect(JSON.parse(execution[1].body).items).toEqual([
      { id: '1', kind: 'shipping' }, { id: '2', kind: 'mail', templateVersion: 3 },
    ]);
    expect(api.selected.size).toBe(0);
  });
});
