// Run against the deployed image with: docker exec -i wms_api node < scripts/verify-xiya-sync.cjs
// Uses only upstream GET requests and database reads; never starts sync jobs or status pushes.
const { PrismaClient } = require('@prisma/client');
const { installCompanyIsolation } = require('/app/apps/api/dist/src/company-scope/company-prisma');
const { companyContext } = require('/app/apps/api/dist/src/company-scope/company-context');
const { resolveXiyaCompany } = require('/app/apps/api/dist/src/common/xiya-company');
const { MasterProductsService } = require('/app/apps/api/dist/src/master-products/master-products.service');
const { OrdersService } = require('/app/apps/api/dist/src/orders/orders.service');

const base = new PrismaClient();
const prisma = installCompanyIsolation(base);
async function main() {
  if (!process.env.XIYA_EXPORT_API_KEY) throw new Error('Xiya export key is not configured');
  const names = [process.env.XIYA_WMS_COMPANY_NAME || 'XYJG', process.env.XIYA_QILIN_WMS_COMPANY_NAME || 'QLSZ'];
  for (const name of names) {
    const company = await prisma.company.findUnique({ where: { name } });
    if (!company || company.status !== 1) throw new Error(`Active WMS company missing: ${name}`);
    await companyContext.run({ companyId: company.id, systemAdmin: true, warehouse: false, userId: 0n }, async () => {
      const profile = await resolveXiyaCompany(prisma);
      const products = new MasterProductsService(prisma, {});
      const orders = new OrdersService(prisma);
      const productRows = await products.fetchXiyaImportRows(profile.productDays);
      const shops = await orders.loadXiyaLogisticsStoreSources(profile);
      const logistics = await orders.fetchXiyaLogisticsRows(shops, profile, profile.logisticsDays);
      const candidates = orders.normalizeXiyaTrackingCandidates(logistics, shops);
      const owners = await companyContext.run({ ...companyContext.getStore(), bypass: true }, () =>
        products.loadExistingMasterProducts(productRows.map((row) => row.productId)));
      const conflicts = productRows.filter((row) => owners.has(row.productId) && owners.get(row.productId).companyId !== company.id).length;
      console.log(JSON.stringify({ company: name, companyId: String(company.id),
        upstream: profile.companyCode || profile.companyName, productDays: profile.productDays,
        products: productRows.length, conflictingProductIds: conflicts,
        logisticsDays: profile.logisticsDays, configuredStoreNames: shops.size,
        logistics: logistics.length, validTrackingRows: candidates.length, bloggerStatusPush: profile.syncBloggerStatus }));
    });
  }
  console.log('Xiya company sync read-only verification passed');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => base.$disconnect());
