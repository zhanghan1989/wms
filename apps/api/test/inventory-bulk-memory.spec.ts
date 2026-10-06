import * as XLSX from 'xlsx';
import { InventoryService } from '../src/inventory/inventory.service';

function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({ boxCode: '001', productId: `P${i}`, qty: 2 }));
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    masterProduct: { findMany: jest.fn().mockResolvedValue(rows.map((row, i) => ({ id: BigInt(i + 1), productId: row.productId, productName: row.productId, stockQty: 1 }))) },
    box: { findMany: jest.fn().mockResolvedValue([{ id: 1n, boxCode: '001', status: 1, shelf: { status: 1 } }]) },
    masterProductBoxInventory: {
      findMany: jest.fn(async (args: any) => args.where.OR.map((pair: any) => ({ ...pair, qty: 1 }))),
      upsert: jest.fn().mockResolvedValue({}),
    },
    inventoryAdjustOrder: { create: jest.fn().mockResolvedValue({ id: 1n, adjustNo: 'ADJ-TEST' }) },
    inventoryAdjustOrderItem: { create: jest.fn().mockResolvedValue({}) },
    stockMovement: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn(async (work: any) => work(tx)) };
  const audit = { createMany: jest.fn().mockResolvedValue(undefined) };
  const service = new InventoryService(prisma as never, audit as never);
  jest.spyOn(service, 'parseBulkInventoryUpdateRows').mockReturnValue(rows.map(row => ({ ...row, sku: row.productId })));
  jest.spyOn(service, 'recalculateMasterProductStockQtyMap').mockResolvedValue(new Map(rows.map(row => [row.productId, row.qty])));
  return { service, prisma, tx, audit };
}

describe('bulk inventory bounded memory', () => {
  it('preserves every change and both audits while batching queries and audit payloads in one transaction', async () => {
    const { service, prisma, tx, audit } = fixture(501);
    const result = await service.importBulkUpdateExcel(Buffer.alloc(0), 'stock.xlsx', 7n, 'request');
    expect(result).toMatchObject({ totalRows: 501, changedRows: 501, changedProductCount: 501 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.masterProductBoxInventory.findMany.mock.calls.map(([args]) => args.where.OR.length)).toEqual([500, 1]);
    expect(tx.masterProductBoxInventory.upsert).toHaveBeenCalledTimes(501);
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(501);
    const batches = audit.createMany.mock.calls.map(([payloads]) => payloads);
    expect(batches.map(batch => batch.length)).toEqual([500, 500, 2]);
    const logs = batches.flat();
    expect(logs).toHaveLength(1002);
    expect(logs.every(log => log.db === tx && log.operatorId === 7n && log.requestId === 'request')).toBe(true);
    expect(logs.filter(log => log.entityType === 'master_product')).toHaveLength(501);
    expect(logs.at(-1).afterData).toMatchObject({ productId: 'P500', stockQty: 2, qtyDelta: 1 });
  });

  it('propagates an audit batch failure through the enclosing transaction and stops further batches', async () => {
    const { service, prisma, audit } = fixture(501);
    audit.createMany.mockRejectedValueOnce(new Error('audit failed'));
    await expect(service.importBulkUpdateExcel(Buffer.alloc(0), 'stock.xlsx', 7n)).rejects.toThrow('audit failed');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.createMany).toHaveBeenCalledTimes(1);
  });

  it('reads the first worksheet without parsing unrelated worksheet cells', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['箱号', '产品ID', '数量'], ['001', 'P1', 5]]), '库存');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['irrelevant'], ['ignored']]), '其他');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const service = new InventoryService({} as never, {} as never);
    expect(service.parseBulkInventoryUpdateRows(buffer)).toEqual([{ boxCode: '001', productId: 'P1', sku: 'P1', qty: 5 }]);
    const firstOnly = XLSX.read(buffer, { type: 'buffer', sheets: 0 });
    expect(firstOnly.Sheets['其他']).toBeUndefined();
  });
});
