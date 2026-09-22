import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Callbacks must contain database work only: a deadlock rolls back and retries the whole unit.
export async function stockTransaction<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, {
        maxWait: 10000, timeout: 60000, ...options,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      });
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError)
        || error.code !== 'P2034') throw error;
    }
  }
}

// All stock writers and reservation creators lock products BEFORE reading balances/reservations.
export async function lockStockProducts(tx: Prisma.TransactionClient, productIds: string[]): Promise<void> {
  const ids = [...new Set(productIds.filter(Boolean))].sort();
  if (!ids.length) return;
  await tx.$queryRaw(Prisma.sql`SELECT product_id FROM master_products
    WHERE product_id IN (${Prisma.join(ids)}) ORDER BY product_id FOR UPDATE`);
}

export async function lockFbaRequests(tx: Prisma.TransactionClient, ids: bigint[]): Promise<void> {
  const sorted = [...new Set(ids)].sort((a, b) => a < b ? -1 : 1);
  if (!sorted.length) return;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM fba_replenishments
    WHERE id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`);
}

export async function changeBoxStock(
  tx: Prisma.TransactionClient, boxId: bigint, productId: string, delta: number,
): Promise<void> {
  if (!Number.isSafeInteger(delta)) throw new ConflictException('库存变更数量必须是整数');
  if (delta === 0) return;
  if (delta > 0) {
    await tx.masterProductBoxInventory.upsert({
      where: { boxId_productId: { boxId, productId } },
      create: { boxId, productId, qty: delta },
      update: { qty: { increment: delta } },
    });
  } else {
    const result = await tx.masterProductBoxInventory.updateMany({
      where: { boxId, productId, qty: { gte: -delta } },
      data: { qty: { decrement: -delta } },
    });
    if (result.count !== 1) throw new ConflictException(`产品 ${productId} 库存不足或已变化，请刷新后重试`);
  }
}
