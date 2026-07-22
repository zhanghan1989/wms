import { shouldArchivePlaceholderProduct } from '../src/master-products/master-product-archive';

describe('master product placeholder archive rule', () => {
  it('archives only zero-stock products whose names start with the placeholder prefix', () => {
    expect(shouldArchivePlaceholderProduct('假产品ID-12345', 0)).toBe(true);
    expect(shouldArchivePlaceholderProduct('普通产品 假产品ID-12345', 0)).toBe(false);
    expect(shouldArchivePlaceholderProduct('假产品ID-12345', 1)).toBe(false);
    expect(shouldArchivePlaceholderProduct(null, 0)).toBe(false);
  });
});
