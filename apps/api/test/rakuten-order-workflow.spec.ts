import { RakutenOrderMail, RakutenOrderRecord, RakutenOrderShippingReport, RakutenRmsConnection } from '@prisma/client';
import { buildOrderWorkflow, IGNORED_MAIL, mailConditionReason, mailReviewReason, shippingFingerprint, trackingReady, VERIFIED_SHIPPING } from '../src/rakuten-rms-api/rakuten-order-workflow';
import { RakutenRmsAutomationService } from '../src/rakuten-rms-api/rakuten-rms-automation.service';

const date = new Date('2026-10-01T00:00:00Z');
const row = (overrides: Partial<RakutenOrderRecord> = {}): RakutenOrderRecord => ({
  id: 1n, rmsConnectionId: 7n, rmsOrderId: null, orderId: 'ORDER', sourceKind: 'rms_api', createdAt: date,
  rawPayload: { rmsPackage: { basketId: 1 }, rmsItem: { itemName: 'セット商品', itemDetailId: 11 } },
  shippingName: '購入者', shippingPostalCode: '123-4567', shippingPrefecture: '東京都', shippingCity: '千代田区', shippingAddress: '1-2-3',
  productName: '箱', skuCode: 'BOX', orderQuantity: 2, buyerEmail: 'buyer@example.jp',
  warehouseShippedAt: date, warehouseShippedBy: 9n,
  dispatchMode: 'japan', shipmentNo: 'JP-1', shipmentCompany: 'Yamato', shipmentNoRegisteredAt: date,
  orderStatusText: '300', ...overrides,
} as RakutenOrderRecord);
const connection = { id: 7n, status: 1, autoShippingEnabled: true, mailNotificationsEnabled: true, shop: { name: '店铺' } } as RakutenRmsConnection & { shop: { name: string } };
const mail = (event: string, overrides: Partial<RakutenOrderMail> = {}) => ({
  id: 10n, connectionId: 7n, orderId: 'ORDER', event, status: 'pending', ...overrides,
} as RakutenOrderMail);
const report = (rows: RakutenOrderRecord[], overrides: Partial<RakutenOrderShippingReport> = {}) => ({
  id: 20n, connectionId: 7n, orderId: 'ORDER', fulfillmentType: 'japan', status: 'sent',
  fingerprint: shippingFingerprint(rows), ...overrides,
} as RakutenOrderShippingReport);
const workflow = (rows: RakutenOrderRecord[], mails: RakutenOrderMail[], shipping: RakutenOrderShippingReport | null = null) => buildOrderWorkflow({
  rows, connection, report: shipping, mails,
  templateVersions: new Map(['new_order', 'japan_shipped', 'china_delay', 'china_customs', 'mixed_partial', 'mixed_customs'].map((event) => [event, 1])), now: date,
});

