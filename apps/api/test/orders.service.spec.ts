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
});
