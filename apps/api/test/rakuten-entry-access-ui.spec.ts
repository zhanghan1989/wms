import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
const loadOrdersSource = source.slice(source.indexOf('async function loadOrders()'), source.indexOf('async function loadMoreOrdersIfNeeded()'));

describe('Rakuten entry loading', () => {
  it.each([false, true])('loads the scoped order list without calling Japan-only summaries for a Chinese account (Japan access: %s)', async japanAccess => {
    const state = { token: 'signed-in', inventoryPageSize: 30, orders: [], ordersLoading: false };
    const request = jest.fn().mockResolvedValue([{ id: '7', fulfillmentCompanyId: '2' }]);
    const context: any = { state, request, canManageJapanOperations: () => japanAccess,
      renderOrdersTable: jest.fn(), renderRakutenTrackingStatusSummary: jest.fn(), loadRakutenTrackingStatusSummary: jest.fn(),
      setTimeout: jest.fn(), maybeAutoLoadOrders: jest.fn() };
    runInNewContext(loadOrdersSource, context);
    await context.loadOrders();
    expect(request).toHaveBeenCalledWith('/orders?limit=30&offset=0');
    expect(state.orders).toEqual([{ id: '7', fulfillmentCompanyId: '2' }]);
    expect(state.ordersLoading).toBe(false);
    expect(context.renderOrdersTable).toHaveBeenCalledTimes(1);
    expect(context.loadRakutenTrackingStatusSummary).toHaveBeenCalledTimes(japanAccess ? 1 : 0);
    if (!japanAccess) expect(context.renderRakutenTrackingStatusSummary).toHaveBeenCalledWith(null);
  });
});