describe('order-level Rakuten workflow', () => {
  it('keeps new-order acknowledgement and shipping independent of product-content review', () => {
    const rows = [row({ rmsManualOverrideAt: date, orderRemark: '交換の説明' })];
    const result = workflow(rows, [mail('new_order')], report(rows, { status: 'pending' }));
    expect(result.steps.find((step) => step.event === 'new_order')).toMatchObject({ state: 'ready', requiresManualReview: false });
    expect(result.steps.find((step) => step.event === 'shipping')).toMatchObject({ state: 'waiting', executable: false });
  });
  it('requires every target row, even when rows share a destination', () => {
    expect(trackingReady([row(), row({ id: 2n, shipmentNo: null })])).toBe(false);
    expect(trackingReady([row({ rawPayload: { rmsPackage: { basketId: null } } })])).toBe(false);
  });
  it('keeps unregistered shipments waiting without classifying them as errors', () => {
    const result = workflow([row({ shipmentNo: null })], [mail('new_order', { status: 'sent' })]);
    expect(result.steps.find((step) => step.event === 'shipping')).toMatchObject({ state: 'waiting', executable: false });
  });
  it('does not infer mail completion from externally registered shipping', () => {
    const rows = [row()];
    const result = workflow(rows, [mail('new_order', { status: 'sent' }), mail('japan_shipped', { status: 'uncertain' })],
      report(rows, { status: 'skipped', lastError: VERIFIED_SHIPPING }));
    expect(result.steps.find((step) => step.event === 'shipping')?.state).toBe('done');
    expect(result.steps.find((step) => step.event === 'japan_shipped')).toMatchObject({ state: 'manual', executable: false });
  });
  it('allows an explicit human resend after verifying external mail history', () => {
    const rows = [row()];
    const result = workflow(rows, [mail('new_order', { status: 'sent' }), mail('japan_shipped', {
      resolutionNote: '用户确认重新发送结果不确定的邮件',
    })], report(rows, { status: 'skipped', lastError: VERIFIED_SHIPPING }));
    expect(result.steps.find((step) => step.event === 'japan_shipped')).toMatchObject({ state: 'ready', executable: true });
  });
  it('allows ignored prerequisites but stops at cancelled prerequisites', () => {
    const rows = [row()];
    expect(workflow(rows, [mail('new_order', { status: 'cancelled', resolutionNote: IGNORED_MAIL }), mail('japan_shipped')], report(rows))
      .steps.find((step) => step.event === 'japan_shipped')?.state).toBe('ready');
    expect(workflow(rows, [mail('new_order', { status: 'cancelled', resolutionNote: '用户手动取消邮件' }), mail('japan_shipped')], report(rows))
      .steps.find((step) => step.event === 'japan_shipped')?.executable).toBe(false);
  });
  it('routes missing new-order records to a human instead of silently backfilling', () => {
    expect(workflow([row()], []).steps.find((step) => step.event === 'new_order')).toMatchObject({ state: 'manual', id: null });
  });
  it.each(['china_pending', 'china_no_stock'])('keeps %s orders waiting before tracking creates the first mail', (dispatchMode) => {
    const rows = [row({ dispatchMode, shipmentNo: null, shipmentNoRegisteredAt: null })];
    const result = workflow(rows, [mail('new_order', { status: 'sent' })]);
    expect(result.state).toBe('processing');
    expect(result.steps.find((step) => step.event === 'china_delay')).toMatchObject({ state: 'waiting', id: null, executable: false });
    expect(result.steps.find((step) => step.event === 'china_customs')).toMatchObject({
      state: 'waiting', id: null, executable: false, reason: '等待中国侧全部包裹通関許可及清关日期',
    });
  });
  it('keeps mixed orders waiting before warehouse dispatch creates the first mail', () => {
    const rows = [row({ warehouseShippedAt: null }), row({ id: 2n, dispatchMode: 'china_pending', shipmentNo: null })];
    const result = workflow(rows, [mail('new_order', { status: 'sent' })]);
    expect(result.state).toBe('processing');
    expect(result.steps.find((step) => step.event === 'mixed_partial')).toMatchObject({ state: 'waiting', id: null, executable: false });
    expect(result.steps.find((step) => step.event === 'mixed_customs')).toMatchObject({ state: 'waiting', id: null, executable: false });
  });
  it.each(['china', 'mixed'])('waits for the first %s mail to be prepared even when downstream conditions are ready', (type) => {
    const china = row({ dispatchMode: 'china_pending', trackingHasCustomsClearance: true, trackingCustomsClearanceDate: date });
    const rows = type === 'china' ? [china] : [row({ id: 2n }), china];
    const result = workflow(rows, [mail('new_order', { status: 'sent' })], report(rows, { fulfillmentType: type }));
    expect(result.state).toBe('processing');
    expect(result.steps.find((step) => step.event === (type === 'china' ? 'china_customs' : 'mixed_customs'))).toMatchObject({
      state: 'waiting', executable: false, reason: `等待前置邮件 ${type === 'china' ? '中国発1' : '混発1'} 生成并完成或人工忽略`,
    });
  });
  it.each(['china', 'mixed'])('preserves cancelled, dead-lettered, and uncertain first %s mail outcomes', (type) => {
    const china = row({ dispatchMode: 'china_pending', trackingHasCustomsClearance: true, trackingCustomsClearanceDate: date });
    const rows = type === 'china' ? [china] : [row({ id: 2n }), china];
    const first = type === 'china' ? 'china_delay' : 'mixed_partial';
    const second = type === 'china' ? 'china_customs' : 'mixed_customs';
    const shipping = report(rows, { fulfillmentType: type });
    const base = [mail('new_order', { status: 'sent' })];
    expect(workflow(rows, [...base, mail(first, { status: 'cancelled' })], shipping).steps.find((step) => step.event === second))
      .toMatchObject({ state: 'done', executable: false, reason: '前置邮件已取消，后续邮件停止' });
    expect(workflow(rows, [...base, mail(first, { status: 'dead_letter' })], shipping).steps.find((step) => step.event === second))
      .toMatchObject({ state: 'manual', executable: false });
    const uncertain = workflow(rows, [...base, mail(first, { status: 'uncertain' })], shipping);
    expect(uncertain.state).toBe('manual');
    expect(uncertain.steps.find((step) => step.event === second)).toMatchObject({ state: 'waiting', executable: false });
    expect(workflow(rows, [...base, mail(first, { status: 'cancelled', resolutionNote: IGNORED_MAIL }), mail(second)], shipping)
      .steps.find((step) => step.event === second)).toMatchObject({ state: 'ready', executable: true });
  });
  it('preserves shipping exceptions when the first China mail has not been prepared', () => {
    const rows = [row({ dispatchMode: 'china_pending', trackingHasCustomsClearance: true, trackingCustomsClearanceDate: date })];
    const saved = report(rows, { fulfillmentType: 'china' });
    const changed = [row({ ...rows[0], shipmentNo: 'CHANGED' })];
    expect(workflow(changed, [mail('new_order', { status: 'sent' })], saved).steps.find((step) => step.event === 'china_customs'))
      .toMatchObject({ state: 'manual', executable: false, reason: '回传后包裹信息已变化，请人工核对' });
    expect(workflow(rows, [mail('new_order', { status: 'sent' })], report(rows, { fulfillmentType: 'china', status: 'skipped', lastError: '用户人工忽略单号回传' }))
      .steps.find((step) => step.event === 'china_customs')).toMatchObject({ state: 'manual', executable: false });
  });
  it('automates structured edits and complete combos but reviews free-form instructions', () => {
    expect(mailReviewReason([row({ rmsManualOverrideAt: date })])).toBeNull();
    expect(mailReviewReason([row({ isComboOrder: true, comboOrderSku: 'SET', setComponentSkuCode: 'SET' })])).toBeNull();
    expect(mailReviewReason([row({ isComboOrder: true })])).toBe('combo_order');
    expect(mailReviewReason([row({ rmsManualOverrideAt: date, orderRemark: '納期について個別説明' })])).toBe('manual_update');
  });
  it.each(['[配送日時指定:]', ' [配送日時指定:]\n[配送日時指定：] '])('does not review an empty RMS delivery heading: %s', (orderRemark) => {
    expect(mailReviewReason([row({ rmsManualOverrideAt: date, orderRemark })])).toBeNull();
    expect(mailReviewReason([row({ rmsManualOverrideAt: date, orderRemark: `${orderRemark}\n交換品を同梱してください` })])).toBe('manual_update');
    expect(mailReviewReason([row({ rmsManualOverrideAt: date, orderRemark, orderQuantity: 3,
      rawPayload: { rmsItem: { units: 2 } } })])).toBe('manual_update');
  });
  it('uses the current valid template after a historical template failure', () => {
    const rows = [row({ rmsManualOverrideAt: date, orderRemark: '[配送日時指定:]' })];
    const mails = [mail('new_order', { status: 'sent' }), mail('japan_shipped', {
      failureCategory: 'template_missing', lastError: '旧模板需要修订',
    })];
    expect(workflow(rows, mails, report(rows)).steps.find((step) => step.event === 'japan_shipped'))
      .toMatchObject({ state: 'ready', executable: true, reason: null, canReviewBody: false });
    const result = buildOrderWorkflow({ rows, connection, report: report(rows), mails, templateVersions: new Map(), now: date });
    expect(result.steps.find((step) => step.event === 'japan_shipped'))
      .toMatchObject({ state: 'manual', executable: false, reason: '旧模板需要修订', canReviewBody: false });
  });
  it('offers body review after a repaired template without bypassing shipment conditions', () => {
    const rows = [row({ rmsManualOverrideAt: date, orderRemark: '交換品を同梱してください' })];
    const mails = [mail('new_order', { status: 'sent' }), mail('japan_shipped', {
      failureCategory: 'template_missing', lastError: '旧模板需要修订',
    })];
    expect(workflow(rows, mails, report(rows)).steps.find((step) => step.event === 'japan_shipped'))
      .toMatchObject({ state: 'manual', executable: false, canReviewBody: true, reason: '订单商品、数量或特殊说明需要核对，请确认正文' });
    expect(workflow(rows, mails, report(rows, { status: 'pending' })).steps.find((step) => step.event === 'japan_shipped'))
      .toMatchObject({ executable: false, canReviewBody: false });
    expect(workflow(rows, [mail('new_order'), mails[1]], report(rows)).steps.find((step) => step.event === 'japan_shipped'))
      .toMatchObject({ executable: false, canReviewBody: false });
    expect(workflow(rows, [mails[0], mail('japan_shipped', { status: 'uncertain' })], report(rows))
      .steps.find((step) => step.event === 'japan_shipped')).toMatchObject({ executable: false, canReviewBody: false });
  });
  it('blocks pending actions for cancelled orders', () => {
    const rows = [row({ orderStatusText: '900' })];
    const result = workflow(rows, [mail('new_order')], report(rows, { status: 'pending' }));
    expect(result.steps.every((step) => !step.executable)).toBe(true);
    expect(result.state).toBe('manual');
  });
  it('requires clearance date, not only clearance flag, for China second mail', () => {
    const rows = [row({ dispatchMode: 'china_pending', trackingHasCustomsClearance: true, trackingCustomsClearanceDate: null })];
    expect(mailConditionReason('china_customs', rows, report(rows, { fulfillmentType: 'china', status: 'pending' }))).toContain('清关日期');
  });
  it('detects changed completed shipments and blocks downstream mail', () => {
    const original = [row()];
    const changed = [row({ shipmentNo: 'JP-2' })];
    const saved = report(original);
    expect(workflow(changed, [mail('new_order', { status: 'sent' }), mail('japan_shipped')], saved)
      .steps.find((step) => step.event === 'shipping')).toMatchObject({ state: 'manual', executable: false });
    expect(mailConditionReason('japan_shipped', changed, saved)).toContain('信息已变化');
  });
  it('returns completed steps without reopening already sent mail', () => {
    const rows = [row()];
    expect(workflow(rows, [mail('new_order', { status: 'sent' }), mail('japan_shipped', { status: 'sent' })], report(rows)).state).toBe('done');
  });
  it('distinguishes retry timing from business waiting', () => {
    const rows = [row()];
    expect(workflow(rows, [mail('new_order', { status: 'failed', nextAttemptAt: new Date(date.getTime() + 3600000) })])
      .steps.find((step) => step.event === 'new_order')).toMatchObject({ state: 'retry', executable: false });
  });
  it('shows disabled shops as waiting instead of ready', () => {
    const rows = [row()];
    const result = buildOrderWorkflow({ rows, connection: { ...connection, mailNotificationsEnabled: false }, report: null,
      mails: [mail('new_order')], templateVersions: new Map([['new_order', 1]]) });
    expect(result.steps[0]).toMatchObject({ state: 'waiting', executable: false });
  });
});

