// Verify deployed sales aggregates using production snapshots without upstream
// API calls, credentials, business writes, or customer information in the logs.
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { defer, from, firstValueFrom } = require('rxjs');
const XLSX = require('xlsx');
const { installCompanyIsolation } = require('/app/apps/api/dist/src/company-scope/company-prisma');
const { CompanyScopeInterceptor } = require('/app/apps/api/dist/src/company-scope/company-scope.interceptor');
const { RakutenRmsApiService } = require('/app/apps/api/dist/src/rakuten-rms-api/rakuten-rms-api.service');
const { RakutenSalesService } = require('/app/apps/api/dist/src/rakuten-rms-api/rakuten-sales.service');
const { exportStoreDashboard } = require('/app/apps/api/dist/src/common/store-dashboard-export');
const base = new PrismaClient();
let writesAttempted = 0;
const reads = new Set(['findMany','findFirst','findFirstOrThrow','findUnique','findUniqueOrThrow','count','aggregate','groupBy','$queryRaw','$queryRawUnsafe']);
const db = installCompanyIsolation(base.$extends({ query: { $allOperations({ operation, args, query }) {
  if (!reads.has(operation)) { writesAttempted++; throw new Error('AUDIT_WRITE_BLOCKED'); }
  return query(args);
} } }));
const report = { deployedVersion: process.env.DEPLOY_SESSION_VERSION, readOnly: true, checks: [], findings: [] };
const normalize = value => String(value || '').trim().toLowerCase();
function asUser(tx, user, route, action, headers = {}) {
  const request = { user, headers, method: 'GET', originalUrl: `/api/${route}` };
  const context = { switchToHttp: () => ({ getRequest: () => request }) };
  const next = { handle: () => defer(() => from(Promise.resolve().then(action))) };
  return new CompanyScopeInterceptor(tx).intercept(context, next).then(firstValueFrom);
}
async function blocked(tx, user, route, headers = {}) {
  try { await asUser(tx, user, route, () => { throw new Error('FORBIDDEN_ROUTE_REACHED_SERVICE'); }, headers); return false; }
  catch (error) { return error.getStatus?.() === 403; }
}
function metrics(rows) {
  return { orderCount: new Set(rows.map(row => row.orderId)).size,
    unitCount: rows.reduce((total, row) => total + Number(row.orderQuantity || 0), 0),
    salesAmount: Math.round(rows.reduce((total, row) => total + Number(row.salesAmount || 0), 0)) };
}
function sameMetrics(actual, expected) {
  return ['orderCount','unitCount','salesAmount'].every(field => actual[field] === expected[field]);
}
async function main() {
  await db.$transaction(async tx => {
    const names = [process.env.XIYA_WMS_COMPANY_NAME || 'XYJG', process.env.XIYA_QILIN_WMS_COMPANY_NAME || '祈麟双子'];
    const companies = await tx.company.findMany({ where: { name: { in: names }, status: 1 }, select: { id: true, name: true } });
    assert.equal(companies.length, 2, 'Two active companies required');
    const users = await tx.user.findMany({ where: { status: 1, passwordHash: { not: null } }, select: { id: true, username: true, role: true, department: true, companyId: true } });
    const warehouse = users.find(user => user.department === 'overseas_warehouse' && user.role !== 'system_admin');
    assert(warehouse, 'Active warehouse account required');
    const connections = await tx.rakutenRmsConnection.findMany({ where: { status: 1, syncOrders: true }, select: { id: true } });
    assert(connections.length, 'Active Rakuten stores required');
    const products = await tx.masterProduct.findMany({ select: { productId: true, companyId: true } });
    const owners = new Map(products.map(row => [normalize(row.productId), row.companyId]));
    const bundles = new Map((await tx.rakutenComboProduct.findMany({ select: { comboName: true, items: { select: { productId: true } } } }))
      .map(row => [normalize(row.comboName), row.items.map(item => item.productId)]));
    const ownerOf = sku => {
      const code = normalize(sku);
      if (!code.startsWith('zh-')) return owners.get(code);
      const parts = bundles.get(code);
      if (!parts?.length) return undefined;
      const owner = owners.get(normalize(parts[0]));
      return owner !== undefined && parts.every(id => owners.get(normalize(id)) === owner) ? owner : undefined;
    };
    const sales = new RakutenSalesService(tx, {}, {});
    const service = new RakutenRmsApiService(tx, {}, {}, undefined, sales);
    for (const connection of connections) {
      for (const days of ['7', '30', '90']) {
        const complete = await asUser(tx, warehouse, 'rakuten-rms-api/store-dashboard', () => service.getStoreDashboard(String(connection.id), days));
        const period = complete.dashboard.period;
        const facts = await sales.read(connection.id, new Date(period.start), new Date(period.end));
        const active = facts.rows.filter(row => !['800','900'].includes(String(row.orderStatusText)));
        if (!sameMetrics(complete.dashboard.summary, metrics(active))) report.findings.push({ code: 'WAREHOUSE_SALES_TOTAL_MISMATCH', store: String(connection.id), days });
        for (const company of companies) {
          const user = users.find(user => user.companyId === company.id && user.role !== 'system_admin' && user.department !== 'overseas_warehouse');
          assert(user, 'Active company account required');
          const payload = await asUser(tx, user, 'rakuten-rms-api/store-dashboard', () => service.getStoreDashboard(String(connection.id), days));
          const expected = metrics(active.filter(row => ownerOf(row.skuCode) === company.id));
          const totalsMatch = sameMetrics(payload.dashboard.summary, expected);
          const trendMatch = Math.round(payload.dashboard.daily.reduce((sum, row) => sum + row.salesAmount, 0)) === expected.salesAmount;
          const foreignProducts = payload.dashboard.topProducts.filter(row => ownerOf(row.skuCode) !== company.id
            || row.componentProducts.some(product => owners.get(normalize(product.productId)) !== company.id)).length;
          const salesOnly = payload.salesOnly === true && payload.latestSyncRun === null && payload.dashboard.factoryRecommendations.rows.length === 0;
          let exportRows = null;
          let exportSafe = null;
          if (payload.sourceSummary.sales?.ready !== false) {
            const file = await asUser(tx, user, 'rakuten-rms-api/store-dashboard/export-excel', async () => exportStoreDashboard(payload, '乐天'));
            const workbook = XLSX.read(file.content, { type: 'buffer' });
            const rows = XLSX.utils.sheet_to_json(workbook.Sheets['商品排行']);
            exportRows = rows.length;
            exportSafe = rows.every(row => ownerOf(row.skuCode) === company.id)
              && !workbook.SheetNames.includes('备货建议') && !workbook.SheetNames.includes('备货说明');
          }
          const other = companies.find(row => row.id !== company.id);
          const restrictions = await Promise.all([
            blocked(tx, user, 'rakuten-rms-api/store-dashboard', { 'x-company-id': String(other.id) }),
            blocked(tx, user, 'rakuten-rms-api/store-dashboard/export-excel', { 'x-company-id': String(other.id) }),
            blocked(tx, user, 'rakuten-rms-api/connections'),
            blocked(tx, user, 'rakuten-rms-api/store-dashboard/factory-recommendations-excel'),
          ]);
          const check = { company: company.name, store: String(connection.id), days, matchingSalesRows: active.filter(row => ownerOf(row.skuCode) === company.id).length,
            totalsMatch, trendMatch, foreignProducts, salesOnly, exportRows, exportSafe, restrictedChecksPassed: restrictions.filter(Boolean).length,
            coverageReady: payload.sourceSummary.sales?.ready ?? null };
          report.checks.push(check);
          if (!totalsMatch || !trendMatch || foreignProducts || !salesOnly || exportSafe === false || restrictions.some(ok => !ok)) {
            report.findings.push({ code: 'COMPANY_DASHBOARD_ISOLATION_FAILURE', company: company.name, store: String(connection.id), days });
          }
          console.log(JSON.stringify({ stage: 'company-dashboard-audit', ...check }));
        }
      }
    }
  }, { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 600000 });
  report.writesAttempted = writesAttempted;
  report.passed = report.findings.length === 0 && writesAttempted === 0;
  console.log('PRODUCTION_RAKUTEN_DASHBOARD_REPORT=' + JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ auditFailed: true, errorType: error.name, code: error.code || null,
  message: error.name === 'AssertionError' ? error.message : 'Dashboard audit did not finish; no write operation was allowed', writesAttempted })); process.exitCode = 1;
}).finally(() => base.$disconnect());
