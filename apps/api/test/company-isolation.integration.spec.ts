import { ShopsService } from '../src/shops/shops.service';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';
import { warehouseCompanyData } from '../src/company-scope/warehouse-company';
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
  let platformKey: string;
  const amazonRows: Array<{ companyId: bigint; shopId: bigint; connectionId: bigint; orderId: bigint }> = [];
  const scope = <T>(companyId: bigint | undefined, fn: () => T | PromiseLike<T>, extra: Partial<CompanyScope> = {}): Promise<T> =>
    companyContext.run({ companyId, systemAdmin: false, warehouse: false, userId: 0n, ...extra }, async () => await fn());
  beforeAll(async () => {
    base = new PrismaClient({ datasourceUrl: url });
    db = installCompanyIsolation(base);
    const tag = Date.now().toString();
    await base.company.upsert({ where: { id: 1n }, create: { id: 1n, name: 'QA-default-XYJG' }, update: {} });
    platformKey = 'amazon';
    await base.shopPlatformDefinition.upsert({ where: { key: platformKey }, create: { key: platformKey, name: 'Amazon' }, update: {} });
    a = (await base.company.create({ data: { name: `QA-A-${tag}` } })).id;
    b = (await base.company.create({ data: { name: `QA-B-${tag}` } })).id;
    shelf = (await base.shelf.create({ data: { shelfCode: `QA-${tag}` } })).id;
    boxA = (await scope(a, () => db.box.create({ data: { boxCode: `QA-A-${tag}`, shelfId: shelf } }))).id;
    boxB = (await scope(b, () => db.box.create({ data: { boxCode: `QA-B-${tag}`, shelfId: shelf } }))).id;
    warehouseUser = (await base.user.create({ data: { username: `QA-warehouse-${tag}`, companyId: null, department: 'overseas_warehouse', role: 'employee' } })).id;
    productA = `QA-A-${tag}`; productB = `QA-B-${tag}`;
    for (const [companyId, productId] of [[a, productA], [b, productB]] as const) {
      await scope(companyId, async () => {
        await db.brand.create({ data: { name: `same-brand-${tag}` } });
        await db.masterProduct.create({ data: { productId, bagBrand: `same-brand-${tag}` } });
        const shop = await db.shop.create({ data: { name: `QA-shop-${productId}`, platform: platformKey } });
        const connection = await db.amazonSpApiConnection.create({ data: {
          shopId: shop.id, sellerId: `QA-seller-${productId}`, marketplaceIds: ['QA'],
          encryptedRefreshToken: 'test-only', tokenIv: 'test-only', tokenAuthTag: 'test-only',
        } });
        const order = await db.amazonOrderRecord.create({ data: {
          rowHash: `${productId}-amazon`.padEnd(40, '0').slice(0, 40),
          orderId: `${productId}-amazon`, shopName: shop.name, spApiConnectionId: connection.id,
        } });
        amazonRows.push({ companyId, shopId: shop.id, connectionId: connection.id, orderId: order.id });
      });
    }
  });
  afterAll(async () => {
    if (!base) return;
    if (warehouseUser) {
      await base.operationAuditLog.deleteMany({ where: { entityType: 'user', entityId: warehouseUser } });
      await base.user.delete({ where: { id: warehouseUser } });
    }
    for (const companyId of [a,b]) {
      if (!companyId) continue;
      await base.amazonOrderRecord.deleteMany({ where: { companyId } });
      await base.amazonSpApiConnection.deleteMany({ where: { companyId } });
      await base.shop.deleteMany({ where: { companyId } });
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
  it('hides the other company shops, Amazon connections, products and orders in both directions', async () => {
    for (const own of amazonRows) {
      const foreign = amazonRows.find(row => row.companyId !== own.companyId)!;
      await scope(own.companyId, async () => {
        const shops = new ShopsService(db as PrismaService, {} as AuditService);
        const amazon = new AmazonSpApiService(db as PrismaService, {} as any, {} as any);
        expect((await shops.list() as Array<{ id: bigint }>).map(row => row.id)).toEqual([own.shopId]);
        const connections = await amazon.listConnections() as Array<{ id: string; companyId: string }>;
        expect(connections).toEqual([expect.objectContaining({ id: String(own.connectionId), companyId: String(own.companyId) })]);
        expect(await db.shop.findUnique({ where: { id: foreign.shopId } })).toBeNull();
        expect(await db.amazonSpApiConnection.findUnique({ where: { id: foreign.connectionId } })).toBeNull();
        expect(await db.masterProduct.findUnique({ where: { productId: own.companyId === a ? productB : productA } })).toBeNull();
        expect(await db.amazonOrderRecord.findUnique({ where: { id: foreign.orderId } })).toBeNull();
        expect((await db.amazonOrderRecord.findMany()).map(row => row.id)).toEqual([own.orderId]);
        expect(await db.amazonOrderRecord.count()).toBe(1);
        await expect(db.amazonOrderRecord.create({ data: {
          rowHash: `${own.companyId}-cross-shop`.padEnd(40, '0'), spApiConnectionId: foreign.connectionId,
        } })).rejects.toThrow('其他公司');
      });
    }
  });
  it('shows only Amazon in Chinese shop management while the warehouse retains other platforms', async () => {
    const key = `qa-other-${Date.now()}`;
    const platform = await base.shopPlatformDefinition.create({ data: { key, name: key } });
    const other = await scope(a, () => db.shop.create({ data: { name: key, platform: key } }));
    try {
      const shops = new ShopsService(db as PrismaService, {} as AuditService);
      await scope(a, async () => {
        expect((await shops.listPlatforms() as Array<{ key: string }>).map(row => row.key)).toEqual(['amazon']);
        expect((await shops.list() as Array<{ id: bigint }>).map(row => row.id)).toEqual([amazonRows[0].shopId]);
        await expect(shops.update(String(other.id), { name: `${key}-renamed` }, warehouseUser)).rejects.toThrow('不存在');
        await expect(shops.remove(String(other.id), warehouseUser)).rejects.toThrow('不存在');
      });
      await scope(undefined, async () => {
        expect((await shops.list() as Array<{ id: bigint }>).some(row => row.id === other.id)).toBe(true);
        expect((await shops.listPlatforms() as Array<{ key: string }>).some(row => row.key === key)).toBe(true);
      }, { warehouse: true, userId: warehouseUser });
    } finally {
      await base.shop.delete({ where: { id: other.id } });
      await base.shopPlatformDefinition.delete({ where: { id: platform.id } });
    }
  });
  it('keeps all shops, Amazon connections, products and orders visible to overseas warehouse management', async () => scope(undefined, async () => {
    const companyIds = [a, b];
    expect(await db.shop.count({ where: { companyId: { in: companyIds } } })).toBe(2);
    expect(await db.amazonSpApiConnection.count({ where: { companyId: { in: companyIds } } })).toBe(2);
    expect(await db.masterProduct.count({ where: { productId: { in: [productA, productB] } } })).toBe(2);
    expect(await db.amazonOrderRecord.count({ where: { companyId: { in: companyIds } } })).toBe(2);
  }, { warehouse: true, userId: warehouseUser }));
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
  it('limits warehouse account queries and writes to its own affiliation even with a business selection', async () => scope(a, async () => {
    const users = await db.user.findMany();
    expect(users.some(user => user.id === warehouseUser)).toBe(true);
    expect(users.every(user => user.companyId === null && user.department === 'overseas_warehouse' && user.role !== 'system_admin')).toBe(true);
    await db.user.update({ where: { id: warehouseUser }, data: { status: 1 } });
    await expect(db.user.update({ where: { id: warehouseUser }, data: { companyId: a } })).rejects.toThrow('跨公司');
    await expect(db.user.update({ where: { id: warehouseUser }, data: { department: 'factory' } })).rejects.toThrow('跨公司');
    const created = await db.user.create({ data: { username: `QA-new-warehouse-${Date.now()}`, companyId: null, department: 'overseas_warehouse', role: 'employee' } });
    expect(created.companyId).toBeNull();
    await db.user.delete({ where: { id: created.id } });
  }, { warehouse: true, userId: warehouseUser }));
  it('preserves global account affiliation during self-service password and audit writes', async () => scope(undefined, async () => {
    await db.user.update({ where: { id: warehouseUser }, data: { passwordHash: 'test-only-hash' } });
    expect((await base.user.findUniqueOrThrow({ where: { id: warehouseUser } })).companyId).toBeNull();
    await scope(undefined, async () => {
      await db.operationAuditLog.create({ data: { entityType: 'user', entityId: warehouseUser, action: 'update', eventType: 'user_updated', operatorId: warehouseUser } });
      expect((await base.operationAuditLog.findFirstOrThrow({ where: { entityType: 'user', entityId: warehouseUser } })).companyId).toBeNull();
    }, { systemAdmin: true });
  }, { warehouse: true, userId: warehouseUser }));
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
    const box = await scope(undefined, () => db.box.create({ data: { boxCode: `QA-no-selector-${Date.now()}`, shelfId: shelf } }), { warehouse: true });
    expect(box.companyId).toBe(1n);
    await base.box.delete({ where: { id: box.id } });
  });
  it('infers warehouse document ownership from goods without narrowing reads', async () => scope(undefined, async () => {
    expect(await warehouseCompanyData(db, { productIds: [productB] })).toEqual({ companyId: b });
    expect(await warehouseCompanyData(db, { boxIds: [boxA] })).toEqual({ companyId: a });
    await expect(warehouseCompanyData(db, { productIds: [productA, productB] })).rejects.toThrow('同一单据');
    const data = await warehouseCompanyData(db, { productIds: [productB] });
    const order = await db.inboundOrder.create({ data: { ...data, orderNo: `QA-warehouse-${Date.now()}`, orderType: 'pending_batch', status: 'draft', createdBy: warehouseUser } });
    expect(order.companyId).toBe(b);
    await db.inboundOrder.delete({ where: { id: order.id } });
    expect((await db.box.findMany({ where: { id: { in: [boxA, boxB] } } })).length).toBe(2);
  }, { warehouse: true }));
  it('lets warehouse staff create combinations for either company without a selector and preserves Chinese ownership', async () => scope(undefined, async () => {
    for (const [companyId, productId] of [[a, productA], [b, productB]] as const) {
      const combo = await db.rakutenComboProduct.create({ data: { comboName: `QA-combo-${productId}`, items: { create: [{ productId, position: 1 }] } } });
      expect(combo.companyId).toBe(companyId);
      expect((await base.rakutenComboProductItem.findFirstOrThrow({ where: { comboId: combo.id } })).companyId).toBe(companyId);
      expect(await scope(companyId === a ? b : a, () => db.rakutenComboProduct.findUnique({ where: { id: combo.id } }))).toBeNull();
      await db.rakutenComboProductItem.deleteMany({ where: { comboId: combo.id } });
      await db.rakutenComboProduct.delete({ where: { id: combo.id } });
    }
  }, { warehouse: true }));
  it('lets the shared Xiya channel see all companies and infer incoming order ownership', async () => {
    const products = await db.masterProduct.findMany({ where: { productId: { in: [productA,productB] } } });
    expect(products).toHaveLength(2);
    const order = await db.manualOrderRecord.create({ data: {
      rowHash: `${productB}-xiya`.padEnd(40,'0').slice(0,40), orderId: `${productB}-xiya`, rawPayload: { '产品ID': productB },
    } });
    expect(order.companyId).toBe(b);
    expect(await scope(a, () => db.manualOrderRecord.findUnique({ where: { id: order.id } }))).toBeNull();
  });
  it('skips conflicting globally unique product IDs from another company', async () => {
    const service = new MasterProductsService(db as PrismaService, {} as AuditService);
    const source = await base.masterProduct.findMany({ where: { productId: { in: [productA,productB] } } });
    jest.spyOn(service as any, 'fetchXiyaImportRows').mockResolvedValue(source.map((row) => ({ ...row, productName: 'shared-xiya-update' })));
    const result = await scope(a, () => (service as any).performXiyaSync(10));
    expect(result.conflictIds).toEqual([productB]);
    const updated = await base.masterProduct.findMany({ where: { productId: { in: [productA,productB] } } });
    expect(updated.find((row) => row.productId === productA)?.productName).toBe('shared-xiya-update');
    expect(updated.find((row) => row.productId === productB)?.productName).toBe(source.find((row) => row.productId === productB)?.productName);
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
