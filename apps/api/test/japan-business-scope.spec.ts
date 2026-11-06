import { ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import * as XLSX from 'xlsx';
import { companyContext, CompanyScope } from '../src/company-scope/company-context';
import { JapanJob, companyScheduleWhere } from '../src/company-scope/company-job';
import { installCompanyIsolation } from '../src/company-scope/company-prisma';
import { scopeCompanySql } from '../src/company-scope/company-sql';
import { SkusService } from '../src/skus/skus.service';

// Exercise the real Prisma extension with an in-memory query adapter. This
// checks the actual scoped predicates and persisted writes, not a second copy
// of the application's company-selection logic.
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(item => matches(row, item));
    if (key === 'OR') return value.some((item: any) => matches(row, item));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value).every(([op, target]: [string, any]) => {
        if (op === 'in') return target.includes(row[key]);
        if (op === 'notIn') return !target.includes(row[key]);
        if (op === 'not') return row[key] !== target;
        if (op === 'equals') return row[key] === target;
        return false;
      });
    }
    return row[key] === value;
  });
}
function fixture() {
  const tables: Record<string, any[]> = {
    Company: [{ id: 1n, status: 1 }, { id: 2n, status: 1 }],
    Shop: [
      { id: 1n, name: 'Japan Rakuten', platform: 'rakuten', companyId: 1n },
      { id: 2n, name: 'Amazon A', platform: 'amazon', companyId: 1n },
      { id: 3n, name: 'Amazon B', platform: 'amazon', companyId: 2n },
    ],
    MasterProduct: [{ productId: 'A', companyId: 1n, stockQty: 100 }, { productId: 'B', companyId: 2n, stockQty: 80 }],
    Sku: [
      { id: 1n, companyId: 1n, sku: 'a-amazon', shop: 'Amazon A', productId: null, status: 1 },
      { id: 2n, companyId: 2n, sku: 'b-amazon', shop: 'Amazon B', productId: null, status: 1 },
      { id: 3n, companyId: 1n, sku: 'a-rakuten', shop: 'Japan Rakuten', productId: 'A', status: 1 },
      { id: 4n, companyId: 2n, sku: 'b-rakuten', shop: 'Japan Rakuten', productId: 'B', status: 1 },
    ],
    RakutenRmsConnection: [{ id: 1n, companyId: 1n, shopId: 1n }],
    RakutenOrderRecord: [
      { id: 1n, companyId: 1n, fulfillmentCompanyId: 1n, skuCode: 'A', dispatchMode: 'china_pending', buyerEmail: 'buyer-a@example.test' },
      { id: 2n, companyId: 1n, fulfillmentCompanyId: 2n, skuCode: 'B', dispatchMode: 'china_no_stock', buyerEmail: 'buyer-b@example.test' },
      { id: 3n, companyId: 1n, fulfillmentCompanyId: null, skuCode: 'unknown', dispatchMode: 'china_no_stock' },
    ],
    RakutenComboProduct: [], RakutenComboProductItem: [],
    FbaReplenishment: [
      { id: 1n, companyId: 1n, status: 'pending_confirm' },
      { id: 2n, companyId: 2n, status: 'pending_confirm' },
    ],
  };
  const calls: Array<{ model: string; operation: string; args: any }> = [];
  const base: any = {};
  const query = async (model: string, operation: string, args: any) => {
    calls.push({ model, operation, args });
    const table = tables[model] ?? [];
    const rows = table.filter(row => matches(row, args.where));
    if (operation === 'findMany') return rows.map(row => ({ ...row }));
    if (operation === 'findFirst' || operation === 'findUnique') return rows[0] ? { ...rows[0] } : null;
    if (operation === 'count') return rows.length;
    if (operation === 'create') {
      const row = { id: BigInt(table.length + 10), ...args.data };
      table.push(row);
      return row;
    }
    if (operation === 'updateMany') { rows.forEach(row => Object.assign(row, args.data)); return { count: rows.length }; }
    if (operation === 'update') {
      if (!rows[0]) throw new Error('record not found');
      Object.assign(rows[0], args.data);
      return rows[0];
    }
    throw new Error(`Unexpected ${model}.${operation}`);
  };
  for (const model of Object.keys(tables)) {
    base[model[0].toLowerCase() + model.slice(1)] = Object.fromEntries(
      ['findMany', 'findFirst', 'findUnique', 'count', 'create', 'update', 'updateMany'].map(operation =>
        [operation, (args: any) => query(model, operation, args)]),
    );
  }
  base.$extends = ({ query: { $allOperations } }: any) => Object.fromEntries(Object.keys(tables).map(model => [
    model[0].toLowerCase() + model.slice(1), Object.fromEntries(
      ['findMany', 'findFirst', 'findUnique', 'count', 'create', 'update', 'updateMany'].map(operation => [operation,
        (args: any) => $allOperations({ model, operation, args, query: (prepared: any) => query(model, operation, prepared) })]),
    ),
  ]));
  return { db: installCompanyIsolation(base) as any, tables, calls };
}
const china = (companyId: bigint): CompanyScope => ({ companyId, systemAdmin: false, warehouse: false, userId: 9n });
const japan: CompanyScope = { systemAdmin: false, warehouse: true, japanOperations: true, userId: 8n };

