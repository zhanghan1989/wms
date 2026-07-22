export const PLACEHOLDER_PRODUCT_NAME_PREFIX = '假产品ID-';

export function shouldArchivePlaceholderProduct(
  productName: unknown,
  stockQty: unknown,
): boolean {
  return String(productName ?? '').startsWith(PLACEHOLDER_PRODUCT_NAME_PREFIX)
    && Number(stockQty ?? 0) === 0;
}
