import { RakutenRmsApiService } from '../src/rakuten-rms-api/rakuten-rms-api.service';
import { RakutenOrderSchedulerService } from '../src/rakuten-rms-api/rakuten-order-scheduler.service';

const rawOrder = (orderId: string, skus: string[], progress = 300) => ({
  orderNumber: orderId, orderProgress: progress, orderDatetime: '2026-10-14T10:00:00+09:00',
  OrdererModel: { emailAddress: 'buyer@example.jp' },
  PackageModelList: [{ basketId: 1, ItemModelList: skus.map((sku, index) => ({
    itemDetailId: index + 1, manageNumber: sku, itemName: sku, units: 1,
  })) }],
});
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (key === 'AND') return value.every((part: any) => matches(row, part));
    if (key === 'connectionId_orderId' || key === 'rmsConnectionId_rmsItemKey') return matches(row, value);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('gt' in value) return row[key] > value.gt;
      if ('not' in value) return row[key] !== value.not;
      if ('contains' in value) return String(row[key]).includes(value.contains);
    }
    return row[key] === value || value instanceof Date && row[key]?.getTime() === value.getTime();
  });
}
function fixture(source = [rawOrder('BAD', ['sku-in-bad-order', 'zh-missing']), rawOrder('GOOD', ['sku-good'])]) {
  const connection: any = { id: 7n, shop: { id: 9n, name: '店铺' }, status: 1, syncOrders: true,
    licenseExpiresAt: null, lastOrdersSyncedAt: null, lastSuccessfulSyncAt: null, lastSyncError: null };
  const issues: any[] = []; const records: any[] = []; const runs: any[] = []; const previews: any[] = []; const combos: any[] = [];
  const products = new Set(['sku-in-bad-order', 'sku-good', 'COMP-A', 'COMP-B']);
  const apiOrders = [...source]; let searchedIds = source.map((order) => order.orderNumber);
  const issueStore = {
    count: jest.fn(async ({ where }) => issues.filter((issue) => matches(issue, where)).length),
    findMany: jest.fn(async ({ where, skip = 0, take = issues.length }) => issues.filter((issue) => matches(issue, where)).slice(skip, skip + take)),
    upsert: jest.fn(async ({ where, create, update }) => {
      let issue = issues.find((row) => matches(row, where));
      if (issue) Object.assign(issue, update, { updatedAt: new Date() });
      else { issue = { id: BigInt(issues.length + 1), resolvedAt: null, createdAt: new Date(), connection, ...create }; issues.push(issue); }
      return issue;
    }),
    updateMany: jest.fn(async ({ where, data }) => { const found = issues.filter((row) => matches(row, where)); found.forEach((row) => Object.assign(row, data)); return { count: found.length }; }),
  };
  const recordStore = {
    findUnique: jest.fn(async ({ where }) => records.find((record) => matches(record, where)) ?? null),
    findMany: jest.fn(async ({ where }) => records.filter((record) => matches(record, where))),
    create: jest.fn(async ({ data }) => { const record = { id: BigInt(records.length + 1), deletedAt: null, updatedAt: new Date(), createdAt: new Date(), ...data }; records.push(record); return record; }),
    update: jest.fn(async ({ where, data }) => { const record = records.find((row) => matches(row, where)); Object.assign(record, data, { updatedAt: new Date() }); return record; }),
    delete: jest.fn(async ({ where }) => { const index = records.findIndex((row) => matches(row, where)); return records.splice(index, 1)[0]; }),
  };
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([]), rakutenOrderImportIssue: issueStore, rakutenOrderRecord: recordStore,
    masterProduct: {
      findMany: jest.fn(async ({ where }) => [...products].filter((id) => where.productId.in.some((value: string) => value.toLowerCase() === id.toLowerCase())).map((productId) => ({ productId }))),
      findUnique: jest.fn(async ({ where }) => products.has(where.productId) ? { productId: where.productId, stockQty: 0, boxInventories: [], bomComponents: [] } : null),
    },
    rakutenComboProduct: { findMany: jest.fn(async () => combos) },
    rakutenOrderSyncExclusion: { findMany: jest.fn().mockResolvedValue([]) },
    overseasPickingBatchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    rakutenRmsConnection: {
      findMany: jest.fn(async () => [connection]), findUnique: jest.fn(async () => connection),
      update: jest.fn(async ({ data }) => { Object.assign(connection, data); return connection; }),
    },
    rakutenRmsSyncRun: {
      create: jest.fn(async ({ data }) => { const run = { id: BigInt(runs.length + 1), startedAt: new Date(), rolledBackAt: null, ...data }; runs.push(run); return run; }),
      update: jest.fn(async ({ where, data }) => { const run = runs.find((row) => matches(row, where)); Object.assign(run, data); return run; }),
      findUnique: jest.fn(async ({ where }) => runs.find((row) => matches(row, where))),
      findFirst: jest.fn(async ({ where }) => runs.find((row) => matches(row, where)) ?? null),
    },
    rakutenRmsSyncPreview: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(async ({ data }) => { previews.push({ usedAt: null, ...data }); return data; }),
      findUnique: jest.fn(async ({ where }) => previews.find((row) => matches(row, where))),
      updateMany: jest.fn(async ({ where, data }) => { const preview = previews.find((row) => row.token === where.token && !row.usedAt); if (preview) Object.assign(preview, data); return { count: preview ? 1 : 0 }; }),
    },
  };
  prisma.$transaction = jest.fn(async (work: any) => typeof work === 'function' ? work(prisma) : Promise.all(work));
  const client = {
    searchOrders: jest.fn(async () => searchedIds),
    getOrders: jest.fn(async (_secret, _license, ids: string[]) => apiOrders.filter((order) => ids.includes(order.orderNumber))),
  };
  const automation = { enqueueNewOrderMails: jest.fn(), sendImportedNewOrderMails: jest.fn().mockResolvedValue({ sent: 1 }) };
  const service = new RakutenRmsApiService(prisma, client as any, {} as any, automation as any);
  jest.spyOn(service as any, 'decryptCredentials').mockReturnValue({ serviceSecret: 'secret', licenseKey: 'key' });
  jest.spyOn(service as any, 'resolveDispatchMode').mockResolvedValue('china_pending');
  const configure = (name = 'zh-missing') => { combos.push({ comboName: name, items: [
    { productId: 'COMP-A', product: { productName: '组件A' } }, { productId: 'COMP-B', product: { productName: '组件B' } },
  ] }); };
  return { service, prisma, client, automation, connection, issues, records, runs, previews, combos, configure, apiOrders, products,
    stopNormalSearch: () => { searchedIds = []; } };
}

