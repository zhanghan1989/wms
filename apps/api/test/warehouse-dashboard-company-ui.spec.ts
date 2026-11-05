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
  const context: any = { state: { me: { id: '8', role: 'employee', department: 'overseas_warehouse' } },
    isWarehouseOnlyAccount: () => true, isCurrentUserSystemAdmin: () => false,
    request: jest.fn().mockResolvedValue(companies), escapeHtml: String,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value) },
    document: { getElementById: (id: string) => id === 'activeCompanySelect' ? selector
      : id === 'rakutenDashboardCompanySelect' ? dashboardSelectors[0]
      : id === 'overviewDashboardCompanySelect' ? dashboardSelectors[1] : null },
    window: { location: { reload } } };
  runInNewContext(source.slice(0, source.indexOf('const AUTH_STORAGE_KEY')), context);
  return { context, selector, storage, reload, dashboardSelectors, wrapper };
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

it('persists dropdown changes and reloads dashboard state', async () => {
  const { context, dashboardSelectors, storage, reload } = fixture();
  const selector = dashboardSelectors[0];
  await context.loadCompanyUi();
  selector.value = '2';
  selector.addEventListener.mock.calls[0][1]();
  expect(storage.get('wms.company.8')).toBe('2');
  expect(reload).toHaveBeenCalledTimes(1);
  await context.loadCompanyUi();
  expect(selector.value).toBe('2');
  expect(selector.addEventListener).toHaveBeenCalledTimes(1);
});
