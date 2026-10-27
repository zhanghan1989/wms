import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

it('keeps monthly queries separate from rolling periods and ignores stale responses', async () => {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const snippet = source.slice(source.indexOf('function loadOverviewDashboard('), source.indexOf('function refreshOverviewAfterInventoryChange('));
  const monthInput = { value: '2024-02', max: '' };
  const pending: Array<(data: unknown) => void> = [];
  const request = jest.fn().mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const render = jest.fn();
  const context: any = { URLSearchParams, Intl, Date, Promise, request, renderOverviewDashboard: render,
    overviewDashboardLoadPromise: null, overviewDashboardLoadKey: '',
    $: (id: string) => id === 'overviewDashboardMonth' ? monthInput : { classList: { toggle: jest.fn() } },
    state: { token: 'session', overviewIncludesFba: false, overviewFbaSnapshotId: '', overviewDashboardDays: 30,
      overviewDashboardMonth: '', overviewDashboardGeneration: 1, overviewDashboardCache: new Map(),
      overviewDashboard: { existing: true }, overviewNeedsRefresh: false } };
  runInNewContext(snippet, context);
  const february = context.loadOverviewDashboard({ days: 'month' });
  expect(request.mock.calls[0][0]).toContain('month=2024-02');
  monthInput.value = '2024-01';
  const january = context.loadOverviewDashboard({ days: 'month' });
  expect(request.mock.calls[1][0]).toContain('month=2024-01');
  pending[1]({ month: '2024-01' });
  await january;
  pending[0]({ month: '2024-02' });
  await february;
  expect(render).toHaveBeenCalledTimes(1);
  expect(context.state.overviewDashboard.month).toBe('2024-01');
  const rolling = context.loadOverviewDashboard({ days: 60 });
  expect(request.mock.calls[2][0]).toContain('days=60');
  expect(request.mock.calls[2][0]).not.toContain('month=');
  pending[2]({ period: { days: 60 } });
  await rolling;
  monthInput.value = '2024-02';
  await context.loadOverviewDashboard({ days: 'month' });
  expect(request).toHaveBeenCalledTimes(3);
  expect(context.state.overviewDashboard.month).toBe('2024-02');
});
