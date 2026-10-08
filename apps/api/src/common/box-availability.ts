import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export function assertBoxUsable(box: { status: number; boxCode?: string } | null): void {
  if (!box) throw new NotFoundException('箱号不存在');
  const label = box.boxCode ? `箱号 ${box.boxCode} ` : '箱号';
  if (box.status === 2) throw new ConflictException(`${label}已锁定，不能用于业务操作，请先解锁`);
  if (box.status !== 1) throw new ConflictException(`${label}未启用，不能用于业务操作`);
}

export async function assertBoxUsableById(tx: Prisma.TransactionClient, boxId: bigint): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM boxes WHERE id = ${boxId} FOR UPDATE`);
  const box = await tx.box.findUnique({ where: { id: boxId }, select: { status: true, boxCode: true } });
  assertBoxUsable(box);
}

export async function assertBoxesUsableByIds(tx: Prisma.TransactionClient, boxIds: bigint[]): Promise<void> {
  const ids = [...new Set(boxIds)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM boxes WHERE id IN (${Prisma.join(batch)}) ORDER BY id FOR UPDATE`);
    const boxes = await tx.box.findMany({ where: { id: { in: batch } }, select: { id: true, status: true, boxCode: true } });
    if (boxes.length !== batch.length) throw new NotFoundException('存在未找到的箱号');
    boxes.forEach(assertBoxUsable);
  }
}
