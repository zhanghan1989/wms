import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
function editor(confirmed = true) {
  const elements: Record<string, any> = {};
  const $ = (id: string) => elements[id] ??= { value: '', dataset: {}, classList: { toggle: jest.fn() } };
  const request = jest.fn().mockResolvedValue({ id: '1' });
  const confirmation = jest.fn().mockResolvedValue(confirmed);
  const start = source.indexOf('function openOrderEditModalFromItem(');
  const end = source.indexOf('function renderOrdersPanels(', start);
  const functions = runInNewContext(`${source.slice(start, end)}; ({ openOrderEditModalFromItem, submitOrderEditForm })`, {
    $, request, openActionConfirmModal: confirmation, encodeURIComponent,
    hasRegisteredShipmentNo: (item: any) => Boolean(item.shipmentNo), formatDate: (date: string) => date,
    setOrderEditFieldValue: (id: string, value: unknown) => { $(id).value = String(value ?? ''); },
    getOrderEditFieldValue: (id: string) => $(id).value.trim(),
    setTextById: (id: string, value: string) => { $(id).textContent = value; },
    setOrderEditSourceMode: jest.fn(), setOrderEditProductMeta: jest.fn(), formatOrderEditDispatchMode: (x: unknown) => x,
    resolveOrderEditDispatchMode: (item: any) => item.dispatchMode, setOrderEditShipmentOnlyMode: jest.fn(), openModal: jest.fn(),
    syncOrderEditProductMeta: jest.fn().mockResolvedValue(undefined),
  });
  functions.openOrderEditModalFromItem('rakuten', { id: '1', orderId: 'ORDER', shipmentNo: 'OLD', shipmentCompany: 'Yamato',
    warehouseShippedAt: '2026-10-14T05:36:36.720Z', dispatchMode: 'overseas' });
  return { ...functions, $, request, confirmation };
}

describe('shipment correction editor', () => {
  it('requires an explicit choice when changing a confirmed parcel', async () => {
    const ui = editor();
    ui.$('orderEditShipmentNo').value = 'NEW';
    await expect(ui.submitOrderEditForm()).rejects.toThrow('请选择');
    expect(ui.request).not.toHaveBeenCalled();
  });
  it('sends the correction and original dispatch snapshot after confirmation', async () => {
    const ui = editor();
    ui.$('orderEditShipmentNo').value = 'NEW';
    ui.$('orderEditShipmentChangeMode').value = 'correction';
    await ui.submitOrderEditForm();
    const body = JSON.parse(ui.request.mock.calls[0][1].body);
    expect(body).toMatchObject({ shipmentEditMode: 'correction', shipmentNo: 'NEW', expectedShipmentNo: 'OLD',
      expectedShipmentCompany: 'Yamato', expectedWarehouseShippedAt: '2026-10-14T05:36:36.720Z' });
    expect(ui.confirmation).toHaveBeenCalledWith(expect.stringContaining('原实际出货时间会保留'), '确认修改发货信息', '确认修改');
  });
  it('cancels without saving or treating the cancellation as success', async () => {
    const ui = editor(false);
    ui.$('orderEditShipmentNo').value = 'NEW';
    ui.$('orderEditShipmentChangeMode').value = 'correction';
    expect(await ui.submitOrderEditForm()).toBe(false);
    expect(ui.request).not.toHaveBeenCalled();
    const start = source.indexOf('$("orderEditForm")?.addEventListener("submit", async (event) => {');
    const end = source.indexOf('\n  });', start) + 6;
    let handler!: (event: any) => Promise<void>;
    const closeModal = jest.fn(); const showToast = jest.fn();
    runInNewContext(source.slice(start, end), {
      $: () => ({ addEventListener: (_type: string, cb: typeof handler) => { handler = cb; } }),
      submitOrderEditForm: async () => false, closeModal, showToast,
      getSubmitButton: () => ({}), getOrderEditFieldValue: () => 'rakuten',
      withBusyButton: (_button: any, _text: string, fn: () => unknown) => fn(),
    });
    await handler({ preventDefault: jest.fn(), submitter: {} });
    expect(closeModal).not.toHaveBeenCalled(); expect(showToast).not.toHaveBeenCalled();
  });
  it('sends the replacement choice with an explanation of renewed dispatch confirmation', async () => {
    const ui = editor();
    ui.$('orderEditShipmentNo').value = 'NEW';
    ui.$('orderEditShipmentChangeMode').value = 'replacement';
    await ui.submitOrderEditForm();
    expect(JSON.parse(ui.request.mock.calls[0][1].body).shipmentEditMode).toBe('replacement');
    expect(ui.confirmation).toHaveBeenCalledWith(expect.stringContaining('原出货确认将清除'), '确认修改发货信息', '确认修改');
  });
  it('does not ask for a choice on an unchanged save', async () => {
    const ui = editor();
    await ui.submitOrderEditForm();
    expect(ui.confirmation).not.toHaveBeenCalled();
    expect(JSON.parse(ui.request.mock.calls[0][1].body).shipmentEditMode).toBeUndefined();
  });
  it.each(['amazon', 'manual', 'rakuten'])('clears the correction choice when opening another %s order', (platform) => {
    const ui = editor();
    ui.$('orderEditShipmentChangeMode').value = 'correction';
    ui.openOrderEditModalFromItem(platform, { id: '2', shipmentNo: 'OTHER', dispatchMode: 'china_pending' });
    expect(ui.$('orderEditShipmentChangeMode').value).toBe('');
    expect(ui.$('orderEditForm').dataset.confirmedJapanParcel).toBe('false');
    expect(ui.$('orderEditShipmentChangeLabel').classList.toggle).toHaveBeenLastCalledWith('hidden', true);
  });
});