describe('missing Rakuten combo configuration does not stop other orders', () => {
  it('skips an entire order with a missing ordinary product and imports the other order', async () => {
    const f = fixture([rawOrder('BAD', ['sku-in-bad-order', 'MISSING-PRODUCT']), rawOrder('GOOD', ['sku-good'])]);
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 1, skipped: 2, catalogMissingOrderCount: 1, productMissingOrderCount: 1, comboMissingOrderCount: 0 });
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
    expect(f.issues[0]).toMatchObject({ comboSkus: [], missingProductIds: ['MISSING-PRODUCT'], resolvedAt: null });
    expect(f.automation.sendImportedNewOrderMails).toHaveBeenCalledWith(7n, ['GOOD'], 'scheduled');
    expect([...f.automation.enqueueNewOrderMails.mock.calls[0][2]]).toEqual(['GOOD']);
  });
  it('detects a missing component product even when the combo definition is present', async () => {
    const f = fixture(); f.configure(); f.products.delete('COMP-B');
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 1, productMissingOrderCount: 1, comboMissingOrderCount: 0 });
    expect(f.issues[0]).toMatchObject({ comboSkus: [], missingProductIds: ['COMP-B'] });
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
  });
  it('records missing combo and ordinary product IDs together without counting the order twice', async () => {
    const f = fixture(); f.products.delete('sku-in-bad-order');
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ skipped: 2, catalogMissingOrderCount: 1, productMissingOrderCount: 1, comboMissingOrderCount: 1 });
    expect(f.issues).toHaveLength(1);
    expect(f.issues[0]).toMatchObject({ comboSkus: ['zh-missing'], missingProductIds: ['sku-in-bad-order'] });
  });
  it('retries a missing ordinary product order after registration, outside the normal search results', async () => {
    const f = fixture([rawOrder('BAD', ['sku-in-bad-order', 'NEW-PRODUCT']), rawOrder('GOOD', ['sku-good'])]);
    await f.service.syncAllConnections(); f.stopNormalSearch(); f.products.add('NEW-PRODUCT');
    const result = await f.service.syncAllConnections() as any;
    expect(f.client.getOrders).toHaveBeenLastCalledWith('secret', 'key', ['BAD']);
    expect(result.results[0]).toMatchObject({ created: 2, catalogMissingOrderCount: 0 });
    expect(f.issues[0].resolvedAt).toBeInstanceOf(Date);
    expect(f.automation.sendImportedNewOrderMails).toHaveBeenLastCalledWith(7n, ['BAD'], 'scheduled');
  });
  it('rechecks product existence at manual confirmation and skips only the newly invalid order', async () => {
    const f = fixture([rawOrder('BAD', ['sku-in-bad-order']), rawOrder('GOOD', ['sku-good'])]);
    const preview = await f.service.previewConnection('7') as any;
    expect(preview).toMatchObject({ canConfirm: true, summary: { create: 2, catalogMissingOrderCount: 0 } });
    f.products.delete('sku-in-bad-order');
    const result = await f.service.syncConnection('7', { previewToken: preview.previewToken }) as any;
    expect(result).toMatchObject({ created: 1, skipped: 1, catalogMissingOrderCount: 1 });
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
    expect(f.issues[0]).toMatchObject({ orderId: 'BAD', missingProductIds: ['sku-in-bad-order'], resolvedAt: null });
    expect(f.automation.sendImportedNewOrderMails).toHaveBeenCalledWith(7n, ['GOOD'], 'manual');
  });
  it('still imports a registered product with zero stock through the normal China no-stock route', async () => {
    const f = fixture([rawOrder('GOOD', ['sku-good'])]);
    (f.service as any).resolveDispatchMode.mockRestore();
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 1, catalogMissingOrderCount: 0 });
    expect(f.records[0].dispatchMode).toBe('china_no_stock');
    expect(f.issues).toHaveLength(0);
  });
  it('requests intervention when the item does not contain a product ID', async () => {
    const f = fixture([rawOrder('BAD', [''])]);
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 0, productMissingOrderCount: 1 });
    expect(f.issues[0].reason).toContain('未提供产品ID');
    expect(f.records).toHaveLength(0);
    expect(f.automation.sendImportedNewOrderMails).not.toHaveBeenCalled();
  });
  it('matches registered product IDs with the same case-insensitive comparison as existing SKU matching', async () => {
    const f = fixture([rawOrder('GOOD', ['SKU-GOOD'])]);
    expect((await f.service.syncAllConnections() as any).results[0]).toMatchObject({ created: 1, catalogMissingOrderCount: 0 });
    expect(f.issues).toHaveLength(0);
  });
  it.each(['user_delete', 'conflict_ignore'])('excludes a deliberately removed missing product before catalogue validation: %s', async (reason) => {
    const f = fixture([rawOrder('BAD', ['sku-in-bad-order', 'MISSING']), rawOrder('GOOD', ['sku-good'])]);
    const exclusion = { orderId: 'BAD', rmsItemKey: null, skuCode: 'missing', rmsConnectionId: 7n, shopName: null, reason };
    f.prisma.rakutenOrderSyncExclusion.findMany.mockImplementation(async ({ where }: any) => matches(exclusion, where) ? [exclusion] : []);
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 2, catalogMissingOrderCount: 0 });
    expect(f.records.map((row) => row.skuCode)).toEqual(['sku-in-bad-order', 'sku-good']);
    expect(f.issues).toHaveLength(0);
  });
  it('closes a pending catalogue issue after every source item is deliberately ignored', async () => {
    const f = fixture([rawOrder('BAD', ['MISSING'])]); await f.service.syncAllConnections(); f.stopNormalSearch();
    const exclusion = { orderId: 'BAD', rmsItemKey: null, skuCode: 'missing', rmsConnectionId: 7n, shopName: null, reason: 'conflict_ignore' };
    f.prisma.rakutenOrderSyncExclusion.findMany.mockImplementation(async ({ where }: any) => matches(exclusion, where) ? [exclusion] : []);
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 0, catalogMissingOrderCount: 0 });
    expect(f.issues[0].resolvedAt).toBeInstanceOf(Date);
    expect(f.records).toHaveLength(0);
    expect(f.automation.sendImportedNewOrderMails).not.toHaveBeenCalled();
  });
  it('skips every item of the affected order and keeps a normal order', async () => {
    const f = fixture(); const issues: any[] = [];
    const mapped = await (f.service as any).mapOrders(f.apiOrders, issues);
    expect(mapped.map((item: any) => item.orderId)).toEqual(['GOOD']);
    expect(issues).toEqual([expect.objectContaining({ orderId: 'BAD', comboSkus: ['zh-missing'], skippedItemCount: 2 })]);
  });
  it('groups several missing combo IDs into one order issue and skips empty definitions', async () => {
    const f = fixture([rawOrder('BAD', ['zh-missing', 'zh-empty'])]);
    f.combos.push({ comboName: 'zh-empty', items: [] });
    const issues: any[] = [];
    expect(await (f.service as any).mapOrders(f.apiOrders, issues)).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0].comboSkus).toEqual(['zh-missing', 'zh-empty']);
  });
  it('continues to expand a configured combo, including a case-insensitive ID', async () => {
    const f = fixture([rawOrder('READY', ['ZH-missing'])]); f.configure();
    const issues: any[] = [];
    const mapped = await (f.service as any).mapOrders(f.apiOrders, issues);
    expect(mapped.map((item: any) => item.skuCode)).toEqual(['COMP-A', 'COMP-B']);
    expect(issues).toEqual([]);
  });
  it('scheduled import commits healthy orders, records the skipped order and only queues healthy mail', async () => {
    const f = fixture();
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 1, skipped: 2, comboMissingOrderCount: 1 });
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
    expect(f.issues).toHaveLength(1); expect(f.issues[0].orderId).toBe('BAD');
    expect(f.runs[0]).toMatchObject({ status: 'partial', manualActionCount: 1 });
    expect(f.connection.lastOrdersSyncedAt).toBeInstanceOf(Date);
    expect([...f.automation.enqueueNewOrderMails.mock.calls[0][2]]).toEqual(['GOOD']);
    expect(f.automation.sendImportedNewOrderMails).toHaveBeenCalledWith(7n, ['GOOD'], 'scheduled');
  });
  it('manual preview allows confirmation and the formal import uses the same skip rule', async () => {
    const f = fixture();
    const preview = await f.service.previewConnection('7') as any;
    expect(preview).toMatchObject({ canConfirm: true, summary: { create: 1, comboMissingOrderCount: 1 } });
    expect(preview.items).toContainEqual(expect.objectContaining({ orderId: 'BAD', action: 'catalog_missing' }));
    expect(f.issues).toHaveLength(0); // Preview does not create fulfilment or intervention records.
    const result = await f.service.syncConnection('7', { previewToken: preview.previewToken }) as any;
    expect(result).toMatchObject({ created: 1, comboMissingOrderCount: 1 });
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
    expect(f.issues).toHaveLength(1);
    expect(f.automation.sendImportedNewOrderMails).toHaveBeenCalledWith(7n, ['GOOD'], 'manual');
  });
  it('persists a wholly blocked import without creating rows or sending acknowledgements', async () => {
    const f = fixture([rawOrder('BAD', ['zh-missing'])]);
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 0, skipped: 1, comboMissingOrderCount: 1 });
    expect(f.records).toHaveLength(0); expect(f.issues).toHaveLength(1);
    expect(f.automation.sendImportedNewOrderMails).not.toHaveBeenCalled();
  });
  it('deduplicates repeated issues and retries them after the incremental search window moves on', async () => {
    const f = fixture(); await f.service.syncAllConnections(); f.stopNormalSearch();
    await f.service.syncAllConnections();
    expect(f.issues).toHaveLength(1);
    expect(f.client.getOrders).toHaveBeenLastCalledWith('secret', 'key', ['BAD']);
    f.configure();
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 3, comboMissingOrderCount: 0 });
    expect(f.records.filter((row) => row.orderId === 'BAD').map((row) => row.skuCode)).toEqual(['sku-in-bad-order', 'COMP-A', 'COMP-B']);
    expect(f.issues[0].resolvedAt).toBeInstanceOf(Date);
    expect(f.automation.sendImportedNewOrderMails).toHaveBeenLastCalledWith(7n, ['BAD'], 'scheduled');
  });
  it('does not silently resolve an issue when RMS omits the requested order', async () => {
    const f = fixture(); await f.service.syncAllConnections(); f.stopNormalSearch(); f.apiOrders.splice(0);
    await f.service.syncAllConnections();
    expect(f.issues[0].resolvedAt).toBeNull();
  });
  it('closes an issue without importing or sending when its order is no longer pending shipment', async () => {
    const f = fixture(); await f.service.syncAllConnections(); f.stopNormalSearch();
    f.apiOrders[0].orderProgress = 900;
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 0, comboMissingOrderCount: 0 });
    expect(f.issues[0].resolvedAt).toBeInstanceOf(Date);
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
    expect(f.automation.sendImportedNewOrderMails).toHaveBeenCalledTimes(1);
  });
  it('retains the issue when RMS returns an unrecognized status', async () => {
    const f = fixture(); await f.service.syncAllConnections(); f.stopNormalSearch();
    f.apiOrders[0].orderProgress = 999;
    await f.service.syncAllConnections();
    expect(f.issues[0].resolvedAt).toBeNull();
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
  });
  it('reopens recovered import issues when the import is rolled back', async () => {
    const f = fixture(); await f.service.syncAllConnections(); f.stopNormalSearch(); f.configure();
    const result = await f.service.syncAllConnections() as any;
    expect(f.issues[0].resolvedAt).toBeInstanceOf(Date);
    await f.service.rollbackSyncRun(result.results[0].syncRunId);
    expect(f.issues[0].resolvedAt).toBeNull();
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
  });
  it('keeps the intervention record with an accurate reason when recovery encounters a matching conflict', async () => {
    const f = fixture(); await f.service.syncAllConnections(); f.stopNormalSearch(); f.configure();
    const originalPlan = (f.service as any).planOrderItem.bind(f.service);
    jest.spyOn(f.service as any, 'planOrderItem').mockImplementation(async (...args: any[]) => args[2].orderId === 'BAD'
      ? { action: 'conflict', item: args[2], existing: null, changedFields: [], reason: '同一订单号和SKU匹配到多条记录' }
      : originalPlan(...args));
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0].importWarning).toContain('匹配冲突');
    expect(f.issues[0].resolvedAt).toBeNull();
    expect(f.issues[0].reason).toContain('商品配置已补齐');
    expect(f.issues[0].reason).toContain('匹配冲突');
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
    expect(f.automation.sendImportedNewOrderMails).toHaveBeenCalledTimes(1);
  });
  it('does not reopen a permanently deleted order as a missing-combo issue', async () => {
    const f = fixture(); await f.service.syncAllConnections(); f.stopNormalSearch();
    f.prisma.rakutenOrderSyncExclusion.findMany.mockResolvedValue([{ orderId: 'BAD', reason: 'user_delete' }]);
    const result = await f.service.syncAllConnections() as any;
    expect(result.results[0]).toMatchObject({ created: 0, comboMissingOrderCount: 0 });
    expect(f.issues[0].resolvedAt).toBeInstanceOf(Date);
    expect(f.records.map((row) => row.orderId)).toEqual(['GOOD']);
    expect(f.automation.sendImportedNewOrderMails).toHaveBeenCalledTimes(1);
  });
  it('returns a scoped manual-intervention list without connection credentials', async () => {
    const f = fixture(); await f.service.syncAllConnections();
    const list = await f.service.listImportIssues({ connectionId: '7', orderId: 'BAD' }) as any;
    expect(list).toMatchObject({ total: 1, items: [{ connectionId: '7', orderId: 'BAD', shopName: '店铺', comboSkus: ['zh-missing'] }] });
    expect(list.items[0].connection).toBeUndefined();
    expect((await f.service.listImportIssues({ orderId: 'OTHER' }) as any).total).toBe(0);
  });
  it('reports partial import in the coordinator and lets other enabled stages continue', async () => {
    const f = fixture();
    const orders = { syncRakutenTrackingStatuses: jest.fn().mockResolvedValue({ failedCount: 0 }) };
    const automation = { runScheduledAutomation: jest.fn().mockResolvedValue({ status: 'completed' }) };
    const controls = { execute: (_key: string, action: () => Promise<unknown>) => action(), enabled: jest.fn().mockResolvedValue(true) };
    const result = await new RakutenOrderSchedulerService(orders as any, automation as any, f.service, controls as any).runNow();
    expect(result).toMatchObject({ stages: { import: { status: 'partial', errors: [expect.stringContaining('等待人工')] } } });
    expect(orders.syncRakutenTrackingStatuses).toHaveBeenCalledTimes(1);
    expect(automation.runScheduledAutomation).toHaveBeenCalledTimes(2);
  });
});
