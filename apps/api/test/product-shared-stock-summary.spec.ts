import { companyContext } from '../src/company-scope/company-context';
import { MasterProductsService } from '../src/master-products/master-products.service';

describe('shared channel quantities in product detail', () => {
  it('shows physical, reserved and available stock after Japan picking/FBA and unbatched platform orders without exposing orders', async () => {
    const box = { id: 2n, boxCode: '002', shelf: { shelfCode: 'S1', name: 'Shelf' } };
    const inventory = { boxId: 2n, productId: 'B', qty: 10, updatedAt: new Date(), box,
      product: { productId: 'B', productName: 'Product B', stockQty: 10 } };
    const db: any = {
      masterProduct: {
        findUnique: jest.fn().mockResolvedValue({ productId: 'B', companyId: 2n, stockQty: 10 }),
        findMany: jest.fn().mockResolvedValue([{ productId: 'B' }]),
      },
      sku: { findMany: jest.fn().mockResolvedValue([]) },
      masterProductBoxInventory: { findMany: jest.fn().mockResolvedValue([inventory]) },
      masterProductBomItem: { findMany: jest.fn().mockResolvedValue([]) },
      fbaReplenishment: { findMany: jest.fn().mockResolvedValue([{ status: 'pending_confirm', requestedQty: 2,
        sku: { productId: 'B' }, box: { boxCode: '002' } }]) },
      overseasPickingBatchItem: { findMany: jest.fn().mockResolvedValue([{ id: 5n, productId: 'B', requestedQty: 3,
        pickingPlanSnapshot: [{ boxCode: '002', pickQty: 3 }], bomSnapshot: [] }]) },
      pickingItemComponentRef: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const orders = { inventorySyncPendingDemands: jest.fn(async (_db, ids) => {
      expect(ids).toEqual(['B']);
      expect(companyContext.getStore()?.warehouse).toBe(true);
      return [{ productId: 'B', quantity: 2 }];
    }) };
    const service = new MasterProductsService(db, {} as any, orders as any);
    const scope = { companyId: 2n, warehouse: false, systemAdmin: false, userId: 7n };
    await companyContext.run(scope, async () => {
      const detail: any = await service.detail('B');
      expect(detail.product).toMatchObject({ companyId: 2n, stockQty: 10, reservedQty: 7, availableQty: 3 });
      expect(Object.keys(detail).sort()).toEqual(['boxes', 'product', 'skus']);
      expect(companyContext.getStore()).toBe(scope);
    });
    expect(db.masterProduct.findUnique).toHaveBeenCalledTimes(1);
    expect(db.masterProductBoxInventory.findMany).toHaveBeenCalledTimes(3);
  });
  it('does not read shared reservations when the product is outside the account scope', async () => {
    const orders = { inventorySyncPendingDemands: jest.fn() };
    const db: any = { masterProduct: { findUnique: jest.fn().mockResolvedValue(null) },
      sku: { findMany: jest.fn().mockResolvedValue([]) }, masterProductBoxInventory: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new MasterProductsService(db, {} as any, orders as any);
    await expect(service.detail('foreign')).rejects.toThrow('未找到产品主表信息');
    expect(orders.inventorySyncPendingDemands).not.toHaveBeenCalled();
  });
});
