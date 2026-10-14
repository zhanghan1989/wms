import { OrdersService } from '../src/orders/orders.service';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';
import { buildOrderWorkflow, japanWarehouseReady, mailConditionReason } from '../src/rakuten-rms-api/rakuten-order-workflow';

const registered = new Date('2026-10-12T02:00:00Z');
const shipped = new Date('2026-10-13T02:00:00Z');
const order = (extra = {}) => ({ id: 1n, orderId: 'ORDER', rmsConnectionId: 7n, sourceKind: 'rms_api', createdAt: registered,
  shipmentNo: 'JP-1', shipmentNoRegisteredAt: registered, warehouseShippedAt: shipped, warehouseShippedBy: 9n,
  shipmentCompany: 'Yamato', dispatchMode: 'overseas', orderStatusText: '300', orderQuantity: 1,
  rawPayload: { rmsPackage: { basketId: 1 } }, ...extra } as any);
function warehouse(batchExtra = {}) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    overseasPickingBatch: { findUnique: jest.fn().mockResolvedValue({ id: 42n, batchNo: 'PK-42', status: 'yamato_exported', ...batchExtra }), update: jest.fn() },
    yamatoShipmentBatch: { findFirst: jest.fn().mockResolvedValue({ id: 16n, status: 'pdf_ready', pageCount: 1 }) },
    printJob: { count: jest.fn().mockResolvedValue(0) },
    yamatoShipmentBatchPage: { findMany: jest.fn().mockResolvedValue([{ printedAt: shipped }]) },
    overseasPickingBatchItem: { findMany: jest.fn().mockResolvedValue([{ sourceRecordId: 1n, requestedQty: 1, actualQty: 1, shipmentTrackingNo: 'JP-1' }]) },
    rakutenOrderRecord: { findUnique: jest.fn().mockResolvedValue(order({ warehouseShippedAt: null })), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const service = new OrdersService({ $transaction: jest.fn(async (cb: any) => cb(tx)) } as any);
  return { service, tx };
}