describe('recovery after a template has been repaired', () => {
  const setup = (orderRemark: string) => {
    const rows = [row({ rmsManualOverrideAt: date, orderRemark })];
    const held = mail('japan_shipped', { failureCategory: 'template_missing', lastError: '旧模板需要修订' });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      rakutenOrderMail: { findMany: jest.fn().mockResolvedValue([held]),
        findUnique: jest.fn().mockResolvedValue(mail('new_order', { status: 'sent' })), updateMany },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
      rakutenOrderShippingReport: { findUnique: jest.fn().mockResolvedValue(report(rows)) },
    };
    const service = new RakutenRmsAutomationService(prisma as any, {} as any, {} as any);
    jest.spyOn(service as any, 'resolveActiveMailTemplate').mockResolvedValue({ subjectTemplate: '発送案内', bodyTemplate: '{{tracking_sections}}' });
    return { service, prisma, updateMany };
  };
  it('resumes an ordinary edited order with only the empty RMS heading', async () => {
    const { service, updateMany } = setup('[配送日時指定:]');
    await (service as any).refreshMailHolds(7n);
    expect(updateMany).toHaveBeenCalledWith({ where: {
      id: 10n, status: 'pending', failureCategory: 'template_missing', lastError: '旧模板需要修订', sendStartedAt: null,
    }, data: { failureCategory: null, lastError: null, nextAttemptAt: null } });
  });
  it('replaces the stale template failure with a real body-review requirement', async () => {
    const { service, updateMany } = setup('交換品を同梱してください');
    await (service as any).refreshMailHolds(7n);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: {
      failureCategory: 'manual_review', lastError: '请人工核对商品调整、数量、特殊说明及收件资料后确认正文', nextAttemptAt: null,
    } }));
  });
  it('does not clear a hold while the prerequisite remains unfinished', async () => {
    const { service, prisma, updateMany } = setup('[配送日時指定:]');
    prisma.rakutenOrderMail.findUnique.mockResolvedValue(mail('new_order'));
    await (service as any).refreshMailHolds(7n);
    expect(updateMany).not.toHaveBeenCalled();
  });
  it.each([null, { subjectTemplate: '発送案内', bodyTemplate: '本日発送の手続きを行いました' }])
    ('keeps the hold when there is no valid enabled template: %j', async (template) => {
      const { service, updateMany } = setup('[配送日時指定:]');
      jest.spyOn(service as any, 'resolveActiveMailTemplate').mockResolvedValue(template);
      await (service as any).refreshMailHolds(7n);
      expect(updateMany).not.toHaveBeenCalled();
    });
});

