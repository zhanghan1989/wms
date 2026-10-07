import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const batchSize = 500;
export function dashboardCodes(values: unknown[]): string[] {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))];
}

type DashboardSku = { sku: string; rbSku: string | null; fbmSku: string | null; shop: string; productId: string };

// Retain all matches (including ambiguous aliases and cross-channel conflicts),
// but never load unrelated SKUs from the entire catalog into the API process.
export async function loadDashboardSkus(prisma: PrismaService, codes: string[]): Promise<DashboardSku[]> {
  const rows = new Map<string, DashboardSku>();
  for (let offset = 0; offset < codes.length; offset += batchSize) {
    const batch = Prisma.join(codes.slice(offset, offset + batchSize));
    const matches = await prisma.$queryRaw<DashboardSku[]>(Prisma.sql`
      SELECT s.sku, s.rbSku, s.fbmSku, s.shop, s.product_id AS productId
      FROM skus s JOIN master_products p ON p.product_id = s.product_id
      WHERE s.status = 1 AND p.status = 1 AND (
        TRIM(s.sku) IN (${batch}) OR TRIM(s.rbSku) IN (${batch}) OR TRIM(s.fbmSku) IN (${batch})
      )
    `);
    for (const row of matches) rows.set(JSON.stringify([row.sku, row.shop]), row);
  }
  return [...rows.values()];
}

export async function loadDashboardProducts(prisma: PrismaService, productIds: string[], includeStock = true) {
  const select = { productId: true, productName: true, stockQty: true, firstStockedAt: true, productType: true } as const;
  const stocked = includeStock
    ? await prisma.masterProduct.findMany({ where: { status: 1, stockQty: { not: 0 } }, select })
    : [];
  const rows = new Map(stocked.map(row => [row.productId, row]));
  const missing = productIds.filter(id => !rows.has(id));
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    const matches = await prisma.masterProduct.findMany({
      where: { status: 1, productId: { in: missing.slice(offset, offset + batchSize) } }, select,
    });
    for (const row of matches) rows.set(row.productId, row);
  }
  return [...rows.values()];
}
