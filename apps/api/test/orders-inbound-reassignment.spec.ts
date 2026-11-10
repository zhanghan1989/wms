import { OrdersService } from '../src/orders/orders.service';
import { BatchInboundService } from '../src/batch-inbound/batch-inbound.service';
import { availableStock } from '../src/inventory/stock-availability';

jest.mock('../src/inventory/stock-availability', () => ({ availableStock: jest.fn() }));

function setup(quantities = [2, 2, 1], stock = 3, pending = 0) {
  const rows = quantities.map((orderQuantity, i) => ({
    id: BigInt(i + 1), companyId: 1n, skuCode: 'P1', setComponentSkuCode: null,
    dispatchMode: 'china_no_stock', orderQuantity, orderRemark: '[配送日時指定:]', rawPayload: null,
  }));
  const tx: any = {
    rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    overseasPickingBatchItem: { findMany: jest.fn().mockResolvedValue([]) },
    operationAuditLog: { create: jest.fn() },
  };
  const service = new OrdersService(tx);
  jest.spyOn(service, 'inventorySyncPendingDemands').mockResolvedValue([{ productId: 'P1', quantity: pending }]);
  (availableStock as jest.Mock).mockResolvedValue([{ productId: 'P1', qty: stock }]);
  return { rows, tx, service, run: () => service.reassignUnpulledChinaOrdersAfterInbound(tx, ['P1'], 7n, 'receipt') };
}

describe('receipt reassigns unclaimed China orders using finished stock', () => {
  it('allocates oldest first without splitting a line or promising the same stock twice', async () => {
    const { tx, run } = setup();
    expect(await run()).toBe(2);
    expect(tx.rakutenOrderRecord.updateMany.mock.calls.map(([arg]: any[]) => arg.where.id)).toEqual([1n, 3n]);
    expect(tx.rakutenOrderRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      where: expect.objectContaining({ xiyaPulledAt: null, xiyaExportedAt: null, deletedAt: null,
        warehouseShippedAt: null, sendStatus: 'unsent', OR: [{ shipmentNo: null }, { shipmentNo: '' }] }),
    }));
    expect(tx.operationAuditLog.create).toHaveBeenCalledTimes(2);
  });

  it('preserves stock for existing unbatched Japan orders after picking/FBA reservations', async () => {
    const { tx, service, run } = setup([2, 1], 4, 3);
    expect(await run()).toBe(1);
    expect(service.inventorySyncPendingDemands).toHaveBeenCalledWith(tx, ['P1']);
    expect(tx.rakutenOrderRecord.updateMany.mock.calls[0][0].where.id).toBe(2n);
  });

  it('keeps all lines in China when no stock remains', async () => {
    const { tx, run } = setup([1, 2], 2, 3);
    expect(await run()).toBe(0);
    expect(tx.rakutenOrderRecord.updateMany).not.toHaveBeenCalled();
  });

  it('does not consume stock when a concurrent Xiya claim wins', async () => {
    const { tx, run } = setup([2, 2], 2);
    tx.rakutenOrderRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await run()).toBe(1);
    expect(tx.rakutenOrderRecord.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.rakutenOrderRecord.updateMany.mock.calls[0][0].where).toMatchObject({
      xiyaPulledAt: null, xiyaExportedAt: null, dispatchMode: 'china_no_stock',
      orderQuantity: 2, skuCode: 'P1', rawPayload: { equals: expect.anything() },
    });
    expect(tx.operationAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('skips remarks awaiting review, existing batches and invalid quantities', async () => {
    const { rows, tx, run } = setup([1, 1, 0, -1, 1.5, 1], 10);
    rows[0].orderRemark = 'review';
    tx.overseasPickingBatchItem.findMany.mockResolvedValue([{ sourceRecordId: 2n }]);
    expect(await run()).toBe(1);
    expect(tx.rakutenOrderRecord.updateMany.mock.calls[0][0].where.id).toBe(6n);
  });

  it('does no work for a zero receipt', async () => {
    const { tx, service } = setup();
    expect(await service.reassignUnpulledChinaOrdersAfterInbound(tx, [], 7n)).toBe(0);
    expect(tx.rakutenOrderRecord.findMany).not.toHaveBeenCalled();
  });

  it('ignores unrelated component codes when a primary product code exists', async () => {
    const { rows, tx, run } = setup([1], 10);
    rows[0].skuCode = 'OTHER'; rows[0].setComponentSkuCode = 'P1' as any;
    expect(await run()).toBe(0);
    expect(tx.rakutenOrderRecord.updateMany).not.toHaveBeenCalled();
  });
});

describe('batch receipt hooks', () => {
  it.each(['confirmItem', 'confirmBox', 'confirmAll'] as const)('%s rechecks only positive, newly received products', async method => {
    const item = { id: 2n, productId: 'P1', qty: 3, status: 'pending' };
    const tx: any = { batchInboundItem: { findFirst: jest.fn().mockResolvedValue(item),
      findMany: jest.fn().mockResolvedValue([item, { ...item, id: 3n, productId: 'P2', qty: 0 }]) } };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const orders: any = { reassignUnpulledChinaOrdersAfterInbound: jest.fn().mockResolvedValue(2) };
    const service: any = new BatchInboundService(prisma, {} as any, orders);
    jest.spyOn(service, 'lockOrder').mockResolvedValue({ id: 1n, orderNo: 'IN-1' });
    jest.spyOn(service, 'applyItemConfirm').mockResolvedValue(undefined);
    jest.spyOn(service, 'syncOrderStatus').mockResolvedValue('confirmed');
    jest.spyOn(service, 'loadOrderDetailInTx').mockResolvedValue({ status: 'confirmed' });
    const result = method === 'confirmAll' ? await service[method]('1', 7n, 'receipt')
      : await service[method]('1', method === 'confirmItem' ? '2' : '001', 7n, 'receipt');
    expect(result.switchedToJapanCount).toBe(2);
    if (method === 'confirmBox') {
      expect(tx.batchInboundItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { orderId: 1n, boxCode: { in: ['0001', '001', '1'] }, status: 'pending' },
      }));
    }
    expect(orders.reassignUnpulledChinaOrdersAfterInbound).toHaveBeenCalledWith(tx, ['P1'], 7n, 'receipt');
    if (method === 'confirmItem') {
      tx.batchInboundItem.findFirst.mockResolvedValue({ ...item, status: 'confirmed' });
    } else tx.batchInboundItem.findMany.mockResolvedValue([]);
    expect((method === 'confirmAll' ? await service[method]('1', 7n)
      : await service[method]('1', method === 'confirmItem' ? '2' : '001', 7n)).idempotent).toBe(true);
    expect(orders.reassignUnpulledChinaOrdersAfterInbound).toHaveBeenCalledTimes(1);
  });
});
