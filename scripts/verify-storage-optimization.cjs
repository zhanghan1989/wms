// Integration verification uses an isolated, disposable LOCAL MySQL database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { OrdersService } = require('../apps/api/dist/src/orders/orders.service');
const { RakutenRmsApiService } = require('../apps/api/dist/src/rakuten-rms-api/rakuten-rms-api.service');
const root = path.resolve(__dirname, '..');
const envFile = require('dotenv').parse(fs.readFileSync(path.join(root, 'apps/api/.env')));
const connection = new URL(envFile.DATABASE_URL);
assert(['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname), 'Only local MySQL is allowed');
const database = `wms_storage_test_${Date.now()}`;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-storage-'));
const mysql = process.env.WMS_TEST_MYSQL_BIN || 'mysql';
const mysqlArgs = ['--protocol=TCP', '-h', connection.hostname, '-P', connection.port || '3306', '-u', decodeURIComponent(connection.username)];
const mysqlEnv = { ...process.env, MYSQL_PWD: decodeURIComponent(connection.password) };
const sql = (source, db) => cp.execFileSync(mysql, [...mysqlArgs, ...(db ? [db] : [])], { input: source, env: mysqlEnv, encoding: 'utf8' });
let created = false;
let db;
(async () => {
  sql(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created = true;
  connection.pathname = `/${database}`;
  const runtimeEnv = { ...process.env };
  runtimeEnv['DATABASE_URL'] = connection.toString();
  const schema = fs.readFileSync(path.join(root, 'apps/api/prisma/schema.prisma'), 'utf8');
  const before = schema.replace(/model RakutenTrackingCheck \{[\s\S]*?\n\}/, '')
    .replace(/\s*@@index\(\[shipmentNo, deletedAt, dispatchMode\], map: "idx_rakuten_tracking_parcel"\)/, '');
  assert.notEqual(schema, before);
  const baseline = path.join(temporary, 'before.prisma');
  fs.writeFileSync(baseline, before);
  const prisma = path.join(root, 'node_modules/.bin/prisma');
  cp.execFileSync(prisma, ['db', 'push', '--schema', baseline, '--skip-generate'], { env: runtimeEnv, stdio: 'pipe' });
  sql(fs.readFileSync(path.join(root, 'apps/api/prisma/migrations/20261028000000_rakuten_tracking_checks/migration.sql'), 'utf8'), database);
  cp.execFileSync(prisma, ['migrate', 'diff', '--from-url', connection.toString(), '--to-schema-datamodel', path.join(root, 'apps/api/prisma/schema.prisma'), '--exit-code'], { env: runtimeEnv, stdio: 'pipe' });
  db = new PrismaClient({ datasources: { db: { url: connection.toString() } } });
  const orders = new OrdersService(db);
  const newOrder = (number, suffix = '') => db.rakutenOrderRecord.create({ data: {
    rowHash: createHash('sha1').update(number + suffix).digest('hex'), orderId: `TEST-${number}${suffix}`,
    shipmentNo: number, dispatchMode: 'china_pending', rawPayload: { padding: 'x'.repeat(120_000) },
  } });
  const a = await newOrder('MOVING');
  await newOrder('MOVING', '-second-line');
  const status = { trackingNo: 'MOVING', label: '輸送中', isDelivered: false, hasCustomsClearance: true,
    customsClearanceDate: '2026-10-20', occurredAt: '2026-10-21T01:00:00.000Z', error: null };
  await orders.persistRakutenTrackingStatus('MOVING', status);
  const first = await db.rakutenOrderRecord.findUniqueOrThrow({ where: { id: a.id } });
  await db.rakutenTrackingCheck.update({ where: { trackingNo: 'MOVING' }, data: { checkedAt: new Date('2020-01-01') } });
  await orders.persistRakutenTrackingStatus('MOVING', status);
  assert.deepEqual(await db.rakutenOrderRecord.findUniqueOrThrow({ where: { id: a.id } }), first, 'unchanged polls must not touch wide rows');
  const check = await db.rakutenTrackingCheck.findUniqueOrThrow({ where: { trackingNo: 'MOVING' } });
  assert(check.checkedAt > new Date('2020-01-01'));
  const [display] = await orders.enrichOrderRows([first]);
  assert.equal(display.trackingCheckedAt.getTime(), check.checkedAt.getTime(), 'UI must show the actual last check');
  await orders.persistRakutenTrackingStatus('MOVING', { ...status, label: '配達完了', isDelivered: true });
  const delivered = await db.rakutenOrderRecord.findMany({ where: { shipmentNo: 'MOVING' } });
  assert(delivered.every(row => row.trackingIsDelivered && row.trackingCustomsClearanceDate));
  assert.deepEqual(delivered[0].rawPayload, first.rawPayload);

  // A failed metadata write must roll back the associated business-state write.
  const failing = new OrdersService({ $transaction: (work) => db.$transaction(tx => work({
    rakutenOrderRecord: tx.rakutenOrderRecord,
    rakutenTrackingCheck: { findUnique: tx.rakutenTrackingCheck.findUnique.bind(tx.rakutenTrackingCheck),
      upsert: async () => { throw new Error('injected metadata failure'); } },
  })) });
  await assert.rejects(failing.persistRakutenTrackingStatus('MOVING', { ...status, label: 'uncommitted' }));
  assert.equal((await db.rakutenOrderRecord.findUniqueOrThrow({ where: { id: a.id } })).trackingStatusLabel, '配達完了');

  const due = await newOrder('DUE');
  await newOrder('BACKOFF');
  await orders.persistRakutenTrackingStatus('BACKOFF', { ...status, trackingNo: 'BACKOFF', error: 'temporary outage' });
  await orders.persistRakutenTrackingStatus('BACKOFF', { ...status, trackingNo: 'BACKOFF', error: 'temporary outage' });
  const failed = await db.rakutenTrackingCheck.findUniqueOrThrow({ where: { trackingNo: 'BACKOFF' } });
  assert.equal(failed.consecutiveFailures, 2);
  assert.equal(failed.nextCheckAt.getTime() - failed.checkedAt.getTime(), 40 * 60_000);
  await newOrder('IGNORED');
  await db.rakutenTrackingQueryIgnore.create({ data: { trackingNo: 'IGNORED', ignoredBy: 'test' } });
  await db.rakutenTrackingSyncLock.create({ data: { id: 'rakuten-tracking-status-sync' } });
  const fetched = [];
  orders.fetchUofTrackingClearanceStatus = async trackingNo => { fetched.push(trackingNo); return { ...status, trackingNo }; };
  await orders.syncRakutenTrackingStatuses();
  assert.deepEqual(fetched, ['DUE'], 'exclude terminal parcels, ignored numbers, and deferred errors before LIMIT');
  assert((await db.rakutenOrderRecord.findUniqueOrThrow({ where: { id: due.id } })).trackingCheckedAt);
  await orders.persistRakutenTrackingStatus('BACKOFF', { ...status, trackingNo: 'BACKOFF' });
  assert.equal((await db.rakutenTrackingCheck.findUniqueOrThrow({ where: { trackingNo: 'BACKOFF' } })).consecutiveFailures, 0);

  const api = new RakutenRmsApiService(db, {}, {});
  const syncedAt = new Date();
  api.buildOrderWriteData = async () => ({ orderQuantity: first.orderQuantity, rawPayload: first.rawPayload, rmsLastSyncedAt: syncedAt });
  const plan = { existing: first, item: {}, action: 'update', changedFields: [] };
  assert.equal(await api.applyOrderPlan(db, {}, plan, syncedAt), null, 'RMS timestamp-only sync must not write');
  api.buildOrderWriteData = async () => ({ orderQuantity: first.orderQuantity, rawPayload: { meaningfulChange: true }, rmsLastSyncedAt: syncedAt });
  assert((await api.applyOrderPlan(db, {}, plan, syncedAt)).before, 'payload changes must remain reversible');
  assert.deepEqual((await db.rakutenOrderRecord.findUniqueOrThrow({ where: { id: a.id } })).rawPayload, { meaningfulChange: true });
  console.log('PASS: migration has zero drift; unchanged polls preserve wide rows; UI freshness, business changes, atomic rollback, bounded candidates, backoff, and RMS payload changes verified on local MySQL.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (db) await db.$disconnect();
  if (created) sql(`DROP DATABASE \`${database}\``);
  fs.rmSync(temporary, { recursive: true });
});
