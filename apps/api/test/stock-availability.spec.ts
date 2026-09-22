import { availableStock } from '../src/inventory/stock-availability';

describe('availableStock query scope', () => {
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
