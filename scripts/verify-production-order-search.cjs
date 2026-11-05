// Read-only audit of the deployed order search, hints and related history.
// Customer names, phone numbers, order numbers and credentials are never logged.
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const { defer, from, firstValueFrom } = require('rxjs');
const { installCompanyIsolation } = require('/app/apps/api/dist/src/company-scope/company-prisma');
const { CompanyScopeInterceptor } = require('/app/apps/api/dist/src/company-scope/company-scope.interceptor');
const { OrdersService } = require('/app/apps/api/dist/src/orders/orders.service');
const base = new PrismaClient();
let writesAttempted = 0;
const reads = new Set(['findMany','findFirst','findFirstOrThrow','findUnique','findUniqueOrThrow','count','aggregate','groupBy','$queryRaw','$queryRawUnsafe']);
const db = installCompanyIsolation(base.$extends({ query: { $allOperations({ operation, args, query }) {
  if (!reads.has(operation)) { writesAttempted++; throw new Error('AUDIT_WRITE_BLOCKED'); }
  return query(args);
} } }));
const report = { deployedVersion: process.env.DEPLOY_SESSION_VERSION, readOnly: true, findings: [], companies: [], warehouse: {} };
const configurations = [
  { source: 'rakuten', label: '乐天', model: 'rakutenOrderRecord', owner: 'fulfillmentCompanyId', name: 'shippingName', phone: 'shippingPhone', where: { deletedAt: null } },
  { source: 'amazon', label: '亚马逊', model: 'amazonOrderRecord', owner: 'companyId', name: 'recipientName', phone: 'buyerPhoneNumber', where: { sourceKind: { not: 'sp_api' } } },
  { source: 'manual', label: '手动订单', model: 'manualOrderRecord', owner: 'companyId', name: 'recipientName', phone: 'buyerPhoneNumber', where: {} },
];
function asUser(tx, user, route, callback, headers = {}) {
  const req = { user, headers, method: 'GET', originalUrl: `/api/${route}` };
  const context = { switchToHttp: () => ({ getRequest: () => req }) };
  return new CompanyScopeInterceptor(tx).intercept(context, { handle: () => defer(() => from(Promise.resolve().then(callback))) }).then(firstValueFrom);
}
async function main() {
  await db.$transaction(async tx => {
    const names = [process.env.XIYA_WMS_COMPANY_NAME || 'XYJG', process.env.XIYA_QILIN_WMS_COMPANY_NAME || '祈麟双子'];
    const companies = await tx.company.findMany({ where: { name: { in: names }, status: 1 }, select: { id: true, name: true } });
    assert.equal(companies.length, 2, 'Two active Chinese companies are required');
    const users = await tx.user.findMany({ where: { status: 1, passwordHash: { not: null } },
      select: { id: true, username: true, role: true, department: true, companyId: true } });
    const warehouse = users.find(user => user.department === 'overseas_warehouse' && user.role !== 'system_admin');
    assert(warehouse, 'An active warehouse account is required');
    const orders = new OrdersService(tx);
    const productOwners = new Map((await tx.masterProduct.findMany({ select: { productId: true, companyId: true } })).map(row => [row.productId, row.companyId]));
    const all = new Map();
    const samples = [];
    for (const config of configurations) {
      const rows = await tx[config.model].findMany({ where: config.where, select: { id: true, [config.owner]: true,
        orderId: true, [config.name]: true, [config.phone]: true }, orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }] });
      all.set(config.source, rows);
      const sample = rows.find(row => row.orderId && row[config.name] && row[config.phone]);
      assert(sample, 'Each order source must have a real sample');
      samples.push({ source: config.source, id: String(sample.id), originCompany: sample[config.owner],
        queries: [ ['orderId', String(sample.orderId)], ['formattedOrderId', orders.normalizeSearchOrderId(sample.orderId)],
          ['recipientName', String(sample[config.name])], ['phone', String(sample[config.phone])] ] });
    }
    const ownerMaps = new Map(configurations.map(config => [config.source, new Map(all.get(config.source).map(row => [String(row.id), row[config.owner]]))]));
    const labels = new Map(configurations.map(config => [config.label, config]));
    for (const company of companies) {
      const user = users.find(user => user.companyId === company.id && user.role !== 'system_admin' && user.department !== 'overseas_warehouse');
      assert(user, 'Each company must have an active account');
      const summary = { company: company.name, searchChecks: 0, suggestionChecks: 0, foreignInputChecks: 0,
        matchedRows: 0, historyRows: 0, returnedSuggestions: 0, foreignRows: 0, foreignSuggestions: 0, mismatchedProducts: 0,
        companyHeaderChecks: 0 };
      for (const sample of samples) {
        for (const [kind, query] of sample.queries) {
          assert(query.trim(), 'A sample query must not be empty');
          const result = await asUser(tx, user, 'orders/search', () => orders.searchOrders(query));
          summary.searchChecks++;
          if (sample.originCompany !== company.id) summary.foreignInputChecks++;
          summary.matchedRows += result.matches.length;
          summary.historyRows += result.history.length;
          for (const row of [...result.matches, ...result.history]) {
            if (ownerMaps.get(row.source)?.get(String(row.id)) !== company.id) summary.foreignRows++;
            const productOwner = productOwners.get(row.productId);
            if (productOwner !== undefined && productOwner !== company.id) summary.mismatchedProducts++;
          }
          const suggestions = await asUser(tx, user, 'orders/search-suggestions', () => orders.searchOrderSuggestions(query));
          summary.suggestionChecks++;
          summary.returnedSuggestions += suggestions.length;
          for (const suggestion of suggestions) {
            const config = labels.get(suggestion.sourceLabel);
            const field = suggestion.type === 'orderId' ? 'orderId' : suggestion.type === 'phone' ? config?.phone : config?.name;
            if (!config || !field || !all.get(config.source).some(row => row[config.owner] === company.id
              && String(row[field] || '').trim() === suggestion.value)) summary.foreignSuggestions++;
          }
        }
      }
      const other = companies.find(row => row.id !== company.id);
      for (const route of ['orders/search', 'orders/search-suggestions']) {
        let blocked = false;
        try { await asUser(tx, user, route, () => { throw new Error('FORGED_HEADER_REACHED_SERVICE'); }, { 'x-company-id': String(other.id) }); }
        catch (error) { blocked = error.getStatus?.() === 403; }
        if (blocked) summary.companyHeaderChecks++;
      }
      if (summary.foreignRows || summary.foreignSuggestions || summary.mismatchedProducts || summary.companyHeaderChecks !== 2) {
        report.findings.push({ code: 'ORDER_SEARCH_ISOLATION_FAILURE', company: company.name });
      }
      report.companies.push(summary);
      console.log(JSON.stringify({ stage: 'search-company-check', ...summary }));
    }
    let warehouseChecks = 0;
    for (const sample of samples) {
      const result = await asUser(tx, warehouse, 'orders/search', () => orders.searchOrders(sample.queries[0][1]));
      if (result.matches.some(row => row.source === sample.source && String(row.id) === sample.id)) warehouseChecks++;
    }
    report.warehouse = { realOrderSourceChecks: warehouseChecks, expectedOrderSources: configurations.length };
    if (warehouseChecks !== configurations.length) report.findings.push({ code: 'WAREHOUSE_SEARCH_INCOMPLETE' });
  }, { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 600000 });
  report.writesAttempted = writesAttempted;
  report.passed = !report.findings.length && writesAttempted === 0;
  console.log('PRODUCTION_ORDER_SEARCH_REPORT=' + JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ auditFailed: true, errorType: error.name, code: error.code || null,
  message: error.name === 'AssertionError' ? error.message : 'Search audit failed; no write operation was allowed', writesAttempted })); process.exitCode = 1;
}).finally(() => base.$disconnect());
