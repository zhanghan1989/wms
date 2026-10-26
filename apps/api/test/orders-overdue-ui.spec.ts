import { readFileSync } from 'fs';
import { join } from 'path';
import { createContext, runInContext } from 'vm';

const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
const summaryCode = source.slice(source.indexOf('let overdueSummaryPending = null;'), source.indexOf('async function loadOverdueOrderReminder()'));
function setup(storage = new Map<string, string>()) {
  const hidden = new Set(['hidden']);
  const reminder = { textContent: '', title: '', classList: {
    toggle: (name: string, hide: boolean) => hide ? hidden.add(name) : hidden.delete(name),
  } };
  const request = jest.fn().mockResolvedValue({ count: 1, checkedAt: new Date().toISOString() });
  const state = { token: 'user-token', me: { id: '1' } };
  const context = createContext({ state, request, Date, setTimeout, clearTimeout,
    document: { hidden: false },
    $: (id: string) => id === 'overdueOrderReminder' ? reminder : { classList: { contains: () => true } },
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
  });
  runInContext(summaryCode, context);
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

  it('coalesces in-flight queries and refreshes when the five minute snapshot expires', async () => {
    const app = setup();
    await Promise.all([app.context.loadOverdueOrderSummary(), app.context.loadOverdueOrderSummary()]);
    expect(app.request).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(299999);
    await app.context.loadOverdueOrderSummary();
    expect(app.request).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    app.request.mockResolvedValue({ count: 0, checkedAt: new Date().toISOString() });
    await app.context.loadOverdueOrderSummary();
    expect(app.request).toHaveBeenCalledTimes(2);
    expect(app.hidden.has('hidden')).toBe(true);
  });

  it('discards an old login response after the user changes', async () => {
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
