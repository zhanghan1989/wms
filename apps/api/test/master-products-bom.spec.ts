import { BadRequestException, ConflictException } from '@nestjs/common';
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
    await expect(service.updateBom('BAG-1', { items: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a BOM containing more than 10 component types', async () => {
    const transaction = jest.fn();
    const service = new MasterProductsService({
      masterProduct: { findUnique: jest.fn().mockResolvedValue({ id: 11n, productType: '肩带' }) },
      $transaction: transaction,
    } as never, {} as never);
    await expect(service.updateBom('STRAP-1', {
      items: Array.from({ length: 11 }, (_, index) => ({
        partId: String(index + 1),
        quantity: 1,
      })),
    })).rejects.toThrow('一个 BOM 最多添加 10 个配件');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('creates independent parts with the next JD number', async () => {
    const now = new Date('2026-08-28T00:00:00.000Z');
    const create = jest.fn().mockImplementation(({ data }) => Promise.resolve({
      id: 10n,
      ...data,
      status: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const service = new MasterProductsService({
      shoulderStrapPart: {
        findMany: jest.fn().mockResolvedValue([
          { partCode: 'JD-0002' },
          { partCode: 'JD-10000' },
          { partCode: 'JD-0099' },
        ]),
        create,
      },
    } as never, {} as never);

    await expect(service.createShoulderStrapPart({
      partName: '旋转龙虾扣',
      stockQty: 25,
    })).resolves.toMatchObject({
      id: '10',
      partCode: 'JD-10001',
      partName: '旋转龙虾扣',
      stockQty: 25,
    });
    expect(create).toHaveBeenCalledWith({
      data: { partCode: 'JD-10001', partName: '旋转龙虾扣', stockQty: 25 },
    });
  });

  it('does not delete a part that is still referenced by a BOM', async () => {
    const update = jest.fn();
    const service = new MasterProductsService({
      shoulderStrapPart: {
        findFirst: jest.fn().mockResolvedValue({ id: 3n, partCode: 'JD-0003' }),
        update,
      },
      masterProductBomItem: { count: jest.fn().mockResolvedValue(2) },
    } as never, {} as never);

    await expect(service.deleteShoulderStrapPart('3')).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });
});
