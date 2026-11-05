import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { CompaniesController } from '../src/companies/companies.controller';
import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { defer, firstValueFrom, of } from 'rxjs';
import { CompanyScopeInterceptor } from '../src/company-scope/company-scope.interceptor';
import { companyContext, CompanyScope } from '../src/company-scope/company-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { scopeCompanySql } from '../src/company-scope/company-sql';
import { ThirdPartyApiKeyGuard } from '../src/orders/third-party-api-key.guard';

function fixture(options: Record<string, unknown> = {}) {
  const request = { user: { id: 1n, username: 'employee', role: 'employee', department: 'china_warehouse', companyId: 2n },
    headers: {}, method: 'GET', originalUrl: '/api/boxes', ...options };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  const prisma = { company: { findUnique: jest.fn().mockResolvedValue({ id: 2n, status: 1 }) } };
  const interceptor = new CompanyScopeInterceptor(prisma as unknown as PrismaService);
  const next = { handle: () => defer(() => of(companyContext.getStore())) };
  return { request, context, prisma, interceptor, next };
}
describe('company request boundaries', () => {
  it.each([
    ['GET', '/api/amazon-sp-api/connections'],
    ['POST', '/api/amazon-sp-api/oauth/start'],
    ['POST', '/api/amazon-sp-api/oauth/appstore/continue'],
    ['PUT', '/api/amazon-sp-api/connections/7'],
    ['POST', '/api/amazon-sp-api/connections/7/test'],
    ['POST', '/api/amazon-sp-api/connections/7/sync'],
    ['GET', '/api/amazon-sp-api/sync-runs?connectionId=7'],
  ])('keeps Chinese employee Amazon connection operations scoped: %s %s', async (method, originalUrl) => {
    const f = fixture({ method, originalUrl });
    expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next)))
      .toMatchObject({ companyId: 2n, warehouse: false, japanOperations: false });
    const forged = fixture({ method, originalUrl, headers: { 'x-company-id': '1' } });
    await expect(forged.interceptor.intercept(forged.context, forged.next)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    ['employee', 1n], ['admin', 1n], ['employee', 2n], ['admin', 2n],
  ])('opens the Rakuten entry with the Chinese %s account company scope (case %#)', async (role, companyId) => {
    const f = fixture({ user: { id: 5n, role, companyId }, originalUrl: '/api/orders?limit=30&offset=0' });
    expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next)))
      .toMatchObject({ companyId, warehouse: false, systemAdmin: false, japanOperations: false });
    const forged = fixture({ user: { id: 5n, role, companyId }, originalUrl: '/api/orders',
      headers: { 'x-company-id': String(companyId === 1n ? 2n : 1n) } });
    await expect(forged.interceptor.intercept(forged.context, forged.next)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('keeps the administrator Rakuten order entry global when a Chinese company is selected', async () => {
    const f = fixture({ user: { id: 1n, role: 'system_admin', companyId: null },
      headers: { 'x-company-id': '2' }, originalUrl: '/api/orders' });
    expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next)))
      .toMatchObject({ companyId: undefined, systemAdmin: true, japanOperations: true });
  });
  it.each(['/api/rakuten-rms-api/store-dashboard', '/api/rakuten-rms-api/store-dashboard/export-excel'])('allows the company-filtered Rakuten dashboard: %s', async originalUrl => {
    const f = fixture({ originalUrl });
    expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next)))
      .toMatchObject({ companyId: 2n, warehouse: false, japanOperations: false });
    const forged = fixture({ originalUrl, headers: { 'x-company-id': '1' } });
    await expect(forged.interceptor.intercept(forged.context, forged.next)).rejects.toBeInstanceOf(ForbiddenException);
    const admin = fixture({ originalUrl, user: { id: 1n, role: 'system_admin' }, headers: { 'x-company-id': '2' } });
    expect(await firstValueFrom(await admin.interceptor.intercept(admin.context, admin.next)))
      .toMatchObject({ companyId: undefined, japanOperations: true });
  });
  it.each(['employee', 'admin'])('blocks Chinese %s warehouse work and Japan sales management at the API boundary', async role => {
    const routes = [
      ['GET', '/api/rakuten-rms-api/connections'], ['PUT', '/api/rakuten-rms-api/automation/schedules/import'],
      ['GET', '/api/rakuten-rms-api/store-dashboard/factory-recommendations-excel'],
      ['GET', '/api/rakuten-combo-products'], ['GET', '/api/orders/overseas-warehouse'],
      ['POST', '/api/orders/overseas-warehouse/picking-batches'], ['POST', '/api/inventory/manual-adjust'],
      ['POST', '/api/master-products/B/box-inventories/outbound-one'], ['POST', '/api/master-products/B/fba-replenishments'],
      ['GET', '/api/batch-inbound/orders'], ['POST', '/api/inbound'], ['POST', '/api/boxes'],
      ['GET', '/api/inventory/dashboard/production-recommendations-excel'], ['POST', '/api/stocktake-planner/tasks/generate'],
      ['GET', '/api/%72akuten-rms-api/connections'],
    ];
    for (const [method, originalUrl] of routes) {
      const f = fixture({ user: { id: 2n, role, companyId: 2n }, method, originalUrl });
      await expect(f.interceptor.intercept(f.context, f.next)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
  it('retains Chinese product/SKU work, Amazon/manual imports, China fulfillment and the existing switch-Japan permission', async () => {
    for (const [method, originalUrl] of [
      ['GET', '/api/master-products/B/detail'], ['GET', '/api/skus/export-unmatched-excel'], ['POST', '/api/skus/import-excel'],
      ['POST', '/api/orders/amazon/import-txt'], ['POST', '/api/orders/manual/import-excel'], ['POST', '/api/orders/manual'],
      ['GET', '/api/orders'], ['GET', '/api/orders/china-orders'], ['GET', '/api/orders/detail/rakuten/2'],
      ['POST', '/api/orders/china-orders/rakuten/2/switch-to-japan'], ['POST', '/api/orders/china-orders/sync-xiya-tracking'],
      ['GET', '/api/inventory/fba-replenishments/pending-summary'],
    ]) {
      const f = fixture({ method, originalUrl });
      expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next))).toMatchObject({ companyId: 2n, warehouse: false });
    }
  });
  it.each([{}, { 'x-company-id': '2' }])('keeps the administrator Japan center global regardless of business selection %j', async headers => {
    const f = fixture({ user: { id: 1n, role: 'system_admin', companyId: null }, headers,
      method: 'POST', originalUrl: '/api/rakuten-rms-api/processing/check' });
    expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next))).toMatchObject({ companyId: undefined, japanOperations: true });
    expect(f.prisma.company.findUnique).not.toHaveBeenCalled();
  });
  it('uses the employee company and retains context during the Observable subscription', async () => {
    const f = fixture();
    expect(await firstValueFrom(await f.interceptor.intercept(f.context,f.next))).toMatchObject({ companyId: 2n, userId: 1n });
    expect(companyContext.getStore()).toBeUndefined();
  });
  it('rejects forged and malformed company selections', async () => {
    for (const value of ['3','0','-1','1 OR 1=1',['2']]) {
      const f = fixture({ headers: { 'x-company-id': value } });
      await expect(f.interceptor.intercept(f.context,f.next)).rejects.toBeInstanceOf(value === '3' ? ForbiddenException : BadRequestException);
    }
  });
  it('leaves warehouse business writes unscoped while existing role guards protect user administration', async () => {
    const warehouse = { id: 3n, role: 'admin', department: 'overseas_warehouse', companyId: 1n };
    const write = fixture({ user: warehouse, method: 'POST' });
    expect(await firstValueFrom(await write.interceptor.intercept(write.context,write.next))).toMatchObject({ companyId: undefined, warehouse: true });
    const admin = fixture({ user: { ...warehouse, role: 'employee' }, originalUrl: '/api/users', headers: { 'x-company-id': '2' } });
    expect(await firstValueFrom(await admin.interceptor.intercept(admin.context,admin.next))).toMatchObject({ companyId: undefined, warehouse: true });
    const read = fixture({ user: warehouse });
    expect((await firstValueFrom(await read.interceptor.intercept(read.context,read.next)) as CompanyScope)?.companyId).toBeUndefined();
  });
  it.each([{}, { 'x-company-id': '2' }])('allows warehouse administrators to manage accounts independently of business selection %j', async (headers) => {
    const user = { id: 3n, role: 'admin', department: 'overseas_warehouse', companyId: null };
    for (const [method, originalUrl] of [['GET', '/api/users'], ['POST', '/api/users'], ['PUT', '/api/users/4'], ['DELETE', '/api/users/4'], ['POST', '/api/users/4/reset-password']]) {
      const f = fixture({ user, headers, method, originalUrl });
      expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next))).toMatchObject({ companyId: undefined, warehouse: true });
    }
  });
  it('keeps warehouse self-service authentication global with a selected business company', async () => {
    const f = fixture({ user: { id: 3n, role: 'employee', department: 'overseas_warehouse', companyId: null }, method: 'POST', originalUrl: '/api/auth/me/password', headers: { 'x-company-id': '2' } });
    expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next))).toMatchObject({ companyId: undefined, warehouse: true });
  });
  it.each(['employee', 'admin'] as const)('allows warehouse %s to read manual-order shop/platform options with or without a company selection', async (role) => {
    const warehouse = { id: 3n, role, department: 'overseas_warehouse', companyId: 1n };
    for (const originalUrl of ['/api/shops', '/api/shops?q=shop', '/api/shops/platforms']) {
      for (const headers of [{}, { 'x-company-id': '2' }]) {
        const f = fixture({ user: warehouse, originalUrl, method: 'GET', headers });
        const scope = await firstValueFrom(await f.interceptor.intercept(f.context, f.next)) as CompanyScope;
        expect(scope.companyId).toBeUndefined();
        expect(scope.warehouse).toBe(true);
      }
    }
  });
  it.each(['employee', 'admin'] as const)('restores warehouse %s routes without company selection or a warehouse-only allowlist', async (role) => {
    const user = { id: 3n, role, department: 'overseas_warehouse', companyId: null };
    const routes = [
      ['GET', '/api/rakuten-combo-products'], ['POST', '/api/rakuten-combo-products'],
      ['PUT', '/api/rakuten-combo-products/4'], ['POST', '/api/rakuten-combo-products/import-excel'],
      ['GET', '/api/rakuten-combo-products/export-excel'], ['POST', '/api/shops'], ['PUT', '/api/shops/4'],
      ['POST', '/api/brands'], ['GET', '/api/amazon-sp-api/connections'],
      ['GET', '/api/rakuten-rms-api/connections'], ['PUT', '/api/rakuten-rms-api/connections/4'],
      ['GET', '/api/rakuten-rms-api/connections/4/mail-templates'],
      ['POST', '/api/rakuten-rms-api/processing/check'], ['GET', '/api/backups'], ['POST', '/api/backups/run'],
    ];
    for (const headers of [{}, { 'x-company-id': '2' }]) {
      for (const [method, originalUrl] of routes) {
        const f = fixture({ user, method, originalUrl, headers });
        expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next))).toMatchObject({ companyId: undefined, warehouse: true });
        expect(f.prisma.company.findUnique).not.toHaveBeenCalled();
      }
    }
  });
  it.each([
    '/api/inventory/dashboard', '/api/inventory/dashboard/summary',
    '/api/inventory/dashboard/page', '/api/inventory/dashboard/export-excel',
    '/api/inventory/dashboard/production-recommendations-excel',
    '/api/rakuten-rms-api/store-dashboard', '/api/rakuten-rms-api/store-dashboard/export-excel',
    '/api/rakuten-rms-api/store-dashboard/factory-recommendations-excel',
  ])('defaults warehouse dashboard reads to XYJG and accepts another company: %s', async originalUrl => {
    for (const selected of [undefined, '2']) {
      const f = fixture({ originalUrl, user: { id: 3n, role: 'employee', department: 'overseas_warehouse' },
        headers: selected ? { 'x-company-id': selected } : {} });
      expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next)))
        .toMatchObject({ companyId: selected ? 2n : 1n, warehouse: true, dashboardCompanyScope: true });
      expect(f.prisma.company.findUnique).toHaveBeenCalled();
    }
    const disabled = fixture({ originalUrl, user: { id: 3n, role: 'employee', department: 'overseas_warehouse' },
      headers: { 'x-company-id': '2' } });
    disabled.prisma.company.findUnique.mockResolvedValue({ id: 2n, status: 0 });
    await expect(disabled.interceptor.intercept(disabled.context, disabled.next)).rejects.toThrow('禁用');
  });
  it('keeps dashboard report writes global for warehouse staff', async () => {
    const f = fixture({ originalUrl: '/api/inventory/dashboard/fba-sales-report', method: 'POST',
      user: { id: 3n, role: 'employee', department: 'overseas_warehouse' }, headers: { 'x-company-id': '2' } });
    expect(await firstValueFrom(await f.interceptor.intercept(f.context, f.next)))
      .toMatchObject({ companyId: undefined, warehouse: true, dashboardCompanyScope: false });
  });
  it('still requires a system administrator to select a company for business writes', async () => {
    const f = fixture({ user: { id: 1n, role: 'system_admin', companyId: null }, method: 'POST' });
    await expect(f.interceptor.intercept(f.context, f.next)).rejects.toThrow('选择所属');
  });
  it('prevents access to disabled companies and global backups', async () => {
    const disabled = fixture(); disabled.prisma.company.findUnique.mockResolvedValue({ id: 2n,status: 0 });
    await expect(disabled.interceptor.intercept(disabled.context,disabled.next)).rejects.toThrow('禁用');
    const backup = fixture({ originalUrl: '/api/backups' });
    await expect(backup.interceptor.intercept(backup.context,backup.next)).rejects.toThrow('系统管理员');
  });
  it('leaves authenticated shared integration routes outside employee company selection', async () => {
    const f = fixture({ user: undefined, headers: { 'x-company-id': '9' } });
    expect((await firstValueFrom(await f.interceptor.intercept(f.context,f.next)) as CompanyScope)?.companyId).toBeUndefined();
  });
});
describe('raw SQL company boundaries', () => {
  const tables = new Set(['boxes','master_products']);
  it('keeps strings and placeholders intact while filtering joined tables', () => {
    const sql = scopeCompanySql("SELECT 'FROM boxes' AS label, b.id FROM boxes b JOIN master_products p ON p.product_id = ? WHERE b.id = ?", 2n,tables);
    expect(sql).toContain("'FROM boxes'"); expect(sql.match(/company_id = 2/g)).toHaveLength(2);
    expect(sql.match(/\?/g)).toHaveLength(2);
  });
  it('rejects multiple statements, schema qualification, unsupported writes and comma joins', () => {
    for (const sql of ['SELECT * FROM boxes; SELECT * FROM boxes','SELECT * FROM boxes, master_products','SELECT * FROM boxes b, master_products p','SELECT * FROM other_database.boxes']) {
      expect(() => scopeCompanySql(sql,2n,tables)).toThrow();
    }
    expect(() => scopeCompanySql('DELETE FROM boxes',2n,tables,true)).toThrow();
  });
});
describe('shared Xiya API authentication', () => {
  const saved = process.env.THIRD_PARTY_API_KEY;
  afterEach(() => { if (saved === undefined) delete process.env.THIRD_PARTY_API_KEY; else process.env.THIRD_PARTY_API_KEY = saved; });
  it('keeps the existing key global and ignores company selection headers', () => {
    process.env.THIRD_PARTY_API_KEY = 'xiya-test-key';
    for (const company of ['1','2','999']) {
      const f = fixture({ user: undefined, headers: { 'x-api-key': 'xiya-test-key', 'x-company-id': company } });
      expect(new ThirdPartyApiKeyGuard().canActivate(f.context)).toBe(true);
      expect((f.request as any).serviceCompanyId).toBeUndefined();
    }
  });
  it('continues to reject invalid keys', () => {
    process.env.THIRD_PARTY_API_KEY = 'xiya-test-key';
    const f = fixture({ headers: { 'x-api-key': 'wrong' } });
    expect(() => new ThirdPartyApiKeyGuard().canActivate(f.context)).toThrow('密钥无效');
  });
});

describe('company management authorization', () => {
  it('permits only system administrators to create, rename or disable companies', () => {
    const guard = new RolesGuard(new Reflector());
    for (const action of ['create', 'update'] as const) {
      for (const role of ['employee', 'admin', 'system_admin'] as const) {
        const context = {
          getHandler: () => CompaniesController.prototype[action], getClass: () => CompaniesController,
          switchToHttp: () => ({ getRequest: () => ({ user: { id: 1n, role } }) }),
        } as unknown as ExecutionContext;
        expect(guard.canActivate(context)).toBe(role === 'system_admin');
      }
    }
  });
});
