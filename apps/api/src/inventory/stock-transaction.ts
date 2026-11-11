import { assertBoxUsableById } from '../common/box-availability';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { companyContext } from '../company-scope/company-context';
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

// The caller holds the box row lock. The company on a box tracks its stock
// for existing queries and relations; the warehouse can reuse an empty box.
export async function assignBoxStockCompany(
  tx: Prisma.TransactionClient, boxId: bigint, companyId: bigint,
): Promise<void> {
  const scope = companyContext.getStore();
  if (!scope?.warehouse) return;
  const box = await tx.box.findUniqueOrThrow({ where: { id: boxId }, select: { boxCode: true, companyId: true } });
  if (box.companyId === companyId) return;

  const [stock, itemCode, fba] = await Promise.all([
    tx.masterProductBoxInventory.findFirst({ where: { boxId, qty: { not: 0 }, companyId: { not: companyId } }, select: { id: true } }),
    tx.itemCode.findFirst({ where: { boxId, status: { in: ['in_stock', 'frozen'] }, companyId: { not: companyId } }, select: { id: true } }),
    tx.fbaReplenishment.findFirst({ where: { boxId, status: { in: ['pending_confirm', 'pending_outbound'] }, companyId: { not: companyId } }, select: { id: true } }),
  ]);
  if (stock || itemCode || fba) {
    throw new ConflictException(`箱号 ${box.boxCode} 仍有其他公司的库存或补货占用，请选择空箱或同公司商品所在的箱号`);
  }
  await companyContext.run({ ...scope, bypass: true },
    async () => tx.box.update({ where: { id: boxId }, data: { companyId }, select: { id: true } }));
}

export async function changeBoxStock(
  tx: Prisma.TransactionClient, boxId: bigint, productId: string, delta: number,
): Promise<void> {
  if (!Number.isSafeInteger(delta)) throw new ConflictException('库存变更数量必须是整数');
  await assertBoxUsableById(tx, boxId);
  if (delta === 0) return;
  if (delta > 0) {
    if (companyContext.getStore()?.warehouse) {
      const product = await tx.masterProduct.findUnique({ where: { productId }, select: { companyId: true } });
      if (!product) throw new NotFoundException('未找到产品主表信息');
      await assignBoxStockCompany(tx, boxId, product.companyId);
    }
    await tx.masterProductBoxInventory.upsert({
      where: { boxId_productId: { boxId, productId } },
      create: { boxId, productId, qty: delta },
      update: { qty: { increment: delta } },
    });
  } else {
    const result = await tx.masterProductBoxInventory.updateMany({
      where: { boxId, productId, qty: { gte: -delta }, box: { status: 1 } },
      data: { qty: { decrement: -delta } },
    });
    if (result.count !== 1) throw new ConflictException(`产品 ${productId} 库存不足或已变化，请刷新后重试`);
  }
}
