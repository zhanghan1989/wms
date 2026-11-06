import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');

function importUi(me: Record<string, unknown>) {
  const file = { name: 'amazon-orders.txt' };
  const form = { reset: jest.fn() };
  const state = { token: 'signed-in', me, inventoryPageSize: 30,
    overseasOrderProcessingOrders: [{ id: 'stale' }], selectedOverseasOrderKeys: new Set(['stale']) };
  let submit!: (event: unknown) => Promise<void>;
  const request = jest.fn(async (path: string) => {
    if (me.role !== 'system_admin' && me.department !== 'overseas_warehouse') {
      throw new Error('此功能由日本海外仓或系统管理员处理');
    }
    return path.endsWith('unconfirmed-count') ? { count: 0 } : [{ id: 'fresh' }];
  });
  const context: any = { state, request,
    $: (id: string) => id === 'importOrdersForm'
      ? { addEventListener: (_type: string, handler: typeof submit) => { submit = handler; } }
      : id === 'ordersImportFile' ? { files: [file] } : null,
    importAmazonOrdersFile: jest.fn().mockResolvedValue({ createdCount: 1, skippedCount: 0, sourceFileName: file.name }),
    loadAmazonOrders: jest.fn().mockResolvedValue(undefined),
    loadChinaOrderProcessingOrders: jest.fn().mockResolvedValue(undefined),
    renderOverseasOrderProcessingTable: jest.fn(), setupOverseasOrderProcessingLoadObserver: jest.fn(),
    closeModal: jest.fn(), showToast: jest.fn(), getSubmitButton: () => ({}),
    withBusyButton: (_button: unknown, _label: string, action: () => unknown) => action() };
  runInNewContext(source.slice(source.indexOf('function isWarehouseOnlyAccount()'),
    source.indexOf('function getDepartmentText(')), context);
  runInNewContext(source.slice(source.indexOf('async function loadOverseasOrderProcessingOrders()'),
    source.indexOf('async function downloadOverseasOrderProcessingOrders()')), context);
  const start = source.indexOf('$("importOrdersForm").addEventListener("submit",');
  runInNewContext(source.slice(start, source.indexOf('\n  });', start) + 6), context);
  return { context, state, request, file, form,
    submit: () => submit({ preventDefault: jest.fn(), currentTarget: form }) };
}

describe('Amazon TXT import completion', () => {
  it.each([
    ['employee', '1'], ['admin', '1'], ['employee', '2'], ['admin', '2'],
  ])('completes for Chinese %s in company %s without requesting Japan-only orders', async (role, companyId) => {
    const ui = importUi({ role, companyId, department: 'china_warehouse', status: 1 });
    await ui.submit();
    expect(ui.context.importAmazonOrdersFile).toHaveBeenCalledWith(ui.file);
    expect(ui.context.loadAmazonOrders).toHaveBeenCalledTimes(1);
    expect(ui.context.loadChinaOrderProcessingOrders).toHaveBeenCalledTimes(1);
    expect(ui.request).not.toHaveBeenCalled();
    expect(ui.state.overseasOrderProcessingOrders).toEqual([]);
    expect(ui.state.selectedOverseasOrderKeys.size).toBe(0);
    expect(ui.form.reset).toHaveBeenCalledTimes(1);
    expect(ui.context.closeModal).toHaveBeenCalledWith('amazonOrderImportModal');
    expect(ui.context.showToast).toHaveBeenCalledWith(expect.stringContaining('新增 1 条'), false);
    expect(ui.context.showToast).toHaveBeenCalledTimes(1);
  });

  it.each([
    { role: 'employee', department: 'overseas_warehouse', status: 1 },
    { role: 'admin', department: 'overseas_warehouse', status: 1 },
    { role: 'system_admin', status: 1 },
  ])('retains warehouse refresh after import for $role / $department', async me => {
    const ui = importUi(me);
    await ui.submit();
    expect(ui.request).toHaveBeenCalledWith('/orders/overseas-warehouse');
    expect(ui.request).toHaveBeenCalledWith('/orders/overseas-warehouse/unconfirmed-count');
    expect(ui.state.overseasOrderProcessingOrders).toEqual([{ id: 'fresh' }]);
    expect(ui.context.closeModal).toHaveBeenCalledWith('amazonOrderImportModal');
    expect(ui.context.showToast).toHaveBeenCalledWith(expect.stringContaining('新增 1 条'), false);
  });
});
