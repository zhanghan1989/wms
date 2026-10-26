import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

describe('overseas batch stock precheck', () => {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('function getOverseasPickingBatchStockIssues(rows)');
  const end = source.indexOf('\nfunction expandOverseasBatchRemovalKeys', start);
  const context: any = {};
  runInNewContext(source.slice(start, end), context);
  const row = { resolvedProductId: '63284', orderQuantity: 1, availableStock: 0,
    assemblableStock: 1, assemblableStockApplicable: true };

  it('allows the screenshot order with no finished stock and one assemblable unit', () => {
    expect(context.getOverseasPickingBatchStockIssues([row])).toHaveLength(0);
  });

  it('counts assembly capacity once across orders for the same product', () => {
    expect(context.getOverseasPickingBatchStockIssues([row, row])[0].shortageQty).toBe(1);
  });

  it('adds finished and assemblable stock while excluding assembly for other products', () => {
    expect(context.getOverseasPickingBatchStockIssues([{ ...row, availableStock: 1, orderQuantity: 2 }])).toHaveLength(0);
    expect(context.getOverseasPickingBatchStockIssues([{ ...row, assemblableStockApplicable: false }])[0].shortageQty).toBe(1);
  });
});

describe('overseas shortage visibility', () => {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('function isOverseasOrderStockShort(item)');
  const end = source.indexOf('\nfunction loadMoreOverseasOrderProcessingIfNeeded', start);
  function render(row: any) {
    const body = { innerHTML: '' };
    const summary = { textContent: '' };
    const context: any = {
      state: { overseasOrderProcessingOrders: [row], inventoryPageSize: 30,
        selectedOverseasOrderKeys: new Set() },
      $: (id: string) => id === 'overseasOrderProcessingBody' ? body : summary,
      syncSelectedOverseasOrderKeys() {}, updateOverseasOrderProcessingSelectAll() {},
      updateOverseasCreatePickingBatchButtonState() {},
      escapeHtml: String, displayText: String, formatDate: String,
    };
    runInNewContext(source.slice(start, end), context);
    context.renderOverseasOrderProcessingTable();
    return { body, summary };
  }
  const row = { source: 'rakuten', id: '6454', orderQuantity: 1, availableStock: 0,
    assemblableStock: 0, assemblableStockApplicable: false };
  it('shows zero-stock Japan orders with a shortage message and a China-switch action', () => {
    const { body, summary } = render(row);
    expect(body.innerHTML).toContain('缺货待处理');
    expect(body.innerHTML).toContain('switchOverseasPendingOrderToChina');
    expect(summary.textContent).toContain('1 条库存不足');
  });
  it('does not flag an assemblable shoulder order as out of stock', () => {
    const { body, summary } = render({ ...row, assemblableStock: 18, assemblableStockApplicable: true });
    expect(body.innerHTML).not.toContain('缺货待处理');
    expect(summary.textContent).not.toContain('库存不足');
  });
  it('flags partial stock below the order quantity', () => {
    expect(render({ ...row, availableStock: 1, orderQuantity: 2 }).body.innerHTML).toContain('缺货待处理');
  });
});
