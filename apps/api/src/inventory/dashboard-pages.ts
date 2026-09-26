import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';

type Dashboard = { demand: { topSkus: unknown[] }; obsolete: { noSales90dSkus: unknown[] }; [key: string]: unknown };
const snapshots = new Map<string, { data: Dashboard; expiresAt: number }>();
const snapshotIds = new WeakMap<object, string>();
const lifetime = 10 * 60_000;
export function dashboardFirstPages(value: unknown): unknown {
  const data = value as Dashboard;
  const now = Date.now();
  for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(id);
  const existingId = snapshotIds.get(data);
  while (!(existingId && snapshots.has(existingId)) && snapshots.size >= 12) snapshots.delete(snapshots.keys().next().value!);
  const snapshotId = existingId && snapshots.has(existingId) ? existingId : randomUUID();
  if (!snapshots.has(snapshotId)) snapshots.set(snapshotId, { data, expiresAt: now + lifetime });
  snapshotIds.set(data, snapshotId);
  return { ...data,
    demand: { ...data.demand, topSkus: data.demand.topSkus.slice(0, 30) },
    obsolete: { ...data.obsolete, noSales90dSkus: data.obsolete.noSales90dSkus.slice(0, 30) },
    pagination: { snapshotId, topTotal: data.demand.topSkus.length, noSalesTotal: data.obsolete.noSales90dSkus.length },
  };
}
export function dashboardPage(snapshotId: string, list: string, offsetRaw: string): unknown {
  if (list !== 'top' && list !== 'no-sales') throw new BadRequestException('无效的一览类型');
  const offset = Number(offsetRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new BadRequestException('无效的分页位置');
  const snapshot = snapshots.get(snapshotId);
  if (!snapshot || snapshot.expiresAt <= Date.now()) throw new ConflictException('看板数据已过期，请刷新看板');
  const rows = list === 'top' ? snapshot.data.demand.topSkus : snapshot.data.obsolete.noSales90dSkus;
  return { items: rows.slice(offset, offset + 30), total: rows.length, hasMore: offset + 30 < rows.length };
}
