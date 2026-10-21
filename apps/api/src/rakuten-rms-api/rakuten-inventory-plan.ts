import { BadRequestException } from '@nestjs/common';
import { promisify, isDeepStrictEqual } from 'util';
import { gzip, gunzip } from 'zlib';
import { InventoryPlanRow } from './rakuten-inventory.types';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const FORMAT = 'gzip-chunks-v1';
const CHUNK_SIZE = 250;
type Chunk = { data: string; total: number; changed: number; zero: number };
type StoredPlan = { format: string; total: number; changed: number; zero: number; chunks: Chunk[] };
const changed = (row: InventoryPlanRow) => row.quantity !== row.currentQuantity;
const zero = (row: InventoryPlanRow) => row.currentQuantity > 0 && row.quantity === 0;

/** Small compressed strings keep Prisma from traversing tens of thousands of JSON objects. */
export async function encodeInventoryPlan(rows: InventoryPlanRow[], progress: (saved: number) => Promise<void> = async () => {}) {
  const plan: StoredPlan = { format: FORMAT, total: rows.length, changed: 0, zero: 0, chunks: [] };
  for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
    const batch = rows.slice(offset, offset + CHUNK_SIZE);
    const chunk = { data: (await compress(JSON.stringify(batch))).toString('base64'), total: batch.length,
      changed: batch.filter(changed).length, zero: batch.filter(zero).length };
    plan.chunks.push(chunk);
    plan.changed += chunk.changed;
    plan.zero += chunk.zero;
    if (offset % 2500 === 0 || offset + CHUNK_SIZE >= rows.length) await progress(Math.min(offset + CHUNK_SIZE, rows.length));
  }
  return plan;
}

function stored(value: unknown): StoredPlan {
  const plan = value as StoredPlan | null;
  if (!plan || plan.format !== FORMAT || !Array.isArray(plan.chunks)) throw new BadRequestException('库存预览格式无效，请重新预览');
  return plan;
}
async function readChunk(chunk: Chunk): Promise<InventoryPlanRow[]> {
  try {
    const rows = JSON.parse((await decompress(Buffer.from(chunk.data, 'base64'), { maxOutputLength: 8 * 1024 * 1024 })).toString());
    if (!Array.isArray(rows) || rows.length !== chunk.total) throw new Error('invalid chunk');
    return rows;
  } catch { throw new BadRequestException('库存预览明细损坏，请重新预览'); }
}

export async function decodeInventoryPlan(value: unknown): Promise<InventoryPlanRow[]> {
  if (Array.isArray(value)) return value as InventoryPlanRow[]; // Existing previews remain usable.
  const rows: InventoryPlanRow[] = [];
  for (const chunk of stored(value).chunks) rows.push(...await readChunk(chunk));
  return rows;
}

export async function inventoryPlanPage(value: unknown, page: number, filter: string) {
  const matches = (row: InventoryPlanRow) => filter === 'all' || filter === 'changed' && changed(row) || filter === 'zero' && zero(row);
  const start = (page - 1) * 50;
  if (Array.isArray(value)) {
    const plan = value as InventoryPlanRow[];
    let filteredTotal = 0, changedCount = 0, zeroedCount = 0;
    const rows: InventoryPlanRow[] = [];
    for (const row of plan) {
      if (changed(row)) changedCount++;
      if (zero(row)) zeroedCount++;
      if (matches(row)) {
        if (filteredTotal >= start && rows.length < 50) rows.push(row);
        filteredTotal++;
      }
    }
    return { total: plan.length, changedCount, zeroedCount, filteredTotal, rows };
  }
  const plan = stored(value);
  const count = (chunk: Chunk) => filter === 'changed' ? chunk.changed : filter === 'zero' ? chunk.zero : chunk.total;
  const filteredTotal = plan.chunks.reduce((sum, chunk) => sum + count(chunk), 0);
  const rows: InventoryPlanRow[] = [];
  let skipped = 0;
  for (const chunk of plan.chunks) {
    const size = count(chunk);
    if (skipped + size <= start) { skipped += size; continue; }
    if (rows.length === 50) break;
    for (const row of await readChunk(chunk)) if (matches(row)) {
      if (skipped >= start && rows.length < 50) rows.push(row);
      skipped++;
    }
  }
  return { total: plan.total, changedCount: plan.changed, zeroedCount: plan.zero, filteredTotal, rows };
}

/** Compare against one decompressed block at a time; never hold two full plans. */
export async function inventoryPlanEquals(value: unknown, rows: InventoryPlanRow[]): Promise<boolean> {
  if (Array.isArray(value)) return isDeepStrictEqual(value, rows);
  const plan = stored(value);
  if (plan.total !== rows.length) return false;
  let offset = 0;
  for (const chunk of plan.chunks) {
    const batch = await readChunk(chunk);
    if (!isDeepStrictEqual(batch, rows.slice(offset, offset + batch.length))) return false;
    offset += batch.length;
  }
  return offset === rows.length;
}
