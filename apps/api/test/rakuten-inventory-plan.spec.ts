import { decodeInventoryPlan, encodeInventoryPlan, inventoryPlanPage, inventoryPlanEquals } from '../src/rakuten-rms-api/rakuten-inventory-plan';
import { InventoryPlanRow } from '../src/rakuten-rms-api/rakuten-inventory.types';

const makeRows = (count: number): InventoryPlanRow[] => Array.from({ length: count }, (_, i) => ({
  mappingId: String(i + 1), productId: `P${i}`, manageNumber: `item${Math.floor(i / 100)}`, variantId: `sku${i}`,
  quantity: i % 3 === 0 ? 0 : 10, currentQuantity: i % 3 === 1 ? 10 : 3, safetyStock: 0,
  operationLeadTime: { normalDeliveryTimeId: 4, backOrderDeliveryTimeId: 5 }, shipFromIds: [7],
  stock: { finishedStock: 10, assemblableStock: null, beforePending: 10, pendingReserved: 0, availableQuantity: 10 },
}));

describe('compressed inventory previews', () => {
  it('round trips 23,586 SKUs with substantially smaller persisted JSON', async () => {
    const rows = makeRows(23586);
    const progress = jest.fn();
    const plan = await encodeInventoryPlan(rows, progress);
    expect(plan.chunks).toHaveLength(95);
    expect(Buffer.byteLength(JSON.stringify(plan))).toBeLessThan(Buffer.byteLength(JSON.stringify(rows)) / 4);
    expect(await decodeInventoryPlan(plan)).toEqual(rows);
    expect(progress).toHaveBeenLastCalledWith(23586);
    for (const filter of ['all', 'changed', 'zero']) for (const page of [1, 5, 1000]) {
      expect(await inventoryPlanPage(plan, page, filter)).toEqual(await inventoryPlanPage(rows, page, filter));
    }
  });
  it('decompresses only the chunks needed for the requested page', async () => {
    const rows = makeRows(1000);
    const plan = await encodeInventoryPlan(rows);
    plan.chunks[0].data = 'corrupt';
    expect((await inventoryPlanPage(plan, 6, 'all')).rows).toEqual(rows.slice(250, 300));
    await expect(inventoryPlanPage(plan, 1, 'all')).rejects.toThrow('损坏');
    await expect(decodeInventoryPlan(plan)).rejects.toThrow('损坏');
  });
  it('compares all blocks and legacy plans without materializing a second full plan', async () => {
    const rows = makeRows(1001);
    const plan = await encodeInventoryPlan(rows);
    expect(await inventoryPlanEquals(plan, rows)).toBe(true);
    expect(await inventoryPlanEquals(rows, rows)).toBe(true);
    expect(await inventoryPlanEquals(plan, rows.slice(1))).toBe(false);
    const edited = rows.map((row) => ({ ...row }));
    edited[1000].quantity++;
    expect(await inventoryPlanEquals(plan, edited)).toBe(false);
    const reordered = rows.map((row) => Object.fromEntries(Object.entries(row).reverse()) as InventoryPlanRow);
    expect(await inventoryPlanEquals(plan, reordered)).toBe(true);
    plan.chunks[0].data = 'corrupt';
    await expect(inventoryPlanEquals(plan, rows)).rejects.toThrow('损坏');
  });
  it('accepts legacy previews and empty previews and rejects unknown formats', async () => {
    const rows = makeRows(3);
    expect(await decodeInventoryPlan(rows)).toEqual(rows);
    expect(await inventoryPlanPage(await encodeInventoryPlan([]), 1, 'all')).toMatchObject({ total: 0, rows: [] });
    await expect(decodeInventoryPlan({ format: 'unknown' })).rejects.toThrow('格式无效');
  });
});
