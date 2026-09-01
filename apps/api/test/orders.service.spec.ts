import { OrdersService } from '../src/orders/orders.service';
import * as XLSX from 'xlsx';
import * as iconv from 'iconv-lite';

describe('OrdersService', () => {
  it("includes China shipment detail labels in the Rakuten daily email CSV without applying the customs gate", async () => {
    const importedAt = new Date();
    const rows = [
      {
        id: 1n,
        orderId: "MIXED-ORDER",
        dispatchMode: "overseas",
        shipmentNo: null,
        shipmentCompany: null,
        shipmentNoRegisteredAt: null,
        csvImportedAt: importedAt,
        rawPayload: {},
        rmsManualActionDetectedAt: null,
        rmsManualActionResolvedAt: null,
      },
      {
        id: 2n,
        orderId: "MIXED-ORDER",
        dispatchMode: "china_pending",
        shipmentNo: null,
        shipmentCompany: null,
        shipmentNoRegisteredAt: null,
        csvImportedAt: importedAt,
        rawPayload: {},
        rmsManualActionDetectedAt: null,
        rmsManualActionResolvedAt: null,
      },
    ];
    const service = new OrdersService({
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
    } as any);
    jest.spyOn(service as any, "loadRakutenShipmentReturnContext").mockResolvedValue({
      chinaDispatchOrderRecordIdsByOrderId: new Map([["MIXED-ORDER", new Set(["2"])]]),
      blockedOrderIds: new Set(["MIXED-ORDER"]),
    });

    const file = await service.buildRakutenShipmentConfirmationCsv({ days: 1, purpose: "daily-email" });
    const csv = iconv.decode(file.content, "cp932");

    expect(file.rowCount).toBe(2);
    expect(csv).toContain('"MIXED-ORDER","","中国発あり"');
    expect(csv).toContain('"MIXED-ORDER","","中国発"');
  });

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
        findMany: jest.fn().mockResolvedValue([{
          productId: 'P-1', productName: '已处理产品', productType: '普通产品', stockQty: 0,
        }]),
      },
    };
    const service = new OrdersService(prisma as any);

    const rows = await service.listOverseasWarehouse(undefined, true);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orderId).toBe('ORDER-DONE');
    expect(rows[0]?.assemblableStockApplicable).toBe(false);
    expect(rakutenFindMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('sendStatus');
  });

  it('marks assemblable stock as applicable only to shoulder strap products', async () => {
    const service = new OrdersService({
      masterProduct: {
        findMany: jest.fn().mockResolvedValue([
          {
            productId: 'STRAP-1',
            productName: '肩带一',
            productType: '肩带',
            stockQty: 0,
            bomComponents: [],
          },
          {
            productId: 'NORMAL-1',
            productName: '普通产品一',
            productType: '普通产品',
            stockQty: 3,
            bomComponents: [],
          },
        ]),
      },
    } as any);

    const availability = await (service as any).loadProductStockAvailability(['STRAP-1', 'NORMAL-1']);

    expect(availability.get('STRAP-1')).toMatchObject({
      assemblableStock: 0,
      assemblableStockApplicable: true,
    });
    expect(availability.get('NORMAL-1')).toMatchObject({
      assemblableStock: 0,
      assemblableStockApplicable: false,
    });
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

  it('deducts shoulder strap parts when a picked order has no finished stock', async () => {
    const confirmedAt = new Date('2026-08-28T10:00:00.000Z');
    const batch = {
      id: 42n,
      batchNo: 'PK-42',
      status: 'created',
      confirmedAt: null,
      items: [{
        id: 1n,
        productId: 'STRAP-1',
        requestedQty: 2,
        actualQty: 2,
        dispatchMode: 'overseas',
        bomSnapshot: [{
          componentProductId: 'BODY-7', componentProductName: '肩带本体', quantity: 3,
        }],
      }],
    };
    const boxUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const stockMovementCreate = jest.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      masterProductBoxInventory: {
        findMany: jest.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ boxId: 7n, productId: 'BODY-7', qty: 10 }]),
        updateMany: boxUpdate,
        aggregate: jest.fn().mockResolvedValue({ _sum: { qty: 0 } }),
      },
      masterProduct: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{
            productId: 'STRAP-1', productType: '肩带', bomComponents: [],
          }])
          .mockResolvedValueOnce([{
            productId: 'BODY-7', productName: '肩带本体', productType: '肩带本体', stockQty: 10, status: 1,
          }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      stockMovement: { create: stockMovementCreate },
      overseasPickingBatch: {
        findUnique: jest.fn().mockResolvedValue({ status: 'created' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      overseasPickingBatch: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(batch)
          .mockResolvedValueOnce({ id: 42n, batchNo: 'PK-42', status: 'picked', confirmedAt }),
      },
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    };
    const service = new OrdersService(prisma as any);

    await service.confirmOverseasPickingBatch('42', { items: [] }, 9n);

    expect(boxUpdate).toHaveBeenCalledWith({
      where: { boxId: 7n, productId: 'BODY-7', qty: { gte: 6 } },
      data: { qty: { decrement: 6 } },
    });
    expect(stockMovementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: 'BODY-7', qtyDelta: -6, boxId: 7n }),
    });
  });

  it('uses finished stock first and parts only for the remaining shoulder strap quantity', async () => {
    const confirmedAt = new Date('2026-08-28T10:00:00.000Z');
    const batch = {
      id: 43n,
      batchNo: 'PK-43',
      status: 'created',
      confirmedAt: null,
      items: [{
        id: 2n,
        productId: 'STRAP-2',
        requestedQty: 2,
        actualQty: 2,
        dispatchMode: 'overseas',
        pickingPlanSnapshot: [{ shelfCode: 'S1', boxCode: 'B1', boxQty: 2, pickQty: 1 }],
        pickingRequirementSnapshot: [
          {
            productId: 'STRAP-2', productName: '成品肩带', productType: '肩带',
            requestedQty: 1, pickedQty: 1,
          },
          {
            productId: 'BODY-8', productName: '肩带布', productType: '肩带本体',
            requestedQty: 2, pickedQty: 2,
          },
        ],
      }],
    };
    const boxUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const stockMovementCreate = jest.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      masterProductBoxInventory: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{ boxId: 4n, productId: 'STRAP-2', qty: 2 }])
          .mockResolvedValueOnce([{ boxId: 8n, productId: 'BODY-8', qty: 12 }]),
        updateMany: boxUpdate,
        aggregate: jest.fn().mockResolvedValue({ _sum: { qty: 0 } }),
      },
      masterProduct: {
        findMany: jest.fn().mockResolvedValue([{
          productId: 'STRAP-2',
          productType: '肩带',
          bomComponents: [{
            componentProductId: 'BODY-8',
            quantity: 2,
            componentProduct: {
              productId: 'BODY-8', productName: '肩带布', productType: '肩带本体', stockQty: 12, status: 1,
            },
          }],
        }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      stockMovement: { create: stockMovementCreate },
      overseasPickingBatch: {
        findUnique: jest.fn().mockResolvedValue({ status: 'created' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      overseasPickingBatch: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(batch)
          .mockResolvedValueOnce({ id: 43n, batchNo: 'PK-43', status: 'picked', confirmedAt }),
      },
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    };
    const service = new OrdersService(prisma as any);

    await service.confirmOverseasPickingBatch('43', { items: [] }, 9n);

    expect(boxUpdate).toHaveBeenCalledWith({
      where: { boxId: 4n, productId: 'STRAP-2', qty: { gte: 1 } },
      data: { qty: { decrement: 1 } },
    });
    expect(stockMovementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: 'STRAP-2', qtyDelta: -1 }),
    });
    expect(boxUpdate).toHaveBeenCalledWith({
      where: { boxId: 8n, productId: 'BODY-8', qty: { gte: 2 } },
      data: { qty: { decrement: 2 } },
    });
    expect(stockMovementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: 'BODY-8', qtyDelta: -2 }),
    });
  });

  it('aggregates shared component demand when validating a picking batch', async () => {
    const sharedComponent = { productId: 'HOOK-9', productName: '共用扣件', productType: '肩带配件', stockQty: 1, status: 1 };
    const service = new OrdersService({
      overseasPickingBatchItem: { findMany: jest.fn().mockResolvedValue([]) },
      masterProduct: {
        findMany: jest.fn()
          .mockResolvedValueOnce([
            {
              productId: 'STRAP-A', productType: '肩带', stockQty: 0,
              bomComponents: [{ componentProductId: 'HOOK-9', quantity: 1, componentProduct: sharedComponent }],
            },
            {
              productId: 'STRAP-B', productType: '肩带', stockQty: 0,
              bomComponents: [{ componentProductId: 'HOOK-9', quantity: 1, componentProduct: sharedComponent }],
            },
          ])
          .mockResolvedValueOnce([sharedComponent]),
      },
    } as any);

    await expect((service as any).assertOverseasPickingBatchDemandWithinStock([
      {
        productId: 'STRAP-A', requestedQty: 1, pickingPlanSnapshot: [],
        bomSnapshot: [{ componentProductId: 'HOOK-9', componentProductName: '共用扣件', quantity: 1 }],
      },
      {
        productId: 'STRAP-B', requestedQty: 1, pickingPlanSnapshot: [],
        bomSnapshot: [{ componentProductId: 'HOOK-9', componentProductName: '共用扣件', quantity: 1 }],
      },
    ])).rejects.toThrow('库存 1，已预占 0，本批次需要 2');
  });

  it('stores the shoulder strap BOM configuration on a new picking batch item', async () => {
    const service = new OrdersService({
      masterProduct: {
        findMany: jest.fn().mockResolvedValue([{
          productId: 'STRAP-SNAPSHOT',
          bomComponents: [{
            componentProductId: 'BODY-11',
            quantity: 2,
            componentProduct: { productName: '快照本体', productType: '肩带本体' },
          }],
        }]),
      },
    } as any);
    const snapshots = [{ productId: 'STRAP-SNAPSHOT' }];

    await (service as any).attachShoulderStrapBomSnapshots(snapshots);

    expect(snapshots[0]).toMatchObject({
      bomSnapshot: [{
        componentProductId: 'BODY-11',
        componentProductName: '快照本体',
        quantity: 2,
      }],
    });
  });

  it('splits an assembled shoulder strap into master-product picking requirements', async () => {
    const service = new OrdersService({
      masterProduct: {
        findMany: jest.fn().mockResolvedValue([
          { productId: 'STRAP-1', productName: '成品肩带', productType: '肩带' },
          { productId: 'BODY-1', productName: '肩带本体', productType: '肩带本体' },
          { productId: 'HOOK-1', productName: '肩带扣', productType: '肩带配件' },
        ]),
      },
    } as any);
    const snapshots = [{
      productId: 'STRAP-1',
      requestedQty: 2,
      pickingPlanSnapshot: [{ shelfCode: 'S1', boxCode: 'B1', boxQty: 1, pickQty: 1 }],
      bomSnapshot: [
        { componentProductId: 'BODY-1', componentProductName: '肩带本体', quantity: 1 },
        { componentProductId: 'HOOK-1', componentProductName: '肩带扣', quantity: 2 },
      ],
    }];

    await (service as any).attachOverseasPickingRequirementSnapshots(snapshots);

    expect(snapshots[0]).toMatchObject({
      pickingRequirementSnapshot: [
        { productId: 'STRAP-1', requestedQty: 1, pickedQty: 0 },
        { productId: 'BODY-1', productType: '肩带本体', requestedQty: 1, pickedQty: 0 },
        { productId: 'HOOK-1', productType: '肩带配件', requestedQty: 2, pickedQty: 0 },
      ],
    });
  });

  it('accepts a shoulder body product ID while scanning an assembled picking requirement', async () => {
    const update = jest.fn().mockResolvedValue({
      id: 1n, productId: 'STRAP-1', actualQty: 0, requestedQty: 1,
    });
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockImplementation((callback) => callback(prisma)),
      overseasPickingBatch: {
        findUnique: jest.fn().mockResolvedValue({ id: 42n, batchNo: 'PK-42', status: 'created' }),
      },
      overseasPickingBatchItem: {
        findMany: jest.fn().mockResolvedValue([{
          id: 1n,
          productId: 'STRAP-1',
          requestedQty: 1,
          actualQty: 0,
          dispatchMode: 'overseas',
          pickingRequirementSnapshot: [
            { productId: 'BODY-1', productName: '肩带本体', productType: '肩带本体', requestedQty: 1, pickedQty: 0 },
            { productId: 'HOOK-1', productName: '肩带扣', productType: '肩带配件', requestedQty: 1, pickedQty: 0 },
          ],
        }]),
        update,
      },
    };
    const service = new OrdersService(prisma as any);
    jest.spyOn(service as any, 'loadOverseasPickingBatchLocationMeta').mockResolvedValue(new Map([
      ['BODY-1', { shelfCode: 'A', boxCode: '1', productName: '肩带本体', stockQty: 1, locations: [] }],
      ['HOOK-1', { shelfCode: 'B', boxCode: '1', productName: '肩带扣', stockQty: 1, locations: [] }],
    ]));

    await expect(service.scanOverseasPickingBatchProduct('42', { productId: 'BODY-1' })).resolves.toMatchObject({
      productId: 'BODY-1', pickedQty: 1, requestedQty: 1, remainingQty: 0,
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1n },
      data: expect.objectContaining({
        actualQty: 0,
        pickingRequirementSnapshot: expect.arrayContaining([
          expect.objectContaining({ productId: 'BODY-1', pickedQty: 1 }),
          expect.objectContaining({ productId: 'HOOK-1', pickedQty: 0 }),
        ]),
      }),
    }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('subtracts component quantities reserved by active picking batches', async () => {
    const bomSnapshot = [{
      componentProductId: 'HOOK-12', componentProductName: '预占配件', quantity: 1,
    }];
    const service = new OrdersService({
      overseasPickingBatchItem: {
        findMany: jest.fn().mockResolvedValue([{
          productId: 'STRAP-RESERVED',
          requestedQty: 1,
          pickingPlanSnapshot: [],
          bomSnapshot,
        }]),
      },
      masterProduct: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{
            productId: 'STRAP-RESERVED', productType: '肩带', bomComponents: [],
          }])
          .mockResolvedValueOnce([{
            productId: 'HOOK-12', productName: '预占配件', productType: '肩带配件', stockQty: 1, status: 1,
          }]),
      },
    } as any);

    await expect((service as any).assertOverseasPickingBatchDemandWithinStock([{
      productId: 'STRAP-RESERVED',
      requestedQty: 1,
      pickingPlanSnapshot: [],
      bomSnapshot,
    }])).rejects.toThrow('库存 1，已预占 1，本批次需要 1');
  });

  it('does not assign finished stock already reserved by another active batch', async () => {
    const service = new OrdersService({
      overseasPickingBatchItem: {
        findMany: jest.fn().mockResolvedValue([{
          productId: 'STRAP-FINISHED',
          pickingPlanSnapshot: [{ shelfCode: 'S1', boxCode: 'B1', boxQty: 1, pickQty: 1 }],
        }]),
      },
    } as any);
    jest.spyOn(service as any, 'loadOverseasPickingBatchLocationMeta').mockResolvedValue(new Map([
      ['STRAP-FINISHED', {
        shelfCode: 'S1',
        boxCode: 'B1',
        productName: '预占成品肩带',
        stockQty: 1,
        locations: [{ shelfCode: 'S1', boxCode: 'B1', qty: 1 }],
      }],
    ]));
    const snapshots = [{ productId: 'STRAP-FINISHED', requestedQty: 1 }];

    await (service as any).attachOverseasPickingPlanSnapshots(snapshots);

    expect(snapshots[0]).toMatchObject({ pickingPlanSnapshot: [] });
  });

  it('blocks completing overseas batch work while a Yamato label remains unprinted', async () => {
    const prisma = {
      overseasPickingBatch: {
        findUnique: jest.fn().mockResolvedValue({ id: 42n, batchNo: 'PK-42', status: 'yamato_exported' }),
        update: jest.fn(),
      },
      yamatoShipmentBatch: {
        findFirst: jest.fn().mockResolvedValue({
          id: 16n,
          status: 'pdf_ready',
          pageCount: 2,
          pages: [{ printedAt: new Date() }, { printedAt: null }],
        }),
      },
    };
    const service = new OrdersService(prisma as any);

    await expect(service.completeOverseasPickingBatchWork('42')).rejects.toThrow('还有 1 张面单未打印');
    expect(prisma.overseasPickingBatch.update).not.toHaveBeenCalled();
  });

  it('builds the assembly part confirmation list for a Yamato label', async () => {
    const prisma = {
      overseasPickingBatchItem: {
        findMany: jest.fn().mockResolvedValue([{
          productId: 'STRAP-LABEL',
          requestedQty: 2,
          actualQty: 2,
          pickingPlanSnapshot: [{ shelfCode: 'S1', boxCode: 'B1', boxQty: 1, pickQty: 1 }],
          bomSnapshot: [
            { componentProductId: 'HOOK-21', componentProductName: '肩带扣', quantity: 2 },
            { componentProductId: 'BODY-22', componentProductName: '肩带布', quantity: 1 },
          ],
        }]),
      },
      masterProduct: {
        findMany: jest.fn().mockResolvedValue([
          { productId: 'HOOK-21', productName: '肩带扣', productType: '肩带配件', stockQty: 8 },
          { productId: 'BODY-22', productName: '肩带布', productType: '肩带本体', stockQty: 5 },
        ]),
      },
    };
    const service = new OrdersService(prisma as any);

    const parts = await (service as any).buildYamatoShipmentPageAssemblyPartDetails(
      42n,
      { orderId: 'ORDER-STRAP', productIds: ['STRAP-LABEL'] },
    );

    expect(parts).toEqual([
      {
        componentProductId: 'HOOK-21', componentProductName: '肩带扣', componentProductType: '肩带配件', requiredQty: 2,
        stockQty: 8, parentProductIds: ['STRAP-LABEL'],
      },
      {
        componentProductId: 'BODY-22', componentProductName: '肩带布', componentProductType: '肩带本体', requiredQty: 1,
        stockQty: 5, parentProductIds: ['STRAP-LABEL'],
      },
    ]);
  });

  it('blocks Yamato label output until every assembly part is confirmed', () => {
    const service = new OrdersService({} as any);
    const parts = [
      { componentProductId: 'HOOK-21', componentProductName: '肩带扣', requiredQty: 2, stockQty: 8 },
      { componentProductId: 'BODY-22', componentProductName: '肩带布', requiredQty: 1, stockQty: 5 },
    ];

    expect(() => (service as any).assertYamatoAssemblyPartsConfirmed(
      { productId: 'STRAP-LABEL', confirmedAssemblyComponentProductIds: ['HOOK-21'] },
      parts,
    )).toThrow('请先确认全部 BOM 材料：BODY-22');
    expect(() => (service as any).assertYamatoAssemblyPartsConfirmed(
      { productId: 'STRAP-LABEL', confirmedAssemblyComponentProductIds: ['HOOK-21', 'BODY-22'] },
      parts,
    )).not.toThrow();
  });

  it('finds the finished shoulder label when the scanned code is a shoulder body product ID', async () => {
    const page = {
      id: 31n,
      pageNo: 1,
      printedAt: null,
      productIds: ['STRAP-LABEL'],
    };
    const service = new OrdersService({
      yamatoShipmentBatch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 9n,
          pickingBatchId: 42n,
          status: 'pdf_ready',
          pdfFilePath: '/tmp/label.pdf',
          pages: [page],
        }),
      },
      masterProduct: {
        findUnique: jest.fn().mockResolvedValue({ productType: '肩带本体' }),
      },
      overseasPickingBatchItem: {
        findMany: jest.fn().mockResolvedValue([{
          productId: 'STRAP-LABEL',
          requestedQty: 1,
          pickingPlanSnapshot: [],
          bomSnapshot: [{
            componentProductId: 'BODY-1', componentProductName: '肩带本体', quantity: 1,
          }],
        }]),
      },
    } as any);

    await expect((service as any).findPrintableYamatoShipmentPageByProductId(
      '9',
      { productId: 'BODY-1' },
    )).resolves.toMatchObject({ targetPage: page, productId: 'BODY-1' });
  });

  it('returns Yamato print progress for the picking batch status display', async () => {
    const createdAt = new Date('2026-08-28T01:00:00.000Z');
    const prisma = {
      overseasPickingBatch: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 42n,
            batchNo: 'PK-42',
            status: 'yamato_exported',
            orderCount: 2,
            itemCount: 2,
            totalQty: 2,
            createdAt,
            confirmedAt: createdAt,
          },
        ]),
      },
      yamatoShipmentBatch: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 16n,
            pickingBatchId: 42n,
            status: 'pdf_ready',
            pageCount: 2,
            pages: [{ printedAt: createdAt }, { printedAt: null }],
          },
        ]),
      },
    };
    const service = new OrdersService(prisma as any);

    await expect(service.listOverseasPickingBatches()).resolves.toEqual([
      expect.objectContaining({
        id: '42',
        yamatoShipmentBatchStatus: 'pdf_ready',
        yamatoPrintedPageCount: 1,
        yamatoPendingPageCount: 1,
      }),
    ]);
  });

  it('persists completed status after every Yamato label has printed', async () => {
    const prisma = {
      overseasPickingBatch: {
        findUnique: jest.fn().mockResolvedValue({ id: 42n, batchNo: 'PK-42', status: 'yamato_exported' }),
        update: jest.fn().mockResolvedValue({}),
      },
      yamatoShipmentBatch: {
        findFirst: jest.fn().mockResolvedValue({
          id: 16n,
          status: 'pdf_ready',
          pageCount: 2,
          pages: [{ printedAt: new Date() }, { printedAt: new Date() }],
        }),
      },
    };
    const service = new OrdersService(prisma as any);

    await expect(service.completeOverseasPickingBatchWork('42')).resolves.toEqual({
      id: '42',
      batchNo: 'PK-42',
      status: 'completed',
    });
    expect(prisma.overseasPickingBatch.update).toHaveBeenCalledWith({
      where: { id: 42n },
      data: { status: 'completed' },
    });
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