describe('workflow history endpoint', () => {
  it('uses the earliest import cutoff and does not generate or execute jobs when reading', async () => {
    const rows = [row()];
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValueOnce([{ total: 1n }]).mockResolvedValueOnce([{ connectionId: 7n, orderId: 'ORDER' }]),
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
      rakutenOrderMail: { findMany: jest.fn().mockResolvedValue([mail('new_order')]), create: jest.fn() },
      rakutenOrderShippingReport: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
      rakutenRmsConnection: { findMany: jest.fn().mockResolvedValue([connection]) },
      rakutenMailTemplateVersion: { findMany: jest.fn().mockResolvedValue([{ connectionId: 7n, event: 'new_order', version: 1, subjectTemplate: '件名', bodyTemplate: '本文' }]) },
    };
    const client = { updateOrderShipping: jest.fn() };
    const service = new RakutenRmsAutomationService(prisma as any, client as any, {} as any);
    const result = await service.listOrderWorkflows({ orderId: 'ORDER' }) as any;
    expect(result).toMatchObject({ total: 1, intervalMinutes: 20, items: [{ orderId: 'ORDER' }] });
    const query = prisma.$queryRaw.mock.calls[0][0];
    expect(query.sql).toContain('HAVING MIN(records.created_at) >=');
    expect(query.values).toContainEqual(new Date('2026-09-30T15:00:00Z'));
    expect(prisma.rakutenOrderMail.create).not.toHaveBeenCalled();
    expect(prisma.rakutenOrderShippingReport.create).not.toHaveBeenCalled();
    expect(client.updateOrderShipping).not.toHaveBeenCalled();
  });
});

