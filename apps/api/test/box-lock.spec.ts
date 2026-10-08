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
      box: { update: jest.fn().mockResolvedValue({ ...before, status }) },
      masterProductBoxInventory: { findMany: jest.fn().mockResolvedValue([{ productId: 'P1' }]), aggregate: jest.fn().mockResolvedValue({ _sum: { qty: status === 2 ? 3 : 8 } }) },
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
    const tx: any = { box: { findUnique: jest.fn().mockResolvedValue({ status: 2 }) }, masterProductBoxInventory: { upsert: jest.fn() } };
    await expect(changeBoxStock(tx, 7n, 'P1', 2)).rejects.toThrow('箱号已锁定');
    expect(tx.masterProductBoxInventory.upsert).not.toHaveBeenCalled();
  });

  it('rejects equivalent-code lookup of a locked box', async () => {
    const tx: any = { box: { findFirst: jest.fn().mockResolvedValue({ id: 7n, boxCode: '007', status: 2 }) } };
    await expect(InventoryService.prototype.findBoxByEquivalentCode.call({} as any, tx, '007')).rejects.toThrow('箱号 007 已锁定');
  });
});
