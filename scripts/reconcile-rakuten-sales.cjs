// Run inside the production image: node scripts/reconcile-rakuten-sales.cjs
// --shop='乐天-1号店' --from=2026-05-01 --to=2026-10-27 --operator=5 [--apply]
// Defaults to a read-only preview. --apply backs up only financial facts first.
const fs = require('node:fs/promises');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { RakutenSalesService } = require('../apps/api/dist/src/rakuten-rms-api/rakuten-sales.service');
const { RakutenRmsApiClient } = require('../apps/api/dist/src/rakuten-rms-api/rakuten-rms-api.client');
const { RakutenRmsApiCryptoService } = require('../apps/api/dist/src/rakuten-rms-api/rakuten-rms-api-crypto.service');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const db = new PrismaClient();
const client = new RakutenRmsApiClient();
const stringify = v => JSON.stringify(v, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
(async () => {
  if (!args.shop || !/^\d{4}-\d{2}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}-\d{2}$/.test(args.to)) throw new Error('须提供shop、from、to；日期按日本时间，to包含当日');
  const connection = await db.rakutenRmsConnection.findFirstOrThrow({ where: { status: 1, syncOrders: true, shop: { name: args.shop } } });
  const start = new Date(`${args.from}T00:00:00+09:00`);
  const end = new Date(Math.min(Date.now(), new Date(`${args.to}T00:00:00+09:00`).getTime() + 86400000));
  if (args.apply) {
    if (!args.operator || !/^\d+$/.test(args.operator)) throw new Error('写入须提供明确的operator用户ID');
    await db.user.findFirstOrThrow({ where: { id: BigInt(args.operator), status: 1, role: { in: ['admin', 'system_admin'] } } });
    const directory = path.join(process.env.BACKUP_DIR || '/app/storage/backups', 'rakuten-sales');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${connection.id}-${Date.now()}.json`);
    const snapshots = await db.rakutenSalesSnapshot.findMany({ where: { connectionId: connection.id } });
    await fs.writeFile(file, stringify({ connectionId: connection.id, salesCoverageStart: connection.salesCoverageStart,
      salesCoverageEnd: connection.salesCoverageEnd, lastSalesSyncedAt: connection.lastSalesSyncedAt,
      lastSalesSyncError: connection.lastSalesSyncError, snapshots }), { mode: 0o600, flag: 'wx' });
    console.log('FINANCIAL_BACKUP', file);
  }
  const service = new RakutenSalesService(db, client, new RakutenRmsApiCryptoService());
  console.log('SALES_RECONCILIATION_START', stringify({ shop: args.shop, from: start, to: end, apply: Boolean(args.apply) }));
  console.log('SALES_RECONCILIATION_RESULT', stringify(await service.reconcile(connection.id, start, end,
    args.operator ? BigInt(args.operator) : undefined, !args.apply)));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await client.onModuleDestroy(); await db.$disconnect();
});