describe('scheduled queue boundaries', () => {
  it('does not let the first hundred human-review mails starve later automatic mails', async () => {
    const jobs = Array.from({ length: 101 }, (_, index) => mail('japan_shipped', {
      id: BigInt(index + 1), orderId: `ORDER-${index + 1}`, attempts: 0, connection,
    } as any));
    const findMany = jest.fn().mockImplementation(({ where, take }: any) => jobs.filter((job) =>
      job.id > where.id.gt && !['manual_review', 'template_missing', 'order_changed', 'prerequisite_missing'].includes(job.failureCategory ?? '')
      && ['pending', 'failed'].includes(job.status)).slice(0, take));
    const update = jest.fn().mockImplementation(({ where, data }: any) => {
      const job = jobs.find((item) => item.id === where.id)!;
      Object.assign(job, data);
      return Promise.resolve(job);
    });
    const prisma = {
      rakutenOrderMail: { findMany, update, findUnique: jest.fn().mockResolvedValue({ status: 'sent' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      rakutenOrderRecord: { findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve([
        row({ orderId: where.orderId ?? where.OR?.[0]?.orderId ?? where.OR?.[0]?.rmsOrderId ?? where.OR?.[0]?.OR?.[0]?.rmsOrderId,
          rmsManualOverrideAt: (where.orderId ?? where.OR?.[0]?.orderId ?? where.OR?.[0]?.rmsOrderId ?? where.OR?.[0]?.OR?.[0]?.rmsOrderId) === 'ORDER-101' ? null : date,
          orderRemark: (where.orderId ?? where.OR?.[0]?.orderId ?? where.OR?.[0]?.rmsOrderId ?? where.OR?.[0]?.OR?.[0]?.rmsOrderId) === 'ORDER-101' ? null : '個別説明' }),
      ])) },
      rakutenOrderShippingReport: { findUnique: jest.fn().mockResolvedValue(report([row()])) },
      rakutenMailTemplateVersion: { findFirst: jest.fn().mockResolvedValue({ subjectTemplate: '件名', bodyTemplate: '{{buyer_name}}' }) },
    };
    const service = new RakutenRmsAutomationService(prisma as any, {} as any, {} as any);
    jest.spyOn(service as any, 'liveMailBlockReason').mockResolvedValue(null);
    const sendMail = jest.fn().mockResolvedValue({ accepted: ['buyer@example.jp'] });
    jest.spyOn(service as any, 'decryptSmtpCredentials').mockReturnValue({ fromAddress: 'shop@example.jp', fromName: '店铺', bccAddresses: [] });
    jest.spyOn(service as any, 'createSmtpTransport').mockReturnValue({ sendMail, close: jest.fn() });
    const first = await (service as any).processMails(7n);
    expect(first).toEqual({ sent: 0, failed: 0, blocked: 100 });
    expect(sendMail).not.toHaveBeenCalled();
    expect(jobs.slice(0, 100).every((job) => job.failureCategory === 'manual_review')).toBe(true);
    const second = await (service as any).processMails(7n);
    expect(second).toEqual({ sent: 1, failed: 0, blocked: 0 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[1][0].where.id.gt).toBe(100n);
  });
  it('creates an uncertain Japan mail when shipping was registered outside WMS', async () => {
    const rows = [row()];
    const saved = report(rows, { status: 'pending', attempts: 0 });
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
      rakutenOrderShippingReport: {
        findMany: jest.fn().mockResolvedValue([{ ...saved, connection }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}),
      },
      rakutenOrderMail: { upsert, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const client = {
      getOrders: jest.fn().mockResolvedValue([{ orderNumber: 'ORDER', orderProgress: 500,
        PackageModelList: [{ basketId: 1, ShippingModelList: [{ shippingNumber: 'JP-1' }] }] }]),
      updateOrderShipping: jest.fn(),
    };
    const service = new RakutenRmsAutomationService(prisma as any, client as any, {} as any);
    jest.spyOn(service as any, 'decryptApiCredentials').mockReturnValue({ serviceSecret: 'test', licenseKey: 'test' });
    expect(await (service as any).processShippingReports(7n)).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(client.updateOrderShipping).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({
      event: 'japan_shipped', status: 'uncertain', failureCategory: 'external_shipping',
    }) }));
  });
  it('excludes orders first imported before October 1 JST even when later rows were added', async () => {
    const createMany = jest.fn();
    const db = {
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([
        { rmsConnectionId: 7n, orderId: 'OLD', createdAt: new Date('2026-09-30T14:59:59.999Z') },
        { rmsConnectionId: 7n, orderId: 'OLD', createdAt: date },
        { rmsConnectionId: 7n, orderId: 'NEW', createdAt: new Date('2026-09-30T15:00:00Z') },
      ]) }, rakutenOrderMail: { createMany },
    };
    const service = new RakutenRmsAutomationService({} as any, {} as any, {} as any);
    await service.enqueueNewOrderMails(db as any, 7n, ['OLD', 'NEW']);
    expect(createMany).toHaveBeenCalledWith({ data: [{ connectionId: 7n, orderId: 'NEW', event: 'new_order' }], skipDuplicates: true });
  });
  it('does not send a fallback template when the shop has no active template', async () => {
    const update = jest.fn().mockResolvedValue({});
    const claim = jest.fn();
    const prisma = {
      rakutenOrderMail: { findMany: jest.fn().mockResolvedValue([mail('new_order', { connection } as any)]), update, updateMany: claim },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([row()]) },
      rakutenMailTemplateVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new RakutenRmsAutomationService(prisma as any, {} as any, {} as any);
    expect(await (service as any).processMails(7n)).toEqual({ sent: 0, failed: 0, blocked: 1 });
    expect(claim).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failureCategory: 'template_missing', nextAttemptAt: null }) }));
  });
});

