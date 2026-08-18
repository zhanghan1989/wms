import { OrdersService } from '../src/orders/orders.service';
import * as XLSX from 'xlsx';

describe('OrdersService', () => {
  it("blocks every line of a mixed Rakuten order until all China shipments clear customs", async () => {
    const registeredAt = new Date("2026-08-18T01:00:00.000Z");
    const rows = [
      {
        id: 1n,
        orderId: "MIXED-ORDER",
        dispatchMode: "overseas",
        shipmentNo: "JP-TRACKING",
        shipmentCompany: "Yamato",
        shipmentNoRegisteredAt: registeredAt,
        csvImportedAt: registeredAt,
        rawPayload: {},
      },
      {
        id: 2n,
        orderId: "MIXED-ORDER",
        dispatchMode: "china_pending",
        shipmentNo: "CN-TRACKING",
        shipmentCompany: "Xiya",
        shipmentNoRegisteredAt: registeredAt,
        csvImportedAt: registeredAt,
        rawPayload: {},
      },
      {
        id: 3n,
        orderId: "JAPAN-ONLY",
        dispatchMode: "overseas",
        shipmentNo: "JP-ONLY-TRACKING",
        shipmentCompany: "Yamato",
        shipmentNoRegisteredAt: registeredAt,
        csvImportedAt: registeredAt,
        rawPayload: {},
      },
    ];
    const prisma = {
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const service = new OrdersService(prisma as any);
    jest.spyOn(service as any, "loadRakutenShipmentReturnContext").mockResolvedValue({
      chinaDispatchOrderRecordIdsByOrderId: new Map([["MIXED-ORDER", new Set(["2"])]]),
      blockedOrderIds: new Set(["MIXED-ORDER"]),
    });

    const file = await service.buildRakutenShipmentConfirmationCsv({ days: "all" });

    expect(file.rowCount).toBe(1);
    expect(file.skippedWithoutCustomsClearanceCount).toBe(2);
  });

  it("derives the Rakuten shipment return gate from every product in the order", async () => {
    const baseTracking = {
      shipmentNo: "TRACKING",
      trackingStatusLabel: null,
      trackingIsDelivered: false,
      trackingStatusOccurredAt: null,
      trackingCheckedAt: null,
      trackingError: null,
      xiyaExportedAt: null,
      shipmentCompany: null,
    };
    const relatedRows = [
      {
        ...baseTracking,
        id: 1n,
        orderId: "MIXED-ORDER",
        dispatchMode: "overseas",
        fulfillmentMode: "overseas_warehouse",
        trackingHasCustomsClearance: false,
      },
      {
        ...baseTracking,
        id: 2n,
        orderId: "MIXED-ORDER",
        dispatchMode: "china_pending",
        fulfillmentMode: "xiya_api",
        trackingHasCustomsClearance: false,
      },
      {
        ...baseTracking,
        id: 3n,
        orderId: "CLEARED-CHINA-ORDER",
        dispatchMode: "china_pending",
        fulfillmentMode: "xiya_api",
        trackingHasCustomsClearance: true,
      },
    ];
    const prisma = {
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(relatedRows) },
    };
    const service = new OrdersService(prisma as any);
    jest.spyOn(service as any, "enrichOrderRows").mockResolvedValue(relatedRows);
    jest.spyOn(service as any, "loadActiveOverseasPickingBatchRefs").mockResolvedValue(new Set());

    const context = await (service as any).loadRakutenShipmentReturnContext([
      { orderId: "MIXED-ORDER" },
      { orderId: "CLEARED-CHINA-ORDER" },
    ]);

    expect(context.blockedOrderIds).toEqual(new Set(["MIXED-ORDER"]));
    expect(context.chinaDispatchOrderRecordIdsByOrderId.get("MIXED-ORDER")).toEqual(new Set(["2"]));
    expect(context.chinaDispatchOrderRecordIdsByOrderId.get("CLEARED-CHINA-ORDER")).toEqual(new Set(["3"]));
  });

  it("blocks shipment return for the whole Rakuten order while Japan must notify China", async () => {
    const relatedRows = [
      {
        id: 1n,
        orderId: "MANUAL-ACTION-ORDER",
        dispatchMode: "overseas",
        fulfillmentMode: "overseas_warehouse",
        rmsManualActionDetectedAt: new Date("2026-08-18T01:00:00.000Z"),
        rmsManualActionResolvedAt: null,
      },
      {
        id: 2n,
        orderId: "MANUAL-ACTION-ORDER",
        dispatchMode: "china_no_stock",
        fulfillmentMode: "xiya_api",
        rmsManualActionDetectedAt: null,
        rmsManualActionResolvedAt: null,
        trackingHasCustomsClearance: true,
      },
    ];
    const service = new OrdersService({
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(relatedRows) },
    } as any);
    jest.spyOn(service as any, "enrichOrderRows").mockResolvedValue(relatedRows);
    jest.spyOn(service as any, "loadActiveOverseasPickingBatchRefs").mockResolvedValue(new Set());

    const context = await (service as any).loadRakutenShipmentReturnContext([{ orderId: "MANUAL-ACTION-ORDER" }]);

    expect(context.blockedOrderIds).toContain("MANUAL-ACTION-ORDER");
  });

  it("resolves every pending Japan-to-China reminder for the same Rakuten order", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const service = new OrdersService({
      rakutenOrderRecord: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1n,
          orderId: "ORDER-1",
          rmsManualActionDetectedAt: new Date("2026-08-18T01:00:00.000Z"),
          rmsManualActionResolvedAt: null,
        }),
        updateMany,
      },
    } as any);

    const result = await service.resolveRakutenXiyaManualAction("1", "jp-operator");

    expect(result).toMatchObject({ orderId: "ORDER-1", resolvedCount: 2 });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        orderId: "ORDER-1",
        rmsManualActionDetectedAt: { not: null },
        rmsManualActionResolvedAt: null,
      },
      data: {
        rmsManualActionResolvedAt: expect.any(Date),
        rmsManualActionResolvedBy: "jp-operator",
      },
    });
  });

  it("marks every product row in a manually edited Rakuten order as operator-managed", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const service = new OrdersService({} as any);
    const manualOverrideAt = new Date("2026-08-18T02:00:00.000Z");

    await (service as any).freezeRelatedRakutenOrderRowsAfterManualEdit(
      { rakutenOrderRecord: { updateMany } },
      "ORDER-1",
      7n,
      manualOverrideAt,
      "jp-operator",
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { orderId: "ORDER-1", id: { not: 7n } },
      data: {
        rmsManualOverrideAt: manualOverrideAt,
        rmsManualOverrideBy: "jp-operator",
      },
    });
  });

  it("creates a permanent RMS item exclusion before deleting one Rakuten product row", async () => {
    const selected = {
      id: 1n,
      orderId: "ORDER-1",
      rmsConnectionId: 7n,
      rmsItemKey: "ORDER-1|ITEM-1",
      skuCode: "SKU-1",
      shopName: "乐天店",
      shipmentNo: null,
    };
    const remaining = {
      id: 2n,
      orderId: "ORDER-1",
      rmsConnectionId: 7n,
      rmsItemKey: "ORDER-1|ITEM-2",
      skuCode: "SKU-2",
      shopName: "乐天店",
      shipmentNo: null,
    };
    const exclusionCreate = jest.fn().mockResolvedValue({ id: 9n });
    const tx = {
      rakutenOrderSyncExclusion: { create: exclusionCreate },
      rakutenOrderRecord: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      rakutenOrderRecord: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 1n, orderId: "ORDER-1", shipmentNo: null }])
          .mockResolvedValueOnce([selected])
          .mockResolvedValueOnce([selected, remaining]),
      },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    const service = new OrdersService(prisma as any);

    await expect(service.deleteRakutenBatch({ ids: ["1"] }, 5n)).resolves.toEqual({ deletedCount: 1 });
    expect(exclusionCreate).toHaveBeenCalledWith({
      data: {
        rmsConnectionId: 7n,
        shopName: "乐天店",
        orderId: "ORDER-1",
        rmsItemKey: "ORDER-1|ITEM-1",
        skuCode: null,
        reason: "user_delete",
        createdBy: 5n,
      },
    });
    expect(tx.rakutenOrderRecord.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1n] } } });
  });

  it("creates an order-level exclusion when every Rakuten product row is deleted", async () => {
    const row = {
      id: 1n,
      orderId: "ORDER-ALL",
      shopName: "乐天店",
      rmsConnectionId: 7n,
      rmsItemKey: "ORDER-ALL|ITEM-1",
      skuCode: "SKU-1",
      shipmentNo: null,
    };
    const exclusionCreate = jest.fn().mockResolvedValue({ id: 10n });
    const tx = {
      rakutenOrderSyncExclusion: { create: exclusionCreate },
      rakutenOrderRecord: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new OrdersService({
      rakutenOrderRecord: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 1n, orderId: "ORDER-ALL", shipmentNo: null }])
          .mockResolvedValueOnce([row])
          .mockResolvedValueOnce([row]),
      },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback) => callback(tx)),
    } as any);

    await service.deleteRakutenBatch({ ids: ["1"] }, 5n);

    expect(exclusionCreate).toHaveBeenCalledWith({
      data: {
        rmsConnectionId: 7n,
        shopName: "乐天店",
        orderId: "ORDER-ALL",
        rmsItemKey: null,
        skuCode: null,
        reason: "user_delete",
        createdBy: 5n,
      },
    });
  });

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
