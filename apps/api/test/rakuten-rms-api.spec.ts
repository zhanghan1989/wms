import { ShopPlatform } from "@prisma/client";
import { ROLES_KEY } from "../src/common/decorators/roles.decorator";
import { PrismaService } from "../src/prisma/prisma.service";
import { RakutenRmsApiClient } from "../src/rakuten-rms-api/rakuten-rms-api.client";
import { RakutenRmsApiController } from "../src/rakuten-rms-api/rakuten-rms-api.controller";
import { RakutenRmsApiCryptoService } from "../src/rakuten-rms-api/rakuten-rms-api-crypto.service";
import { RakutenRmsApiService } from "../src/rakuten-rms-api/rakuten-rms-api.service";

describe("Rakuten RMS API integration", () => {
  const originalEncryptionKey = process.env.RAKUTEN_RMS_API_ENCRYPTION_KEY;
  const originalProxyUrl = process.env.RAKUTEN_RMS_API_PROXY_URL;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalEncryptionKey === undefined) delete process.env.RAKUTEN_RMS_API_ENCRYPTION_KEY;
    else process.env.RAKUTEN_RMS_API_ENCRYPTION_KEY = originalEncryptionKey;
    if (originalProxyUrl === undefined) delete process.env.RAKUTEN_RMS_API_PROXY_URL;
    else process.env.RAKUTEN_RMS_API_PROXY_URL = originalProxyUrl;
  });

  it("does not role-restrict any Rakuten RMS API operation", () => {
    const unrestrictedHandlers = [
      RakutenRmsApiController.prototype.listConnections,
      RakutenRmsApiController.prototype.createConnection,
      RakutenRmsApiController.prototype.updateConnection,
      RakutenRmsApiController.prototype.testConnection,
      RakutenRmsApiController.prototype.previewConnection,
      RakutenRmsApiController.prototype.syncConnection,
      RakutenRmsApiController.prototype.ignorePreviewConflicts,
      RakutenRmsApiController.prototype.rollbackSyncRun,
      RakutenRmsApiController.prototype.syncAllConnections,
      RakutenRmsApiController.prototype.listSyncRuns,
      RakutenRmsApiController.prototype.runAutomation,
      RakutenRmsApiController.prototype.getAutomationSummary,
      RakutenRmsApiController.prototype.previewManualAutomationActions,
      RakutenRmsApiController.prototype.executeManualAutomationActions,
    ];

    expect(Reflect.getMetadata(ROLES_KEY, RakutenRmsApiController)).toBeUndefined();
    for (const handler of unrestrictedHandlers) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    }
  });

  it("keeps scheduled Rakuten order import paused by default", async () => {
    const service = new RakutenRmsApiService(
      {} as PrismaService,
      {} as RakutenRmsApiClient,
      {} as RakutenRmsApiCryptoService,
    );
    const syncAllConnections = jest.spyOn(service, "syncAllConnections");

    await service.runScheduledSync();

    expect(syncAllConnections).not.toHaveBeenCalled();
  });

  it("encrypts the RMS credentials with authenticated encryption", () => {
    process.env.RAKUTEN_RMS_API_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const crypto = new RakutenRmsApiCryptoService();
    const encrypted = crypto.encrypt("SL421951_license-key");

    expect(encrypted.encryptedValue).not.toContain("SL421951_license-key");
    expect(crypto.decrypt(encrypted.encryptedValue, encrypted.iv, encrypted.authTag)).toBe("SL421951_license-key");
  });

  it("normalizes and validates multiple shop BCC addresses", () => {
    const service = new RakutenRmsApiService(
      {} as PrismaService,
      {} as RakutenRmsApiClient,
      {} as RakutenRmsApiCryptoService,
    );

    expect((service as any).normalizeEmailAddressList(
      " Archive@Example.jp; audit@example.jp\narchive@example.jp ",
    )).toBe("archive@example.jp, audit@example.jp");
    expect(() => (service as any).normalizeEmailAddressList("not-an-email"))
      .toThrow("BCC邮箱格式无效");
  });

  it("rejects an RMS connection for an Amazon shop", async () => {
    const prisma = {
      shop: {
        findUnique: jest.fn().mockResolvedValue({ id: 3n, platform: ShopPlatform.amazon }),
      },
      rakutenRmsConnection: { findUnique: jest.fn(), create: jest.fn() },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(
      prisma,
      {} as RakutenRmsApiClient,
      {} as RakutenRmsApiCryptoService,
    );

    await expect(
      service.createConnection({
        shopId: "3",
        serviceSecret: "secret",
        licenseKey: "license",
      }),
    ).rejects.toThrow("只有乐天店铺可以配置乐天 RMS API 连接");
    expect(prisma.rakutenRmsConnection.findUnique).not.toHaveBeenCalled();
  });

  it("uses ESA authentication and follows searchOrder pagination", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            orderNumberList: ["421951-1"],
            PaginationResponseModel: { totalPages: 2 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            orderNumberList: ["421951-2"],
            PaginationResponseModel: { totalPages: 2 },
          }),
          { status: 200 },
        ),
      );
    const client = new RakutenRmsApiClient();
    const rows = await client.searchOrders("service-secret", "license-key", {
      start: new Date("2026-08-13T00:00:00.000Z"),
      end: new Date("2026-08-14T00:00:00.000Z"),
      orderProgressList: [100, 300],
    });

    expect(rows).toEqual(["421951-1", "421951-2"]);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.headers).toMatchObject({
      authorization: `ESA ${Buffer.from("service-secret:license-key").toString("base64")}`,
    });
    expect(JSON.parse(String(request.body))).toMatchObject({
      dateType: 1,
      orderProgressList: [100, 300],
      PaginationRequestModel: { requestPage: 1, requestRecordsAmount: 1000 },
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      PaginationRequestModel: { requestPage: 2 },
    });
  });

  it("sends the order fix datetime search type when requested", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ orderNumberList: [], PaginationResponseModel: { totalPages: 1 } }),
        { status: 200 },
      ),
    );
    const client = new RakutenRmsApiClient();

    await client.searchOrders("service-secret", "license-key", {
      start: new Date("2026-08-23T18:00:00.000Z"),
      end: new Date("2026-08-24T06:00:00.000Z"),
      dateType: 3,
      orderProgressList: [300],
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toMatchObject({ dateType: 3, orderProgressList: [300] });
  });

  it("uses the dedicated proxy only when the Rakuten proxy setting is configured", async () => {
    process.env.RAKUTEN_RMS_API_PROXY_URL = "http://100.64.0.10:3128";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ orderNumberList: [], PaginationResponseModel: { totalPages: 1 } }),
        { status: 200 },
      ),
    );
    const client = new RakutenRmsApiClient();

    await client.searchOrders("service-secret", "license-key", {
      start: new Date("2026-08-17T00:00:00.000Z"),
      end: new Date("2026-08-18T00:00:00.000Z"),
    });

    expect(fetchMock.mock.calls[0][1]).toHaveProperty("dispatcher");
    await client.onModuleDestroy();
  });

  it("rejects an unsafe Rakuten proxy protocol before making a request", async () => {
    process.env.RAKUTEN_RMS_API_PROXY_URL = "socks5://100.64.0.10:3128";
    const fetchMock = jest.spyOn(global, "fetch");
    const client = new RakutenRmsApiClient();

    await expect(
      client.searchOrders("service-secret", "license-key", {
        start: new Date("2026-08-17T00:00:00.000Z"),
        end: new Date("2026-08-18T00:00:00.000Z"),
      }),
    ).rejects.toThrow("仅支持 http:// 或 https://");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes searchOrder with one record and does not traverse result pages", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          orderNumberList: ["421951-1"],
          PaginationResponseModel: { totalRecordsAmount: 824, totalPages: 824 },
        }),
        { status: 200 },
      ),
    );
    const client = new RakutenRmsApiClient();

    await expect(
      client.probeOrders("service-secret", "license-key", {
        start: new Date("2026-06-17T00:00:00.000Z"),
        end: new Date("2026-08-18T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ matchedOrderCount: 824, sampleOrderNumber: "421951-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      PaginationRequestModel: { requestPage: 1, requestRecordsAmount: 1 },
    });
  });

  it("retries a transient network failure before returning search results", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            orderNumberList: ["421951-1"],
            PaginationResponseModel: { totalPages: 1 },
          }),
          { status: 200 },
        ),
      );
    const client = new RakutenRmsApiClient();

    await expect(
      client.searchOrders("service-secret", "license-key", {
        start: new Date("2026-08-17T00:00:00.000Z"),
        end: new Date("2026-08-18T00:00:00.000Z"),
      }),
    ).resolves.toEqual(["421951-1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an actionable error after repeated network failures", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockRejectedValue(
      new TypeError("fetch failed", {
        cause: new Error("getaddrinfo EAI_AGAIN api.rms.rakuten.co.jp"),
      }),
    );
    const client = new RakutenRmsApiClient();

    await expect(
      client.searchOrders("service-secret", "license-key", {
        start: new Date("2026-08-17T00:00:00.000Z"),
        end: new Date("2026-08-18T00:00:00.000Z"),
      }),
    ).rejects.toThrow("getaddrinfo EAI_AGAIN api.rms.rakuten.co.jp");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("tests getOrder permission when a recent order is available", async () => {
    const connection = {
      id: 7n,
      status: 1,
      syncOrders: true,
      licenseExpiresAt: null,
      encryptedServiceSecret: "encrypted-secret",
      serviceSecretIv: "secret-iv",
      serviceSecretAuthTag: "secret-tag",
      encryptedLicenseKey: "encrypted-license",
      licenseKeyIv: "license-iv",
      licenseKeyAuthTag: "license-tag",
      shop: { id: 3n, name: "乐天店" },
    };
    const prisma = {
      rakutenRmsConnection: {
        findUnique: jest.fn().mockResolvedValue(connection),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const client = {
      probeOrders: jest.fn().mockResolvedValue({ matchedOrderCount: 1, sampleOrderNumber: "421951-1" }),
      getOrders: jest.fn().mockResolvedValue([{ orderNumber: "421951-1" }]),
    } as unknown as RakutenRmsApiClient;
    const crypto = {
      decrypt: jest.fn().mockReturnValueOnce("service-secret").mockReturnValueOnce("license-key"),
    } as unknown as RakutenRmsApiCryptoService;
    const service = new RakutenRmsApiService(prisma, client, crypto);

    const result = (await service.testConnection("7")) as any;

    expect(client.probeOrders).toHaveBeenCalledWith(
      "service-secret",
      "license-key",
      expect.objectContaining({
        start: expect.any(Date),
        end: expect.any(Date),
      }),
    );
    expect((client.probeOrders as jest.Mock).mock.calls[0][2].orderProgressList).toBeUndefined();
    expect(client.getOrders).toHaveBeenCalledWith("service-secret", "license-key", ["421951-1"]);
    expect((prisma.rakutenRmsConnection.update as jest.Mock)).toHaveBeenCalledWith({
      where: { id: 7n },
      data: { shippingCircuitOpenedAt: null, shippingCircuitReason: null },
    });
    expect(result.testedOperations).toEqual({
      searchOrder: true,
      getOrder: true,
    });
  });

  it("requests and maps only pending-shipment orders", async () => {
    const client = {
      searchOrders: jest.fn().mockResolvedValue(["pending-order", "changed-order"]),
      getOrders: jest.fn().mockResolvedValue([
        { orderNumber: "pending-order", orderProgress: 300 },
        { orderNumber: "changed-order", orderProgress: 400 },
      ]),
    } as unknown as RakutenRmsApiClient;
    const service = new RakutenRmsApiService(
      {} as PrismaService,
      client,
      {} as RakutenRmsApiCryptoService,
    );
    jest.spyOn(service as any, "decryptCredentials").mockReturnValue({
      serviceSecret: "service-secret",
      licenseKey: "license-key",
    });
    const mapOrders = jest.spyOn(service as any, "mapOrders").mockResolvedValue([]);

    const result = await (service as any).fetchSyncItems(
      { id: 7n, licenseExpiresAt: null, lastOrdersSyncedAt: null },
      14,
    );

    expect(client.searchOrders).toHaveBeenCalledWith(
      "service-secret",
      "license-key",
      expect.objectContaining({ dateType: 3, orderProgressList: [300] }),
    );
    expect(mapOrders).toHaveBeenCalledWith([{ orderNumber: "pending-order", orderProgress: 300 }]);
    expect(result).toMatchObject({
      searchedOrderCount: 2,
      reconciledOrderCount: 0,
      requestedOrderCount: 2,
    });
  });

  it("starts six hours before the last formal sync when searching by order fix datetime", async () => {
    const client = {
      searchOrders: jest.fn().mockResolvedValue([]),
      getOrders: jest.fn().mockResolvedValue([]),
    } as unknown as RakutenRmsApiClient;
    const service = new RakutenRmsApiService(
      {} as PrismaService,
      client,
      {} as RakutenRmsApiCryptoService,
    );
    jest.spyOn(service as any, "decryptCredentials").mockReturnValue({
      serviceSecret: "service-secret",
      licenseKey: "license-key",
    });

    await (service as any).fetchSyncItems(
      {
        id: 7n,
        licenseExpiresAt: null,
        lastOrdersSyncedAt: new Date("2026-08-24T00:00:00.000Z"),
      },
      7,
    );

    const options = (client.searchOrders as jest.Mock).mock.calls[0][2];
    expect(options.start.toISOString()).toBe("2026-08-23T18:00:00.000Z");
    expect(options.dateType).toBe(3);
  });

  it("returns sync history without exposing encrypted connection credentials", async () => {
    const prisma = {
      rakutenRmsSyncRun: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 11n,
            connectionId: 7n,
            status: "success",
            startedAt: new Date("2026-08-18T01:00:00.000Z"),
            finishedAt: new Date("2026-08-18T01:00:02.000Z"),
            fetchedCount: 2,
            createdCount: 1,
            updatedCount: 1,
            skippedCount: 0,
            errorMessage: null,
            changeSnapshot: { secretAddress: "must-not-leak", changes: [] },
            rolledBackAt: null,
            connection: {
              id: 7n,
              encryptedServiceSecret: "must-not-leak",
              encryptedLicenseKey: "must-not-leak",
              shop: { id: 3n, name: "乐天店" },
            },
          },
        ]),
      },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const rows = (await service.listSyncRuns("7", "10")) as any[];

    expect(rows[0]).toMatchObject({
      id: "11",
      connectionId: "7",
      fetchedCount: 2,
      connection: { id: "7", shop: { id: "3", name: "乐天店" } },
    });
    expect(rows[0].connection.encryptedServiceSecret).toBeUndefined();
    expect(rows[0].connection.encryptedLicenseKey).toBeUndefined();
    expect(rows[0].changeSnapshot).toBeUndefined();
  });

  it("does not claim a single CSV row when the SKU does not match exactly", async () => {
    const existing = {
      id: 9n,
      rmsConnectionId: null,
      orderId: "421951-1",
      shopName: "乐天店",
      skuCode: "CSV-SKU",
      comboOrderSku: null,
      setComponentSkuCode: null,
    };
    const prisma = {
      rakutenOrderRecord: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([existing]),
      },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const plan = await (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天店" } },
      { orderId: "421951-1", itemKey: "item-1", skuCode: "API-SKU" },
    );

    expect(plan.action).toBe("conflict");
    expect(plan.reason).toContain("SKU不一致");
  });

  it("claims a unique CSV row by order number and SKU even when the legacy shop name differs", async () => {
    const existing = {
      id: 9n,
      rmsConnectionId: null,
      rmsItemKey: null,
      sourceKind: "csv",
      orderId: "421951-1",
      shopName: "1号店-DGAZ store",
      skuCode: "9259",
      comboOrderSku: null,
      setComponentSkuCode: null,
      dispatchMode: "overseas",
      shipmentNo: null,
      xiyaExportedAt: null,
      rmsManualOverrideAt: null,
      rawPayload: {},
      updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    };
    const findMany = jest.fn().mockResolvedValue([existing]);
    const prisma = {
      rakutenOrderRecord: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany,
      },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const plan = await (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天-1号店" } },
      { orderId: "421951-1", itemKey: "item-1", skuCode: "9259" },
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { orderId: "421951-1" },
      orderBy: { id: "asc" },
    });
    expect(plan.action).toBe("claim");
    expect(plan.existing).toBe(existing);
  });

  it("creates a later API item when an earlier item from the same order was just created", async () => {
    const firstCreatedItem = {
      id: 9n,
      rmsConnectionId: 7n,
      rmsItemKey: "item-1|component:9259",
      sourceKind: "rms_api",
      orderId: "421951-20260822-0868449346",
      skuCode: "9259",
      comboOrderSku: "zh-combo-1",
      setComponentSkuCode: "zh-combo-1",
    };
    const prisma = {
      rakutenOrderRecord: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([firstCreatedItem]),
      },
      masterProduct: { findUnique: jest.fn().mockResolvedValue({ stockQty: 0 }) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const plan = await (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天-1号店" } },
      {
        orderId: "421951-20260822-0868449346",
        itemKey: "item-1|component:8736",
        skuCode: "8736",
        comboLookupSku: "zh-combo-1",
        isComboOrder: true,
        comboOrderSku: "zh-combo-1",
        setComponentSkuCode: "zh-combo-1",
      },
    );

    expect(plan.action).toBe("create");
    expect(plan.existing).toBeNull();
  });

  it("does not classify sync metadata refreshes as business updates", async () => {
    const existing = {
      id: 9n,
      rmsConnectionId: 7n,
      rmsItemKey: "item-1",
      orderQuantity: 1,
      shippingAddress: "8-1",
      shipmentNo: null,
      xiyaExportedAt: null,
      rmsManualOverrideAt: null,
      rawPayload: { version: "old" },
      csvImportedAt: new Date("2026-08-18T00:00:00.000Z"),
      rmsLastSyncedAt: new Date("2026-08-18T00:00:00.000Z"),
      updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    };
    const prisma = {
      rakutenOrderRecord: { findUnique: jest.fn().mockResolvedValue(existing) },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);
    jest.spyOn(service as any, "buildOrderWriteData").mockResolvedValue({
      orderQuantity: 1,
      shippingAddress: "8-1",
      rawPayload: { version: "new" },
      csvImportedAt: new Date("2026-08-21T00:00:00.000Z"),
      rmsLastSyncedAt: new Date("2026-08-21T00:00:00.000Z"),
    });

    const plan = await (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天店" } },
      { orderId: "421951-1", itemKey: "item-1", skuCode: "9259" },
    );

    expect(plan).toMatchObject({ action: "update", changedFields: [] });
  });

  it("preserves the first import time when an existing RMS item is synced again", async () => {
    const firstImportedAt = new Date("2026-09-02T05:08:11.000Z");
    const syncedAt = new Date("2026-09-03T02:46:08.000Z");
    const service = new RakutenRmsApiService(
      {} as PrismaService,
      {} as RakutenRmsApiClient,
      {} as RakutenRmsApiCryptoService,
    );

    const data = await (service as any).buildOrderWriteData(
      {},
      { id: 7n, shop: { id: 3n, name: "乐天店" } },
      {
        orderId: "421951-20260902-0113701603",
        itemKey: "421951-20260902-0113701603|item-1",
        skuCode: "98610",
        comboLookupSku: null,
        isComboOrder: false,
        comboOrderSku: null,
        setComponentSkuCode: null,
        orderQuantity: 1,
      },
      {
        csvImportedAt: firstImportedAt,
        dispatchMode: "china_no_stock",
      },
      syncedAt,
    );

    expect(data.csvImportedAt).toEqual(firstImportedAt);
    expect(data.rmsLastSyncedAt).toEqual(syncedAt);
  });

  it("uses the sync time as the import time for a newly created RMS item", async () => {
    const syncedAt = new Date("2026-09-03T02:46:08.000Z");
    const prisma = {
      masterProduct: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(
      prisma,
      {} as RakutenRmsApiClient,
      {} as RakutenRmsApiCryptoService,
    );

    const data = await (service as any).buildOrderWriteData(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天店" } },
      {
        orderId: "421951-new",
        itemKey: "421951-new|item-1",
        skuCode: "98610",
        comboLookupSku: null,
        isComboOrder: false,
        comboOrderSku: null,
        setComponentSkuCode: null,
        orderQuantity: 1,
      },
      null,
      syncedAt,
    );

    expect(data.csvImportedAt).toEqual(syncedAt);
    expect(data.rmsLastSyncedAt).toEqual(syncedAt);
  });

  it("reports only changed business fields for an existing RMS order", async () => {
    const existing = {
      id: 9n,
      rmsConnectionId: 7n,
      rmsItemKey: "item-1",
      orderQuantity: 1,
      buyerEmail: "old@example.com",
      shippingAddress: "8-1",
      shipmentNo: null,
      xiyaExportedAt: null,
      rmsManualOverrideAt: null,
      rawPayload: { version: "old" },
      updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    };
    const prisma = {
      rakutenOrderRecord: { findUnique: jest.fn().mockResolvedValue(existing) },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);
    jest.spyOn(service as any, "buildOrderWriteData").mockResolvedValue({
      orderQuantity: 2,
      buyerEmail: "new@example.com",
      shippingAddress: "8-1",
      rawPayload: { version: "new" },
      csvImportedAt: new Date("2026-08-21T00:00:00.000Z"),
      rmsLastSyncedAt: new Date("2026-08-21T00:00:00.000Z"),
    });

    const plan = await (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天店" } },
      { orderId: "421951-1", itemKey: "item-1", skuCode: "9259" },
    );

    expect(plan).toMatchObject({ action: "update", changedFields: ["orderQuantity", "buyerEmail"] });
  });

  it("freezes an RMS order that has already entered a picking batch", async () => {
    const existing = {
      id: 9n,
      rmsConnectionId: 7n,
      rmsItemKey: "item-1",
      shipmentNo: null,
      xiyaExportedAt: null,
      rawPayload: {},
      updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    };
    const prisma = {
      rakutenOrderRecord: { findUnique: jest.fn().mockResolvedValue(existing) },
      overseasPickingBatchItem: {
        findFirst: jest.fn().mockResolvedValue({ id: 5n }),
      },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const plan = await (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天店" } },
      { orderId: "421951-1", itemKey: "item-1", skuCode: "9259" },
    );

    expect(plan.action).toBe("frozen");
    expect(plan.reason).toBe("已经进入拣货批次");
  });

  it("freezes an RMS order after an operator has manually taken it over", async () => {
    const service = new RakutenRmsApiService(
      {} as PrismaService,
      {} as RakutenRmsApiClient,
      {} as RakutenRmsApiCryptoService,
    );

    const reason = await (service as any).resolveFreezeReason(
      {},
      {
        id: 9n,
        shipmentNo: null,
        xiyaExportedAt: null,
        rmsManualOverrideAt: new Date("2026-08-18T02:00:00.000Z"),
        rawPayload: {},
      },
    );

    expect(reason).toBe("已经由操作人员人工接管");
  });

  it("does not recreate a Rakuten item that an operator deleted", async () => {
    const prisma = {
      rakutenOrderSyncExclusion: { findMany: jest.fn().mockResolvedValue([{ reason: "user_delete" }]) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const plan = await (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天店" } },
      { orderId: "ORDER-1", itemKey: "ORDER-1|ITEM-1", skuCode: "SKU-1" },
    );

    expect(plan).toMatchObject({
      action: "excluded",
      reason: "已经由操作人员删除，禁止 RMS API 重新拉取",
    });
  });

  it("classifies an operator-confirmed RMS conflict as ignored", async () => {
    const prisma = {
      rakutenOrderSyncExclusion: { findMany: jest.fn().mockResolvedValue([{ reason: "conflict_ignore" }]) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const plan = await (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天店" } },
      { orderId: "ORDER-1", itemKey: "ORDER-1|ITEM-1", skuCode: "NEW-SKU" },
    );

    expect(plan).toMatchObject({
      action: "ignored",
      reason: "已经由操作人员确认忽略此冲突明细",
    });
  });

  it("persists an operator-confirmed conflict ignore from a valid preview", async () => {
    const exclusionCreate = jest.fn().mockResolvedValue({ id: 13n });
    const tx = {
      rakutenOrderSyncExclusion: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        create: exclusionCreate,
      },
      rakutenOrderRecord: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([{ id: 21n, skuCode: "OLD-SKU" }]),
      },
    };
    const item = {
      orderId: "ORDER-1",
      itemKey: "ORDER-1|ITEM-1",
      skuCode: "NEW-SKU",
    };
    const prisma = {
      rakutenRmsSyncPreview: {
        findUnique: jest.fn().mockResolvedValue({
          token: "a".repeat(64),
          connectionId: 7n,
          usedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
          previewData: {
            mappedItems: [item],
            planDescriptors: [
              { itemKey: item.itemKey, action: "conflict", existingId: null, existingUpdatedAt: null },
            ],
          },
        }),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);
    jest.spyOn(service as any, "loadConnection").mockResolvedValue({
      id: 7n,
      shop: { id: 3n, name: "乐天店" },
    });

    await expect(
      service.ignorePreviewConflicts(
        "7",
        { previewToken: "a".repeat(64), itemKeys: [item.itemKey] },
        5n,
      ),
    ).resolves.toEqual({ ignoredCount: 1, orderCount: 1 });
    expect(exclusionCreate).toHaveBeenCalledWith({
      data: {
        rmsConnectionId: 7n,
        orderId: item.orderId,
        rmsItemKey: item.itemKey,
        reason: "conflict_ignore",
        createdBy: 5n,
      },
    });
  });

  it("raises a manual Japan-side action when an Xiya-acknowledged order changes", async () => {
    const existing = {
      id: 9n,
      rmsConnectionId: 7n,
      rmsItemKey: "item-1",
      shipmentNo: null,
      xiyaExportedAt: new Date("2026-08-18T00:00:00.000Z"),
      rawPayload: {},
      skuCode: "9259",
      orderQuantity: 1,
      shippingAddress: "8-1",
      dispatchMode: "china_no_stock",
      updatedAt: new Date("2026-08-18T00:00:00.000Z"),
    };
    const prisma = {
      rakutenOrderRecord: { findUnique: jest.fn().mockResolvedValue(existing) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const plan = await (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天店" } },
      {
        orderId: "421951-1",
        itemKey: "item-1",
        skuCode: "9259",
        orderQuantity: 2,
        shippingAddress: "8-2",
        orderStatusText: "300",
        rawPayload: { orderNumber: "421951-1", orderProgress: 300 },
      },
    );

    expect(plan).toMatchObject({
      action: "manual_action",
      manualActionType: "update",
      changedFields: expect.arrayContaining(["orderQuantity", "shippingAddress"]),
    });
    expect(plan.reason).toContain("人工通知中国");
  });

  it("classifies an Xiya-acknowledged Rakuten cancellation as manual cancel handling", async () => {
    const service = new RakutenRmsApiService(
      {} as PrismaService,
      {} as RakutenRmsApiClient,
      {} as RakutenRmsApiCryptoService,
    );

    expect((service as any).isCancellationStatus("900")).toBe(true);
    expect((service as any).isCancellationStatus("キャンセル確定")).toBe(true);
    expect((service as any).isCancellationStatus("300")).toBe(false);
  });

  it("uses the standard preview range for a connection that has never synced", async () => {
    const previewCreate = jest.fn().mockResolvedValue({ token: "saved" });
    const prisma = {
      rakutenRmsSyncPreview: {
        create: previewCreate,
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);
    const connection = {
      id: 7n,
      lastSuccessfulSyncAt: null,
      shop: { id: 3n, name: "乐天店" },
    };
    jest.spyOn(service as any, "loadConnection").mockResolvedValue(connection);
    const fetchSpy = jest.spyOn(service as any, "fetchSyncItems").mockResolvedValue({
      mappedItems: [],
      searchedOrderCount: 0,
      reconciledOrderCount: 0,
      requestedOrderCount: 0,
      truncated: false,
    });

    const result = (await service.previewConnection("7")) as any;

    expect(fetchSpy).toHaveBeenCalledWith(connection, 7, undefined);
    expect(result.appliedLimits).toEqual({
      initialLookbackDays: 7,
      maxOrders: null,
    });
    expect(result.canConfirm).toBe(true);
    expect(previewCreate).toHaveBeenCalled();
  });

  it("shows existing rows with no business changes as synced without an update", async () => {
    const prisma = {
      rakutenRmsSyncPreview: {
        create: jest.fn().mockResolvedValue({ token: "saved" }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);
    jest.spyOn(service as any, "loadConnection").mockResolvedValue({
      id: 7n,
      shop: { id: 3n, name: "乐天店" },
    });
    jest.spyOn(service as any, "fetchSyncItems").mockResolvedValue({
      mappedItems: [
        {
          orderId: "421951-older",
          orderImportedAtRaw: "2026-08-20T10:00:00+0900",
          itemKey: "item-older",
          skuCode: "9259",
        },
        {
          orderId: "421951-newer",
          orderImportedAtRaw: "2026-08-21T10:00:00+0900",
          itemKey: "item-newer",
          skuCode: "9259",
        },
      ],
      searchedOrderCount: 2,
      reconciledOrderCount: 0,
      requestedOrderCount: 2,
      truncated: false,
    });
    jest.spyOn(service as any, "planOrderItem").mockImplementation(async (_db, _connection, item: any) => ({
      action: "update",
      item,
      existing: { id: 9n, updatedAt: new Date("2026-08-18T00:00:00.000Z") },
      reason: null,
      changedFields: [],
    }));

    const result = (await service.previewConnection("7")) as any;

    expect(result.summary).toMatchObject({ update: 0, unchanged: 2 });
    expect(result.items).toMatchObject([
      { orderId: "421951-newer", action: "unchanged", changedFields: [] },
      { orderId: "421951-older", action: "unchanged", changedFields: [] },
    ]);
  });

  it("returns every preview detail when the sync plan contains more than 100 rows", async () => {
    const prisma = {
      rakutenRmsSyncPreview: {
        create: jest.fn().mockResolvedValue({ token: "saved" }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);
    const connection = {
      id: 7n,
      lastSuccessfulSyncAt: new Date("2026-08-19T00:00:00.000Z"),
      shop: { id: 3n, name: "乐天店" },
    };
    const mappedItems = [
      ...Array.from({ length: 100 }, (_, index) => ({
        orderId: `frozen-${index}`,
        itemKey: `frozen-item-${index}`,
        skuCode: `frozen-sku-${index}`,
        previewAction: "frozen",
      })),
      ...Array.from({ length: 16 }, (_, index) => ({
        orderId: `create-${index}`,
        itemKey: `create-item-${index}`,
        skuCode: `create-sku-${index}`,
        previewAction: "create",
      })),
    ];
    jest.spyOn(service as any, "loadConnection").mockResolvedValue(connection);
    jest.spyOn(service as any, "fetchSyncItems").mockResolvedValue({
      mappedItems,
      searchedOrderCount: 116,
      reconciledOrderCount: 0,
      requestedOrderCount: 116,
      truncated: false,
    });
    jest.spyOn(service as any, "planOrderItem").mockImplementation(async (_db, _connection, item: any) => ({
      action: item.previewAction,
      item,
      existing: null,
      reason: null,
      changedFields: [],
    }));

    const result = (await service.previewConnection("7")) as any;

    expect(result.summary).toMatchObject({ fetched: 116, create: 16, frozen: 100 });
    expect(result.items).toHaveLength(116);
    expect(result.items.filter((item: any) => item.action === "create")).toHaveLength(16);
  });

  it("rolls back a created order only when it has not changed since the sync", async () => {
    const updatedAt = new Date("2026-08-18T02:00:00.000Z");
    const run = {
      id: 11n,
      connectionId: 7n,
      status: "success",
      rolledBackAt: null,
      changeSnapshot: {
        connectionBefore: {
          lastOrdersSyncedAt: null,
          lastSuccessfulSyncAt: null,
          lastSyncError: null,
        },
        changes: [
          {
            action: "created",
            recordId: "21",
            before: null,
            afterUpdatedAt: updatedAt.toISOString(),
          },
        ],
      },
      startedAt: new Date("2026-08-18T01:00:00.000Z"),
    };
    const tx = {
      rakutenOrderRecord: {
        findUnique: jest.fn().mockResolvedValue({
          id: 21n,
          updatedAt,
          shipmentNo: null,
          xiyaExportedAt: null,
          rawPayload: {},
        }),
        delete: jest.fn().mockResolvedValue({ id: 21n }),
        update: jest.fn(),
      },
      overseasPickingBatchItem: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      rakutenRmsConnection: { update: jest.fn().mockResolvedValue({}) },
      rakutenRmsSyncRun: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      rakutenRmsSyncRun: {
        findUnique: jest.fn().mockResolvedValue(run),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (callback) => callback(tx)),
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const result = (await service.rollbackSyncRun("11")) as any;

    expect(tx.rakutenOrderRecord.delete).toHaveBeenCalledWith({
      where: { id: 21n },
    });
    expect(result.restoredCount).toBe(1);
  });

  it("writes all confirmed order changes and the rollback snapshot in one transaction", async () => {
    const startedAt = new Date("2026-08-18T01:00:00.000Z");
    const tx = {
      rakutenRmsSyncRun: { update: jest.fn().mockResolvedValue({}) },
      rakutenRmsConnection: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      rakutenRmsSyncRun: {
        create: jest.fn().mockResolvedValue({ id: 11n, startedAt }),
        update: jest.fn(),
      },
      rakutenRmsConnection: { update: jest.fn() },
      $transaction: jest.fn(async (callback) => callback(tx)),
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);
    const item = { orderId: "421951-1", itemKey: "item-1", skuCode: "9259" };
    jest.spyOn(service as any, "planOrderItem").mockResolvedValue({
      action: "create",
      item,
      existing: null,
      reason: null,
      changedFields: [],
    });
    jest.spyOn(service as any, "applyOrderPlan").mockResolvedValue({
      action: "created",
      recordId: "21",
      before: null,
      afterUpdatedAt: "2026-08-18T01:00:01.000Z",
    });

    const result = await (service as any).runSync(
      {
        id: 7n,
        licenseExpiresAt: null,
        lastOrdersSyncedAt: null,
        lastSuccessfulSyncAt: null,
        lastSyncError: null,
        shop: { id: 3n, name: "乐天店" },
      },
      {
        mappedItems: [item],
        searchedOrderCount: 1,
        reconciledOrderCount: 0,
        requestedOrderCount: 1,
      },
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.rakutenRmsSyncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 11n },
        data: expect.objectContaining({
          createdCount: 1,
          changeSnapshot: expect.anything(),
        }),
      }),
    );
    expect(tx.rakutenRmsConnection.update).toHaveBeenCalled();
    expect(result).toMatchObject({
      syncRunId: "11",
      created: 1,
      rollbackAvailable: true,
    });
  });

  it("keeps a Japanese house number such as 8-1 as text when mapping an order", async () => {
    const prisma = {
      rakutenComboProduct: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);
    const rows = await (service as any).mapOrders([
      {
        orderNumber: "421951-20260805-0302246615",
        orderDatetime: "2026-08-05T00:56:00+0900",
        orderProgress: 300,
        DeliveryModel: { deliveryName: "宅配便", deliveryTime: "1820" },
        PackageModelList: [
          {
            SenderModel: {
              familyName: "緒方",
              firstName: "友子",
              zipCode1: "655",
              zipCode2: "0865",
              prefecture: "兵庫県",
              city: "神戸市垂水区清玄町",
              subAddress: "8-1",
              phoneNumber1: "080",
              phoneNumber2: "1434",
              phoneNumber3: "9751",
            },
            ItemModelList: [
              {
                itemDetailId: 99,
                manageNumber: "bolide-bag-in-bag",
                SkuModelList: [
                  {
                    variantId: "oty-zip-mini-hei",
                    merchantDefinedSkuId: "system-integration-sku",
                    skuInfo: "Bolide 31 / blue jean",
                  },
                ],
                itemName: "Bolide 31",
                units: 1,
              },
            ],
          },
        ],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orderId: "421951-20260805-0302246615",
      skuCode: "oty-zip-mini-hei",
      shippingPostalCode: "655-0865",
      shippingCity: "神戸市垂水区清玄町",
      shippingAddress: "8-1",
    });
    expect(rows[0].rawPayload["送付先住所それ以降の住所"]).toBe("8-1");
  });

  it("expands a combo when Rakuten returns its zh- identifier in manageNumber", async () => {
    const prisma = {
      rakutenComboProduct: {
        findMany: jest.fn().mockResolvedValue([{ comboName: "zh-combo-1", items: [
          { productId: "9259", product: { productId: "9259", productName: "组合明细A" } },
          { productId: "8736", product: { productId: "8736", productName: "组合明细B" } },
        ] }]),
      },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);

    const rows = await (service as any).mapOrders([{
      orderNumber: "421951-20260822-0868449346",
      orderProgress: 300,
      PackageModelList: [{ ItemModelList: [{
        itemDetailId: 99,
        manageNumber: "zh-combo-1",
        SkuModelList: [{ variantId: "ordinary-variant", merchantDefinedSkuId: "integration-sku" }],
        itemName: "乐天组合产品",
        units: 1,
      }] }],
    }]);

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ skuCode: "9259", comboOrderSku: "zh-combo-1", isComboOrder: true }),
      expect.objectContaining({ skuCode: "8736", comboOrderSku: "zh-combo-1", isComboOrder: true }),
    ]));
  });

  it("claims each matching CSV component after expanding an RMS combo", async () => {
    const manuallyImportedRows = ["9259", "8736"].map((skuCode, index) => ({
      id: BigInt(index + 1),
      rmsConnectionId: null,
      rmsItemKey: null,
      sourceKind: "csv",
      orderId: "421951-20260822-0868449346",
      shopName: "乐天-1号店",
      skuCode,
      comboOrderSku: "zh-combo-1",
      setComponentSkuCode: "zh-combo-1",
      dispatchMode: "overseas",
      shipmentNo: null,
      xiyaExportedAt: null,
      rmsManualOverrideAt: null,
      rawPayload: {},
      updatedAt: new Date("2026-08-24T00:00:00.000Z"),
    }));
    const prisma = {
      rakutenComboProduct: {
        findMany: jest.fn().mockResolvedValue([{
          comboName: "zh-combo-1",
          items: [
            { productId: "9259", product: { productId: "9259", productName: "组合明细A" } },
            { productId: "8736", product: { productId: "8736", productName: "组合明细B" } },
          ],
        }]),
      },
      rakutenOrderRecord: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue(manuallyImportedRows),
      },
      overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new RakutenRmsApiService(prisma, {} as RakutenRmsApiClient, {} as RakutenRmsApiCryptoService);
    const rows = await (service as any).mapOrders([{
      orderNumber: "421951-20260822-0868449346",
      orderProgress: 300,
      PackageModelList: [{ ItemModelList: [{
        itemDetailId: 99,
        manageNumber: "zh-combo-1",
        SkuModelList: [{ variantId: "ordinary-variant", merchantDefinedSkuId: "integration-sku" }],
        itemName: "乐天组合产品",
        units: 1,
      }] }],
    }]);

    const plans = await Promise.all(rows.map((item: any) => (service as any).planOrderItem(
      prisma,
      { id: 7n, shop: { id: 3n, name: "乐天-1号店" } },
      item,
    )));

    expect(plans.map((plan: any) => plan.action)).toEqual(["claim", "claim"]);
    expect(plans.map((plan: any) => plan.existing.id)).toEqual([1n, 2n]);
  });

  it("requests getOrder version 7 so SKU identifiers are included", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ OrderModelList: [] }), { status: 200 }));
    const client = new RakutenRmsApiClient();
    await client.getOrders("service-secret", "license-key", ["421951-1"]);

    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      orderNumberList: ["421951-1"],
      version: 7,
    });
  });

  it("posts automatic shipment data to updateOrderShipping without retrying the mutation", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ MessageModelList: [{ messageType: "INFO", messageCode: "OK" }] }), {
        status: 200,
      }),
    );
    const client = new RakutenRmsApiClient();
    const baskets = [{
      basketId: 1,
      ShippingModelList: [{
        shippingNumber: "390853178660",
        deliveryCompany: "1001",
        shippingDate: "2026-08-21",
        shippingDeleteFlag: 0,
      }],
    }];

    await client.updateOrderShipping("service-secret", "license-key", "421951-ORDER", baskets);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.rms.rakuten.co.jp/es/2.0/order/updateOrderShipping/",
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      orderNumber: "421951-ORDER",
      BasketidModelList: baskets,
    });
  });
});
