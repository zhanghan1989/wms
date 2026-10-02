import { OrdersService } from '../src/orders/orders.service';

function stockDb(stockQty: number, componentStockQty: number, productId = 'STRAP-1', reservedQty = 0) {
  return {
    masterProductBomItem: { findMany: jest.fn().mockResolvedValue([]) },
    masterProductBoxInventory: { findMany: jest.fn().mockResolvedValue([
      { productId, boxId: 1n, qty: stockQty, box: { boxCode: 'B1', shelf: { shelfCode: 'S1' } } },
      { productId: 'BODY', boxId: 2n, qty: componentStockQty, box: { boxCode: 'B2', shelf: { shelfCode: 'S1' } } },
    ]) },
    fbaReplenishment: { findMany: jest.fn().mockResolvedValue(reservedQty ? [
      { status: 'pending_confirm', requestedQty: reservedQty, sku: { productId: 'BODY' }, box: { boxCode: 'B2' } },
    ] : []) },
    overseasPickingBatchItem: { findMany: jest.fn().mockResolvedValue([]) },
    pickingItemComponentRef: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('order BOM stock fallback', () => {
  function createService(stockQty: number, componentStockQty: number, reservedQty = 0): OrdersService {
    return new OrdersService({
      ...stockDb(stockQty, componentStockQty, 'STRAP-1', reservedQty),
      masterProduct: {
        findMany: jest.fn().mockResolvedValue([
          {
            productId: 'STRAP-1',
            productName: '测试肩带',
            productType: '肩带',
            stockQty,
            bomComponents: [
              {
                componentProductId: 'BODY',
                quantity: 2,
                componentProduct: {
                  stockQty: componentStockQty,
                  status: 1,
                  productType: '肩带本体',
                },
              },
            ],
          },
        ]),
      },
    } as never);
  }

  it('routes an assemblable shoulder order to the overseas warehouse', async () => {
    const service = createService(0, 6);
    await expect(
      (service as unknown as {
        resolveDispatchModeForProductId: (id: string) => Promise<string>;
      }).resolveDispatchModeForProductId('STRAP-1'),
    ).resolves.toBe('overseas');
  });

  it('routes to China when finished plus assemblable stock is below the ordered quantity', async () => {
    const service = createService(1, 4);
    await expect(
      (service as unknown as {
        resolveDispatchModeForProductId: (id: string, qty: number) => Promise<string>;
      }).resolveDispatchModeForProductId('STRAP-1', 4),
    ).resolves.toBe('china_no_stock');
  });

  it('subtracts FBA material reservations before routing or displaying assembly stock', async () => {
    const service = createService(0, 6, 5) as any;
    const stock = await service.loadProductStockAvailability(['STRAP-1']);
    expect(stock.get('STRAP-1').assemblableStock).toBe(0);
    await expect(service.resolveDispatchModeForProductId('STRAP-1')).resolves.toBe('china_no_stock');
  });

  it('uses box inventory instead of stale cached stock for routing', async () => {
    const service = new OrdersService({
      ...stockDb(0, 6, 'STRAP-BOX'),
      masterProduct: {
        findMany: jest.fn().mockResolvedValue([{
          productId: 'STRAP-BOX',
          productName: '箱库存肩带',
          productType: '肩带',
          stockQty: 99,
          boxInventories: [],
          bomComponents: [{
            componentProductId: 'BODY',
                quantity: 2,
            componentProduct: {
              stockQty: 0,
              status: 1,
              productType: '肩带本体',
              boxInventories: [{ qty: 6 }],
            },
          }],
        }]),
      },
    } as never);

    await expect((service as unknown as {
      resolveDispatchModeForProductId: (id: string, qty: number) => Promise<string>;
    }).resolveDispatchModeForProductId('STRAP-BOX', 3)).resolves.toBe('overseas');
    await expect((service as unknown as {
      resolveDispatchModeForProductId: (id: string, qty: number) => Promise<string>;
    }).resolveDispatchModeForProductId('STRAP-BOX', 4)).resolves.toBe('china_no_stock');
  });
});
