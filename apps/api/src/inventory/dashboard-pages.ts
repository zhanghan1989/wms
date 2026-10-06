import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';

type Dashboard = { demand: { topSkus: unknown[] }; obsolete: { noSales90dSkus: unknown[] }; [key: string]: unknown };
type Snapshot = { top: unknown[]; noSales: unknown[]; expiresAt: number; timer: NodeJS.Timeout };
const snapshots = new Map<string, Snapshot>();
const snapshotIds = new WeakMap<object, string>();
const lifetime = 10 * 60_000;
// Bound retained list rows as well as snapshot count: large refreshes must not keep 12 full lists.
const maxRetainedRows = 100_000;
let retainedRows = 0;
function deleteSnapshot(id: string): void {
  const snapshot = snapshots.get(id);
  if (!snapshot) return;
  clearTimeout(snapshot.timer);
  retainedRows -= snapshot.top.length + snapshot.noSales.length;
  snapshots.delete(id);
}
export function dashboardFirstPages(value: unknown): unknown {
  const data = value as Dashboard;
  const now = Date.now();
  for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now) deleteSnapshot(id);
  const existingId = snapshotIds.get(data);
  const snapshotId = existingId && snapshots.has(existingId) ? existingId : randomUUID();
  if (!snapshots.has(snapshotId)) {
    const top = data.demand.topSkus;
    const noSales = data.obsolete.noSales90dSkus;
    const rowCount = top.length + noSales.length;
    // Keep at least the newest snapshot even when that single list exceeds the budget.
    while (snapshots.size && (snapshots.size >= 12 || retainedRows + rowCount > maxRetainedRows)) {
      deleteSnapshot(snapshots.keys().next().value!);
    }
    const timer = setTimeout(() => deleteSnapshot(snapshotId), lifetime);
    timer.unref();
    snapshots.set(snapshotId, { top, noSales, expiresAt: now + lifetime, timer });
    retainedRows += rowCount;
  }
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
  if (!snapshot || snapshot.expiresAt <= Date.now()) {
    deleteSnapshot(snapshotId);
    throw new ConflictException('看板数据已过期，请刷新看板');
  }
  const rows = list === 'top' ? snapshot.top : snapshot.noSales;
  return { items: rows.slice(offset, offset + 30), total: rows.length, hasMore: offset + 30 < rows.length };
}
