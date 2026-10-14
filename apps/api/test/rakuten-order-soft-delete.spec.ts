import { OrdersService } from '../src/orders/orders.service';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';
import { orderBlockReason } from '../src/rakuten-rms-api/rakuten-order-workflow';

const row = (id: bigint, extra: object = {}) => ({ id, orderId: 'ORDER', rmsConnectionId: 7n, rmsOrderId: null, shopName: '店铺', deletedAt: null,
  rmsItemKey: `ITEM-${id}`, shipmentNo: 'REGISTERED', ...extra });
function cancellation(rows = [row(1n), row(2n)], selected = rows) {
  const updateMany = jest.fn().mockResolvedValue({ count: rows.length });
  const tx = { rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows), updateMany, deleteMany: jest.fn() },
    rakutenRmsConnection: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    rakutenOrderSyncExclusion: { create: jest.fn().mockResolvedValue({}) },
    rakutenOrderMail: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    rakutenOrderShippingReport: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) } };
  const prisma = { rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(selected) },
    $transaction: jest.fn(async (callback: any) => callback(tx)) };
  return { service: new OrdersService(prisma as any), tx, prisma };
}

describe('Rakuten order cancellation by human-confirmed logical deletion', () => {
  it('expands a component selection to its whole order, retains rows and records who deleted them', async () => {
    const { service, tx } = cancellation();
    expect(await service.deleteRakutenBatch({ ids: ['1', '2'] }, 9n)).toMatchObject({ deletedCount: 2 });
    expect(tx.rakutenOrderRecord.updateMany).toHaveBeenCalledWith({ where: { id: { in: [1n, 2n] }, deletedAt: null },
      data: { deletedAt: expect.any(Date), deletedBy: 9n } });
    expect(tx.rakutenOrderRecord.deleteMany).not.toHaveBeenCalled();
    expect(tx.rakutenOrderSyncExclusion.create).toHaveBeenCalledWith({ data: {
      orderId: 'ORDER', rmsConnectionId: 7n, shopName: '店铺', rmsItemKey: null, skuCode: null,
      reason: 'user_delete', createdBy: 9n,
    } });
    expect(tx.rakutenOrderMail.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { connectionId: 7n, orderId: 'ORDER', status: { in: ['pending', 'failed', 'dead_letter'] } },
      data: expect.objectContaining({ status: 'cancelled', failureCategory: 'order_deleted', nextAttemptAt: null }),
    }));
    expect(tx.rakutenOrderShippingReport.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'skipped', failureCategory: 'order_deleted' }),
    }));
  });
  it('scopes cancellation to the selected shop and connection, preserving completed and uncertain history', async () => {
    const { service, tx } = cancellation();
    await service.deleteRakutenBatch({ ids: ['1', '2'] }, 9n);
    expect(tx.rakutenOrderRecord.findMany).toHaveBeenCalledWith({ where: {
      deletedAt: null, OR: [{ rmsConnectionId: 7n, OR: [{ rmsOrderId: 'ORDER' }, { rmsOrderId: null, orderId: 'ORDER' }] }, { id: { in: [] } }],
    } });
    for (const update of [tx.rakutenOrderMail.updateMany, tx.rakutenOrderShippingReport.updateMany]) {
      const statuses = update.mock.calls[0][0].where.status.in;
      expect(statuses).not.toContain('sent'); expect(statuses).not.toContain('uncertain');
    }
  });
  it('serializes deletion with the outbound connection lock and releases only its own token', async () => {
    const { service, tx } = cancellation();
    await service.deleteRakutenBatch({ ids: ['1', '2'] }, 9n);
    const [acquire, release] = tx.rakutenRmsConnection.updateMany.mock.calls.map((call) => call[0]);
    expect(acquire.where).toMatchObject({ id: 7n, OR: expect.any(Array) });
    expect(release).toEqual({ where: { id: 7n, automationLockToken: acquire.data.automationLockToken }, data: { automationLockToken: null, automationLockedAt: null } });
    expect(tx.rakutenRmsConnection.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.rakutenOrderRecord.updateMany.mock.invocationCallOrder[0]);
  });
  it('rejects deletion during an in-flight external send without modifying records', async () => {
    const { service, tx } = cancellation();
    tx.rakutenRmsConnection.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.deleteRakutenBatch({ ids: ['1', '2'] }, 9n)).rejects.toThrow('正在执行');
    expect(tx.rakutenOrderRecord.updateMany).not.toHaveBeenCalled();
    expect(tx.rakutenOrderMail.updateMany).not.toHaveBeenCalled();
  });
  it('rejects cancellation of an order still linked to a picking batch', async () => {
    const { service, tx } = cancellation();
    tx.overseasPickingBatchItem.findFirst.mockResolvedValue({ id: 1n } as any);
    await expect(service.deleteRakutenBatch({ ids: ['1', '2'] }, 9n)).rejects.toThrow('拣货批次');
    expect(tx.rakutenOrderRecord.updateMany).not.toHaveBeenCalled();
  });
  it('supports CSV orders while recording an order-level exclusion', async () => {
    const { service, tx } = cancellation([row(1n, { rmsConnectionId: null })]);
    await service.deleteRakutenBatch({ ids: ['1', '2'] }, 9n);
    expect(tx.rakutenRmsConnection.updateMany).not.toHaveBeenCalled();
    expect(tx.rakutenOrderSyncExclusion.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rmsConnectionId: null, rmsItemKey: null, skuCode: null }) }));
  });
  it('makes repeated cancellation a no-op', async () => {
    const { service, prisma } = cancellation([], []);
    expect(await service.deleteRakutenBatch({ ids: ['1', '2'] }, 9n)).toMatchObject({ deletedCount: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('excludes deleted orders from normal lists and logistics queries', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new OrdersService({ rakutenOrderRecord: { findMany } } as any);
    await service.list();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null } }));
    expect(orderBlockReason([row(1n, { deletedAt: new Date() }) as any])).toContain('流程已终止');
  });
  it('prevents a human retry from resurrecting cancelled mail', async () => {
    const updateMany = jest.fn();
    const service = new RakutenRmsAutomationService({
      rakutenOrderMail: { findUnique: jest.fn().mockResolvedValue({ id: 1n, connectionId: 7n, orderId: 'ORDER', status: 'cancelled' }), updateMany },
      rakutenOrderRecord: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any, {} as any, {} as any);
    await expect(service.retryMail('1', 9n)).rejects.toThrow('不能恢复');
    expect(updateMany).not.toHaveBeenCalled();
  });
  it('prevents a connection-management mail retry from resurrecting a deleted order', async () => {
    const updateMany = jest.fn();
    const service = new RakutenRmsAutomationService({
      rakutenOrderMail: { findUnique: jest.fn().mockResolvedValue({ id: 1n, connectionId: 7n, orderId: 'ORDER', status: 'dead_letter' }), updateMany },
      rakutenOrderRecord: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any, {} as any, {} as any);
    await expect(service.retryJob('7', { kind: 'mail', id: '1' }, 9n)).rejects.toThrow('不能恢复');
    expect(updateMany).not.toHaveBeenCalled();
  });
});
