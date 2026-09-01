import { BadRequestException } from '@nestjs/common';
import { MasterProductsService } from '../src/master-products/master-products.service';
import { calculateAssemblableStock } from '../src/master-products/master-product-bom-stock';

describe('master product BOM', () => {
  it('calculates the maximum assemblable quantity from the limiting component', () => {
    expect(calculateAssemblableStock([
      { quantity: 2, componentStockQty: 9, componentStatus: 1 },
      { quantity: 3, componentStockQty: 10, componentStatus: 1 },
    ])).toBe(3);
    expect(calculateAssemblableStock([])).toBeNull();
  });

  it('rejects BOM editing for non-shoulder products', async () => {
    const service = new MasterProductsService({
      masterProduct: { findUnique: jest.fn().mockResolvedValue({ id: 9n, productType: '包' }) },
    } as never, {} as never);
    await expect(service.updateBom('BAG-1', { items: [] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a BOM containing more than 10 component types', async () => {
    const transaction = jest.fn();
    const service = new MasterProductsService({
      masterProduct: { findUnique: jest.fn().mockResolvedValue({ id: 11n, productType: '肩带' }) },
      $transaction: transaction,
    } as never, {} as never);
    await expect(service.updateBom('STRAP-1', {
      items: Array.from({ length: 11 }, (_, index) => ({
        componentProductId: `MATERIAL-${index + 1}`,
        quantity: 1,
      })),
    })).rejects.toThrow('一个 BOM 最多添加 10 个配件');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('lists shoulder bodies and accessories from active master products', async () => {
    const updatedAt = new Date('2026-09-01T00:00:00.000Z');
    const findMany = jest.fn().mockResolvedValue([
      { productId: 'BODY-1', productName: '黑色肩带本体', productType: '肩带本体', stockQty: 8, updatedAt },
      { productId: 'HOOK-1', productName: '银色扣件', productType: '肩带配件', stockQty: 20, updatedAt },
    ]);
    const service = new MasterProductsService({ masterProduct: { findMany } } as never, {} as never);

    await expect(service.listShoulderStrapMaterials()).resolves.toMatchObject({
      total: 2,
      bodyItems: [{ productId: 'BODY-1', productType: '肩带本体', stockQty: 8 }],
      accessoryItems: [{ productId: 'HOOK-1', productType: '肩带配件', stockQty: 20 }],
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 1, productType: { in: ['肩带本体', '肩带配件'] } },
    }));
  });

  it('rejects BOM materials outside the two allowed master-product types', async () => {
    const transaction = jest.fn();
    const service = new MasterProductsService({
      masterProduct: {
        findUnique: jest.fn().mockResolvedValue({ id: 11n, productType: '肩带' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: transaction,
    } as never, {} as never);

    await expect(service.updateBom('STRAP-1', {
      items: [{ componentProductId: 'BAG-1', quantity: 1 }],
    })).rejects.toThrow('肩带本体或肩带配件主产品不存在或已停用：BAG-1');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a BOM without a shoulder body', async () => {
    const transaction = jest.fn();
    const service = new MasterProductsService({
      masterProduct: {
        findUnique: jest.fn().mockResolvedValue({ id: 11n, productType: '肩带' }),
        findMany: jest.fn().mockResolvedValue([
          { productId: 'HOOK-1', productType: '肩带配件' },
        ]),
      },
      $transaction: transaction,
    } as never, {} as never);

    await expect(service.updateBom('STRAP-1', {
      items: [{ componentProductId: 'HOOK-1', quantity: 1 }],
    })).rejects.toThrow('必须且只能包含一种“肩带本体”');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a BOM containing two different shoulder bodies', async () => {
    const transaction = jest.fn();
    const service = new MasterProductsService({
      masterProduct: {
        findUnique: jest.fn().mockResolvedValue({ id: 11n, productType: '肩带' }),
        findMany: jest.fn().mockResolvedValue([
          { productId: 'BODY-1', productType: '肩带本体' },
          { productId: 'BODY-2', productType: '肩带本体' },
        ]),
      },
      $transaction: transaction,
    } as never, {} as never);

    await expect(service.updateBom('STRAP-1', {
      items: [
        { componentProductId: 'BODY-1', quantity: 1 },
        { componentProductId: 'BODY-2', quantity: 1 },
      ],
    })).rejects.toThrow('必须且只能包含一种“肩带本体”');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('accepts a body-only BOM because accessories are optional', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      masterProductBomItem: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      masterProduct: {
        findUnique: jest.fn().mockResolvedValue({ id: 11n, productType: '肩带' }),
        findMany: jest.fn().mockResolvedValue([
          { productId: 'BODY-1', productType: '肩带本体' },
        ]),
      },
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    };
    const service = new MasterProductsService(prisma as never, {} as never);
    jest.spyOn(service, 'getBom').mockResolvedValue({ product: {}, bomItems: [] });

    await expect(service.updateBom('STRAP-1', {
      items: [{ componentProductId: 'BODY-1', quantity: 2 }],
    })).resolves.toEqual({ product: {}, bomItems: [] });
    expect(tx.masterProductBomItem.createMany).toHaveBeenCalledWith({
      data: [{
        parentProductId: 'STRAP-1', componentProductId: 'BODY-1', quantity: 2, position: 1,
      }],
    });
  });
});
