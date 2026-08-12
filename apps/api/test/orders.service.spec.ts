import { OrdersService } from '../src/orders/orders.service';
import * as XLSX from 'xlsx';

describe('OrdersService', () => {
  it('includes processed overseas orders in an all-order download query', async () => {
    const processedOrder = {
      id: 1n,
      dispatchMode: 'overseas',
      sendStatus: 'sent',
      shipmentNo: 'TRACK-1',
      csvImportedAt: new Date('2026-08-10T00:00:00.000Z'),
      createdAt: new Date('2026-08-10T00:00:00.000Z'),
      orderId: 'ORDER-DONE',
      skuCode: 'P-1',
      setComponentSkuCode: null,
      orderQuantity: 1,
      productName: '已处理产品',
      shopName: '一号店',
      shippingName: '测试用户',
    };
    const rakutenFindMany = jest.fn().mockResolvedValue([processedOrder]);
    const prisma = {
      rakutenOrderRecord: { findMany: rakutenFindMany },
      amazonOrderRecord: { findMany: jest.fn().mockResolvedValue([]) },
      manualOrderRecord: { findMany: jest.fn().mockResolvedValue([]) },
      masterProduct: {
        findMany: jest.fn().mockResolvedValue([{ productId: 'P-1', productName: '已处理产品', stockQty: 0 }]),
      },
    };
    const service = new OrdersService(prisma as any);

    const rows = await service.listOverseasWarehouse(undefined, true);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orderId).toBe('ORDER-DONE');
    expect(rakutenFindMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('sendStatus');
  });

  it('exports every overseas order returned by the unbounded order query', async () => {
    const service = new OrdersService({} as any);
    const listSpy = jest.spyOn(service, 'listOverseasWarehouse').mockResolvedValue([
      {
        source: 'rakuten',
        sourceLabel: '乐天',
        csvImportedAt: new Date('2026-08-12T01:02:03.000Z'),
        createdAt: new Date('2026-08-12T01:02:03.000Z'),
        orderId: 'ORDER-1',
        skuCode: 'SKU-1',
        resolvedProductId: 'P-1',
        resolvedProductName: '产品一',
        orderQuantity: 2,
        shopName: '一号店',
        shippingName: '测试用户',
        availableStock: 9,
      },
    ]);

    const file = await service.buildOrderProcessingExport('overseas');
    const workbook = XLSX.read(file.content, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<Array<string | number>>(workbook.Sheets['海外仓订单处理一览'], {
      header: 1,
    });

    expect(listSpy).toHaveBeenCalledWith(undefined, true);
    expect(rows[1]).toEqual(expect.arrayContaining(['乐天', 'ORDER-1', 'SKU-1', 'P-1', '产品一', 2]));
  });

  it('exports pending and registered China orders through the all-order query', async () => {
    const service = new OrdersService({} as any);
    const listSpy = jest.spyOn(service, 'listChinaOrderProcessing').mockResolvedValue([]);

    const file = await service.buildOrderProcessingExport('china');

    expect(listSpy).toHaveBeenCalledWith(undefined, 'all', undefined, true);
    expect(file.fileName).toMatch(/^中国订单处理一览_\d{8}_\d{6}\.xlsx$/);
  });

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