describe('Japanese fulfilment warehouse confirmation', () => {
  it('records actual dispatch time and operator on batch and eligible Japan order rows', async () => {
    const { service, tx } = warehouse();
    await service.completeOverseasPickingBatchWork('42', 9n);
    const batch = tx.overseasPickingBatch.update.mock.calls[0][0].data;
    expect(batch).toMatchObject({ status: 'completed', workCompletedAt: expect.any(Date), workCompletedBy: 9n });
    expect(tx.rakutenOrderRecord.updateMany).toHaveBeenCalledWith({ where: {
      id: 1n, deletedAt: null, OR: [{ dispatchMode: null }, { dispatchMode: { notIn: ['china_pending', 'china_no_stock'] } }],
      shipmentNo: 'JP-1', shipmentCompany: 'Yamato', orderQuantity: 1, warehouseShippedAt: null,
    }, data: { warehouseShippedAt: batch.workCompletedAt, warehouseShippedBy: 9n } });
  });
  it('does not infer dispatch for older completed batches until they are explicitly reconfirmed', async () => {
    const { service, tx } = warehouse({ status: 'completed', workCompletedAt: null });
    await service.completeOverseasPickingBatchWork('42', 9n);
    expect(tx.overseasPickingBatch.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workCompletedAt: expect.any(Date) }) }));
  });
  it('preserves the original dispatch time and actor on repeated confirmations', async () => {
    const { service, tx } = warehouse({ status: 'completed', workCompletedAt: shipped, workCompletedBy: 8n });
    await service.completeOverseasPickingBatchWork('42', 9n);
    expect(tx.rakutenOrderRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { warehouseShippedAt: shipped, warehouseShippedBy: 8n } }));
    expect(tx.overseasPickingBatch.update).not.toHaveBeenCalled();
  });
  it('does not confirm a partially picked row or one without the batch tracking number', async () => {
    const { service, tx } = warehouse();
    tx.overseasPickingBatchItem.findMany.mockResolvedValue([
      { sourceRecordId: 1n, requestedQty: 2, actualQty: 1, shipmentTrackingNo: 'JP-1' },
      { sourceRecordId: 2n, requestedQty: 1, actualQty: 1, shipmentTrackingNo: '' },
    ]);
    await expect(service.completeOverseasPickingBatchWork('42', 9n)).rejects.toThrow('不完整');
    expect(tx.rakutenOrderRecord.updateMany).not.toHaveBeenCalled();
  });
  it('never confirms dispatch while a print or reprint job remains outstanding', async () => {
    const { service, tx } = warehouse(); tx.printJob.count.mockResolvedValue(1);
    await expect(service.completeOverseasPickingBatchWork('42', 9n)).rejects.toThrow('补打');
    expect(tx.rakutenOrderRecord.updateMany).not.toHaveBeenCalled();
  });
  it('refuses dispatch confirmation when the current order number or quantity differs from the batch', async () => {
    const { service, tx } = warehouse();
    tx.rakutenOrderRecord.findUnique.mockResolvedValue(order({ shipmentNo: 'OTHER', warehouseShippedAt: null }));
    await expect(service.completeOverseasPickingBatchWork('42', 9n)).rejects.toThrow('不一致');
    expect(tx.overseasPickingBatch.update).not.toHaveBeenCalled();
  });
  it('rechecks the printed package identity even on an already completed batch', async () => {
    const { service, tx } = warehouse({ status: 'completed', workCompletedAt: shipped });
    tx.rakutenOrderRecord.findUnique.mockResolvedValue(order({ shipmentNo: 'OTHER' }));
    await expect(service.completeOverseasPickingBatchWork('42', 9n)).rejects.toThrow('不一致');
    expect(tx.rakutenOrderRecord.updateMany).not.toHaveBeenCalled();
  });
  it('does not confirm a carrier that differs from the Yamato label', async () => {
    const { service, tx } = warehouse();
    tx.rakutenOrderRecord.findUnique.mockResolvedValue(order({ shipmentCompany: 'Sagawa', warehouseShippedAt: null }));
    await expect(service.completeOverseasPickingBatchWork('42', 9n)).rejects.toThrow('不一致');
  });
  it('rolls back completion when shipment facts change before the confirmation write', async () => {
    const { service, tx } = warehouse();
    tx.rakutenOrderRecord.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.completeOverseasPickingBatchWork('42', 9n)).rejects.toThrow('确认期间发生变化');
    expect(tx.overseasPickingBatch.update).not.toHaveBeenCalled();
  });
  it('can confirm legacy Japanese rows whose dispatch mode is null', async () => {
    const { service, tx } = warehouse();
    tx.rakutenOrderRecord.findUnique.mockResolvedValue(order({ dispatchMode: null, warehouseShippedAt: null }));
    await expect(service.completeOverseasPickingBatchWork('42', 9n)).resolves.toMatchObject({ status: 'completed' });
    expect(tx.rakutenOrderRecord.updateMany.mock.calls[0][0].where.OR).toContainEqual({ dispatchMode: null });
  });
  it('requires confirmation for every Japanese package before reporting or mailing', () => {
    const rows = [order(), order({ id: 2n, warehouseShippedAt: null })];
    expect(japanWarehouseReady(rows)).toBe(false);
    expect(mailConditionReason('japan_shipped', rows, { status: 'sent' } as any)).toContain('仓库');
    const flow = buildOrderWorkflow({ rows, connection: { id: 7n, status: 1, autoShippingEnabled: true, mailNotificationsEnabled: true, shop: { name: '店铺' } } as any,
      report: { id: 20n, status: 'pending', fulfillmentType: 'japan' } as any,
      mails: [{ id: 10n, event: 'new_order', status: 'pending' }] as any, templateVersions: new Map([['new_order', 1]]) });
    expect(flow.steps.find((step) => step.event === 'new_order')).toMatchObject({ state: 'ready', requiresManualReview: false });
    expect(flow.steps.find((step) => step.event === 'shipping')?.reason).toContain('新規');
  });
  it('does not call Rakuten when only a tracking number has been registered', async () => {
    const report = { id: 20n, connectionId: 7n, orderId: 'ORDER', status: 'pending', attempts: 0, fulfillmentType: 'japan' };
    const getOrders = jest.fn(); const claim = jest.fn(); const update = jest.fn();
    const service = new RakutenRmsAutomationService({ rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([order({ warehouseShippedAt: null })]) },
      rakutenOrderShippingReport: { findMany: jest.fn().mockResolvedValue([report]), updateMany: claim, update } } as any, { getOrders } as any, {} as any);
    await (service as any).processShippingReports(7n);
    expect(getOrders).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failureCategory: 'waiting_conditions' }) }));
  });
  it('never substitutes registration day or today for actual Japan dispatch day', () => {
    const service = new RakutenRmsAutomationService({} as any, {} as any, {} as any);
    expect((service as any).renderTrackingLines([order()])).toContain('[発送日] 2026年10月13日');
    expect(() => (service as any).renderTrackingLines([order({ warehouseShippedAt: null })])).toThrow('实际出货');
    expect(() => (service as any).formatShippingDate(null)).toThrow('实际出货');
    expect(() => (service as any).formatShippingDate(new Date('invalid'))).toThrow('有效');
  });
  it('reports the confirmed dispatch date and persists Japan mail even while notifications are disabled', async () => {
    const upsert = jest.fn().mockResolvedValue({}); const updateOrderShipping = jest.fn().mockResolvedValue({});
    const report = { id: 20n, connectionId: 7n, orderId: 'ORDER', status: 'pending', attempts: 0, fulfillmentType: 'japan', connection: { mailNotificationsEnabled: false } };
    const prisma = { rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([order()]) },
      rakutenOrderShippingReport: { findMany: jest.fn().mockResolvedValue([report]), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}) },
      rakutenOrderMail: { upsert }, $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)) };
    const service = new RakutenRmsAutomationService(prisma as any, { getOrders: jest.fn().mockResolvedValue([{ orderNumber: 'ORDER', orderProgress: 300 }]), updateOrderShipping } as any, {} as any);
    jest.spyOn(service as any, 'decryptApiCredentials').mockReturnValue({ serviceSecret: 'test', licenseKey: 'test' });
    expect(await (service as any).processShippingReports(7n)).toMatchObject({ sent: 1 });
    expect(updateOrderShipping.mock.calls[0][3][0].ShippingModelList[0].shippingDate).toBe('2026-10-13');
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { connectionId: 7n, orderId: 'ORDER', event: 'japan_shipped' } }));
  });
});

