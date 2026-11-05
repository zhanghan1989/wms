import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

function fixture(saved: string | null = null) {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const storage = new Map(saved === null ? [] : [['wms.company.8', saved]]);
  const wrapper = { classList: { toggle: jest.fn() } };
  const selector = { dataset: {} as Record<string, string>, value: '', innerHTML: '', disabled: true,
    title: '', closest: () => wrapper, setAttribute: jest.fn(), addEventListener: jest.fn() };
  const dashboardSelectors = ['rakutenDashboardCompanySelect', 'overviewDashboardCompanySelect'].map(() => {
    const wrapper = { classList: { toggle: jest.fn() } };
    return { ...selector, dataset: {}, closest: () => wrapper, addEventListener: jest.fn() };
  });
  const reload = jest.fn();
  const companies = [{ id: '2', name: 'Other company', status: 1 }, { id: '1', name: 'XYJG', status: 1 },
    { id: '3', name: 'Disabled company', status: 0 }];
  const panels = { overview: { classList: { contains: () => false } },
    rakutenDashboard: { classList: { contains: () => true } } };
  const context: any = { state: { me: { id: '8', role: 'employee', department: 'overseas_warehouse' },
    overviewDashboardGeneration: 1, overviewDashboardCache: new Map([['old', { data: 'XYJG' }]]),
    overviewDashboard: { company: 'XYJG' }, overviewFbaSnapshotId: 'previous-company-snapshot',
    rakutenStoreDashboard: { company: 'XYJG' }, rakutenStoreDashboardRequestId: 4 },
    clearOverviewDashboard: jest.fn(() => { context.state.overviewDashboard = null; }),
    setTextById: jest.fn(), showToast: jest.fn(),
    loadOverviewDashboard: jest.fn().mockResolvedValue(undefined),
    loadRakutenStoreDashboard: jest.fn().mockResolvedValue(undefined),
    isWarehouseOnlyAccount: () => true, isCurrentUserSystemAdmin: () => false,
    request: jest.fn().mockResolvedValue(companies), escapeHtml: String,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value) },
    document: { getElementById: (id: string) => id === 'activeCompanySelect' ? selector
      : id === 'rakutenDashboardCompanySelect' ? dashboardSelectors[0]
      : id === 'overviewDashboardCompanySelect' ? dashboardSelectors[1] : null },
    window: { location: { reload } } };
  context.$ = (id: string) => context.document.getElementById(id) || (panels as any)[id];
  runInNewContext(source.slice(0, source.indexOf('const AUTH_STORAGE_KEY')), context);
  return { context, selector, storage, reload, dashboardSelectors, wrapper, panels };
}

it.each([null, '', '3', '999'])('defaults warehouse dashboards to XYJG for missing or invalid saved selection: %s', async saved => {
  const { context, selector, dashboardSelectors, wrapper } = fixture(saved);
  await context.loadCompanyUi();
  expect(selector.value).toBe('1');
  expect(selector.disabled).toBe(false);
  expect(selector.innerHTML).toContain('Other company');
  expect(selector.innerHTML).not.toContain('Disabled company');
  expect(selector.innerHTML).not.toContain('全部公司');
  expect(wrapper.classList.toggle).toHaveBeenCalledWith('hidden', true);
  for (const dashboard of dashboardSelectors) {
    expect(dashboard.value).toBe('1');
    expect(dashboard.closest().classList.toggle).toHaveBeenCalledWith('hidden', false);
  }
});

it('restores another company and sends it only to dashboard queries and exports', async () => {
  const { context, selector } = fixture('2');
  await context.loadCompanyUi();
  expect(selector.value).toBe('2');
  for (const path of ['/inventory/dashboard?days=30', '/inventory/dashboard/summary', '/inventory/dashboard/page?snapshotId=abc',
    '/inventory/dashboard/export-excel', '/rakuten-rms-api/store-dashboard?connectionId=1',
    '/rakuten-rms-api/store-dashboard/export-excel', '/rakuten-rms-api/store-dashboard/factory-recommendations-excel']) {
    expect(context.companyHeaders(path)).toEqual({ 'X-Company-Id': '2' });
  }
  for (const path of ['', '/orders/overseas-warehouse', '/inventory/manual-adjust', '/users', '/rakuten-rms-api/connections']) {
    expect(context.companyHeaders(path)).toEqual({});
  }
});