describe('Japan sales and Chinese fulfillment boundaries', () => {
  it('offers FBA actions without general stock operations for Chinese accounts', () => {
    const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
    const context: any = { canManageJapanOperations: () => false, escapeHtml: (s: string) => s };
    runInNewContext(source.slice(source.indexOf('function buildProductBoxFillButtons('),
      source.indexOf('function buildInventoryDetailBoxRows(')), context);
    expect(context.buildProductBoxFillButtons('BOX', 'MasterProduct')).toContain('fillMasterProductFbaBox');
    expect(context.buildProductBoxFillButtons('BOX', 'MasterProduct')).not.toContain('InboundBox');
    expect(context.buildInventoryDetailBoxActionButtons({ boxCode: 'BOX', qty: 5 })).toContain('openInventoryDetailFbaBox');
    expect(context.buildInventoryDetailBoxActionButtons({ boxCode: 'BOX', qty: 5 })).not.toContain('OutboundOne');
    expect(context.buildInventoryDetailBoxActionButtons({ boxCode: 'BOX', qty: 0 })).not.toContain('data-action');
  });
  it.each([1n, 2n])('isolates FBA list and updates for company %s', async companyId => {
    const { db, tables } = fixture();
    await companyContext.run(china(companyId), async () => {
      expect((await db.fbaReplenishment.findMany()).map((row: any) => row.companyId)).toEqual([companyId]);
      const otherId = companyId === 1n ? 2n : 1n;
      expect(await db.fbaReplenishment.findUnique({ where: { id: otherId } })).toBeNull();
      await expect(db.fbaReplenishment.update({ where: { id: otherId }, data: { status: 'outbound' } })).rejects.toThrow();
      await db.fbaReplenishment.update({ where: { id: companyId }, data: { status: 'pending_outbound' } });
      expect(tables.FbaReplenishment.find(row => row.id === otherId)?.status).toBe('pending_confirm');
    });
  });
  it.each([1n, 2n])('narrows warehouse dashboard stock and orders while keeping shared Japan sales SKUs (case %#)', async companyId => {
    const { db } = fixture();
    await companyContext.run({ ...japan, companyId, dashboardCompanyScope: true }, async () => {
      expect((await db.masterProduct.findMany()).map((row: any) => row.productId)).toEqual([companyId === 1n ? 'A' : 'B']);
      expect((await db.rakutenOrderRecord.findMany()).map((row: any) => row.fulfillmentCompanyId)).toEqual([companyId]);
      const shops = await db.shop.findMany();
      expect(shops.map((row: any) => row.name)).toContain('Japan Rakuten');
      expect(shops.filter((row: any) => row.platform === 'amazon').map((row: any) => row.companyId)).toEqual([companyId]);
    });
    await companyContext.run({ ...japan, companyId }, async () => {
      expect(await db.masterProduct.findMany()).toHaveLength(2);
      expect(await db.rakutenOrderRecord.findMany()).toHaveLength(3);
    });
  });
  it.each([1n, 2n])('exports only the company Amazon SKUs, including unmatched SKUs (case %#)', async companyId => {
    const { db } = fixture();
    const service = new SkusService(db, {} as any);
    await companyContext.run(china(companyId), async () => {
      for (const method of ['exportExcel', 'exportUnmatchedExcel'] as const) {
        const file = await service[method]();
        const workbook = XLSX.read(file.content, { type: 'buffer' });
        const rows = XLSX.utils.sheet_to_json<any>(workbook.Sheets['SKU列表']);
        expect(rows.map(row => row.SKU)).toEqual([companyId === 1n ? 'a-amazon' : 'b-amazon']);
      }
    });
  });
  it('filters nested product SKU lists and counts as well as direct SKU queries', async () => {
    const { db, calls } = fixture();
    await companyContext.run(china(2n), () => db.masterProduct.findUnique({
      where: { productId: 'B' }, include: { skus: true, _count: { select: { skus: true } } },
    }));
    const args = calls.find(call => call.model === 'MasterProduct')!.args;
    expect(args.include.skus.where.AND).toContainEqual({ shop: { notIn: ['Japan Rakuten'] } });
    expect(args.include._count.select.skus.where.AND).toContainEqual({ shop: { notIn: ['Japan Rakuten'] } });
  });
  it.each([1n, 2n])('routes Rakuten China lines by the product company rather than the shop company (case %#)', async companyId => {
    const { db } = fixture();
    await companyContext.run(china(companyId), async () => {
      const rows = await db.rakutenOrderRecord.findMany({ where: { dispatchMode: { in: ['china_pending', 'china_no_stock'] } } });
      expect(rows.map((row: any) => row.id)).toEqual([companyId]);
      expect(rows[0].buyerEmail).toBe(companyId === 1n ? 'buyer-a@example.test' : 'buyer-b@example.test');
      expect(await db.rakutenOrderRecord.findUnique({ where: { id: companyId === 1n ? 2n : 1n } })).toBeNull();
    });
    expect((await companyContext.run(japan, () => db.rakutenOrderRecord.findMany({})))).toHaveLength(3);
  });
  it('allows shipment updates to an assigned line without transferring its sales record ownership', async () => {
    const { db, tables } = fixture();
    await companyContext.run(china(2n), async () => {
      await db.rakutenOrderRecord.update({ where: { id: 2n }, data: { shipmentNo: 'TRACK-B' } });
      expect(await db.rakutenOrderRecord.updateMany({ where: { id: { in: [1n, 2n] } }, data: { shipmentCompany: 'carrier' } })).toEqual({ count: 1 });
    });
    expect(tables.RakutenOrderRecord[1]).toMatchObject({ companyId: 1n, fulfillmentCompanyId: 2n, shipmentNo: 'TRACK-B' });
    expect(tables.RakutenOrderRecord[0].shipmentCompany).toBeUndefined();
  });
  it('assigns imported and remapped Rakuten lines from the product, keeps unknown products unassigned and leaves stock intact', async () => {
    const { db, tables } = fixture();
    await companyContext.run(japan, async () => {
      const row = await db.rakutenOrderRecord.create({ data: { skuCode: 'B', rmsConnectionId: 1n, shopName: 'Japan Rakuten' } });
      expect(row).toMatchObject({ companyId: 1n, fulfillmentCompanyId: 2n });
      const unknown = await db.rakutenOrderRecord.create({ data: { skuCode: 'unknown' } });
      expect(unknown.fulfillmentCompanyId).toBeNull();
      await db.rakutenOrderRecord.update({ where: { id: 1n }, data: { skuCode: 'B' } });
    });
    expect(tables.RakutenOrderRecord[0].fulfillmentCompanyId).toBe(2n);
    expect(tables.MasterProduct.map(row => row.stockQty)).toEqual([100, 80]);
  });
  it('rejects changing a company China line to another company product', async () => {
    const { db } = fixture();
    await companyContext.run(china(2n), async () => {
      await expect(db.rakutenOrderRecord.update({ where: { id: 2n }, data: { skuCode: 'A' } })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
  it('lets Japan associate its SKU with either company product while Chinese accounts cannot edit Japan SKUs', async () => {
    const { db } = fixture();
    const row = await companyContext.run(japan, () => db.sku.create({ data: { sku: 'b-new', shop: 'Japan Rakuten', productId: 'B' } }));
    expect(row.companyId).toBe(2n);
    await companyContext.run(china(2n), async () => {
      await expect(db.sku.create({ data: { sku: 'invalid', shop: 'Japan Rakuten', productId: 'B' } })).rejects.toBeInstanceOf(ForbiddenException);
      expect(await db.sku.findUnique({ where: { id: 4n } })).toBeNull();
    });
  });
  it('lets an administrator see shared Japan stores and SKUs while selecting a Chinese company', async () => {
    const { db } = fixture();
    await companyContext.run({ ...china(2n), systemAdmin: true }, async () => {
      expect((await db.shop.findMany({})).map((row: any) => row.name)).toEqual(['Japan Rakuten', 'Amazon B']);
      expect((await db.sku.findMany({})).map((row: any) => row.sku)).toEqual(['b-amazon', 'a-rakuten', 'b-rakuten']);
    });
  });
  it('allows Japan-managed bundles to reference products from both companies without changing those products', async () => {
    const { db, tables } = fixture();
    const combo = await companyContext.run(japan, () => db.rakutenComboProduct.create({ data: {
      comboName: 'Japan set', items: { create: [{ productId: 'A', position: 1 }, { productId: 'B', position: 2 }] },
    } }));
    expect(combo.items.create.map((item: any) => item.productId)).toEqual(['A', 'B']);
    expect(tables.MasterProduct.map(row => row.companyId)).toEqual([1n, 2n]);
  });
  it('does not tie the Japan center to the enabled status of its legacy storage company', async () => {
    const { db, tables } = fixture();
    tables.Company[0].status = 0;
    const row = await companyContext.run(japan, () => db.rakutenOrderRecord.create({ data: {
      skuCode: 'B', rmsConnectionId: 1n, shopName: 'Japan Rakuten',
    } }));
    expect(row.fulfillmentCompanyId).toBe(2n);
  });
  it('scopes raw order queries by fulfillment company', () => {
    const sql = scopeCompanySql('SELECT * FROM rakuten_order_records r JOIN master_products p ON p.product_id = r.sku_code', 2n,
      new Set(['rakuten_order_records', 'master_products']));
    expect(sql).toContain('WHERE fulfillment_company_id = 2');
    expect(sql).toContain('WHERE company_id = 2');
    expect(scopeCompanySql('SELECT * FROM skus', 2n, new Set(['skus']), false, true))
      .toContain("shop NOT IN (SELECT name FROM shops WHERE platform <> 'amazon')");
  });
  it('keeps the XYJG Amazon RB export free of Japan-managed SKUs even for warehouse staff', async () => {
    const { db } = fixture();
    const rows = await companyContext.run({ ...japan, amazonSkuOnly: true }, () => db.sku.findMany({ where: { companyId: 1n } }));
    expect(rows.map((row: any) => row.sku)).toEqual(['a-amazon']);
  });
});

describe('one Japan automation center', () => {
  it('runs once globally and restores the caller scope instead of looping over Chinese companies', async () => {
    const calls: Array<CompanyScope | undefined> = [];
    class Job { @JapanJob() async run() { calls.push(companyContext.getStore()); } }
    await new Job().run();
    const admin = { ...china(2n), systemAdmin: true };
    await companyContext.run(admin, async () => {
      await new Job().run();
      expect(companyContext.getStore()).toBe(admin);
      expect(companyScheduleWhere('import').companyId_key.companyId).toBe(1n);
    });
    expect(calls).toHaveLength(2);
    expect(calls.every(scope => scope?.warehouse && scope.companyId === undefined)).toBe(true);
    expect(companyContext.getStore()).toBeUndefined();
  });
  it('does not allow a Chinese account to trigger the global job', async () => {
    class Job { @JapanJob() async run() {} }
    expect(() => companyContext.run(china(2n), () => new Job().run())).toThrow('仅日本海外仓');
  });
});

describe('account UI boundaries', () => {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  it.each([
    [{ role: 'employee', companyId: '2' }, false],
    [{ role: 'admin', companyId: '1' }, false],
    [{ role: 'employee', companyId: '1' }, false],
    [{ role: 'admin', companyId: '2' }, false],
    [{ role: 'employee', department: 'overseas_warehouse' }, true],
    [{ role: 'system_admin', status: 1 }, true],
  ])('keeps warehouse controls and SKU downloads consistent for account %#', (me, expected) => {
    const elements = new Map<string, any>();
    const $ = (id: string) => {
      if (!elements.has(id)) {
        const hidden = new Set(id === 'openFbaReplenishmentPanel' ? ['hidden'] : []);
        elements.set(id, { classList: { toggle: (name: string, force: boolean) => force ? hidden.add(name) : hidden.delete(name),
          remove: (name: string) => hidden.delete(name), contains: (name: string) => hidden.has(name) }, setAttribute() {} });
      }
      return elements.get(id);
    };
    const context: any = { state: { me }, $, document: { querySelector: () => null, querySelectorAll: () => [] }, canCurrentUserEditOrders: () => false };
    runInNewContext(source.slice(source.indexOf('function hasAdminAccess('), source.indexOf('function getDepartmentText('))
      + source.slice(source.indexOf('function applyRoleView('), source.indexOf('function setAuthGate(')), context);
    context.applyRoleView();
    for (const id of ['openOverseasWarehousePanel', 'openBatchInboundModal',
      'openRakutenApiImportModal', 'openRakutenWorkflowModal', 'rakutenBatchChangeOrderIdBtn',
      'rakutenBatchDeleteBtn', 'openRakutenComboProductManagementPanel', 'openOverseasOrderProcessingPanel']) {
      expect(!$(id).classList.contains('hidden')).toBe(expected);
    }
    expect(!$('openRakutenOrderImportPanel').classList.contains('hidden')).toBe(true);
    expect(!$('openFbaReplenishmentPanel').classList.contains('hidden')).toBe(true);
    expect(!$('openRakutenDashboardPanel').classList.contains('hidden')).toBe(true);
  });
});
