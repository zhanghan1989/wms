import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { companyContext } from './company-context';

// A warehouse document inherits its referenced goods' owner without narrowing
// warehouse reads to that company. Unassociated new documents use the legacy default.
export async function warehouseCompanyData(
  db: Prisma.TransactionClient,
  references: { productIds?: string[]; skuIds?: bigint[] },
): Promise<{ companyId?: bigint }> {
  if (!companyContext.getStore()?.warehouse) return {};
  const products = references.productIds?.length
    ? await db.masterProduct.findMany({ where: { productId: { in: references.productIds } }, select: { companyId: true } }) : [];
  const skus = references.skuIds?.length
    ? await db.sku.findMany({ where: { id: { in: references.skuIds } }, select: { companyId: true } }) : [];
  const owners = new Set([...products, ...skus].map(row => row.companyId));
  if (owners.size > 1) throw new BadRequestException('同一单据不能混合不同公司的商品');
  return owners.size ? { companyId: [...owners][0] } : {};
}
