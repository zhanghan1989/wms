import { availableStock } from '../src/inventory/stock-availability';
import { companyContext } from '../src/company-scope/company-context';

describe('availableStock query scope', () => {
  it('includes Japan picking/FBA claims for owned products without returning another company stock or any order details', async () => {
    const scope = { companyId: 2n, systemAdmin: false, warehouse: false, userId: 7n };
    const tx: any = {
      masterProduct: { findMany: jest.fn().mockResolvedValue([{ productId: 'B' }]) },
      masterProductBomItem: { findMany: jest.fn().mockResolvedValue([]) },
      masterProductBoxInventory: { findMany: jest.fn(async ({ where }) => {
        expect(companyContext.getStore()?.warehouse).toBe(true);
        expect(where.productId.in).toEqual(['B']);
        return [{ boxId: 2n, productId: 'B', qty: 10, box: { boxCode: '002', shelf: { shelfCode: 'S1' } } }];
      }) },
      fbaReplenishment: { findMany: jest.fn().mockResolvedValue([{ status: 'pending_confirm', requestedQty: 2,
        sku: { productId: 'B' }, box: { boxCode: '002' } }]) },
      overseasPickingBatchItem: { findMany: jest.fn().mockResolvedValue([{ id: 9n, productId: 'B', requestedQty: 3,
        pickingPlanSnapshot: [{ boxCode: '002', pickQty: 3 }], bomSnapshot: [] }]) },
      pickingItemComponentRef: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await companyContext.run(scope, async () => {
      const rows = await availableStock(tx, ['A', 'B']);
      expect(rows).toEqual([{ boxId: 2n, productId: 'B', qty: 5, box: { boxCode: '002', shelf: { shelfCode: 'S1' } } }]);
      expect(companyContext.getStore()).toBe(scope);
      expect(tx.masterProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { productId: { in: ['A', 'B'] }, companyId: 2n } }));
    });
  });
  it('filters direct and BOM picking claims by indexed product references', async () => {
    const item = { id: 7n, productId: 'KIT', requestedQty: 2,
      pickingPlanSnapshot: [], bomSnapshot: [{ componentProductId: 'PART', quantity: 2 }] };
    const directFind = jest.fn().mockResolvedValue([item]);
    const componentFind = jest.fn().mockResolvedValue([{ item }]);
    const tx = {
      masterProductBomItem: { findMany: jest.fn().mockResolvedValue([{ parentProductId: 'KIT' }]) },
      masterProductBoxInventory: { findMany: jest.fn().mockResolvedValue([
        { boxId: 1n, productId: 'PART', qty: 10, box: { boxCode: 'B1', shelf: { shelfCode: 'S1' } } },
      ]) },
      fbaReplenishment: { findMany: jest.fn().mockResolvedValue([]) },
      overseasPickingBatchItem: { findMany: directFind },
      pickingItemComponentRef: { findMany: componentFind },
    };

    const result = await availableStock(tx as any, ['PART']);

    expect(result[0].qty).toBe(6); // The same item returned by both indexes is counted once.
    expect(directFind).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ productId: { in: ['PART', 'KIT'] } }),
    }));
    expect(componentFind).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ componentProductId: { in: ['PART'] } }),
    }));
  });
});