describe('single task preparation entry', () => {
  function prepare(locked = false) {
    const service = new RakutenRmsAutomationService({ rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([{ id: 7n, autoShippingEnabled: true, mailNotificationsEnabled: true }]) } } as any, {} as any, {} as any);
    jest.spyOn(service as any, 'recoverStaleJobs').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'acquireConnectionLock').mockResolvedValue(!locked);
    jest.spyOn(service as any, 'startConnectionLockHeartbeat').mockReturnValue(undefined);
    const release = jest.spyOn(service as any, 'releaseConnectionLock').mockResolvedValue(undefined);
    const shipping = jest.spyOn(service as any, 'prepareShippingReports').mockResolvedValue(undefined);
    for (const name of ['refreshMailHolds', 'prepareTrackingMails', 'prepareCustomsMails']) jest.spyOn(service as any, name).mockResolvedValue(undefined);
    const send = jest.spyOn(service as any, 'processMails'); const report = jest.spyOn(service as any, 'processShippingReports');
    return { service, release, shipping, send, report };
  }
  it('prepares tasks without invoking the external send or return paths', async () => {
    const { service, release, send, report } = prepare();
    expect(await service.prepareOrderTasks('7')).toEqual({ preparedConnections: 1, lockedConnections: 0 });
    expect(send).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
  });
  it('skips a busy shop without creating tasks during deletion or sending', async () => {
    const { service, shipping } = prepare(true);
    expect(await service.prepareOrderTasks('7')).toEqual({ preparedConnections: 0, lockedConnections: 1 });
    expect(shipping).not.toHaveBeenCalled();
  });
  it('releases its lock if task preparation fails', async () => {
    const { service, shipping, release } = prepare(); shipping.mockRejectedValue(new Error('unavailable'));
    await expect(service.prepareOrderTasks('7')).rejects.toThrow('unavailable'); expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('China and mixed outbound safety', () => {
  it('waits for actual Japan dispatch before a mixed first notification', () => {
    const rows = [order({ warehouseShippedAt: null }), order({ id: 2n, dispatchMode: 'china_pending' })];
    expect(mailConditionReason('mixed_partial', rows)).toContain('实际出货');
    expect(mailConditionReason('mixed_partial', [order(), rows[1]])).toBeNull();
  });
  it('requires external mail verification for both China and mixed clearance notifications', () => {
    const china = order({ dispatchMode: 'china_pending', trackingHasCustomsClearance: true, trackingCustomsClearanceDate: shipped });
    const report = { status: 'skipped', lastError: '乐天侧在本次自动任务前已经存在相同快递单号，按人工或其他系统回传处理' } as any;
    expect(mailConditionReason('china_customs', [china], report)).toContain('外部');
    expect(mailConditionReason('mixed_customs', [order(), china], report)).toContain('外部');
  });
  it('does not describe delayed clearance notifications as dispatched today', () => {
    const service = new RakutenRmsAutomationService({} as any, {} as any, {} as any);
    for (const event of ['china_customs', 'mixed_customs']) {
      const template = (service as any).defaultMailTemplate(event);
      expect(template.bodyTemplate).not.toContain('本日発送');
      expect(template.bodyTemplate).not.toContain('最短お届け日を設定');
    }
  });
});

// These unit fixtures bypass orchestration; lock ownership is tested separately.
beforeEach(() => {
  jest.spyOn(RakutenRmsAutomationService.prototype as any, "assertExecutionLock").mockResolvedValue(undefined);
  jest.spyOn(RakutenRmsAutomationService.prototype as any, "shippingPrerequisiteSatisfied").mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());
