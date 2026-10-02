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
