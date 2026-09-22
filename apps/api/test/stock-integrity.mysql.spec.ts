import { randomUUID } from 'crypto';
import { hash } from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import { AuthService } from '../src/auth/auth.service';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { InventoryService } from '../src/inventory/inventory.service';
import { BatchInboundService } from '../src/batch-inbound/batch-inbound.service';
import { OrdersService } from '../src/orders/orders.service';
import { InboundService } from '../src/inbound/inbound.service';
import { availableStock } from '../src/inventory/stock-availability';

// Opt-in only. Never use DATABASE_URL, which may point at a real warehouse.
const testUrl = process.env.WMS_TEST_DATABASE_URL;
const mysql = testUrl ? describe : describe.skip;
mysql('stock integrity against isolated MySQL', () => {
  let db: PrismaClient;
  let inventory: InventoryService;
  let inbound: BatchInboundService;
  let orders: OrdersService;
  let operatorId: bigint;
  let boxSequence = 100000;
  const name = () => `TEST-${randomUUID().slice(0, 16)}`;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/(_test|_regression)$/.test(url.pathname)) {
      throw new Error('WMS_TEST_DATABASE_URL must target a loopback database ending in _test or _regression');
    }
    db = new PrismaClient({ datasources: { db: { url: testUrl } } });
    await db.$connect();
    const maxBox = await db.$queryRaw<Array<{ maxCode: bigint | null }>>`SELECT MAX(CAST(box_code AS UNSIGNED)) AS maxCode FROM boxes WHERE box_code REGEXP '^[0-9]{1,6}$'`;
    boxSequence = Math.max(100000, Number(maxBox[0]?.maxCode ?? 0));
    const operator = await db.user.create({ data: { username: name(), role: 'system_admin', passwordHash: await hash('TestOnly@123', 4), passwordChangedAt: new Date() } });
    operatorId = operator.id;
    const audit = new AuditService(db as any);
    inventory = new InventoryService(db as any, audit);
    inbound = new BatchInboundService(db as any, audit);
    orders = new OrdersService(db as any);
  });
  afterAll(async () => { await db?.$disconnect(); });

  async function fixture(qty = 10) {
    const productId = name();
    const product = await db.masterProduct.create({ data: { productId, productName: productId, stockQty: qty } });
    const shelf = await db.shelf.create({ data: { shelfCode: name(), name: '测试货架' } });
    const box = await db.box.create({ data: { boxCode: String(++boxSequence), shelfId: shelf.id } });
    const sku = await db.sku.create({ data: { sku: name(), productId, fnsku: name(), shop: 'TEST-SHOP' } });
    await db.masterProductBoxInventory.create({ data: { boxId: box.id, productId, qty } });
    return { product, productId, box, sku, shelf, qty };
  }
  async function expectBalance(f: Awaited<ReturnType<typeof fixture>>, expected: number) {
    const rows = await db.masterProductBoxInventory.findMany({ where: { productId: f.productId } });
    const product = await db.masterProduct.findUniqueOrThrow({ where: { productId: f.productId } });
    const movement = await db.stockMovement.aggregate({ where: { productId: f.productId }, _sum: { qtyDelta: true } });
    expect(rows.reduce((sum, row) => sum + row.qty, 0)).toBe(expected);
    expect(product.stockQty).toBe(expected);
    expect(f.qty + (movement._sum.qtyDelta ?? 0)).toBe(expected);
  }
  async function fba(f: Awaited<ReturnType<typeof fixture>>, qty: number) {
    return db.fbaReplenishment.create({ data: { requestNo: name(), skuId: f.sku.id,
      boxId: f.box.id, requestedQty: qty, actualQty: qty, status: 'pending_outbound', createdBy: operatorId } });
  }
  async function picking(f: Awaited<ReturnType<typeof fixture>>, qty: number) {
    return db.overseasPickingBatch.create({ data: { batchNo: name(), items: { create: {
      source: 'manual', sourceRecordId: 1n, productId: f.productId, requestedQty: qty, actualQty: qty,
      pickingPlanSnapshot: [{ shelfCode: f.shelf.shelfCode, boxCode: f.box.boxCode, boxQty: f.qty, pickQty: qty }],
      bomSnapshot: [],
    } } }, include: { items: true } });
  }

  it('keeps concurrent product-only adjustments and ledger consistent', async () => {
    const f = await fixture();
    await Promise.all([-3, -4].map(qtyDelta => inventory.manualAdjust({ productId: f.productId, boxCode: f.box.boxCode, qtyDelta }, operatorId)));
    await expectBalance(f, 3);
    expect(await db.inventoryAdjustOrderItem.count({ where: { productId: f.productId, skuId: null } })).toBe(2);
  });
  it('prevents overselling when two adjustments compete for stock', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([-8, -8].map(qtyDelta => inventory.manualAdjust({ productId: f.productId, boxCode: f.box.boxCode, qtyDelta }, operatorId)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await expectBalance(f, 2);
    expect(await db.stockMovement.count({ where: { productId: f.productId } })).toBe(1);
  });
  it('keeps a product total consistent when different boxes change concurrently', async () => {
    const f = await fixture();
    const second = await db.box.create({ data: { boxCode: String(++boxSequence), shelfId: f.shelf.id } });
    await db.masterProductBoxInventory.create({ data: { boxId: second.id, productId: f.productId, qty: 10 } });
    await db.masterProduct.update({ where: { productId: f.productId }, data: { stockQty: 20 } });
    f.qty = 20;
    await Promise.all([
      inventory.manualAdjust({ productId: f.productId, boxCode: f.box.boxCode, qtyDelta: -4 }, operatorId),
      inventory.manualAdjust({ productId: f.productId, boxCode: second.boxCode, qtyDelta: 3 }, operatorId),
    ]);
    await expectBalance(f, 19);
  });
  it('records normal inbound receipts in the same transaction as their balance', async () => {
    const f = await fixture(0);
    const order = await db.inboundOrder.create({ data: { orderNo: name(), orderType: 'manual_single', status: 'draft',
      createdBy: operatorId, items: { create: { boxId: f.box.id, productId: f.productId, qty: 7 } } }, include: { items: true } });
    const service = new InboundService(db as any, new AuditService(db as any));
    await service.confirm(String(order.id), operatorId);
    await expectBalance(f, 7);
    expect(await db.stockMovement.count({ where: { operationKey: `inbound-item:${order.items[0].id}` } })).toBe(1);
  });
  it('deducts an FBA request exactly once across 20 concurrent retries', async () => {
    const f = await fixture(); const request = await fba(f, 3);
    const results = await Promise.all(Array.from({ length: 20 }, () => inventory.outboundFbaReplenishments({ ids: [Number(request.id)], expressNo: 'TEST-TRACK' }, operatorId)));
    expect(results.reduce((sum, r) => sum + r.updatedCount, 0)).toBe(1);
    await expectBalance(f, 7);
    expect(await db.stockMovement.count({ where: { operationKey: `fba:${request.id}:outbound` } })).toBe(1);
  });
  it('does not resurrect an outbound request when confirmation races with outbound', async () => {
    const f = await fixture(); const request = await fba(f, 3);
    await Promise.allSettled([
      inventory.confirmFbaReplenishment(String(request.id), { actualQty: 4 }, operatorId),
      inventory.outboundFbaReplenishments({ ids: [Number(request.id)], expressNo: 'TEST-RACE' }, operatorId),
    ]);
    const saved = await db.fbaReplenishment.findUniqueOrThrow({ where: { id: request.id } });
    expect(saved.status).toBe('outbound');
    await expectBalance(f, 10 - saved.actualQty!);
  });
  it('rejects FBA claiming stock already reserved by picking', async () => {
    const f = await fixture(); await picking(f, 8);
    await expect(inventory.createFbaReplenishment({ skuId: Number(f.sku.id), boxCode: f.box.boxCode, qty: 8 }, operatorId)).rejects.toThrow('可用库存不足');
    expect(await db.fbaReplenishment.count({ where: { skuId: f.sku.id } })).toBe(0);
  });
  it('does not plan picking stock already reserved by FBA', async () => {
    const f = await fixture(); await fba(f, 8);
    const snapshots = [{ productId: f.productId, requestedQty: 8, bomSnapshot: [] }];
    await (orders as any).attachOverseasPickingPlanSnapshots(snapshots);
    expect((snapshots[0] as any).pickingPlanSnapshot.reduce((sum: number, row: any) => sum + row.pickQty, 0)).toBe(2);
    await expect((orders as any).assertOverseasPickingBatchDemandWithinStock(snapshots)).rejects.toThrow('超过库存');
  });
  it('counts FBA and existing picking claims against shared BOM materials', async () => {
    const material = await fixture();
    await fba(material, 6);
    const strapId = name();
    const strap = await db.masterProduct.create({ data: { productId: strapId, productName: '肩带', productType: '肩带', stockQty: 0 } });
    await db.masterProduct.update({ where: { productId: material.productId }, data: { productType: '肩带本体' } });
    const snapshots = [{ productId: strap.productId, requestedQty: 3, pickingPlanSnapshot: [],
      bomSnapshot: [{ componentProductId: material.productId, componentProductName: '材料', quantity: 2 }] }];
    await expect((orders as any).assertOverseasPickingBatchDemandWithinStock(snapshots)).rejects.toThrow('超过库存');
  });
  it('loads indexed BOM claims without unrelated picking items', async () => {
    const material = await fixture();
    const unrelated = await fixture();
    await picking(unrelated, 7);
    const parent = await db.masterProduct.create({ data: { productId: name(), productName: '测试组合', stockQty: 0 } });
    await db.overseasPickingBatch.create({ data: { batchNo: name(), items: { create: {
      source: 'manual', sourceRecordId: 1n, productId: parent.productId, requestedQty: 3,
      pickingPlanSnapshot: [], bomSnapshot: [{ componentProductId: material.productId, quantity: 2 }],
      componentRefs: { create: [{ componentProductId: material.productId }] },
    } } } });
    const rows = await availableStock(db as any, [material.productId]);
    expect(rows.reduce((sum, row) => sum + row.qty, 0)).toBe(4);
  });
  it('keeps legacy picking BOM claims when snapshots are absent', async () => {
    const material = await fixture();
    const parent = await db.masterProduct.create({ data: { productId: name(), productName: '旧组合', stockQty: 0 } });
    await db.masterProductBomItem.create({ data: { parentProductId: parent.productId,
      componentProductId: material.productId, quantity: 2, position: 1 } });
    await db.overseasPickingBatch.create({ data: { batchNo: name(), items: { create: {
      source: 'manual', sourceRecordId: 1n, productId: parent.productId, requestedQty: 3,
      pickingPlanSnapshot: [], bomSnapshot: undefined,
    } } } });
    const rows = await availableStock(db as any, [material.productId]);
    expect(rows.reduce((sum, row) => sum + row.qty, 0)).toBe(4);
  });
  it('protects reservations from manual deductions and moves', async () => {
    const f = await fixture(); await fba(f, 8);
    await expect(inventory.manualAdjust({ productId: f.productId, boxCode: f.box.boxCode, qtyDelta: -3 }, operatorId)).rejects.toThrow('可用库存不足');
    await expectBalance(f, 10);
  });
  it.each([0, 8, 10])('persists actual receipt %i after reload and retries', async actual => {
    const f = await fixture(0);
    const order = await db.batchInboundOrder.create({ data: { orderNo: name(), status: 'waiting_inbound', expectedBoxCount: 1,
      rangeStart: 1, rangeEnd: 1, collectedBoxCodes: [f.box.boxCode], createdBy: operatorId,
      items: { create: { boxCode: f.box.boxCode, productId: f.productId, qty: 10 } } }, include: { items: true } });
    const payload = { actualQuantities: { [String(order.items[0].id)]: actual }, differenceReason: '测试差异' };
    await inbound.confirmItem(String(order.id), String(order.items[0].id), operatorId, undefined, payload);
    const retry = await inbound.confirmItem(String(order.id), String(order.items[0].id), operatorId, undefined, payload);
    expect(retry.idempotent).toBe(true);
    const detail = await inbound.detail(String(order.id));
    expect(detail.items[0]).toMatchObject({ qty: 10, actualQty: actual, status: 'confirmed' });
    await expectBalance(f, actual);
  });
  it('moves inventory with balanced out/in ledger entries', async () => {
    const f = await fixture();
    const target = await db.box.create({ data: { boxCode: String(++boxSequence), shelfId: f.shelf.id } });
    await inventory.moveProductBetweenBoxes({ productId: f.productId, fromBoxCode: f.box.boxCode, toBoxCode: target.boxCode }, operatorId);
    await expectBalance(f, 10);
    expect(await db.stockMovement.count({ where: { productId: f.productId } })).toBe(2);
    expect((await db.masterProductBoxInventory.findUniqueOrThrow({ where: { boxId_productId: { boxId: target.id, productId: f.productId } } })).qty).toBe(10);
  });
  it('deducts picking once and respects other box reservations', async () => {
    const f = await fixture(); const batch = await picking(f, 2); await fba(f, 8);
    await Promise.all(Array.from({ length: 3 }, () => orders.confirmOverseasPickingBatch(String(batch.id), { items: [] }, operatorId)));
    await expectBalance(f, 8);
    const available = await availableStock(db as any, [f.productId]);
    expect(available.reduce((sum, row) => sum + row.qty, 0)).toBe(0);
  });
  it('invalidates real signed sessions on logout and password change', async () => {
    const oldSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'integration-signing-secret';
    try {
      const user = await db.user.findUniqueOrThrow({ where: { id: operatorId } });
      const jwt = new JwtService({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '1h' } });
      const auth = new AuthService(db as any, jwt, new AuditService(db as any), {} as any);
      const strategy = new JwtStrategy(db as any);
      const login = await auth.login(user.username, 'TestOnly@123');
      const claims = jwt.verify(login.accessToken);
      const principal = await strategy.validate(claims);
      await auth.logout(principal.id, principal.sessionId);
      await expect(strategy.validate(claims)).rejects.toThrow('登录已失效');
      const second = await auth.login(user.username, 'TestOnly@123');
      const changed = await auth.changePassword(user.id, 'TestOnly@123', 'NewTestOnly@123');
      await expect(strategy.validate(jwt.verify(second.accessToken))).rejects.toThrow('登录已失效');
      await expect(strategy.validate(jwt.verify(changed.accessToken))).resolves.toMatchObject({ id: user.id });
    } finally { if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret; }
  });
});
