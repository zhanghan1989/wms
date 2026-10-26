import { readFileSync } from 'fs';
import { join } from 'path';
import { createContext, runInContext } from 'vm';

const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
const summaryCode = source.slice(source.indexOf('let overdueSummaryPending = null;'), source.indexOf('async function loadOverdueOrderReminder('));
function setup(storage = new Map<string, string>()) {
  const hidden = new Set(['hidden']);
  const reminder = { textContent: '', title: '', classList: {
    toggle: (name: string, hide: boolean) => hide ? hidden.add(name) : hidden.delete(name),
  } };
  const request = jest.fn().mockResolvedValue({ count: 1, checkedAt: new Date().toISOString() });
  const state = { token: 'user-token', me: { id: '1' } };
  const nodes = { '[data-refresh]': { disabled: false }, '[data-orders]': {}, '[data-count]': {} };
  const context = createContext({ state, request, Date, setTimeout, clearTimeout, escapeHtml: String,
    document: { hidden: false },
    $: (id: string) => id === 'overdueOrderReminder' ? reminder : { classList: { contains: () => true }, querySelector: (selector: string) => (nodes as any)[selector] },
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
  });
  runInContext(summaryCode, context);
  runInContext(source.slice(source.indexOf('async function loadOverdueOrderReminder('), source.indexOf('function getSubmitButton(')), context);
  return { context, request, hidden, reminder, state };
}

describe('overdue reminder summary loading', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-26T03:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it('shows a fresh saved count immediately without querying on reload or repeated navigation', async () => {
    const storage = new Map<string, string>();
    const first = setup(storage);
    await first.context.loadOverdueOrderSummary();
    expect(first.request).toHaveBeenCalledWith('/orders/overdue/summary');
    const reload = setup(storage);
    const pending = reload.context.loadOverdueOrderSummary();
    expect(reload.hidden.has('hidden')).toBe(false);
    await pending;
    await reload.context.loadOverdueOrderSummary();
    expect(reload.request).not.toHaveBeenCalled();
  });

  it('coalesces requests, reuses the daily snapshot and refreshes after 09:30 Japan time', async () => {
    const app = setup();
    await Promise.all([app.context.loadOverdueOrderSummary(), app.context.loadOverdueOrderSummary()]);
    expect(app.request).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60 * 60000);
    await app.context.loadOverdueOrderSummary();
    expect(app.request).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date('2026-10-27T00:30:31Z'));
    app.request.mockResolvedValue({ count: 0, checkedAt: new Date().toISOString() });
    await app.context.loadOverdueOrderSummary();
    expect(app.request).toHaveBeenCalledTimes(2);
    expect(app.hidden.has('hidden')).toBe(true);
  });

  it('uses the daily snapshot when opened and bypasses it immediately on manual refresh', async () => {
    const app = setup();
    app.request.mockResolvedValue({ count: 0, checkedAt: new Date().toISOString(), items: [] });
    await app.context.loadOverdueOrderReminder();
    expect(app.request).toHaveBeenLastCalledWith('/orders/overdue');
    await app.context.loadOverdueOrderReminder({ refresh: true });
    expect(app.request).toHaveBeenLastCalledWith('/orders/overdue?refresh=true');
    expect(app.request).toHaveBeenCalledTimes(2);
    expect(app.hidden.has('hidden')).toBe(true);
  });

  it('discards an old login response after the user changes' , async () => {
    const app = setup();
    let resolve: (value: unknown) => void = () => {};
    app.request.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = app.context.loadOverdueOrderSummary();
    app.state.token = 'different-user';
    resolve({ count: 3, checkedAt: new Date().toISOString() });
    await pending;
    expect(app.hidden.has('hidden')).toBe(true);
  });
});

it('calculates the next 09:30 Japan boundary before and after the morning run', () => {
  const app = setup();
  expect(app.context.nextOverdueSummaryRefresh('2026-10-27T00:29:59Z')).toBe(Date.parse('2026-10-27T00:30:00Z'));
  expect(app.context.nextOverdueSummaryRefresh('2026-10-27T00:30:00Z')).toBe(Date.parse('2026-10-28T00:30:00Z'));
});