it('updates both company dropdowns and only reloads the visible dashboard', async () => {
  const { context, dashboardSelectors, storage, reload } = fixture();
  const selector = dashboardSelectors[0];
  await context.loadCompanyUi();
  selector.value = '2';
  await selector.addEventListener.mock.calls[0][1]();
  expect(storage.get('wms.company.8')).toBe('2');
  expect(reload).not.toHaveBeenCalled();
  expect(dashboardSelectors.map(item => item.value)).toEqual(['2', '2']);
  expect(context.companyHeaders('/inventory/dashboard')).toEqual({ 'X-Company-Id': '2' });
  expect(context.loadRakutenStoreDashboard).toHaveBeenCalledTimes(1);
  expect(context.loadOverviewDashboard).not.toHaveBeenCalled();
  expect(context.state.overviewDashboardCache.size).toBe(0);
  expect(context.state.overviewDashboardGeneration).toBe(2);
  expect(context.state.overviewDashboard).toBeNull();
  expect(context.state.overviewFbaSnapshotId).toBe('');
  expect(context.state.rakutenStoreDashboard).toBeNull();
  expect(context.state.rakutenStoreDashboardRequestId).toBe(5);
  await context.loadCompanyUi();
  expect(selector.value).toBe('2');
  expect(selector.addEventListener).toHaveBeenCalledTimes(1);
});


it('reloads the system dashboard in place and preserves its period and unrelated work', async () => {
  const { context, dashboardSelectors, reload, panels } = fixture();
  panels.overview.classList.contains = () => true;
  panels.rakutenDashboard.classList.contains = () => false;
  context.state.overviewDashboardDays = 'month';
  context.state.overviewDashboardMonth = '2026-10';
  context.state.manualOrderDraft = { note: 'unsaved' };
  await context.loadCompanyUi();
  dashboardSelectors[1].value = '2';
  await dashboardSelectors[1].addEventListener.mock.calls[0][1]();
  expect(context.loadOverviewDashboard).toHaveBeenCalledTimes(1);
  expect(context.loadRakutenStoreDashboard).not.toHaveBeenCalled();
  expect(context.state.overviewDashboardDays).toBe('month');
  expect(context.state.overviewDashboardMonth).toBe('2026-10');
  expect(context.state.manualOrderDraft).toEqual({ note: 'unsaved' });
  expect(reload).not.toHaveBeenCalled();
});

it('keeps errors scoped to the latest company selection and allows retry', async () => {
  const { context, dashboardSelectors, reload } = fixture();
  let rejectOld!: (error: Error) => void;
  context.loadRakutenStoreDashboard.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
  await context.loadCompanyUi();
  dashboardSelectors[0].value = '2';
  const previous = dashboardSelectors[0].addEventListener.mock.calls[0][1]();
  dashboardSelectors[0].value = '1';
  await dashboardSelectors[0].addEventListener.mock.calls[0][1]();
  rejectOld(new Error('old company failure'));
  await previous;
  expect(context.showToast).not.toHaveBeenCalled();
  context.loadRakutenStoreDashboard.mockRejectedValueOnce(new Error('offline'));
  dashboardSelectors[0].value = '2';
  await dashboardSelectors[0].addEventListener.mock.calls[0][1]();
  expect(context.showToast).toHaveBeenCalledWith('公司看板读取失败：offline', true);
  expect(reload).not.toHaveBeenCalled();
});

it.each(['overview', 'rakutenDashboard'])('ignores an old company response arriving after the switch in %s', async panel => {
  const { context, dashboardSelectors, panels } = fixture();
  panels.overview.classList.contains = () => panel === 'overview';
  panels.rakutenDashboard.classList.contains = () => panel === 'rakutenDashboard';
  context.state.token = 'session';
  context.URLSearchParams = URLSearchParams;
  context.storeDashboardPeriodQuery = () => new URLSearchParams();
  context.rakutenFactoryMinimumDailySales = () => '0.05';
  context.renderOverviewDashboard = jest.fn(data => { context.state.overviewDashboard = data; });
  context.renderRakutenStoreDashboard = jest.fn(data => { context.state.rakutenStoreDashboard = data; });
  await context.loadCompanyUi();
  const pending: Array<(data: unknown) => void> = [];
  context.request = jest.fn((path: string) => path.includes('/summary') ? Promise.resolve({})
    : new Promise(resolve => pending.push(resolve)));
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const functionName = panel === 'overview' ? 'function loadOverviewDashboard(' : 'async function loadRakutenStoreDashboard(';
  const nextFunction = panel === 'overview' ? 'function refreshOverviewAfterInventoryChange(' : 'async function downloadRakutenStoreFactoryRecommendationsExcel(';
  context.overviewDashboardLoadPromise = null;
  context.overviewDashboardLoadKey = '';
  runInNewContext(source.slice(source.indexOf(functionName), source.indexOf(nextFunction)), context);
  const load = panel === 'overview' ? context.loadOverviewDashboard : context.loadRakutenStoreDashboard;
  const oldRequest = load();
  dashboardSelectors[panel === 'overview' ? 1 : 0].value = '2';
  const switched = dashboardSelectors[panel === 'overview' ? 1 : 0].addEventListener.mock.calls[0][1]();
  expect(pending).toHaveLength(2);
  pending[1]({ company: 'Other company' });
  await switched;
  pending[0]({ company: 'XYJG' });
  await oldRequest;
  const render = panel === 'overview' ? context.renderOverviewDashboard : context.renderRakutenStoreDashboard;
  expect(render).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledWith({ company: 'Other company' });
});
