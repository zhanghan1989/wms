// Run only inside the deployed API container. No tokens/passwords are read,
// no accounts are impersonated through HTTP, and every Prisma write is blocked.
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { defer, firstValueFrom, from } = require('rxjs');
const { installCompanyIsolation } = require('/app/apps/api/dist/src/company-scope/company-prisma');
const { companyContext } = require('/app/apps/api/dist/src/company-scope/company-context');
const { CompanyScopeInterceptor } = require('/app/apps/api/dist/src/company-scope/company-scope.interceptor');
const { OrdersService } = require('/app/apps/api/dist/src/orders/orders.service');
const { SkusService } = require('/app/apps/api/dist/src/skus/skus.service');
const XLSX = require('xlsx');

const base = new PrismaClient();
const allowed = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy', '$queryRaw', '$queryRawUnsafe']);
let writesAttempted = 0;
const readOnly = base.$extends({ query: { $allOperations({ operation, args, query }) {
  if (!allowed.has(operation)) { writesAttempted++; throw new Error('AUDIT_WRITE_BLOCKED'); }
  return query(args);
} } });
const db = installCompanyIsolation(readOnly);
const report = { deployedVersion: process.env.DEPLOY_SESSION_VERSION, method: 'deployed-interceptor-and-services', readOnly: true, findings: [] };
const note = (code, details = {}) => report.findings.push({ code, ...details });
const key = row => `${row.source}:${row.id}`;
function asUser(tx, user, path, action, headers = {}, method = 'GET') {
  const req = { user, headers, method, originalUrl: `/api/${path}` };
  const context = { switchToHttp: () => ({ getRequest: () => req }) };
  const next = { handle: () => defer(() => from(Promise.resolve().then(action))) };
  return new CompanyScopeInterceptor(tx).intercept(context, next).then(firstValueFrom);
}
async function denied(tx, user, path, headers = {}, method = 'GET') {
  let invoked = false;
  try { await asUser(tx, user, path, () => { invoked = true; }, headers, method); return false; }
  catch (error) { return error.getStatus?.() === 403 && !invoked; }
}
function counts(rows) {
  return { total: rows.length, pending: rows.filter(row => !String(row.shipmentNo || '').trim()).length,
    withTracking: rows.filter(row => String(row.shipmentNo || '').trim()).length,
    rakuten: rows.filter(row => row.source === 'rakuten').length,
    amazon: rows.filter(row => row.source === 'amazon').length, manual: rows.filter(row => row.source === 'manual').length };
}
async function main() {
  const expectedNames = [process.env.XIYA_WMS_COMPANY_NAME || 'XYJG', process.env.XIYA_QILIN_WMS_COMPANY_NAME || '祈麟双子'];
  const companies = await db.company.findMany({ where: { name: { in: expectedNames }, status: 1 }, select: { id: true, name: true } });
  assert.equal(companies.length, 2, 'Expected two active Chinese companies');
  const users = await db.user.findMany({ where: { status: 1, passwordHash: { not: null }, OR: [
    { companyId: { in: companies.map(row => row.id) } }, { department: 'overseas_warehouse' }, { role: 'system_admin' },
  ] }, select: { id: true, username: true, role: true, department: true, companyId: true } });
  const warehouse = users.find(user => user.department === 'overseas_warehouse' && user.role !== 'system_admin');
  const administrator = users.find(user => user.role === 'system_admin');
  assert(warehouse, 'No active warehouse account available for verification');
  const results = await db.$transaction(async tx => {
    const orders = new OrdersService(tx);
    const products = await tx.masterProduct.findMany({ select: { productId: true, companyId: true } });
    const productOwners = new Map(products.map(row => [row.productId, row.companyId]));
    const assignments = await tx.rakutenOrderRecord.findMany({ where: { deletedAt: null },
      select: { id: true, skuCode: true, setComponentSkuCode: true, fulfillmentCompanyId: true } });
    const mismatched = assignments.filter(row => {
      const code = String(row.skuCode || '').trim() || String(row.setComponentSkuCode || '').trim();
      return (productOwners.get(code) ?? null) !== row.fulfillmentCompanyId;
    });
    if (mismatched.length) note('RAKUTEN_ASSIGNMENT_MISMATCH', { count: mismatched.length, recordIds: mismatched.slice(0, 5).map(row => String(row.id)) });
    report.rakutenAssignments = { total: assignments.length, unassigned: assignments.filter(row => row.fulfillmentCompanyId === null).length,
      byCompany: companies.map(company => ({ company: company.name, count: assignments.filter(row => row.fulfillmentCompanyId === company.id).length })), mismatched: mismatched.length };
    console.log(JSON.stringify({ stage: 'assignment-audit', ...report.rakutenAssignments }));
    const warehouseRows = await asUser(tx, warehouse, 'orders/china-orders', () => orders.listChinaOrderProcessing(undefined, 'all', undefined, true));
    const warehouseKeys = new Set(warehouseRows.map(key));
    assert.equal(warehouseKeys.size, warehouseRows.length, 'Duplicate warehouse China order references');
    const ownerByRef = new Map();
    for (const [source, model, ownerField] of [
      ['rakuten', 'rakutenOrderRecord', 'fulfillmentCompanyId'], ['amazon', 'amazonOrderRecord', 'companyId'], ['manual', 'manualOrderRecord', 'companyId'],
    ]) {
      const ids = warehouseRows.filter(row => row.source === source).map(row => BigInt(row.id));
      for (let start = 0; start < ids.length; start += 500) {
        const rows = await tx[model].findMany({ where: { id: { in: ids.slice(start, start + 500) } }, select: { id: true, [ownerField]: true } });
        for (const row of rows) ownerByRef.set(`${source}:${row.id}`, row[ownerField]);
      }
    }
    const japanShopNames = (await tx.shop.findMany({ where: { platform: { not: 'amazon' } }, select: { name: true } })).map(row => row.name);
    const companyResults = [];
    for (const company of companies) {
      const accounts = users.filter(user => user.companyId === company.id && user.role !== 'system_admin' && user.department !== 'overseas_warehouse');
      assert(accounts.length, 'A Chinese company has no active account for verification');
      let permittedAccounts = 0;
      let blockedCompanyHeaders = 0;
      let blockedWarehouseRoutes = 0;
      const other = companies.find(row => row.id !== company.id);
      for (const user of accounts) {
        const scope = await asUser(tx, user, 'orders/china-orders', () => companyContext.getStore());
        if (scope.companyId === company.id && !scope.warehouse && !scope.systemAdmin) permittedAccounts++;
        if (await denied(tx, user, 'orders/china-orders', { 'x-company-id': String(other.id) })) blockedCompanyHeaders++;
        for (const [method, route] of [['GET', 'orders/overseas-warehouse'], ['GET', 'rakuten-rms-api/connections'],
          ['GET', 'rakuten-combo-products'], ['GET', 'batch-inbound/orders'], ['POST', 'inventory/manual-adjust']]) {
          if (await denied(tx, user, route, {}, method)) blockedWarehouseRoutes++;
        }
      }
      if (permittedAccounts !== accounts.length || blockedCompanyHeaders !== accounts.length || blockedWarehouseRoutes !== accounts.length * 5) {
        note('ACCOUNT_PERMISSION_FAILURE', { company: company.name });
      }
      const user = accounts.find(row => row.role === 'employee') || accounts[0];
      const actual = await asUser(tx, user, 'orders/china-orders', () => orders.listChinaOrderProcessing(undefined, 'all', undefined, true));
      const actualKeys = new Set(actual.map(key));
      const expected = new Set(warehouseRows.filter(row => ownerByRef.get(key(row)) === company.id).map(key));
      const leaked = [...actualKeys].filter(ref => ownerByRef.get(ref) !== company.id);
      const missing = [...expected].filter(ref => !actualKeys.has(ref));
      const extra = [...actualKeys].filter(ref => !expected.has(ref));
      if (leaked.length || missing.length || extra.length) note('CHINA_ORDER_SET_MISMATCH', { company: company.name,
        leaked: leaked.length, missing: missing.length, extra: extra.length, sampleReferences: [...leaked, ...missing, ...extra].slice(0, 5) });
      const foreign = warehouseRows.find(row => ownerByRef.get(key(row)) === other.id);
      let foreignDetailCheck = 'no-live-foreign-sample';
      if (foreign) {
        try { await asUser(tx, user, `orders/detail/${foreign.source}/${foreign.id}`, () => orders.getOrderDetail(foreign.source, String(foreign.id)));
          foreignDetailCheck = 'FAILED'; note('FOREIGN_ORDER_DETAIL_VISIBLE', { company: company.name });
        } catch (error) { foreignDetailCheck = error.getStatus?.() === 404 ? 'blocked-404' : 'unexpected-error';
          if (foreignDetailCheck === 'unexpected-error') note('FOREIGN_DETAIL_CHECK_ERROR', { company: company.name }); }
      }
      const visibleSkus = await asUser(tx, user, 'skus', () => tx.sku.findMany({ select: { companyId: true, shop: true } }));
      const invalidSkus = visibleSkus.filter(row => row.companyId !== company.id || japanShopNames.includes(row.shop));
      if (invalidSkus.length) note('SKU_VISIBILITY_FAILURE', { company: company.name, count: invalidSkus.length });
      const skuService = new SkusService(tx, {});
      const exports = {};
      for (const [method, route] of [['exportExcel', 'skus/export-excel'], ['exportUnmatchedExcel', 'skus/export-unmatched-excel']]) {
        const file = await asUser(tx, user, route, () => skuService[method]());
        const workbook = XLSX.read(file.content, { type: 'buffer' });
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets['SKU列表']);
        if (rows.some(row => japanShopNames.includes(String(row['所属店铺'] || '')))) note('JAPAN_SKU_IN_CHINESE_EXPORT', { company: company.name, method });
        exports[method] = rows.length;
      }
      const result = { company: company.name, companyId: String(company.id), activeAccounts: accounts.length,
        roles: [...new Set(accounts.map(row => row.role))], accountScopeChecks: permittedAccounts, forgedCompanyHeaderBlocked: blockedCompanyHeaders,
        restrictedRouteChecks: blockedWarehouseRoutes, chinaOrders: counts(actual), expectedFromWarehouse: expected.size,
        leaked: leaked.length, missing: missing.length, extra: extra.length, foreignDetailCheck,
        visibleSkus: visibleSkus.length, invalidSkus: invalidSkus.length, exports };
      companyResults.push(result);
      console.log(JSON.stringify({ stage: 'company-audit', ...result }));
    }
    let warehouseHeaderIgnored = false;
    const selectedScope = await asUser(tx, warehouse, 'orders/china-orders', () => companyContext.getStore(), { 'x-company-id': String(companies[1].id) });
    warehouseHeaderIgnored = selectedScope.warehouse && selectedScope.companyId === undefined;
    assert(warehouseHeaderIgnored, 'Warehouse access was incorrectly narrowed by a company header');
    let administratorCount = null;
    if (administrator) {
      const rows = await asUser(tx, administrator, 'orders/china-orders', () => orders.listChinaOrderProcessing(undefined, 'all', undefined, true));
      administratorCount = rows.length;
      const adminKeys = new Set(rows.map(key));
      if (adminKeys.size !== warehouseKeys.size || [...warehouseKeys].some(ref => !adminKeys.has(ref))) note('ADMIN_WAREHOUSE_ORDER_SET_MISMATCH');
    }
    return { companies: companyResults, warehouse: { chinaOrders: counts(warehouseRows), companyHeaderIgnored: warehouseHeaderIgnored,
      unassignedOrOtherCompany: warehouseRows.filter(row => !companies.some(company => ownerByRef.get(key(row)) === company.id)).length }, administratorChinaOrders: administratorCount };
  }, { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 600000 });
  Object.assign(report, results, { writesAttempted, passed: report.findings.length === 0 && writesAttempted === 0 });
  console.log('PRODUCTION_COMPANY_ACCESS_REPORT=' + JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ auditFailed: true, errorType: error.name,
  code: error.code || null, message: error.name === 'AssertionError' ? error.message : 'Audit could not finish; no write operation was allowed', writesAttempted }));
  process.exitCode = 1;
}).finally(() => base.$disconnect());
