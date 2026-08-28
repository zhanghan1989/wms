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
        componentProductId: `PART-${index + 1}`,
        quantity: 1,
      })),
    })).rejects.toThrow('一个 BOM 最多添加 10 个配件');
    expect(transaction).not.toHaveBeenCalled();
  });
});
