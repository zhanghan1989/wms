import { OrdersService } from '../src/orders/orders.service';

describe('OrdersService', () => {
  it('treats confirming an already picked batch as an idempotent retry', async () => {
    const confirmedAt = new Date('2026-07-21T02:35:04.000Z');
    const prisma = {
      overseasPickingBatch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 42n,
          batchNo: 'PK-20260721-113504',
          status: 'picked',
          confirmedAt,
          items: [],
        }),
      },
      $transaction: jest.fn(),
    };
    const service = new OrdersService(prisma as any);

    await expect(service.confirmOverseasPickingBatch('42', { items: [] }, 7n)).resolves.toEqual({
      id: '42',
      batchNo: 'PK-20260721-113504',
      status: 'picked',
      confirmedAt: confirmedAt.toISOString(),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('records an item-level SP-API exclusion when one line is deleted', async () => {
    const selected = {
      id: 1n,
      orderId: '503-1',
      orderItemId: 'edited-item-id',
      rawPayload: { item: { orderItemId: 'amazon-item-id' } },
      spApiConnectionId: 3n,
    };
    const remaining = {
      id: 2n,
      orderId: '503-1',
      orderItemId: 'item-2',
      rawPayload: { item: { orderItemId: 'item-2' } },
      spApiConnectionId: 3n,
    };
    const tx = {
      amazonOrderSyncExclusion: {
        create: jest.fn().mockResolvedValue({ id: 1n }),
      },
      amazonOrderRecord: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      amazonOrderRecord: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{ id: 1n, orderId: '503-1', shipmentNo: null }])
          .mockResolvedValueOnce([selected])
          .mockResolvedValueOnce([selected, remaining]),
      },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    const service = new OrdersService(prisma as any);

    await expect(service.deleteAmazonBatch({ ids: ['1'] })).resolves.toEqual({ deletedCount: 1 });
    expect(tx.amazonOrderSyncExclusion.create).toHaveBeenCalledWith({
      data: {
        spApiConnectionId: 3n,
        orderId: '503-1',
        orderItemId: 'amazon-item-id',
        reason: 'user_delete',
        createdBy: null,
      },
    });
  });

  it('restores a deleted SP-API exclusion without losing its audit history', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new OrdersService({
      amazonOrderSyncExclusion: { updateMany },
    } as any);

    await expect(service.restoreAmazonSyncExclusions({ ids: ['9'] }, 7n)).resolves.toEqual({ restoredCount: 1 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: [9n] }, isActive: true },
      data: {
        isActive: false,
        restoredBy: 7n,
        restoredAt: expect.any(Date),
      },
    });
  });
});
