import { OrdersService } from '../src/orders/orders.service';

describe('manual order platform selection', () => {
  function setup(platform: any, shop: any) {
    const prisma = {
      shopPlatformDefinition: { findUnique: jest.fn().mockResolvedValue(platform) },
      shop: { findUnique: jest.fn().mockResolvedValue(shop) },
      $transaction: jest.fn(),
    };
    return { service: new OrdersService(prisma as any), prisma };
  }

  it('rejects unknown platforms before creating an order', async () => {
    const { service, prisma } = setup(null, null);
    await expect(service.createAmazonManualOrder({ mallName: 'Unknown' } as any)).rejects.toThrow('平台不存在');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { platform: 'amazon', status: 1 },
    { platform: 'custom', status: 0 },
  ])('rejects missing, mismatched or disabled shops: %s', async (shop) => {
    const { service, prisma } = setup({ key: 'custom', name: 'Yahoo' }, shop);
    await expect(service.createAmazonManualOrder({ mallName: 'Yahoo', shopName: 'Store' } as any))
      .rejects.toThrow('店铺不属于所选平台或已停用');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts an enabled shop on a custom platform', async () => {
    const { service, prisma } = setup({ key: 'custom', name: 'Yahoo' }, { platform: 'custom', status: 1 });
    await expect((service as any).assertManualOrderShopSelection({ mallName: ' Yahoo ', shopName: ' Store ' }))
      .resolves.toBeUndefined();
    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { name: 'Store' } });
  });

  it('preserves optional empty platform and shop fields', async () => {
    const { service, prisma } = setup(null, null);
    await expect((service as any).assertManualOrderShopSelection({})).resolves.toBeUndefined();
    expect(prisma.shopPlatformDefinition.findUnique).not.toHaveBeenCalled();
  });
});
