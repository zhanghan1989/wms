import {
  RakutenAutomationRunStatus,
  RakutenAutomationRunTrigger,
  RakutenAutomationStatus,
  RakutenOrderMailEvent,
  RakutenOrderRecord,
} from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RakutenRmsApiClient } from '../src/rakuten-rms-api/rakuten-rms-api.client';
import { RakutenRmsApiCryptoService } from '../src/rakuten-rms-api/rakuten-rms-api-crypto.service';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';

describe('Rakuten RMS shipping and mail automation', () => {
  const service = new RakutenRmsAutomationService(
    {} as PrismaService,
    {} as RakutenRmsApiClient,
    {} as RakutenRmsApiCryptoService,
  );

  const makeRow = (overrides: Partial<RakutenOrderRecord> = {}): RakutenOrderRecord => ({
    id: 1n,
    rmsConnectionId: 7n,
    rmsItemKey: 'item-1',
    sourceKind: 'rms_api',
    rmsLastSyncedAt: new Date('2026-08-21T00:00:00Z'),
    rmsManualOverrideAt: null,
    rmsManualOverrideBy: null,
    rmsManualActionType: null,
    rmsManualActionChangedFields: null,
    rmsManualActionObservedPayload: null,
    rmsManualActionObservedHash: null,
    rmsManualActionDetectedAt: null,
    rmsManualActionResolvedAt: null,
    rmsManualActionResolvedBy: null,
    rowHash: 'hash',
    orderId: '421951-ORDER',
    itemDetailStatus: null,
    skuCode: 'SKU-1',
    isComboOrder: false,
    comboOrderSku: null,
    setComponentSkuCode: null,
    orderQuantity: 1,
    productName: '商品A',
    mallName: 'Rakuten',
    shopName: '乐天店',
    mallOrderNo: '421951-ORDER',
    orderStatusText: '300',
    orderImportedAtRaw: '2026-08-21 09:00:00',
    orderImportedDate: new Date('2026-08-21T00:00:00Z'),
    orderRemark: null,
    buyerEmail: 'masked@pc.fw.rakuten.ne.jp',
    shippingName: '山田 太郎',
    shippingPostalCode: '100-0001',
    shippingPrefecture: '東京都',
    shippingCity: '千代田区',
    shippingAddress: '1-1',
    shippingPhone: '090-0000-0000',
    shipmentCompany: 'Yamato',
    shipmentNo: '390853178660',
    shipmentNoRegisteredAt: new Date('2026-08-21T00:00:00Z'),
    trackingStatusLabel: null,
    trackingHasCustomsClearance: false,
    trackingIsDelivered: false,
    trackingStatusOccurredAt: null,
    trackingCheckedAt: null,
    trackingError: null,
    dispatchMode: 'overseas',
    xiyaExportedAt: null,
    sendStatus: 'sent',
    deliveryMethod: '宅配便',
    deliveryDateRaw: null,
    deliveryTimeSlot: null,
    shipmentRequestNo: null,
    productNameExtra: null,
    sourceFileName: 'Rakuten RMS API',
    sourceFilePath: 'rms-api:7',
    rawPayload: { rmsPackage: { basketId: 1 } },
    csvImportedAt: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  });

  it('queues new-order mail only for orders first imported from September 1, 2026 JST', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const db = {
      rakutenOrderRecord: {
        findMany: jest.fn().mockResolvedValue([
          { rmsConnectionId: 7n, orderId: 'OLD-ORDER', createdAt: new Date('2026-08-31T14:59:59Z') },
          { rmsConnectionId: 7n, orderId: 'OLD-ORDER', createdAt: new Date('2026-09-01T00:00:00Z') },
          { rmsConnectionId: 7n, orderId: 'NEW-ORDER', createdAt: new Date('2026-08-31T15:00:00Z') },
        ]),
      },
      rakutenOrderMail: { createMany },
    } as any;

    await service.enqueueNewOrderMails(db, 7n, ['OLD-ORDER', 'NEW-ORDER']);

    expect(createMany).toHaveBeenCalledWith({
      data: [{ connectionId: 7n, orderId: 'NEW-ORDER', event: RakutenOrderMailEvent.new_order }],
      skipDuplicates: true,
    });
  });

  it('renders the new-order sheet with the actual buyer instead of workbook sample data', () => {
    const rendered = (service as any).renderMail(RakutenOrderMailEvent.new_order, [makeRow({
      rawPayload: {
        rmsOrder: { OrdererModel: { familyName: '購入者', firstName: '花子' } },
        rmsPackage: { basketId: 1 },
      },
    })]);

    expect(rendered.subject).toBe('【DGAZ楽天市場店】ご注文いただきありがとうございます！');
    expect(rendered.body).toContain('購入者 花子様');
    expect(rendered.body).not.toContain('江頭 亜衣菜');
    expect(rendered.body).toContain('商品レビューを書く');
  });

  it('renders separate destinations, items, and tracking numbers for a multi-basket order', () => {
    const rmsOrder = {
      OrdererModel: { familyName: '購入者', firstName: '太郎' },
      SettlementModel: { settlementMethod: 'クレジットカード 一括払い' },
      goodsPrice: 18000,
      postagePrice: 0,
      requestPrice: 18000,
    };
    const first = makeRow({
      rawPayload: {
        rmsOrder,
        rmsPackage: { basketId: 1 },
        rmsItem: { price: 9000, subtotalPrice: 9000 },
      },
    });
    const second = makeRow({
      id: 2n,
      rmsItemKey: 'item-2',
      productName: '商品B',
      shippingName: '佐藤 次郎',
      shippingPostalCode: '150-0001',
      shippingPrefecture: '東京都',
      shippingCity: '渋谷区',
      shippingAddress: '2-2',
      shipmentNo: '390853178999',
      rawPayload: {
        rmsOrder,
        rmsPackage: { basketId: 2 },
        rmsItem: { price: 9000, subtotalPrice: 9000 },
      },
    });

    const rendered = (service as any).renderMail(RakutenOrderMailEvent.japan_shipped, [first, second]);

    expect(rendered.body).toContain('[注文者] 購入者 太郎 様');
    expect(rendered.body).toContain('[送付先] 山田 太郎 様');
    expect(rendered.body).toContain('[送付先] 佐藤 次郎 様');
    expect(rendered.body).toContain('商品A');
    expect(rendered.body).toContain('商品B');
    expect(rendered.body).toContain('390853178660');
    expect(rendered.body).toContain('390853178999');
    expect(rendered.body).toContain('送付先件数   2(件)');
  });

  it('uses the factory-direct disclaimer from the China second-mail sheet', () => {
    const rendered = (service as any).renderMail(RakutenOrderMailEvent.china_customs, [makeRow({
      dispatchMode: 'china_pending',
      shipmentCompany: 'XIYA-SAGAWA',
    })]);

    expect(rendered.body).toContain('こちらの商品は工場からの直送となっており');
    expect(rendered.body).toContain('発送情報は下記のとおりでございます');
    expect(rendered.body).not.toContain('通関許可となり');
  });

  it('shows a combo purchase once instead of exposing each WMS component in buyer mail', () => {
    const rawPayload = {
      rmsOrder: { OrdererModel: { familyName: '購入者', firstName: '太郎' } },
      rmsPackage: { basketId: 1 },
      rmsItem: { itemDetailId: 88, price: 10000 },
    };
    const first = makeRow({
      rmsItemKey: 'order|88|component:A',
      productName: 'セット商品',
      rawPayload,
    });
    const second = makeRow({
      id: 2n,
      rmsItemKey: 'order|88|component:B',
      productName: 'セット商品',
      rawPayload,
    });

    const rendered = (service as any).renderMail(RakutenOrderMailEvent.japan_shipped, [first, second]);

    expect(rendered.body.match(/セット商品/g)).toHaveLength(1);
    expect(rendered.body).toContain('合計商品数   1(個)');
  });

  it('classifies a Japan/China order as mixed and selects only China rows for shipment return', () => {
    const japan = makeRow();
    const china = makeRow({
      id: 2n,
      rmsItemKey: 'item-2',
      dispatchMode: 'china_pending',
      shipmentCompany: 'XIYA-SAGAWA',
      shipmentNo: '358556700110',
      trackingHasCustomsClearance: true,
      rawPayload: { rmsPackage: { basketId: 1 } },
    });

    expect((service as any).resolveFulfillmentType([japan, china])).toBe('mixed');
    expect((service as any).isShippingCustomsReady([japan, china], 'mixed')).toBe(true);
    const selectedRows = (service as any).shippingTargetRows([japan, china], 'mixed');
    const baskets = (service as any).buildShippingBaskets(selectedRows);
    expect(baskets).toEqual([{
      basketId: 1,
      ShippingModelList: [{
        shippingNumber: '358556700110',
        deliveryCompany: '1002',
        shippingDate: '2026-08-21',
        shippingDeleteFlag: 0,
      }],
    }]);
  });

  it('recognizes a tracking number already accepted by Rakuten after an uncertain response', () => {
    const baskets = (service as any).buildShippingBaskets([makeRow()]);
    const currentOrders = [{
      PackageModelList: [{
        basketId: 1,
        ShippingModelList: [{ shippingNumber: '390853178660' }],
      }],
    }];

    expect((service as any).shippingAlreadyReported(currentOrders, baskets)).toBe(true);
  });

  it('requires tracking numbers to match the same Rakuten basket', () => {
    const baskets = (service as any).buildShippingBaskets([makeRow()]);
    const currentOrders = [{
      PackageModelList: [{
        basketId: 2,
        ShippingModelList: [{ shippingNumber: '390853178660' }],
      }],
    }];

    expect((service as any).shippingAlreadyReported(currentOrders, baskets)).toBe(false);
  });

  it('rejects an unknown carrier instead of returning a guessed Rakuten code', () => {
    expect(() => (service as any).buildShippingBaskets([
      makeRow({ shipmentCompany: 'Xiya' }),
    ])).toThrow('无法识别配送公司');
  });

  it('skips a shipment when the live Rakuten order is no longer pending shipment', async () => {
    const report = {
      id: 91n,
      connectionId: 7n,
      orderId: '421951-ORDER',
      fulfillmentType: 'japan',
      attempts: 0,
      connection: {
        encryptedServiceSecret: 'secret',
        serviceSecretIv: 'iv',
        serviceSecretAuthTag: 'tag',
        encryptedLicenseKey: 'key',
        licenseKeyIv: 'iv',
        licenseKeyAuthTag: 'tag',
        mailNotificationsEnabled: true,
      },
    };
    const prisma = {
      rakutenOrderShippingReport: {
        findMany: jest.fn().mockResolvedValue([report]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([makeRow()]) },
    } as any;
    const client = {
      getOrders: jest.fn().mockResolvedValue([{
        orderNumber: '421951-ORDER',
        orderProgress: 500,
        PackageModelList: [{ basketId: 1, ShippingModelList: [] }],
      }]),
      updateOrderShipping: jest.fn(),
    } as any;
    const crypto = { decrypt: jest.fn().mockReturnValue('credential') } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, client, crypto);

    const result = await (scopedService as any).processShippingReports(7n);

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(client.updateOrderShipping).not.toHaveBeenCalled();
    expect(prisma.rakutenOrderShippingReport.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: RakutenAutomationStatus.skipped }),
    }));
  });

  it('does not report a China tracking number before customs clearance', async () => {
    const report = {
      id: 91n,
      connectionId: 7n,
      orderId: '421951-ORDER',
      fulfillmentType: 'china',
      attempts: 0,
      connection: {
        encryptedServiceSecret: 'secret',
        serviceSecretIv: 'iv',
        serviceSecretAuthTag: 'tag',
        encryptedLicenseKey: 'key',
        licenseKeyIv: 'iv',
        licenseKeyAuthTag: 'tag',
        mailNotificationsEnabled: true,
      },
    };
    const prisma = {
      rakutenOrderShippingReport: {
        findMany: jest.fn().mockResolvedValue([report]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      rakutenOrderRecord: {
        findMany: jest.fn().mockResolvedValue([makeRow({
          dispatchMode: 'china_pending',
          shipmentCompany: 'XIYA-SAGAWA',
          shipmentNo: '358556700110',
          trackingHasCustomsClearance: false,
        })]),
      },
    } as any;
    const client = {
      getOrders: jest.fn().mockResolvedValue([{
        orderNumber: '421951-ORDER',
        orderProgress: 300,
        PackageModelList: [{ basketId: 1, ShippingModelList: [] }],
      }]),
      updateOrderShipping: jest.fn().mockResolvedValue({ MessageModelList: [] }),
    } as any;
    const crypto = { decrypt: jest.fn().mockReturnValue('credential') } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, client, crypto);

    const result = await (scopedService as any).processShippingReports(7n);

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(client.updateOrderShipping).not.toHaveBeenCalled();
  });

  it('returns only China tracking numbers for a mixed order after every China number clears customs', async () => {
    const report = {
      id: 92n,
      connectionId: 7n,
      orderId: '421951-MIXED',
      fulfillmentType: 'mixed',
      attempts: 0,
      connection: {
        encryptedServiceSecret: 'secret', serviceSecretIv: 'iv', serviceSecretAuthTag: 'tag',
        encryptedLicenseKey: 'key', licenseKeyIv: 'iv', licenseKeyAuthTag: 'tag',
        mailNotificationsEnabled: false,
      },
    };
    const rows = [
      makeRow({ orderId: '421951-MIXED', shipmentNo: 'JP-TRACKING' }),
      makeRow({
        id: 2n,
        rmsItemKey: 'item-2',
        orderId: '421951-MIXED',
        dispatchMode: 'china_pending',
        shipmentCompany: 'XIYA-SAGAWA',
        shipmentNo: 'CN-TRACKING-1',
        trackingHasCustomsClearance: true,
      }),
      makeRow({
        id: 3n,
        rmsItemKey: 'item-3',
        orderId: '421951-MIXED',
        dispatchMode: 'china_no_stock',
        shipmentCompany: 'XIYA-SAGAWA',
        shipmentNo: 'CN-TRACKING-2',
        trackingHasCustomsClearance: true,
      }),
    ];
    const prisma = {
      rakutenOrderShippingReport: {
        findMany: jest.fn().mockResolvedValue([report]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
    } as any;
    const client = {
      getOrders: jest.fn().mockResolvedValue([{
        orderNumber: '421951-MIXED',
        orderProgress: 300,
        PackageModelList: [{ basketId: 1, ShippingModelList: [] }],
      }]),
      updateOrderShipping: jest.fn().mockResolvedValue({ MessageModelList: [] }),
    } as any;
    const crypto = { decrypt: jest.fn().mockReturnValue('credential') } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, client, crypto);

    const result = await (scopedService as any).processShippingReports(7n);

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    const baskets = client.updateOrderShipping.mock.calls[0][3];
    const numbers = baskets.flatMap((basket: any) =>
      basket.ShippingModelList.map((shipping: any) => shipping.shippingNumber));
    expect(numbers).toEqual(['CN-TRACKING-1', 'CN-TRACKING-2']);
    expect(numbers).not.toContain('JP-TRACKING');
  });

  it('queues the Japan shipment mail only after its tracking number is returned to Rakuten', async () => {
    const report = {
      id: 92n,
      connectionId: 7n,
      orderId: '421951-JAPAN',
      fulfillmentType: 'japan',
      attempts: 0,
      connection: {
        encryptedServiceSecret: 'secret',
        serviceSecretIv: 'iv',
        serviceSecretAuthTag: 'tag',
        encryptedLicenseKey: 'key',
        licenseKeyIv: 'iv',
        licenseKeyAuthTag: 'tag',
        mailNotificationsEnabled: true,
      },
    };
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      rakutenOrderShippingReport: {
        findMany: jest.fn().mockResolvedValue([report]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([makeRow({ orderId: '421951-JAPAN' })]) },
      rakutenOrderMail: { upsert },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as any;
    const client = {
      getOrders: jest.fn().mockResolvedValue([{
        orderNumber: '421951-JAPAN',
        orderProgress: 300,
        PackageModelList: [{ basketId: 1, ShippingModelList: [] }],
      }]),
      updateOrderShipping: jest.fn().mockResolvedValue({ MessageModelList: [] }),
    } as any;
    const crypto = { decrypt: jest.fn().mockReturnValue('credential') } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, client, crypto);

    await (scopedService as any).processShippingReports(7n);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: {
        connectionId: 7n,
        orderId: '421951-JAPAN',
        event: RakutenOrderMailEvent.japan_shipped,
      },
    }));
  });

  it('queues the first China and mixed mails when target tracking numbers are ready without waiting for Rakuten return', async () => {
    const create = jest.fn().mockResolvedValue({});
    const rowsByOrder = new Map<string, RakutenOrderRecord[]>([
      ['CHINA', [makeRow({
        orderId: 'CHINA',
        dispatchMode: 'china_pending',
        shipmentCompany: 'XIYA-SAGAWA',
        shipmentNo: '358556700110',
        trackingHasCustomsClearance: false,
      })]],
      ['MIXED', [
        makeRow({ orderId: 'MIXED' }),
        makeRow({
          id: 2n,
          orderId: 'MIXED',
          rmsItemKey: 'item-2',
          dispatchMode: 'china_pending',
          shipmentCompany: null,
          shipmentNo: null,
          trackingHasCustomsClearance: false,
        }),
      ]],
    ]);
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ orderId: 'CHINA' }, { orderId: 'MIXED' }]),
      rakutenOrderRecord: {
        findMany: jest.fn().mockImplementation(({ where }: any) => rowsByOrder.get(where.orderId) ?? []),
      },
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({ status: RakutenAutomationStatus.sent }),
        create,
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    await (scopedService as any).prepareTrackingMails({ id: 7n });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith({
      data: { connectionId: 7n, orderId: 'CHINA', event: RakutenOrderMailEvent.china_delay },
    });
    expect(create).toHaveBeenCalledWith({
      data: { connectionId: 7n, orderId: 'MIXED', event: RakutenOrderMailEvent.mixed_partial },
    });
  });

  it('does not send a customs email before its first shipping email succeeds', async () => {
    const mail = {
      id: 52n,
      connectionId: 7n,
      orderId: '421951-ORDER',
      event: RakutenOrderMailEvent.china_customs,
      attempts: 0,
      connection: {},
    };
    const prisma = {
      rakutenOrderMail: {
        findMany: jest.fn().mockResolvedValue([mail]),
        findUnique: jest.fn().mockResolvedValue({ status: RakutenAutomationStatus.failed }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await (scopedService as any).processMails(7n);

    expect(result).toEqual({ sent: 0, failed: 0, blocked: 1 });
    expect(prisma.rakutenOrderMail.updateMany).not.toHaveBeenCalled();
    expect(prisma.rakutenOrderMail.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastError: expect.stringContaining('等待前置邮件') }),
    }));
  });

  it('does not send a dependent mail when its prerequisite record is missing', async () => {
    const mail = {
      id: 54n,
      connectionId: 7n,
      orderId: '421951-ORDER',
      event: RakutenOrderMailEvent.japan_shipped,
      attempts: 0,
      connection: {},
    };
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      rakutenOrderMail: {
        findMany: jest.fn().mockResolvedValue([mail]),
        findUnique: jest.fn().mockResolvedValue(null),
        update,
        updateMany: jest.fn(),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await (scopedService as any).processMails(7n);

    expect(result).toEqual({ sent: 0, failed: 0, blocked: 1 });
    expect(prisma.rakutenOrderMail.updateMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lastError: expect.stringContaining('等待前置邮件 new_order 生成并发送'),
      }),
    }));
  });

  it('moves a dependent mail to manual handling when its prerequisite cannot auto-recover', async () => {
    const mail = {
      id: 53n,
      connectionId: 7n,
      orderId: '421951-ORDER',
      event: RakutenOrderMailEvent.china_customs,
      attempts: 0,
      connection: {},
    };
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      rakutenOrderMail: {
        findMany: jest.fn().mockResolvedValue([mail]),
        findUnique: jest.fn().mockResolvedValue({ status: RakutenAutomationStatus.dead_letter }),
        update,
        updateMany: jest.fn(),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await (scopedService as any).processMails(7n);

    expect(result).toEqual({ sent: 0, failed: 1, blocked: 0 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: RakutenAutomationStatus.dead_letter,
        failureCategory: 'prerequisite',
        nextAttemptAt: null,
      }),
    }));
    expect(prisma.rakutenOrderMail.updateMany).not.toHaveBeenCalled();
  });

  it('retries only a failed shipping job belonging to the selected connection', async () => {
    const prisma = {
      rakutenOrderShippingReport: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      rakutenRmsConnection: { update: jest.fn().mockResolvedValue({}) },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    await scopedService.retryJob('7', { kind: 'shipping', id: '91' }, 9n);

    expect(prisma.rakutenOrderShippingReport.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 91n, connectionId: 7n }),
      data: expect.objectContaining({ status: RakutenAutomationStatus.pending, attempts: 0 }),
    }));
  });

  it('cancels dependent unsent mails when a new-order mail is cancelled', async () => {
    const updateMany = jest.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });
    const prisma = {
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({
          id: 52n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          event: RakutenOrderMailEvent.new_order,
          status: RakutenAutomationStatus.pending,
        }),
        updateMany,
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await scopedService.cancelMail('52', 9n);

    expect(result).toEqual({ cancelled: true, dependentMailsCancelled: 2 });
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        connectionId: 7n,
        orderId: '421951-ORDER',
        event: { in: expect.arrayContaining([RakutenOrderMailEvent.japan_shipped, RakutenOrderMailEvent.china_customs]) },
      }),
      data: expect.objectContaining({ status: RakutenAutomationStatus.cancelled, lastError: '前置邮件已取消' }),
    }));
  });

  it('restores a cancelled mail and its automatically cancelled dependents', async () => {
    const updateMany = jest.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({
          id: 53n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          event: RakutenOrderMailEvent.china_delay,
          status: RakutenAutomationStatus.cancelled,
        }),
        updateMany,
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await scopedService.retryMail('53', 9n);

    expect(result).toEqual({ retried: true, dependentMailsRetried: 1 });
    expect(updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ event: { in: [RakutenOrderMailEvent.china_customs] } }),
      data: expect.objectContaining({ status: RakutenAutomationStatus.pending, attempts: 0 }),
    }));
  });

  it('returns the persisted sent body and SMTP message id in mail detail', async () => {
    const prisma = {
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({
          id: 54n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          event: RakutenOrderMailEvent.japan_shipped,
          status: RakutenAutomationStatus.sent,
          bccRecipients: 'sent-archive@example.jp',
          subject: '保存済み件名',
          body: '保存済み本文',
          smtpMessageId: '<message@example>',
          connection: { id: 7n, smtpBccAddresses: 'current-archive@example.jp', shop: { id: 3n, name: '乐天店' } },
        }),
      },
      rakutenOrderRecord: { findMany: jest.fn() },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const detail = await scopedService.getMailDetail('54') as Record<string, unknown>;

    expect(detail).toMatchObject({
      id: '54',
      subject: '保存済み件名',
      body: '保存済み本文',
      bccRecipients: 'sent-archive@example.jp',
      smtpMessageId: '<message@example>',
      connection: { id: '7', shop: { id: '3', name: '乐天店' } },
    });
    expect(prisma.rakutenOrderRecord.findMany).not.toHaveBeenCalled();
  });

  it('renders both subject and body when viewing a pending mail detail', async () => {
    const prisma = {
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({
          id: 55n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          event: RakutenOrderMailEvent.new_order,
          status: RakutenAutomationStatus.pending,
          subject: null,
          body: null,
          connection: { id: 7n, smtpBccAddresses: 'archive@example.jp', shop: { id: 3n, name: '乐天店' } },
        }),
      },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([makeRow()]) },
      rakutenMailTemplateVersion: {
        findFirst: jest.fn().mockResolvedValue({
          subjectTemplate: '注文 {{order_number}}',
          bodyTemplate: '{{buyer_name}}様',
        }),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const detail = await scopedService.getMailDetail('55') as Record<string, unknown>;

    expect(detail).toMatchObject({
      id: '55',
      subject: '注文 421951-ORDER',
      body: expect.stringContaining('山田 太郎様'),
      bccRecipients: 'archive@example.jp',
      previewError: null,
    });
  });

  it('regenerates a pending mail detail from the latest WMS order instead of showing a stale send attempt', async () => {
    const prisma = {
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({
          id: 56n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          event: RakutenOrderMailEvent.new_order,
          status: RakutenAutomationStatus.failed,
          subject: '古い件名',
          body: '古い商品名',
          connection: { id: 7n, smtpBccAddresses: null, shop: { id: 3n, name: '乐天店' } },
        }),
      },
      rakutenOrderRecord: {
        findMany: jest.fn().mockResolvedValue([makeRow({ productName: 'WMSで変更した商品名' })]),
      },
      rakutenMailTemplateVersion: {
        findFirst: jest.fn().mockResolvedValue({
          subjectTemplate: '最新 {{order_number}}',
          bodyTemplate: '{{order_summary}}',
        }),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const detail = await scopedService.getMailDetail('56') as Record<string, unknown>;

    expect(detail.subject).not.toBe('古い件名');
    expect(detail.body).toEqual(expect.stringContaining('WMSで変更した商品名'));
    expect(detail.body).not.toContain('古い商品名');
  });

  it('renders the active shop template with order variables', async () => {
    const prisma = {
      rakutenMailTemplateVersion: {
        findFirst: jest.fn().mockResolvedValue({
          subjectTemplate: '発送 {{order_number}}',
          bodyTemplate: '{{buyer_name}}様\n{{tracking_sections}}',
        }),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const rendered = await (scopedService as any).renderConfiguredMail(
      7n,
      RakutenOrderMailEvent.japan_shipped,
      [makeRow({
        rawPayload: {
          rmsOrder: { OrdererModel: { familyName: '購入者', firstName: '花子' } },
          rmsPackage: { basketId: 1 },
        },
      })],
    );

    expect(rendered.subject).toBe('発送 421951-ORDER');
    expect(rendered.body).toContain('購入者 花子様');
    expect(rendered.body).toContain('390853178660');
  });

  it('previews a manual mail with the exact active shop template version', async () => {
    const connection = { id: 7n, shop: { id: 3n, name: '乐天店' } };
    const prisma = {
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({
          id: 92n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          event: RakutenOrderMailEvent.new_order,
          status: RakutenAutomationStatus.pending,
          connection,
        }),
      },
      rakutenMailTemplateVersion: {
        findUnique: jest.fn().mockResolvedValue({
          version: 3,
          subjectTemplate: '注文 {{order_number}}',
          bodyTemplate: '{{buyer_name}}様',
          isActive: true,
        }),
      },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([makeRow()]) },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'decryptSmtpCredentials').mockReturnValue({
      authId: '421951', password: 'secret', fromAddress: 'shop@example.jp', fromName: '乐天店',
      bccAddresses: ['archive@example.jp'],
    });

    const preview = await scopedService.previewManualMailAction('92', 3) as any;

    expect(prisma.rakutenMailTemplateVersion.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { connectionId_event_version: { connectionId: 7n, event: RakutenOrderMailEvent.new_order, version: 3 } },
    }));
    expect(preview).toMatchObject({
      id: '92', shopName: '乐天店', recipient: 'masked@pc.fw.rakuten.ne.jp',
      fromAddress: 'shop@example.jp', bccAddresses: ['archive@example.jp'],
      templateVersion: 3, subject: '注文 421951-ORDER', orderFingerprint: expect.stringMatching(/^[a-f0-9]{40}$/),
      requiresManualReview: false,
    });
  });

  it('marks the preview for manual review after a WMS order edit', async () => {
    const connection = { id: 7n, shop: { id: 3n, name: '乐天店' } };
    const prisma = {
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({
          id: 94n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          event: RakutenOrderMailEvent.japan_shipped,
          status: RakutenAutomationStatus.pending,
          connection,
        }),
      },
      rakutenMailTemplateVersion: {
        findUnique: jest.fn().mockResolvedValue({
          version: 3,
          subjectTemplate: '注文 {{order_number}}',
          bodyTemplate: '{{buyer_name}}様',
          isActive: true,
        }),
      },
      rakutenOrderRecord: {
        findMany: jest.fn().mockResolvedValue([makeRow({ rmsManualOverrideAt: new Date('2026-09-02T00:00:00Z') })]),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'decryptSmtpCredentials').mockReturnValue({
      fromAddress: 'shop@example.jp', fromName: '乐天店', bccAddresses: [],
    });

    const preview = await scopedService.previewManualMailAction('94', 3) as any;

    expect(preview).toMatchObject({
      requiresManualReview: true,
      manualReviewReason: 'manual_update',
    });
  });

  it('reviews manual edits or combo orders in Japan, China second, mixed first, and mixed second mails', () => {
    const manuallyUpdatedRows = [makeRow({ rmsManualOverrideAt: new Date('2026-09-02T00:00:00Z') })];
    const comboRows = [makeRow({ isComboOrder: true })];
    const bothRows = [makeRow({
      isComboOrder: true,
      rmsManualOverrideAt: new Date('2026-09-02T00:00:00Z'),
    })];

    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.japan_shipped, manuallyUpdatedRows)).toBe(true);
    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.china_customs, manuallyUpdatedRows)).toBe(true);
    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.mixed_partial, manuallyUpdatedRows)).toBe(true);
    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.mixed_customs, manuallyUpdatedRows)).toBe(true);
    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.japan_shipped, comboRows)).toBe(true);
    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.mixed_partial, comboRows)).toBe(true);
    expect((service as any).manualMailReviewReason(RakutenOrderMailEvent.japan_shipped, comboRows)).toBe('combo_order');
    expect((service as any).manualMailReviewReason(RakutenOrderMailEvent.japan_shipped, bothRows)).toBe('manual_update_and_combo');
    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.new_order, manuallyUpdatedRows)).toBe(false);
    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.new_order, comboRows)).toBe(false);
    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.china_delay, manuallyUpdatedRows)).toBe(false);
    expect((service as any).requiresManualMailReview(RakutenOrderMailEvent.china_delay, comboRows)).toBe(false);
  });

  it('blocks a confirmed mail when the WMS order changes after preview', async () => {
    const currentRows = [makeRow({ productName: 'プレビュー後の商品名' })];
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      rakutenOrderMail: {
        findMany: jest.fn().mockResolvedValue([{
          id: 93n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          event: RakutenOrderMailEvent.new_order,
          status: RakutenAutomationStatus.pending,
          attempts: 0,
          createdAt: new Date('2026-09-01T00:00:00Z'),
          connection: {},
        }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update,
      },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(currentRows) },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await (scopedService as any).processMails(
      7n,
      [93n],
      new Map([['93', 1]]),
      new Map([['93', '0'.repeat(40)]]),
    );

    expect(result).toEqual({ sent: 0, failed: 0, blocked: 1 });
    expect(update).toHaveBeenCalledWith({
      where: { id: 93n },
      data: expect.objectContaining({
        status: RakutenAutomationStatus.pending,
        attempts: { decrement: 1 },
        lastError: '订单在预览后已发生变化，请重新预览邮件后再发送',
      }),
    });
  });

  it('sends and persists the operator-edited body for a manually updated order', async () => {
    const rows = [makeRow({ rmsManualOverrideAt: new Date('2026-09-02T00:00:00Z') })];
    const mail = {
      id: 95n,
      connectionId: 7n,
      orderId: '421951-ORDER',
      event: RakutenOrderMailEvent.japan_shipped,
      attempts: 0,
      createdAt: new Date('2026-09-02T00:00:00Z'),
      connection: {
        smtpAuthId: '421951',
        encryptedSmtpPassword: 'encrypted',
        smtpPasswordIv: 'iv',
        smtpPasswordAuthTag: 'tag',
        smtpFromAddress: 'shop@example.jp',
        smtpFromName: '乐天店',
        smtpBccAddresses: null,
      },
    };
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      rakutenOrderMail: {
        findMany: jest.fn().mockResolvedValue([mail]),
        findUnique: jest.fn().mockResolvedValue({ status: RakutenAutomationStatus.sent }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update,
      },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
      rakutenMailTemplateVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any;
    const crypto = { decrypt: jest.fn().mockReturnValue('smtp-password') } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, crypto);
    const sendMail = jest.fn().mockResolvedValue({ messageId: '<accepted@example.jp>' });
    jest.spyOn(scopedService as any, 'createSmtpTransport').mockReturnValue({ sendMail, close: jest.fn() });
    const fingerprint = (scopedService as any).mailOrderFingerprint(rows);
    const editedBody = '担当者が確認・修正したメール本文';

    const result = await (scopedService as any).processMails(
      7n,
      [95n],
      new Map(),
      new Map([['95', fingerprint]]),
      new Map([['95', editedBody]]),
    );

    expect(result).toEqual({ sent: 1, failed: 0, blocked: 0 });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: editedBody }));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 95n },
      data: expect.objectContaining({ status: RakutenAutomationStatus.sent, body: editedBody }),
    }));
  });

  it('saves an edited template as the next active version', async () => {
    const tx = {
      rakutenMailTemplateVersion: {
        aggregate: jest.fn().mockResolvedValue({ _max: { version: 2 } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 71n,
          ...data,
          creator: { id: 9n, username: 'operator' },
          createdAt: new Date('2026-08-21T00:00:00Z'),
        })),
      },
    };
    const prisma = {
      rakutenRmsConnection: { findUnique: jest.fn().mockResolvedValue({ id: 7n }) },
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await scopedService.saveMailTemplate(
      '7',
      RakutenOrderMailEvent.new_order,
      { subjectTemplate: '注文 {{order_number}}', bodyTemplate: '{{buyer_name}}様\n本文\n{{signature}}' },
      9n,
    ) as Record<string, unknown>;

    expect(result).toMatchObject({ id: '71', version: 3, isActive: true, createdBy: '9' });
    expect(tx.rakutenMailTemplateVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { isActive: false },
    }));
    expect(tx.rakutenMailTemplateVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ version: 3, createdBy: 9n, isActive: true }),
    }));
  });

  it('rejects unsupported template variables before saving a version', async () => {
    const prisma = {
      rakutenRmsConnection: { findUnique: jest.fn().mockResolvedValue({ id: 7n }) },
      $transaction: jest.fn(),
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    await expect(scopedService.saveMailTemplate(
      '7',
      RakutenOrderMailEvent.new_order,
      { subjectTemplate: '注文', bodyTemplate: '{{unknown_value}}' },
      9n,
    )).rejects.toThrow('不支持的变量');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('moves an interrupted SMTP attempt to manual confirmation instead of retrying automatically', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      rakutenOrderShippingReport: { updateMany },
      rakutenOrderMail: { updateMany },
      rakutenAutomationRun: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      rakutenRmsConnection: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    await (scopedService as any).recoverStaleJobs();

    expect(updateMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
      where: expect.objectContaining({
        status: RakutenAutomationStatus.processing,
        sendStartedAt: { not: null },
      }),
      data: expect.objectContaining({
        status: RakutenAutomationStatus.uncertain,
        nextAttemptAt: null,
      }),
    }));
  });

  it('marks delivery uncertain when SMTP accepts but the sent-state write fails', async () => {
    const mail = {
      id: 81n,
      connectionId: 7n,
      orderId: '421951-ORDER',
      event: RakutenOrderMailEvent.new_order,
      attempts: 0,
      connection: {
        smtpAuthId: '421951',
        encryptedSmtpPassword: 'encrypted',
        smtpPasswordIv: 'iv',
        smtpPasswordAuthTag: 'tag',
        smtpFromAddress: 'dgaz@createbetter.co.jp',
        smtpFromName: 'DGAZ楽天市場店',
        smtpBccAddresses: 'archive@example.jp, audit@example.jp',
      },
    };
    const update = jest.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('sent-state write failed'))
      .mockResolvedValueOnce({});
    const prisma = {
      rakutenOrderMail: {
        findMany: jest.fn().mockResolvedValue([mail]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update,
      },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([makeRow()]) },
      rakutenMailTemplateVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any;
    const crypto = { decrypt: jest.fn().mockReturnValue('smtp-password') } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, crypto);
    const sendMail = jest.fn().mockResolvedValue({ messageId: '<accepted@createbetter.co.jp>' });
    jest.spyOn(scopedService as any, 'createSmtpTransport').mockReturnValue({
      sendMail,
      close: jest.fn(),
    });

    const result = await (scopedService as any).processMails(7n);

    expect(result).toEqual({ sent: 0, failed: 0, blocked: 1 });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      messageId: '<wms-rakuten-mail-81@createbetter.co.jp>',
      bcc: ['archive@example.jp', 'audit@example.jp'],
    }));
    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({ bccRecipients: 'archive@example.jp, audit@example.jp' }),
    }));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: RakutenAutomationStatus.uncertain, nextAttemptAt: null }),
    }));
  });

  it('allows a user to resolve an uncertain mail as sent without sending again', async () => {
    const prisma = {
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({ id: 82n, status: RakutenAutomationStatus.uncertain }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    await expect(scopedService.markMailAsSent('82', 9n)).resolves.toEqual({ markedSent: true });

    expect(prisma.rakutenOrderMail.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 82n, status: RakutenAutomationStatus.uncertain },
      data: expect.objectContaining({
        status: RakutenAutomationStatus.sent,
        resolvedBy: 9n,
        resolutionNote: expect.stringContaining('确认'),
      }),
    }));
  });

  it('marks a pending mail as manually ignored without cancelling its later stages', async () => {
    const prisma = {
      rakutenOrderMail: {
        findUnique: jest.fn().mockResolvedValue({ id: 83n, status: RakutenAutomationStatus.pending }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    await expect(scopedService.ignoreMail('83', 9n)).resolves.toEqual({ ignored: true });

    expect(prisma.rakutenOrderMail.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 83n, status: RakutenAutomationStatus.pending },
      data: expect.objectContaining({
        status: RakutenAutomationStatus.cancelled,
        resolvedBy: 9n,
        resolutionNote: '用户人工忽略邮件',
      }),
    }));
    expect((scopedService as any).isMailPrerequisiteSatisfied({
      status: RakutenAutomationStatus.cancelled,
      resolutionNote: '用户人工忽略邮件',
    })).toBe(true);
    expect((scopedService as any).isMailPrerequisiteSatisfied({
      status: RakutenAutomationStatus.cancelled,
      resolutionNote: '用户手动取消邮件',
    })).toBe(false);
  });

  it('marks a pending or failed shipment report as manually ignored', async () => {
    const prisma = {
      rakutenOrderShippingReport: {
        findUnique: jest.fn().mockResolvedValue({ id: 84n, status: RakutenAutomationStatus.failed }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const audit = { create: jest.fn().mockResolvedValue(undefined) } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any, audit);

    await expect(scopedService.ignoreShippingReport('84', 9n)).resolves.toEqual({ ignored: true });

    expect(prisma.rakutenOrderShippingReport.updateMany).toHaveBeenCalledWith({
      where: {
        id: 84n,
        status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed] },
      },
      data: expect.objectContaining({
        status: RakutenAutomationStatus.skipped,
        lastError: '用户人工忽略单号回传',
        nextAttemptAt: null,
      }),
    });
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 84n,
      eventType: 'rakuten_shipping_ignored',
      operatorId: 9n,
    }));
  });

  it('reports a critical shop health state for uncertain mail and failed shipping', async () => {
    const connection = {
      id: 7n,
      status: 1,
      syncOrders: true,
      autoShippingEnabled: true,
      mailNotificationsEnabled: true,
      smtpAuthId: '421951',
      encryptedSmtpPassword: 'encrypted',
      smtpPasswordIv: 'iv',
      smtpPasswordAuthTag: 'tag',
      smtpFromAddress: 'dgaz@createbetter.co.jp',
      licenseExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      lastSuccessfulSyncAt: new Date('2026-08-21T00:00:00Z'),
      lastSyncError: null,
      automationLockToken: 'active-lease',
      automationLockedAt: new Date(),
      shippingCircuitOpenedAt: null,
      shippingCircuitReason: null,
      mailCircuitOpenedAt: new Date(),
      mailCircuitReason: 'SMTP认证失败',
      shop: { id: 3n, name: '乐天店' },
    };
    const shippingGroupBy = jest.fn()
      .mockResolvedValueOnce([{ connectionId: 7n, status: RakutenAutomationStatus.failed, _count: { _all: 1 } }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ connectionId: 7n, _max: { reportedAt: new Date('2026-08-21T01:00:00Z') } }]);
    const mailGroupBy = jest.fn()
      .mockResolvedValueOnce([{ connectionId: 7n, status: RakutenAutomationStatus.uncertain, _count: { _all: 2 } }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ connectionId: 7n, _max: { sentAt: new Date('2026-08-21T02:00:00Z') } }]);
    const prisma = {
      rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([connection]) },
      rakutenOrderShippingReport: { groupBy: shippingGroupBy },
      rakutenOrderMail: { groupBy: mailGroupBy },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await scopedService.getAutomationHealth('7') as any;

    expect(result).toMatchObject({ running: true, activeConnections: 1, summary: { critical: 1 } });
    expect(prisma.rakutenRmsConnection.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7n } }));
    expect(shippingGroupBy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ connectionId: 7n, createdAt: { gte: new Date('2026-08-31T15:00:00.000Z') } }),
    }));
    expect(mailGroupBy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ connectionId: 7n, createdAt: { gte: new Date('2026-08-31T15:00:00.000Z') } }),
    }));
    expect(result.items[0]).toMatchObject({
      connectionId: '7',
      health: 'critical',
      running: true,
      circuits: { mail: { open: true, reason: 'SMTP认证失败' } },
      features: { smtpReady: true },
      mail: { uncertain: 2 },
      shipping: { failed: 1 },
    });
    expect(result.items[0].alerts).toEqual(expect.arrayContaining([
      expect.stringContaining('2封邮件发送结果待人工确认'),
      expect.stringContaining('1个单号回传失败'),
      expect.stringContaining('邮件发送已暂停'),
    ]));
  });

  it('keeps the mail management list inside the September 1 automation scope', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      rakutenOrderMail: {
        findMany,
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    await scopedService.listMails({ connectionId: '7', dateFrom: '2026-08-01' });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        connectionId: 7n,
        createdAt: expect.objectContaining({ gte: new Date('2026-08-31T15:00:00.000Z') }),
      }),
    }));
  });

  it('continues the mail stage when the shipping stage fails and persists a partial run', async () => {
    const prisma = {
      rakutenAutomationRun: {
        create: jest.fn().mockResolvedValue({ id: 301n }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'prepareShippingReports').mockRejectedValue(new Error('shipping unavailable'));
    jest.spyOn(scopedService as any, 'prepareTrackingMails').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'prepareCustomsMails').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'processMails').mockResolvedValue({ sent: 1, failed: 0, blocked: 0 });

    const result = await (scopedService as any).runConnectionAutomation({
      id: 7n,
      autoShippingEnabled: true,
      mailNotificationsEnabled: true,
      shop: { id: 3n, name: '乐天店' },
    }, RakutenAutomationRunTrigger.manual);

    expect(result).toMatchObject({
      runId: '301',
      status: RakutenAutomationRunStatus.partial,
      shipping: { sent: 0, skipped: 0, failed: 0 },
      mail: { sent: 1, failed: 0, blocked: 0 },
      errors: [expect.stringContaining('单号回传阶段')],
    });
    expect((scopedService as any).processMails).toHaveBeenCalledWith(7n);
    expect(prisma.rakutenAutomationRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: RakutenAutomationRunStatus.partial,
        mailSent: 1,
        errorMessage: expect.stringContaining('shipping unavailable'),
      }),
    }));
  });

  it('continues with later shops when one shop run fails unexpectedly', async () => {
    const connections = [
      { id: 7n, shop: { id: 3n, name: '店铺A' } },
      { id: 8n, shop: { id: 4n, name: '店铺B' } },
    ];
    const prisma = {
      rakutenRmsConnection: {
        findMany: jest.fn().mockResolvedValue(connections),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'recoverStaleJobs').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'runConnectionAutomation')
      .mockRejectedValueOnce(new Error('shop A failed'))
      .mockResolvedValueOnce({
        connectionId: '8',
        shopName: '店铺B',
        runId: '302',
        status: RakutenAutomationRunStatus.success,
        shipping: { sent: 1, skipped: 0, failed: 0 },
        mail: { sent: 1, failed: 0, blocked: 0 },
        errors: [],
      });

    const result = await scopedService.runAutomation(undefined, RakutenAutomationRunTrigger.scheduled);

    expect((scopedService as any).runConnectionAutomation).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      alreadyRunning: false,
      shippingReports: 1,
      mails: 1,
    });
    expect(result.connectionRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectionId: '7', status: RakutenAutomationRunStatus.failed }),
      expect.objectContaining({ connectionId: '8', runId: '302' }),
    ]));
  });

  it('does not start a second run when another instance holds the shop lease', async () => {
    const connection = { id: 7n, shop: { id: 3n, name: '乐天店' } };
    const prisma = {
      rakutenRmsConnection: {
        findMany: jest.fn().mockResolvedValue([connection]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'recoverStaleJobs').mockResolvedValue(undefined);
    const runConnection = jest.spyOn(scopedService as any, 'runConnectionAutomation');

    const result = await scopedService.runAutomation(7n, RakutenAutomationRunTrigger.manual);

    expect(result).toMatchObject({
      alreadyRunning: true,
      lockedConnections: 1,
      connectionRuns: [],
    });
    expect(runConnection).not.toHaveBeenCalled();
    expect(prisma.rakutenRmsConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 7n,
        OR: expect.arrayContaining([{ automationLockToken: null }, { automationLockedAt: null }]),
      }),
      data: expect.objectContaining({ automationLockToken: expect.any(String), automationLockedAt: expect.any(Date) }),
    }));
  });

  it('releases only the lease token owned by the current run', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const scopedService = new RakutenRmsAutomationService({
      rakutenRmsConnection: { updateMany },
    } as any, {} as any, {} as any);

    await (scopedService as any).releaseConnectionLock(7n, 'owned-token');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 7n, automationLockToken: 'owned-token' },
      data: { automationLockToken: null, automationLockedAt: null },
    });
  });

  it('moves a permanent SMTP authentication failure directly to manual handling', async () => {
    const update = jest.fn().mockResolvedValue({});
    const scopedService = new RakutenRmsAutomationService({
      rakutenOrderMail: { update },
    } as any, {} as any, {} as any);
    const error = Object.assign(new Error('Authentication failed'), { code: 'EAUTH', responseCode: 535 });

    await (scopedService as any).markMailFailed(91n, 1, error);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: RakutenAutomationStatus.dead_letter,
        failureCategory: 'authentication',
        deadLetteredAt: expect.any(Date),
        nextAttemptAt: null,
      }),
    }));
  });

  it('backs off a temporary RMS failure and adds deterministic jitter', async () => {
    const update = jest.fn().mockResolvedValue({});
    const scopedService = new RakutenRmsAutomationService({
      rakutenOrderShippingReport: { update },
    } as any, {} as any, {} as any);
    const before = Date.now();

    await (scopedService as any).markShippingFailed(92n, 2, new Error('乐天 RMS API 请求失败（HTTP 503）'));

    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: RakutenAutomationStatus.failed,
      failureCategory: 'temporary_remote',
      deadLetteredAt: null,
    });
    expect(data.nextAttemptAt).toBeInstanceOf(Date);
    expect(data.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(8 * 60_000);
    expect(data.nextAttemptAt.getTime() - before).toBeLessThanOrEqual(12 * 60_000);
  });

  it('stops automatic retry after the maximum attempt count', async () => {
    const update = jest.fn().mockResolvedValue({});
    const scopedService = new RakutenRmsAutomationService({
      rakutenOrderShippingReport: { update },
    } as any, {} as any, {} as any);

    await (scopedService as any).markShippingFailed(93n, 10, new Error('unknown temporary failure'));

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: RakutenAutomationStatus.dead_letter,
        failureCategory: 'max_attempts',
        nextAttemptAt: null,
      }),
    }));
  });

  it('opens the mail circuit and stops the batch after a shop-level SMTP configuration failure', async () => {
    const mails = [81n, 82n].map((id) => ({
      id,
      connectionId: 7n,
      orderId: `421951-${id.toString()}`,
      event: RakutenOrderMailEvent.new_order,
      attempts: 0,
      connection: {
        smtpAuthId: null,
        encryptedSmtpPassword: null,
        smtpPasswordIv: null,
        smtpPasswordAuthTag: null,
        smtpFromAddress: null,
      },
    }));
    const mailUpdate = jest.fn().mockResolvedValue({});
    const connectionUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      rakutenOrderMail: {
        findMany: jest.fn().mockResolvedValue(mails),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: mailUpdate,
      },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([makeRow()]) },
      rakutenRmsConnection: { update: connectionUpdate },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await (scopedService as any).processMails(7n);

    expect(result).toEqual({ sent: 0, failed: 1, blocked: 0 });
    expect(prisma.rakutenOrderMail.updateMany).toHaveBeenCalledTimes(1);
    expect(mailUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 81n },
      data: expect.objectContaining({
        status: RakutenAutomationStatus.dead_letter,
        failureCategory: 'configuration',
      }),
    }));
    expect(connectionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7n },
      data: expect.objectContaining({
        mailCircuitOpenedAt: expect.any(Date),
        mailCircuitReason: expect.stringContaining('SMTP配置不完整'),
      }),
    }));
  });

  it('skips an open circuit while allowing the other automation stage to run', async () => {
    const prisma = {
      rakutenAutomationRun: {
        create: jest.fn().mockResolvedValue({ id: 401n }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'prepareShippingReports').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'processShippingReports').mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
    const processMails = jest.spyOn(scopedService as any, 'processMails');

    const result = await (scopedService as any).runConnectionAutomation({
      id: 7n,
      autoShippingEnabled: true,
      mailNotificationsEnabled: true,
      shippingCircuitOpenedAt: null,
      mailCircuitOpenedAt: new Date(),
      mailCircuitReason: 'SMTP认证失败',
      shop: { id: 3n, name: '乐天店' },
    }, RakutenAutomationRunTrigger.manual);

    expect(result).toMatchObject({
      status: RakutenAutomationRunStatus.partial,
      shipping: { sent: 1 },
      errors: [expect.stringContaining('邮件阶段已暂停')],
    });
    expect(processMails).not.toHaveBeenCalled();
  });

  it('allows an operator to reset one circuit without changing the other circuit', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const audit = { create: jest.fn().mockResolvedValue({}) } as any;
    const scopedService = new RakutenRmsAutomationService({
      rakutenRmsConnection: { updateMany },
    } as any, {} as any, {} as any, audit);

    await expect(scopedService.resetCircuit('7', 'mail', 9n)).resolves.toEqual({ reset: true, kind: 'mail' });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 7n },
      data: { mailCircuitOpenedAt: null, mailCircuitReason: null },
    });
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 7n,
      operatorId: 9n,
      afterData: { circuit: 'mail', reset: true },
    }));
  });

  it('lists automation runs with shop, status filter, and pagination', async () => {
    const prisma = {
      rakutenAutomationRun: {
        findMany: jest.fn().mockResolvedValue([{
          id: 301n,
          connectionId: 7n,
          trigger: RakutenAutomationRunTrigger.manual,
          status: RakutenAutomationRunStatus.success,
          startedAt: new Date('2026-08-21T03:00:00Z'),
          connection: { id: 7n, shop: { id: 3n, name: '乐天店' } },
        }]),
        count: jest.fn().mockResolvedValue(1),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await scopedService.listAutomationRuns({
      connectionId: '7', status: 'success', page: '2', pageSize: '10',
    }) as any;

    expect(prisma.rakutenAutomationRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { connectionId: 7n, status: RakutenAutomationRunStatus.success },
      skip: 10,
      take: 10,
    }));
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10, items: [{ id: '301' }] });
  });

  it('lists all shipment report outcomes as read-only shop history', async () => {
    const prisma = {
      rakutenOrderShippingReport: {
        findMany: jest.fn().mockResolvedValue([{
          id: 91n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          fulfillmentType: 'china',
          status: RakutenAutomationStatus.sent,
          attempts: 1,
          reportedAt: new Date('2026-09-01T03:00:00Z'),
          updatedAt: new Date('2026-09-01T03:00:00Z'),
          connection: { id: 7n, shop: { id: 3n, name: '乐天店' } },
        }]),
        count: jest.fn().mockResolvedValue(1),
        groupBy: jest.fn().mockResolvedValue([
          { status: RakutenAutomationStatus.sent, _count: { _all: 8 } },
          { status: RakutenAutomationStatus.failed, _count: { _all: 2 } },
        ]),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);

    const result = await scopedService.listShippingReports({
      connectionId: '7', status: 'sent', orderId: '421951', page: '2', pageSize: '10',
    }) as any;

    expect(prisma.rakutenOrderShippingReport.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { connectionId: 7n, orderId: { contains: '421951' }, status: RakutenAutomationStatus.sent },
      skip: 10,
      take: 10,
    }));
    expect(prisma.rakutenOrderShippingReport.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { connectionId: 7n, orderId: { contains: '421951' } },
    }));
    expect(result).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      stats: { sent: 8, failed: 2 },
      items: [{ id: '91', connectionId: '7', status: RakutenAutomationStatus.sent }],
    });
  });

  it('keeps scheduled shipping and mail automation paused by default', async () => {
    const scopedService = new RakutenRmsAutomationService({} as any, {} as any, {} as any);
    const runAutomation = jest.spyOn(scopedService, 'runAutomation');

    await scopedService.runScheduledAutomation();

    expect(runAutomation).not.toHaveBeenCalled();
    await expect(scopedService.runConnection('7')).rejects.toThrow('自动执行当前已暂停');
  });

  it('prepares a manual worklist without executing a shipment or sending a mail', async () => {
    const connection = {
      id: 7n,
      status: 1,
      autoShippingEnabled: true,
      mailNotificationsEnabled: true,
      shippingCircuitOpenedAt: null,
      shippingCircuitReason: null,
      mailCircuitOpenedAt: null,
      mailCircuitReason: null,
      shop: { id: 3n, name: '乐天店' },
    };
    const prisma = {
      rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([connection]) },
      rakutenOrderRecord: {
        findMany: jest.fn().mockResolvedValue([{
          rmsConnectionId: 7n,
          orderId: '421951-ORDER',
          isComboOrder: true,
          rmsManualOverrideAt: null,
          createdAt: new Date('2026-09-01T00:00:00Z'),
        }]),
      },
      rakutenOrderShippingReport: {
        findMany: jest.fn().mockResolvedValue([{
          id: 91n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          fulfillmentType: 'japan',
          status: RakutenAutomationStatus.pending,
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          createdAt: new Date('2026-08-31T00:00:00Z'),
          connection,
        }]),
      },
      rakutenOrderMail: {
        findMany: jest.fn().mockResolvedValue([{
          id: 92n,
          connectionId: 7n,
          orderId: '421951-ORDER',
          event: RakutenOrderMailEvent.japan_shipped,
          status: RakutenAutomationStatus.pending,
          attempts: 0,
          recipient: null,
          subject: null,
          lastError: null,
          nextAttemptAt: null,
          createdAt: new Date('2026-08-31T00:00:01Z'),
          connection,
        }]),
        findUnique: jest.fn().mockResolvedValue({ status: RakutenAutomationStatus.sent }),
      },
      rakutenMailTemplateVersion: {
        findMany: jest.fn().mockResolvedValue([{ connectionId: 7n, event: RakutenOrderMailEvent.japan_shipped, version: 1 }]),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'recoverStaleJobs').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'prepareShippingReports').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'prepareTrackingMails').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'prepareCustomsMails').mockResolvedValue(undefined);
    const processShippingReports = jest.spyOn(scopedService as any, 'processShippingReports');
    const processMails = jest.spyOn(scopedService as any, 'processMails');

    const result = await scopedService.prepareManualActions() as any;

    expect(result).toMatchObject({
      scheduledPaused: true,
      summary: { shipping: 1, mail: 1 },
      items: [
        expect.objectContaining({ kind: 'shipping', id: '91', executable: true }),
        expect.objectContaining({
          kind: 'mail',
          id: '92',
          executable: true,
          requiresManualReview: true,
          manualReviewReason: 'combo_order',
        }),
      ],
    });
    expect(processShippingReports).not.toHaveBeenCalled();
    expect(processMails).not.toHaveBeenCalled();

    prisma.rakutenOrderMail.findMany.mockClear();
    const shippingOnly = await scopedService.prepareManualActions('shipping') as any;
    expect(shippingOnly.items).toEqual([
      expect.objectContaining({ kind: 'shipping', id: '91' }),
    ]);
    expect(prisma.rakutenOrderMail.findMany).not.toHaveBeenCalled();

    prisma.rakutenOrderShippingReport.findMany.mockClear();
    const mailOnly = await scopedService.prepareManualActions('mail') as any;
    expect(mailOnly.items).toEqual([
      expect.objectContaining({
        kind: 'mail',
        id: '92',
        requiresManualReview: true,
        manualReviewReason: 'combo_order',
      }),
    ]);
    expect(prisma.rakutenOrderShippingReport.findMany).not.toHaveBeenCalled();
    await expect(scopedService.prepareManualActions('other')).rejects.toThrow('任务类型只支持shipping或mail');
  });

  it('returns all mail stages for each actionable order without making sent stages executable', async () => {
    const connection = {
      id: 7n,
      status: 1,
      autoShippingEnabled: false,
      mailNotificationsEnabled: true,
      shippingCircuitOpenedAt: null,
      mailCircuitOpenedAt: null,
      shop: { id: 3n, name: '乐天店' },
    };
    const sentAt = new Date('2026-09-01T01:00:00Z');
    const newOrderMail = {
      id: 92n,
      connectionId: 7n,
      orderId: '421951-ORDER',
      event: RakutenOrderMailEvent.new_order,
      status: RakutenAutomationStatus.sent,
      attempts: 1,
      sentAt,
      nextAttemptAt: null,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      connection,
    };
    const shippingMail = {
      id: 93n,
      connectionId: 7n,
      orderId: '421951-ORDER',
      event: RakutenOrderMailEvent.japan_shipped,
      status: RakutenAutomationStatus.pending,
      attempts: 0,
      sentAt: null,
      nextAttemptAt: null,
      createdAt: new Date('2026-09-01T02:00:00Z'),
      connection,
    };
    const prisma = {
      rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([connection]) },
      rakutenOrderMail: {
        findMany: jest.fn()
          .mockResolvedValueOnce([shippingMail])
          .mockResolvedValueOnce([newOrderMail, shippingMail]),
        findUnique: jest.fn().mockResolvedValue({ status: RakutenAutomationStatus.sent }),
      },
      rakutenOrderRecord: {
        findMany: jest.fn().mockResolvedValue([{
          rmsConnectionId: 7n,
          orderId: '421951-ORDER',
          dispatchMode: 'overseas',
          createdAt: new Date('2026-09-01T00:00:00Z'),
        }]),
      },
      rakutenMailTemplateVersion: {
        findMany: jest.fn().mockResolvedValue([{ connectionId: 7n, event: RakutenOrderMailEvent.japan_shipped, version: 2 }]),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'recoverStaleJobs').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'prepareTrackingMails').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'prepareCustomsMails').mockResolvedValue(undefined);

    const result = await scopedService.prepareManualActions('mail') as any;

    expect(result.summary).toEqual({ mail: 1 });
    expect(result.items).toEqual([
      expect.objectContaining({
        id: '92',
        event: RakutenOrderMailEvent.new_order,
        status: RakutenAutomationStatus.sent,
        fulfillmentType: 'japan',
        sentAt: sentAt.toISOString(),
        executable: false,
      }),
      expect.objectContaining({
        id: '93',
        event: RakutenOrderMailEvent.japan_shipped,
        status: RakutenAutomationStatus.pending,
        fulfillmentType: 'japan',
        executable: true,
      }),
    ]);
  });

  it('omits an order from the manual mail dialog after every mail stage is complete', async () => {
    const connection = {
      id: 7n,
      status: 1,
      autoShippingEnabled: false,
      mailNotificationsEnabled: true,
      mailCircuitOpenedAt: null,
      shop: { id: 3n, name: '乐天店' },
    };
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([connection]) },
      rakutenOrderMail: { findMany },
      rakutenOrderRecord: { findMany: jest.fn() },
      rakutenMailTemplateVersion: { findMany: jest.fn() },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'recoverStaleJobs').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'prepareTrackingMails').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'prepareCustomsMails').mockResolvedValue(undefined);

    const result = await scopedService.prepareManualActions('mail') as any;

    expect(result).toMatchObject({ items: [], totalOrders: 0, totalPages: 0 });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: { in: [
          RakutenAutomationStatus.pending,
          RakutenAutomationStatus.failed,
          RakutenAutomationStatus.uncertain,
          RakutenAutomationStatus.dead_letter,
        ] },
      }),
    }));
  });

  it('shows China and mixed shipment returns only after every China tracking number clears customs', async () => {
    const connection = {
      id: 7n,
      status: 1,
      autoShippingEnabled: true,
      mailNotificationsEnabled: false,
      shippingCircuitOpenedAt: null,
      shippingCircuitReason: null,
      shop: { id: 3n, name: '乐天店' },
    };
    const makeReport = (id: bigint, orderId: string, fulfillmentType: string) => ({
      id,
      connectionId: 7n,
      orderId,
      fulfillmentType,
      status: RakutenAutomationStatus.pending,
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      connection,
    });
    const shippingReports = [
      makeReport(91n, 'JAPAN', 'japan'),
      makeReport(92n, 'CHINA-WAITING', 'china'),
      makeReport(93n, 'MIXED-WAITING', 'mixed'),
      makeReport(94n, 'CHINA-READY', 'china'),
      makeReport(95n, 'MIXED-READY', 'mixed'),
    ];
    const prisma = {
      rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([connection]) },
      rakutenOrderShippingReport: { findMany: jest.fn().mockResolvedValue(shippingReports) },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'recoverStaleJobs').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'prepareShippingReports').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'loadEligibleAutomationOrderKeys').mockResolvedValue(new Set([
      '7:JAPAN', '7:CHINA-WAITING', '7:MIXED-WAITING', '7:CHINA-READY', '7:MIXED-READY',
    ]));
    jest.spyOn(scopedService as any, 'loadOrderRows').mockImplementation(async (_connectionId, orderId) => {
      if (orderId === 'JAPAN') return [{ dispatchMode: 'japan_stock' }];
      if (orderId === 'CHINA-WAITING') {
        return [{ dispatchMode: 'china_pending', shipmentNo: 'CN-WAITING', trackingHasCustomsClearance: false }];
      }
      if (orderId === 'MIXED-WAITING') return [
        { dispatchMode: 'japan_stock', shipmentNo: 'JP-1' },
        { dispatchMode: 'china_pending', shipmentNo: 'CN-CLEARED', trackingHasCustomsClearance: true },
        { dispatchMode: 'china_pending', shipmentNo: 'CN-WAITING', trackingHasCustomsClearance: false },
      ];
      if (orderId === 'CHINA-READY') return [
        { dispatchMode: 'china_pending', shipmentNo: 'CN-1', trackingHasCustomsClearance: true },
        { dispatchMode: 'china_no_stock', shipmentNo: 'CN-2', trackingHasCustomsClearance: true },
      ];
      return [
        { dispatchMode: 'japan_stock', shipmentNo: 'JP-1' },
        { dispatchMode: 'china_pending', shipmentNo: 'CN-1', trackingHasCustomsClearance: true },
        { dispatchMode: 'china_no_stock', shipmentNo: 'CN-2', trackingHasCustomsClearance: true },
      ];
    });

    const result = await scopedService.prepareManualActions({ kind: 'shipping', connectionId: '7' }) as any;

    expect(prisma.rakutenRmsConnection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 7n, autoShippingEnabled: true }),
    }));
    expect(result.items.map((item: any) => item.orderId)).toEqual(['CHINA-READY', 'JAPAN', 'MIXED-READY']);
    expect(result.items.find((item: any) => item.orderId === 'MIXED-READY')).toMatchObject({
      actionLabel: '回传混发订单的中国快递单号',
    });
  });

  it('limits manual shipment processing to the explicitly selected task ids', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const scopedService = new RakutenRmsAutomationService({
      rakutenOrderShippingReport: { findMany },
    } as any, {} as any, {} as any);

    await (scopedService as any).processShippingReports(7n, [91n, 93n]);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ connectionId: 7n, id: { in: [91n, 93n] } }),
      take: 2,
    }));
  });

  it('executes only the explicitly confirmed manual worklist items', async () => {
    const connection = {
      id: 7n,
      status: 1,
      autoShippingEnabled: true,
      mailNotificationsEnabled: true,
      shippingCircuitOpenedAt: null,
      mailCircuitOpenedAt: null,
      shop: { id: 3n, name: '乐天店' },
    };
    const shippingRow = {
      id: 91n,
      connectionId: 7n,
      orderId: '421951-SHIPPING',
      status: RakutenAutomationStatus.pending,
      nextAttemptAt: null,
      connection,
    };
    const mailRow = {
      id: 92n,
      connectionId: 7n,
      orderId: '421951-MAIL',
      event: RakutenOrderMailEvent.new_order,
      status: RakutenAutomationStatus.pending,
      nextAttemptAt: null,
      connection,
    };
    const prisma = {
      rakutenOrderRecord: {
        findMany: jest.fn().mockResolvedValue([
          { rmsConnectionId: 7n, orderId: '421951-SHIPPING', createdAt: new Date('2026-09-01T00:00:00Z') },
          { rmsConnectionId: 7n, orderId: '421951-MAIL', createdAt: new Date('2026-09-01T00:00:00Z') },
        ]),
      },
      rakutenOrderShippingReport: { findMany: jest.fn().mockResolvedValue([shippingRow]) },
      rakutenOrderMail: { findMany: jest.fn().mockResolvedValue([mailRow]) },
      rakutenMailTemplateVersion: {
        findFirst: jest.fn().mockResolvedValue({ version: 1 }),
      },
      rakutenAutomationRun: {
        create: jest.fn().mockResolvedValue({ id: 501n }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'acquireConnectionLock').mockResolvedValue(true);
    jest.spyOn(scopedService as any, 'startConnectionLockHeartbeat').mockReturnValue({});
    jest.spyOn(scopedService as any, 'releaseConnectionLock').mockResolvedValue(undefined);
    const processShipping = jest.spyOn(scopedService as any, 'processShippingReports')
      .mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
    const processMails = jest.spyOn(scopedService as any, 'processMails')
      .mockResolvedValue({ sent: 1, failed: 0, blocked: 0 });

    const result = await scopedService.executeManualActions([
      { kind: 'shipping', id: '91' },
      { kind: 'mail', id: '92', templateVersion: 1 },
    ]) as any;

    expect(processShipping).toHaveBeenCalledWith(7n, [91n]);
    expect(processMails).toHaveBeenCalledWith(7n, [92n], new Map([['92', 1]]), new Map(), new Map());
    expect(result).toMatchObject({
      executed: 2,
      results: [{ shipping: { sent: 1 }, mail: { sent: 1 }, status: RakutenAutomationRunStatus.success }],
    });
  });

  it('keeps shop templates isolated when manually sending a cross-shop batch', async () => {
    const connections = [
      {
        id: 7n,
        status: 1,
        autoShippingEnabled: false,
        mailNotificationsEnabled: true,
        shippingCircuitOpenedAt: null,
        mailCircuitOpenedAt: null,
        shop: { id: 3n, name: '乐天1号店' },
      },
      {
        id: 8n,
        status: 1,
        autoShippingEnabled: false,
        mailNotificationsEnabled: true,
        shippingCircuitOpenedAt: null,
        mailCircuitOpenedAt: null,
        shop: { id: 4n, name: '乐天2号店' },
      },
    ];
    const mailRows = connections.map((connection, index) => ({
      id: BigInt(92 + index),
      connectionId: connection.id,
      orderId: `ORDER-${index + 1}`,
      event: RakutenOrderMailEvent.new_order,
      status: RakutenAutomationStatus.pending,
      nextAttemptAt: null,
      connection,
    }));
    const findTemplate = jest.fn().mockImplementation(({ where }: any) => ({
      version: 1,
      subjectTemplate: where.connectionId === 7n
        ? '1号店 {{order_number}}'
        : '2号店 {{order_number}}',
      bodyTemplate: where.connectionId === 7n ? '1号店正文' : '2号店正文',
    }));
    const prisma = {
      rakutenOrderRecord: {
        findMany: jest.fn().mockResolvedValue(mailRows.map((row) => ({
          rmsConnectionId: row.connectionId,
          orderId: row.orderId,
          createdAt: new Date('2026-09-01T00:00:00Z'),
        }))),
      },
      rakutenOrderShippingReport: { findMany: jest.fn().mockResolvedValue([]) },
      rakutenOrderMail: { findMany: jest.fn().mockResolvedValue(mailRows) },
      rakutenMailTemplateVersion: { findFirst: findTemplate },
      rakutenAutomationRun: {
        create: jest.fn()
          .mockResolvedValueOnce({ id: 501n })
          .mockResolvedValueOnce({ id: 502n }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const scopedService = new RakutenRmsAutomationService(prisma, {} as any, {} as any);
    jest.spyOn(scopedService as any, 'acquireConnectionLock').mockResolvedValue(true);
    jest.spyOn(scopedService as any, 'startConnectionLockHeartbeat').mockReturnValue({});
    jest.spyOn(scopedService as any, 'releaseConnectionLock').mockResolvedValue(undefined);
    jest.spyOn(scopedService as any, 'processShippingReports')
      .mockResolvedValue({ sent: 0, skipped: 0, failed: 0 });
    const renderedSubjects = new Map<string, string>();
    const processMails = jest.spyOn(scopedService as any, 'processMails')
      .mockImplementation(async (...args: unknown[]) => {
        const connectionId = args[0] as bigint;
        const selectedIds = args[1] as bigint[];
        const row = mailRows.find((item) => item.connectionId === connectionId);
        expect(selectedIds).toEqual(row ? [row.id] : []);
        if (!row) throw new Error('test mail row is missing');
        const rendered = await (scopedService as any).renderConfiguredMail(
          connectionId,
          row.event,
          [makeRow({
            rmsConnectionId: connectionId,
            orderId: row.orderId,
            mallOrderNo: row.orderId,
          })],
        );
        renderedSubjects.set(connectionId.toString(), rendered.subject);
        return { sent: 1, failed: 0, blocked: 0 };
      });

    const result = await scopedService.executeManualActions([
      { kind: 'mail', id: '92', templateVersion: 1 },
      { kind: 'mail', id: '93', templateVersion: 1 },
    ]) as any;

    expect(processMails).toHaveBeenNthCalledWith(1, 7n, [92n], new Map([['92', 1]]), new Map(), new Map());
    expect(processMails).toHaveBeenNthCalledWith(2, 8n, [93n], new Map([['93', 1]]), new Map(), new Map());
    expect(findTemplate).toHaveBeenCalledWith(expect.objectContaining({
      where: { connectionId: 7n, event: RakutenOrderMailEvent.new_order, isActive: true },
    }));
    expect(findTemplate).toHaveBeenCalledWith(expect.objectContaining({
      where: { connectionId: 8n, event: RakutenOrderMailEvent.new_order, isActive: true },
    }));
    expect(renderedSubjects).toEqual(new Map([
      ['7', '1号店 ORDER-1'],
      ['8', '2号店 ORDER-2'],
    ]));
    expect(result).toMatchObject({
      executed: 2,
      results: [
        { connectionId: '7', shopName: '乐天1号店', mail: { sent: 1 } },
        { connectionId: '8', shopName: '乐天2号店', mail: { sent: 1 } },
      ],
    });
  });
});
