import { OrdersService } from '../src/orders/orders.service';

describe('order BOM stock fallback', () => {
  function createService(stockQty: number, componentStockQty: number): OrdersService {
    return new OrdersService({
      masterProduct: {
        findMany: jest.fn().mockResolvedValue([
          {
            productId: 'STRAP-1',
            productName: '测试肩带',
            productType: '肩带',
            stockQty,
            bomComponents: [
              { quantity: 2, part: { stockQty: componentStockQty, status: 1 } },
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
});
