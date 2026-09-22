import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { normalizeBoxCode } from '../common/box-code';

const boxKey = (code: string) => normalizeBoxCode(code) || String(code).trim().toUpperCase();

interface ReservationOptions { excludeFbaIds?: bigint[]; excludePickingBatchId?: bigint }
type StockRow = { boxId: bigint; productId: string; qty: number; box: { boxCode: string; shelf: { shelfCode: string } } };
type Demand = { productId: string; qty: number; boxCode?: string };

// Box-specific claims are allocated first; BOM materials without a frozen box use remaining stock.
export function subtractReservations<T extends StockRow>(rows: T[], demands: Demand[]): T[] {
  const available = rows.map(row => ({ ...row, qty: Number(row.qty) }));
  const boxed = new Map<string, number>();
  const pooled = new Map<string, number>();
  for (const demand of demands) {
    if (demand.qty <= 0) continue;
    if (demand.boxCode) {
      const key = `${demand.productId}\u001f${boxKey(demand.boxCode)}`;
      boxed.set(key, (boxed.get(key) ?? 0) + demand.qty);
    } else pooled.set(demand.productId, (pooled.get(demand.productId) ?? 0) + demand.qty);
  }
  for (const row of available) {
    const key = `${row.productId}\u001f${boxKey(row.box.boxCode)}`;
    const qty = boxed.get(key) ?? 0;
    const physicalQty = row.qty;
    row.qty = Math.max(0, physicalQty - qty);
    // A pre-existing shortfall must not be hidden by allocating another box to a new request.
    if (qty > physicalQty) {
      pooled.set(row.productId, (pooled.get(row.productId) ?? 0) + qty - physicalQty);
    }
    boxed.delete(key);
  }
  for (const [key, qty] of boxed) {
    const productId = key.split('\u001f')[0];
    pooled.set(productId, (pooled.get(productId) ?? 0) + qty);
  }
  for (const row of available) {
    const reserved = Math.min(row.qty, pooled.get(row.productId) ?? 0);
    row.qty -= reserved;
    pooled.set(row.productId, (pooled.get(row.productId) ?? 0) - reserved);
  }
  return available;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object') : [];
}

export async function availableStock(
  tx: Prisma.TransactionClient, productIds: string[], options: ReservationOptions = {},
): Promise<StockRow[]> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return [];
  const [rows, fba, picking] = await Promise.all([
    tx.masterProductBoxInventory.findMany({
      where: { productId: { in: ids } },
      include: { box: { include: { shelf: { select: { shelfCode: true } } } } },
      orderBy: [{ qty: 'asc' }, { boxId: 'asc' }],
    }),
    tx.fbaReplenishment.findMany({
      where: { status: { in: ['pending_confirm', 'pending_outbound'] },
        sku: { productId: { in: ids } },
        ...(options.excludeFbaIds?.length ? { id: { notIn: options.excludeFbaIds } } : {}) },
      select: { status: true, requestedQty: true, actualQty: true,
        sku: { select: { productId: true } }, box: { select: { boxCode: true } } },
    }),
    tx.overseasPickingBatchItem.findMany({
      where: { batch: { status: 'created' }, dispatchMode: { in: ['', 'overseas'] },
        ...(options.excludePickingBatchId ? { batchId: { not: options.excludePickingBatchId } } : {}) },
      select: { productId: true, requestedQty: true, pickingPlanSnapshot: true, bomSnapshot: true },
    }),
  ]);
  const legacyIds = [...new Set(picking.filter(item => !Array.isArray(item.bomSnapshot)).map(item => item.productId))];
  const legacyProducts = legacyIds.length ? await tx.masterProduct.findMany({
    where: { productId: { in: legacyIds } },
    select: { productId: true, bomComponents: { select: { componentProductId: true, quantity: true } } },
  }) : [];
  const legacyBom = new Map(legacyProducts.map(row => [row.productId, row.bomComponents]));
  const demands: Demand[] = fba.map(row => ({
    productId: String(row.sku.productId), boxCode: row.box.boxCode,
    qty: row.status === 'pending_outbound' ? row.actualQty ?? row.requestedQty : row.requestedQty,
  }));
  for (const item of picking) {
    const plans = objects(item.pickingPlanSnapshot);
    let finished = 0;
    for (const plan of plans) {
      const qty = Math.max(0, Number(plan.pickQty) || 0);
      finished += qty;
      demands.push({ productId: item.productId, boxCode: String(plan.boxCode ?? '') || undefined, qty });
    }
    const assembly = Math.max(0, item.requestedQty - finished);
    const bom = Array.isArray(item.bomSnapshot) ? objects(item.bomSnapshot) : legacyBom.get(item.productId) ?? [];
    if (!bom.length && assembly > 0) demands.push({ productId: item.productId, qty: assembly });
    for (const part of bom) {
      demands.push({ productId: String(part.componentProductId), qty: Number(part.quantity) * assembly });
    }
  }
  return subtractReservations(rows, demands.filter(d => ids.includes(d.productId)));
}

export async function assertStockAvailable(
  tx: Prisma.TransactionClient, productId: string, boxId: bigint, qty: number,
  options: ReservationOptions = {},
): Promise<void> {
  const rows = await availableStock(tx, [productId], options);
  const available = rows.find(row => row.boxId === boxId)?.qty ?? 0;
  if (qty > available) throw new ConflictException(`产品 ${productId} 可用库存不足（已扣除 FBA、拣货及 BOM 预占），当前可用 ${available}`);
}
