import { Prisma } from '@prisma/client';

export const isInventoryCombo = (code: string) => /^zh-/i.test(code);
export type InventoryCombo = { comboName: string; items: Array<{ productId: string; product: { status: number; productType: string | null } }> };
export function validInventoryCombo(combo: InventoryCombo): boolean {
  return combo.items.length > 0 && new Set(combo.items.map((item) => item.productId)).size === combo.items.length
    && combo.items.every((item) => item.productId && item.product?.status === 1
      && !['肩带本体', '肩带配件'].includes(String(item.product.productType ?? '').trim()));
}

// Exact, case-sensitive names only; the database collation may be insensitive.
export async function inventoryCombos(tx: Pick<Prisma.TransactionClient, 'rakutenComboProduct'>, codes: string[]) {
  const names = [...new Set(codes.filter(isInventoryCombo))];
  const result = new Map<string, InventoryCombo>();
  for (let offset = 0; offset < names.length; offset += 500) {
    const batch = names.slice(offset, offset + 500);
    const rows = await tx.rakutenComboProduct.findMany({ where: { comboName: { in: batch } },
      select: { comboName: true, items: { select: { productId: true, product: { select: { status: true, productType: true } } } } } });
    for (const row of rows) if (batch.includes(row.comboName)) result.set(row.comboName, row);
  }
  return result;
}
