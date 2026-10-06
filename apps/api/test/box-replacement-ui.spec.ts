import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

const app = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
const snippet = app.slice(app.indexOf('let replaceBoxSourceRevision ='), app.indexOf('async function submitMoveBoxShelfForm()'));
function setup() {
  const elements: Record<string, any> = {};
  for (const id of ['replaceBoxOldCode', 'replaceBoxNewCode', 'replaceBoxOldShelf', 'replaceBoxNewShelf', 'replaceBoxSummary', 'replaceBoxSubmit', 'replaceBoxShelfList']) {
    elements[id] = { value: '', textContent: '', innerHTML: '' };
  }
  elements.replaceBoxForm = { reset: () => Object.values(elements).forEach(element => { if ('value' in element) element.value = ''; }) };
  elements.replaceBoxOldCode.value = '1'; elements.replaceBoxNewCode.value = '2'; elements.replaceBoxNewShelf.value = 'A1';
  const storage = new Map();
  const summary = { oldBoxCode: '001', newBoxCode: '002', oldShelfCode: 'A1', newShelfCode: 'A1', qty: 17, productCount: 2, snapshotToken: 'a'.repeat(64) };
  const request = jest.fn().mockImplementation(async path => path.endsWith('preview') ? summary : { ...summary, idempotent: false });
  const context: any = {
    state: { me: { id: '1' } }, $: (id: string) => elements[id], request,
    normalizeBoxCodeInput: (raw: string) => /^\d{1,6}$/.test(raw.trim()) ? raw.trim().padStart(3, '0') : raw,
    normalizeShelfCodeInput: (raw: string) => raw.trim().split('-')[0], formatShelfCodeWithName: (code: string) => code,
    getEnabledShelvesSorted: () => [], escapeHtml: (value: string) => value,
    openActionConfirmModal: jest.fn().mockResolvedValue(true), newYamatoRequestId: () => 'operation-unique-id',
    showToast: jest.fn(), loadBoxes: jest.fn(), loadInventory: jest.fn(), loadAudit: jest.fn(),
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    clearTimeout, setTimeout,
  };
  runInNewContext(snippet, context);
  return { context, elements, request, summary, storage };
}

describe('whole-box replacement UI', () => {
  it('previews the full quantity, confirms once, submits the snapshot and refreshes stock', async () => {
    const { context, request } = setup();
    await context.submitReplaceBoxForm();
    expect(context.openActionConfirmModal.mock.calls[0][0]).toContain('全部 2 种产品、共 17 件');
    expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({ fromBoxCode: '001', toBoxCode: '002', shelfCode: 'A1', operationId: 'operation-unique-id', snapshotToken: 'a'.repeat(64) });
    expect(context.loadBoxes).toHaveBeenCalled();
    expect(context.loadInventory).toHaveBeenCalled();
  });
  it('retains the exact request across a lost response and page reset, without previewing the now empty source', async () => {
    const { context, request, summary, elements } = setup();
    request.mockResolvedValueOnce(summary).mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 0 })).mockResolvedValueOnce({ ...summary, idempotent: true });
    await expect(context.submitReplaceBoxForm()).rejects.toThrow('offline');
    const original = request.mock.calls[1][1].body;
    context.resetReplaceBoxForm();
    expect(elements.replaceBoxSubmit.textContent).toContain('上次换箱');
    await context.submitReplaceBoxForm();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2][1].body).toBe(original);
    expect(context.openActionConfirmModal).toHaveBeenCalledTimes(1);
  });
  it('requires the uncertain request to be resolved before replacing a different box', async () => {
    const { context, request, summary, elements } = setup();
    request.mockResolvedValueOnce(summary).mockRejectedValueOnce(new Error('offline'));
    await expect(context.submitReplaceBoxForm()).rejects.toThrow('offline');
    elements.replaceBoxNewCode.value = '3';
    await expect(context.submitReplaceBoxForm()).rejects.toThrow('上次换箱结果尚未确认');
    expect(request).toHaveBeenCalledTimes(2);
    expect(elements.replaceBoxNewCode.value).toBe('002');
  });
  it('preserves the retry request across form resets when browser storage is unavailable', async () => {
    const { context, request, summary, elements } = setup();
    context.sessionStorage.setItem = () => { throw new Error('storage disabled'); };
    context.sessionStorage.getItem = () => { throw new Error('storage disabled'); };
    request.mockResolvedValueOnce(summary).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...summary, idempotent: true });
    await expect(context.submitReplaceBoxForm()).rejects.toThrow('offline');
    const original = request.mock.calls[1][1].body;
    context.resetReplaceBoxForm();
    expect(elements.replaceBoxNewCode.value).toBe('002');
    await context.submitReplaceBoxForm();
    expect(request.mock.calls[2][1].body).toBe(original);
    expect(context.openActionConfirmModal).toHaveBeenCalledTimes(1);
  });
  it("does not restore another account's in-memory request when storage is unavailable", async () => {
    const { context, request, summary, elements } = setup();
    context.sessionStorage.setItem = () => { throw new Error('storage disabled'); };
    context.sessionStorage.getItem = () => { throw new Error('storage disabled'); };
    request.mockResolvedValueOnce(summary).mockRejectedValueOnce(new Error('offline'));
    await expect(context.submitReplaceBoxForm()).rejects.toThrow('offline');
    context.state.me = { id: '2' };
    context.resetReplaceBoxForm();
    expect(elements.replaceBoxNewCode.value).toBe('');
    expect(elements.replaceBoxSubmit.textContent).toBe('一键换箱号');
  });
  it('keeps replacement successful when refreshing a list fails, and clears the completed retry', async () => {
    const { context, request, elements, storage } = setup();
    context.loadInventory.mockRejectedValue(new Error('refresh offline'));
    await expect(context.submitReplaceBoxForm()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(context.showToast).toHaveBeenLastCalledWith('换箱已完成，但部分列表刷新失败，请刷新页面查看最新数据。', true);
    expect(elements.replaceBoxNewCode.value).toBe('');
    expect(storage.size).toBe(0);
  });
  it('does not submit a cancelled confirmation or an invalid box number', async () => {
    const { context, request, elements } = setup();
    context.openActionConfirmModal.mockResolvedValue(false);
    await context.submitReplaceBoxForm();
    expect(request).toHaveBeenCalledTimes(1);
    elements.replaceBoxNewCode.value = 'abc';
    await expect(context.submitReplaceBoxForm()).rejects.toThrow('数字箱号');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('ignores stale source responses and defaults the shelf to the latest source', async () => {
    const { context, request, elements } = setup();
    const resolvers: Array<(data: unknown) => void> = [];
    request.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    elements.replaceBoxNewShelf.value = '';
    const first = context.syncReplaceBoxSource();
    elements.replaceBoxOldCode.value = '3';
    const second = context.syncReplaceBoxSource();
    resolvers[1]({ shelfCode: 'A3', qty: 6, productCount: 2 });
    await second;
    resolvers[0]({ shelfCode: 'A1', qty: 17, productCount: 2 });
    await first;
    expect(elements.replaceBoxOldShelf.value).toBe('A3');
    expect(elements.replaceBoxNewShelf.value).toBe('A3');
    expect(elements.replaceBoxSummary.textContent).toContain('6 件');
  });
});
