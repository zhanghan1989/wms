import { BoxesService } from '../src/boxes/boxes.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { changeBoxStock } from '../src/inventory/stock-transaction';

describe('locked boxes', () => {
  it('keeps locked boxes visible in management but excludes them from options', async () => {
    const prisma: any = { box: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } };
    const service = new BoxesService(prisma, {} as any);
    await service.listManage();
    expect(prisma.box.findMany.mock.calls[0][0].where.status).toEqual({ in: [1, 2] });
    await service.listOptions();
    expect(prisma.box.findMany.mock.calls[1][0].where.status).toBe(1);
  });

  it.each([2, 1])('recalculates counted product stock when changing lock status to %s', async (status) => {
    const before = { id: 7n, boxCode: '007', shelfId: 1n, status: status === 2 ? 1 : 2 };
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      box: { findUnique: jest.fn().mockResolvedValue(before), update: jest.fn().mockResolvedValue({ ...before, status }) },
      itemCode: { findFirst: jest.fn().mockResolvedValue(null) },
      masterProductBoxInventory: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([{ productId: 'P1' }]), aggregate: jest.fn().mockResolvedValue({ _sum: { qty: status === 2 ? 3 : 8 } }) },
      masterProduct: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = { box: { findUnique: jest.fn().mockResolvedValue(before) }, $transaction: (work: any) => work(tx) };
    const audit: any = { create: jest.fn().mockResolvedValue({}) };
    await new BoxesService(prisma, audit).update('7', { status }, 1n);
    expect(tx.masterProductBoxInventory.aggregate).toHaveBeenCalledWith({ where: { productId: 'P1', box: { status: { not: 2 } } }, _sum: { qty: true } });
    expect(tx.masterProduct.update).toHaveBeenCalledWith({ where: { productId: 'P1' }, data: { stockQty: status === 2 ? 3 : 8 } });
    expect(audit.create).toHaveBeenCalled();
  });

  it('rejects stock changes in locked boxes', async () => {
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([]), box: { findUnique: jest.fn().mockResolvedValue({ status: 2 }) }, masterProductBoxInventory: { upsert: jest.fn() } };
    await expect(changeBoxStock(tx, 7n, 'P1', 2)).rejects.toThrow('箱号已锁定');
    expect(tx.masterProductBoxInventory.upsert).not.toHaveBeenCalled();
  });

  it('rejects equivalent-code lookup of a locked box', async () => {
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([]), box: { findFirst: jest.fn().mockResolvedValue({ id: 7n, boxCode: '007', status: 2 }) } };
    await expect(InventoryService.prototype.findBoxByEquivalentCode.call({} as any, tx, '007')).rejects.toThrow('箱号 007 已锁定');
  });

  it.each(['source', 'target'])('rejects moving products when the %s box is locked', async (lockedSide) => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      masterProduct: { findUnique: jest.fn().mockResolvedValue({ productId: 'P1' }) },
      box: { findUnique: jest.fn().mockImplementation(({ where }) => Promise.resolve({
        id: where.boxCode === '007' ? 7n : 8n, boxCode: where.boxCode,
        status: (where.boxCode === '007' ? 'source' : 'target') === lockedSide ? 2 : 1,
      })) },
      masterProductBoxInventory: { delete: jest.fn(), upsert: jest.fn() },
    };
    const context: any = { prisma: { $transaction: (work: any) => work(tx) } };
    await expect(InventoryService.prototype.moveProductBetweenBoxes.call(context,
      { productId: 'P1', fromBoxCode: '007', toBoxCode: '008' }, 1n)).rejects.toThrow('已锁定');
    expect(tx.masterProductBoxInventory.delete).not.toHaveBeenCalled();
    expect(tx.masterProductBoxInventory.upsert).not.toHaveBeenCalled();
  });

  it('rejects a stale move-to-shelf request after the box is locked', async () => {
    const before = { id: 7n, boxCode: '007', shelfId: 1n, status: 1 };
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([]), box: { findUnique: jest.fn().mockResolvedValue({ ...before, status: 2 }), update: jest.fn() }, masterProductBoxInventory: { findMany: jest.fn().mockResolvedValue([]) } };
    const prisma: any = { box: { findUnique: jest.fn().mockResolvedValue(before) },
      shelf: { findUnique: jest.fn().mockResolvedValue({ id: 1n }) }, $transaction: (work: any) => work(tx) };
    await expect(new BoxesService(prisma, {} as any).update('7', { shelfId: 1 }, 1n)).rejects.toThrow('已锁定');
    expect(tx.box.update).not.toHaveBeenCalled();
  });

  it('rejects even a zero stock change when the box is locked', async () => {
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([]), box: { findUnique: jest.fn().mockResolvedValue({ status: 2, boxCode: '007' }) } };
    await expect(changeBoxStock(tx, 7n, 'P1', 0)).rejects.toThrow('已锁定');
  });

  it.each(['product', 'itemCode'])('rejects locking a box with %s stock', async (kind) => {
    const box = { id: 7n, boxCode: '007', shelfId: 1n, status: 1 };
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      box: { findUnique: jest.fn().mockResolvedValue(box), update: jest.fn() },
      masterProductBoxInventory: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(kind === 'product' ? { id: 1n } : null) },
      itemCode: { findFirst: jest.fn().mockResolvedValue(kind === 'itemCode' ? { id: 1n } : null) },
    };
    const prisma: any = { box: { findUnique: jest.fn().mockResolvedValue(box) }, $transaction: (work: any) => work(tx) };
    await expect(new BoxesService(prisma, {} as any).update('7', { status: 2 }, 1n)).rejects.toThrow('只有空箱才能锁定');
    expect(tx.box.update).not.toHaveBeenCalled();
  });

  it('rejects a stale disable request when another request has locked the box', async () => {
    const before = { id: 7n, boxCode: '007', shelfId: 1n, status: 1 };
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      box: { findUnique: jest.fn().mockResolvedValue({ ...before, status: 2 }), update: jest.fn() },
      masterProductBoxInventory: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma: any = { box: { findUnique: jest.fn().mockResolvedValue(before) }, $transaction: (work: any) => work(tx) };
    await expect(new BoxesService(prisma, {} as any).update('7', { status: 0 }, 1n)).rejects.toThrow('请先解锁');
    expect(tx.box.update).not.toHaveBeenCalled();
  });

});
