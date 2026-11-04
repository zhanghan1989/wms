import { MasterProductsService } from '../src/master-products/master-products.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { Prisma, PrismaClient } from '@prisma/client';
import { companyContext, CompanyScope } from '../src/company-scope/company-context';
import { installCompanyIsolation } from '../src/company-scope/company-prisma';

// Use only a disposable database explicitly supplied by the operator.
const url = process.env.WMS_COMPANY_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('company isolation against MySQL', () => {
  let base: PrismaClient;
  let db: PrismaClient;
  let a: bigint;
  let b: bigint;
  let shelf: bigint;
  let boxA: bigint;
  let boxB: bigint;
  let productA: string;
  let productB: string;
  let warehouseUser: bigint;
  const scope = <T>(companyId: bigint | undefined, fn: () => T | PromiseLike<T>, extra: Partial<CompanyScope> = {}): Promise<T> =>
    companyContext.run({ companyId, systemAdmin: false, warehouse: false, userId: 0n, ...extra }, async () => await fn());
  beforeAll(async () => {
    base = new PrismaClient({ datasourceUrl: url });
    db = installCompanyIsolation(base);
    const tag = Date.now().toString();
    a = (await base.company.create({ data: { name: `QA-A-${tag}` } })).id;
    b = (await base.company.create({ data: { name: `QA-B-${tag}` } })).id;
    shelf = (await base.shelf.create({ data: { shelfCode: `QA-${tag}` } })).id;
    boxA = (await scope(a, () => db.box.create({ data: { boxCode: `QA-A-${tag}`, shelfId: shelf } }))).id;
    boxB = (await scope(b, () => db.box.create({ data: { boxCode: `QA-B-${tag}`, shelfId: shelf } }))).id;
    warehouseUser = (await base.user.create({ data: { username: `QA-warehouse-${tag}`, companyId: a, department: 'overseas_warehouse', role: 'employee' } })).id;
    productA = `QA-A-${tag}`; productB = `QA-B-${tag}`;
    for (const [companyId, productId] of [[a, productA], [b, productB]] as const) {
      await scope(companyId, async () => {
        await db.brand.create({ data: { name: `same-brand-${tag}` } });
        await db.masterProduct.create({ data: { productId, bagBrand: `same-brand-${tag}` } });
      });
    }
  });
  afterAll(async () => {
    if (!base) return;
    for (const companyId of [a,b]) {
      if (!companyId) continue;
      await base.manualOrderRecord.deleteMany({ where: { companyId } });
      await base.masterProductBoxInventory.deleteMany({ where: { companyId } });
      await base.sku.deleteMany({ where: { companyId } });
      await base.masterProduct.deleteMany({ where: { companyId } });
      await base.box.deleteMany({ where: { companyId } });
      await base.brand.deleteMany({ where: { companyId } });
      await base.rakutenScheduleControl.deleteMany({ where: { companyId } });
      await base.user.deleteMany({ where: { companyId } });
      await base.company.delete({ where: { id: companyId } });
    }
    if (shelf) await base.shelf.delete({ where: { id: shelf } });
    await base.$disconnect();
  });
  it('filters lists, unique lookups, aggregates and shared-shelf children', async () => scope(a, async () => {
    expect((await db.masterProduct.findMany()).every((r) => r.companyId === a)).toBe(true);
    expect(await db.box.findUnique({ where: { id: boxB } })).toBeNull();
    expect(await db.box.count({ where: { id: boxB } })).toBe(0);
    const result = await db.shelf.findUniqueOrThrow({ where: { id: shelf }, include: { boxes: true, _count: { select: { boxes: true } } } });
    expect(result.boxes.map((r) => r.id)).toEqual([boxA]);
    expect(result._count.boxes).toBe(1);
  }));
  it('blocks ID-based updates, mass updates, ownership changes and foreign associations', async () => scope(a, async () => {
    await expect(db.box.update({ where: { id: boxB }, data: { status: 0 } })).rejects.toThrow();
    expect((await db.box.updateMany({ where: { id: boxB }, data: { status: 0 } })).count).toBe(0);
    await expect(db.box.update({ where: { id: boxA }, data: { companyId: b } })).rejects.toThrow('其他公司');
    await expect(db.masterProductBoxInventory.create({ data: { boxId: boxA, productId: productB, qty: 1 } })).rejects.toThrow('其他公司');
    await expect(db.sku.create({ data: { sku: 'cross-company', productId: productB } })).rejects.toThrow('其他公司');
    await expect(db.user.create({ data: { username: 'cross-authority', role: 'employee', department: 'overseas_warehouse' } })).rejects.toThrow('跨公司');
  }));
  it('hides global warehouse accounts from company account management', async () => scope(a, async () => {
    expect(await db.user.findUnique({ where: { id: warehouseUser } })).toBeNull();
    await expect(db.user.update({ where: { id: warehouseUser }, data: { passwordHash: 'replacement' } })).rejects.toThrow();
    expect((await db.user.updateMany({ where: { id: warehouseUser }, data: { status: 0 } })).count).toBe(0);
  }));
  it('scopes raw reports, joins, UNIONs and locking reads with bound values', async () => scope(a, async () => {
    const rows = await db.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM boxes WHERE id IN (${boxA}, ${boxB}) UNION SELECT id FROM boxes WHERE id = ${boxB}`;
    expect(rows.map((r) => r.id)).toEqual([boxA]);
    const joined = await db.$queryRawUnsafe<Array<{ id: bigint }>>('SELECT b.id FROM boxes b JOIN shelves s ON s.id = b.shelf_id WHERE s.id = ?', shelf);
    expect(joined.map((r) => r.id)).toEqual([boxA]);
    await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: bigint }>>(Prisma.sql`SELECT id FROM boxes WHERE id IN (${boxA}, ${boxB}) FOR UPDATE`);
      expect(locked.map((r) => r.id)).toEqual([boxA]);
    });
    await expect(db.$executeRawUnsafe('DELETE FROM boxes')).rejects.toThrow('不支持公司范围');
  }));
  it('does not retain company predicates in reusable query arguments', async () => {
    const query = Prisma.sql`SELECT id FROM boxes WHERE shelf_id = ${shelf}`;
    const args = { where: { id: shelf }, include: { boxes: true } };
    for (const companyId of [a,b,a]) {
      await scope(companyId, async () => {
        const rows = await db.$queryRaw<Array<{ id: bigint }>>(query);
        expect(rows.map((row) => row.id)).toEqual([companyId === a ? boxA : boxB]);
        const row = await db.shelf.findUniqueOrThrow(args);
        expect(row.boxes.map((box) => box.id)).toEqual([companyId === a ? boxA : boxB]);
      });
    }
  });
  it('keeps raw bulk updates scoped', async () => scope(a, async () => {
    await db.$executeRaw(Prisma.sql`UPDATE master_products SET product_name = ${'scoped'} WHERE product_id IN (${productA}, ${productB})`);
    expect((await base.masterProduct.findUniqueOrThrow({ where: { productId: productB } })).productName).toBeNull();
  }));
  it('checks references within the same transaction, including newly created parents', async () => scope(a, async () => {
    await db.$transaction(async (tx) => {
      const row = await tx.masterProduct.create({ data: { productId: `${productA}-tx` } });
      const sku = await tx.sku.create({ data: { sku: `${productA}-sku`, productId: row.productId } });
      expect(sku.companyId).toBe(a);
    });
  }));
  it('allows the Japan warehouse to read all companies and work within either company', async () => {
    const rows = await scope(undefined, () => db.box.findMany({ where: { id: { in: [boxA,boxB] } } }), { warehouse: true });
    expect(rows).toHaveLength(2);
    await scope(b, () => db.box.update({ where: { id: boxB }, data: { status: 1 } }), { warehouse: true });
    await expect(scope(undefined, () => db.box.create({ data: { boxCode: 'no-owner', shelfId: shelf } }), { warehouse: true })).rejects.toThrow('选择所属');
  });
  it('lets the shared Xiya channel see all companies and infer incoming order ownership', async () => {
    const products = await db.masterProduct.findMany({ where: { productId: { in: [productA,productB] } } });
    expect(products).toHaveLength(2);
    const order = await db.manualOrderRecord.create({ data: {
      rowHash: `${productB}-xiya`.padEnd(40,'0').slice(0,40), orderId: `${productB}-xiya`, rawPayload: { '产品ID': productB },
    } });
    expect(order.companyId).toBe(b);
    expect(await scope(a, () => db.manualOrderRecord.findUnique({ where: { id: order.id } }))).toBeNull();
  });
  it('preserves both companies when importing a shared Xiya product response', async () => {
    const service = new MasterProductsService(db as PrismaService, {} as AuditService);
    const source = await base.masterProduct.findMany({ where: { productId: { in: [productA,productB] } } });
    jest.spyOn(service as any, 'fetchXiyaImportRows').mockResolvedValue(source.map((row) => ({ ...row, productName: 'shared-xiya-update' })));
    await scope(a, () => (service as any).performXiyaSync(10));
    const updated = await base.masterProduct.findMany({ where: { productId: { in: [productA,productB] } } });
    expect(updated.every((row) => row.productName === 'shared-xiya-update')).toBe(true);
    expect(updated.find((row) => row.productId === productA)?.companyId).toBe(a);
    expect(updated.find((row) => row.productId === productB)?.companyId).toBe(b);
  });
  it('keeps concurrent requests and company schedule controls independent', async () => {
    const result = await Promise.all([a,b].map((id) => scope(id, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const control = await db.rakutenScheduleControl.upsert({ where: { companyId_key: { companyId: id, key: 'import' } }, create: { key: 'import', enabled: id === a }, update: {} });
      const boxes = await db.box.findMany({ where: { shelfId: shelf } });
      return { control, boxes };
    })));
    expect(result[0].control.enabled).toBe(true); expect(result[1].control.enabled).toBe(false);
    expect(result[0].boxes.map((r) => r.id)).toEqual([boxA]);
    expect(result[1].boxes.map((r) => r.id)).toEqual([boxB]);
  });
});
