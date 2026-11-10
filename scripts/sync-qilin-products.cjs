// Runs inside the existing API container. Only the Qilin company scope may be written.
const { PrismaClient } = require('@prisma/client');
const { installCompanyIsolation } = require('/app/apps/api/dist/src/company-scope/company-prisma');
const { companyContext } = require('/app/apps/api/dist/src/company-scope/company-context');
const { resolveXiyaCompany } = require('/app/apps/api/dist/src/common/xiya-company');
const { MasterProductsService } = require('/app/apps/api/dist/src/master-products/master-products.service');
const base = new PrismaClient();
const prisma = installCompanyIsolation(base);
async function main() {
  const mode = process.env.QILIN_PRODUCT_SYNC_MODE || 'inspect';
  if (!['inspect', 'import'].includes(mode)) throw new Error('Unsupported operation');
  const company = await prisma.company.findUnique({ where: { name: process.env.XIYA_QILIN_WMS_COMPANY_NAME || 'QLSZ' } });
  if (!company || company.status !== 1) throw new Error('Active Qilin company not found');
  const xyjg = await prisma.company.findUnique({ where: { name: process.env.XIYA_WMS_COMPANY_NAME || 'XYJG' } });
  if (!xyjg || xyjg.id === company.id) throw new Error('Company mapping is invalid');
  const xyjgBefore = await prisma.masterProduct.count({ where: { companyId: xyjg.id } });
  await companyContext.run({ companyId: company.id, systemAdmin: true, warehouse: false, userId: 0n }, async () => {
    const profile = await resolveXiyaCompany(prisma);
    if (profile.companyCode !== 'CO260716362' || profile.syncBloggerStatus) throw new Error('Qilin scope validation failed');
    const service = new MasterProductsService(prisma, {});
    const before = await prisma.masterProduct.count();
    console.log(JSON.stringify({ company: company.name, companyId: String(company.id), mode, localProductsBefore: before, xyjgProductsBefore: xyjgBefore }));
    if (mode === 'import') {
      if (await prisma.masterProductSyncRecord.findFirst({ where: { status: 'running' }, select: { id: true } })) {
        throw new Error('An existing Qilin product sync is running; retry after it completes');
      }
      const started = await service.triggerXiyaSync(30, { operationType: 'manual_sync', operatorName: 'Qilin initial product import' }, true);
      const record = await prisma.masterProductSyncRecord.findUnique({ where: { id: BigInt(started.recordId) } });
      if (!record || record.status !== 'success') throw new Error(record?.errorMessage || 'Product import did not complete');
      console.log(JSON.stringify({ recordId: started.recordId, status: record.status, fetchedCount: record.fetchedCount,
        createdCount: record.createdCount, updatedCount: record.updatedCount, warning: record.errorMessage }));
    }
    // Check the same product-list service used by the company account UI.
    const page = await service.list(1, 1);
    const after = await prisma.masterProduct.count();
    const visible = await prisma.masterProduct.count({ where: { status: 1 } });
    if (mode === 'import' && (visible === 0 || !page.items.length)) throw new Error('No products visible in the company product list after import');
    console.log(JSON.stringify({ localProductsAfter: after, visibleProducts: visible, productListReturnsItems: page.items.length > 0 }));
  });
  const xyjgAfter = await prisma.masterProduct.count({ where: { companyId: xyjg.id } });
  console.log(JSON.stringify({ xyjgProductsAfter: xyjgAfter, xyjgProductCountUnchanged: xyjgBefore === xyjgAfter }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => base.$disconnect());