describe('human decisions for missing new-order mail', () => {
  const setup = () => {
    const create = jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 99n, status: 'pending', ...data }));
    const prisma = {
      rakutenRmsConnection: { findUnique: jest.fn().mockResolvedValue(connection) },
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([row()]) },
      rakutenOrderMail: { findUnique: jest.fn().mockResolvedValue(null), create },
    };
    return { prisma, create, service: new RakutenRmsAutomationService(prisma as any, {} as any, {} as any) };
  };
  it('records an ignored new-order step without sending a mail', async () => {
    const { service, create } = setup();
    await service.resolveMissingOrderMail('7', 'ORDER', 'new_order', 'ignore', 3n);
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ event: 'new_order', status: 'cancelled', resolutionNote: IGNORED_MAIL, resolvedBy: 3n }) });
  });
  it('creates a pending task only on an explicit human request', async () => {
    const { service, create } = setup();
    expect(await service.resolveMissingOrderMail('7', 'ORDER', 'new_order', 'create', 3n)).toMatchObject({ id: '99', status: 'pending' });
    expect(create).toHaveBeenCalledWith({ data: { connectionId: 7n, orderId: 'ORDER', event: 'new_order' } });
  });
  it('does not overwrite an existing new-order step', async () => {
    const { service, prisma, create } = setup();
    prisma.rakutenOrderMail.findUnique.mockResolvedValue(mail('new_order') as any);
    await expect(service.resolveMissingOrderMail('7', 'ORDER', 'new_order', 'create', 3n)).rejects.toThrow('新規任务已存在');
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects out-of-scope and cancelled orders', async () => {
    const { service, prisma, create } = setup();
    prisma.rakutenOrderRecord.findMany.mockResolvedValue([row({ createdAt: new Date('2026-09-30T14:59:59Z') })]);
    await expect(service.resolveMissingOrderMail('7', 'ORDER', 'new_order', 'ignore', 3n)).rejects.toThrow('首次导入');
    prisma.rakutenOrderRecord.findMany.mockResolvedValue([row({ orderStatusText: '900' })]);
    await expect(service.resolveMissingOrderMail('7', 'ORDER', 'new_order', 'create', 3n)).rejects.toThrow('取消');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('modified purchase information', () => {
  it('reviews quantity/SKU changes that can invalidate original order totals', () => {
    expect(mailReviewReason([row({ rmsManualOverrideAt: date, orderQuantity: 3,
      rawPayload: { rmsPackage: { basketId: 1 }, rmsItem: { units: 2 } } })])).toBe('manual_update');
    expect(mailReviewReason([row({ rmsManualOverrideAt: date,
      rawPayload: { rmsPackage: { basketId: 1 }, rmsItem: { SkuModelList: [{ variantId: 'ORIGINAL-SKU' }] } } })])).toBe('manual_update');
    expect(mailReviewReason([row({ rmsManualOverrideAt: date, shippingAddress: '新住所',
      rawPayload: { rmsPackage: { basketId: 1 }, rmsItem: { units: 2, SkuModelList: [{ variantId: 'BOX' }] } } })])).toBeNull();
  });
});

describe('shipment verification recovery', () => {
  it('routes a new unnumbered package on an already completed shipment to human review', () => {
    const original = [row()];
    const saved = report(original);
    const expanded = [...original, row({ id: 2n, shipmentNo: null })];
    expect(workflow(expanded, [mail('new_order', { status: 'sent' }), mail('japan_shipped')], saved)
      .steps.find((step) => step.event === 'shipping')?.state).toBe('manual');
    expect(mailConditionReason('japan_shipped', expanded, saved)).toContain('人工核对');
  });
  it('recognizes a known WMS shipment request after a timeout without resubmitting', async () => {
    const rows = [row()];
    const saved = report(rows, { status: 'failed', attempts: 1, responsePayload: {
      wmsUpdateRequestedAt: date.toISOString(), wmsRequestFingerprint: shippingFingerprint(rows),
    } });
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
      rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue(rows) },
      rakutenOrderShippingReport: { findMany: jest.fn().mockResolvedValue([{ ...saved, connection }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}) },
      rakutenOrderMail: { upsert },
    };
    const client = {
      getOrders: jest.fn().mockResolvedValue([{ orderNumber: 'ORDER',
        PackageModelList: [{ basketId: 1, ShippingModelList: [{ shippingNumber: 'JP-1' }] }] }]), updateOrderShipping: jest.fn(),
    };
    const service = new RakutenRmsAutomationService(prisma as any, client as any, {} as any);
    jest.spyOn(service as any, 'decryptApiCredentials').mockReturnValue({ serviceSecret: 'test', licenseKey: 'test' });
    expect(await (service as any).processShippingReports(7n)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(client.updateOrderShipping).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { connectionId: 7n, orderId: 'ORDER', event: 'japan_shipped' } }));
  });
  it('keeps snapshot fingerprints compatible with historical basket payloads', () => {
    const service = new RakutenRmsAutomationService({} as any, {} as any, {} as any);
    const crypto = require('crypto') as typeof import('crypto');
    const rows = [row()];
    const oldPayload = (service as any).buildShippingBaskets(rows).map((basket: any) => ({ ...basket, ShippingModelList: basket.ShippingModelList.map((item: any) => ({ ...item, deliveryCompany: rows[0].shipmentCompany })) }));
    expect(shippingFingerprint(rows)).toBe(crypto.createHash('sha1').update(JSON.stringify(oldPayload)).digest('hex'));
  });
});

describe('processing center views', () => {
  it('filters across all eligible orders before paginating the manual inbox', async () => {
    const refs = Array.from({ length: 105 }, (_, index) => ({ connectionId: 7n, orderId: `ORDER-${index}` }));
    const query = jest.fn().mockResolvedValue(refs);
    const service = new RakutenRmsAutomationService({ $queryRaw: query } as any, {} as any, {} as any);
    const batch = jest.spyOn(service as any, 'loadOrderWorkflowBatch').mockImplementation(async (rows: any) => rows.map((ref: any) => ({
      ...ref, connectionId: '7', steps: [], state: Number(ref.orderId.split('-')[1]) >= 100 ? 'manual' : 'processing',
    })));
    const result = await service.listOrderWorkflows({ view: 'manual', page: '2', pageSize: '2' }) as any;
    expect(result).toMatchObject({ total: 5, page: 2, summary: { manual: 5, processing: 100, done: 0 } });
    expect(result.items.map((item: any) => item.orderId)).toEqual(['ORDER-102', 'ORDER-103']);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[0][0]).toHaveLength(100);
    expect(batch.mock.calls[1][0]).toHaveLength(5);
    expect(query.mock.calls[0][0].sql).not.toContain('LIMIT');
  });
  it('keeps completed and manual orders out of the processing view', async () => {
    const service = new RakutenRmsAutomationService({ $queryRaw: jest.fn().mockResolvedValue([
      { connectionId: 7n, orderId: 'DONE' }, { connectionId: 7n, orderId: 'ACTIVE' }, { connectionId: 7n, orderId: 'REVIEW' },
    ]) } as any, {} as any, {} as any);
    jest.spyOn(service as any, 'loadOrderWorkflowBatch').mockResolvedValue([
      { orderId: 'DONE', state: 'done' }, { orderId: 'ACTIVE', state: 'processing' }, { orderId: 'REVIEW', state: 'manual' },
    ]);
    const result = await service.listOrderWorkflows({ view: 'processing' }) as any;
    expect(result.total).toBe(1);
    expect(result.items.map((item: any) => item.orderId)).toEqual(['ACTIVE']);
    expect(result.summary).toEqual({ manual: 1, processing: 1, done: 1 });
  });
  it('rejects unknown views rather than silently returning a different inbox', async () => {
    const query = jest.fn();
    const service = new RakutenRmsAutomationService({ $queryRaw: query } as any, {} as any, {} as any);
    await expect(service.listOrderWorkflows({ view: 'unknown' })).rejects.toThrow('视图无效');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('external-mail confirmation eligibility', () => {
  it('still requires a template after an external Japan mail is explicitly reopened', () => {
    const rows = [row()];
    const result = buildOrderWorkflow({ rows, connection, report: report(rows, { status: 'skipped', lastError: VERIFIED_SHIPPING }),
      mails: [mail('new_order', { status: 'sent' }), mail('japan_shipped', { resolutionNote: '用户确认重新发送结果不确定的邮件' })],
      templateVersions: new Map([['new_order', 1]]), now: date });
    expect(result.steps.find((step) => step.event === 'japan_shipped')).toMatchObject({ state: 'manual', executable: false, reason: '尚未配置并启用该邮件模板' });
  });
});

// These unit fixtures bypass orchestration; lock ownership is tested separately.
beforeEach(() => {
  jest.spyOn(RakutenRmsAutomationService.prototype as any, "assertExecutionLock").mockResolvedValue(undefined);
  jest.spyOn(RakutenRmsAutomationService.prototype as any, "shippingPrerequisiteSatisfied").mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());
