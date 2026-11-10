import { MasterProductsService } from '../src/master-products/master-products.service';
import { OrdersService } from '../src/orders/orders.service';
import { companyContext } from '../src/company-scope/company-context';
import { resolveXiyaCompany, setXiyaCompanyParams } from '../src/common/xiya-company';

const scope = <T>(id: bigint, fn: () => T) => companyContext.run(
  { companyId: id, systemAdmin: true, warehouse: false, userId: 0n }, fn);
const companies = [{ id: 1n, name: 'XYJG', status: 1 }, { id: 2n, name: 'QLSZ', status: 1 }];
const companyModel = () => ({
  findUnique: jest.fn(async ({ where }) => companies.find((row) => row.id === where.id || row.name === where.name)),
  findMany: jest.fn().mockResolvedValue(companies),
});
const product = (productId: string, companyId: bigint, productName = '原名称') => ({
  productId, companyId, productName, productType: null, bagBrand: null, color: null,
  bagName: null, bagType: null, zipperStyle: null, style: null, pattern: null,
  buckleType: null, matchingBagType: null, length: null, width: null, patternType: null,
  size: null, yamatoPrinterName: null, stockQty: 0,
});
const response = (rows: unknown[], code = 0) => ({ ok: true, json: async () => ({ code, data: { rows } }) } as Response);

afterEach(() => jest.restoreAllMocks());

describe('Xiya company selection', () => {
  it('uses the company code only for Qilin and preserves the legacy company name', async () => {
    const prisma = { company: companyModel() } as any;
    for (const id of [1n, 2n]) {
      const profile = await scope(id, () => resolveXiyaCompany(prisma));
      const url = new URL('http://example.com/?company_name=OLD&company_code=OLD&apiKey=secret');
      setXiyaCompanyParams(url, profile);
      expect(url.searchParams.has('apiKey')).toBe(false);
      expect(url.searchParams.get('company_name')).toBe(id === 1n ? 'XYJG' : null);
      expect(url.searchParams.get('company_code')).toBe(id === 2n ? 'CO260716362' : null);
    }
  });

  it('rejects unselected, inactive and unconfigured companies instead of falling back to XYJG', async () => {
    const prisma = { company: { findUnique: jest.fn() } } as any;
    await expect(resolveXiyaCompany(prisma)).rejects.toThrow('请先选择');
    prisma.company.findUnique.mockResolvedValue({ name: '停用公司', status: 0 });
    await expect(scope(3n, () => resolveXiyaCompany(prisma))).rejects.toThrow('已停用');
    prisma.company.findUnique.mockResolvedValue({ name: '其他公司', status: 1 });
    await expect(scope(3n, () => resolveXiyaCompany(prisma))).rejects.toThrow('尚未配置');
  });
});

describe('company-scoped product sync', () => {
  it('imports new products into the selected company and skips foreign IDs without creating their brands', async () => {
    const existing = [product('FOREIGN', 1n), product('OWN', 2n)];
    const prisma = {
      company: companyModel(),
      masterProduct: {
        findMany: jest.fn(async () => companyContext.getStore()?.bypass ? existing : existing.filter((r) => r.companyId === companyContext.getStore()?.companyId)),
        createMany: jest.fn(async ({ data }) => ({ count: data.length })),
      },
      brand: { upsert: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(1),
      masterProductSyncRecord: { update: jest.fn() },
    };
    const service = new MasterProductsService(prisma as any, {} as any);
    jest.spyOn(service as any, 'fetchXiyaImportRows').mockResolvedValue([
      { ...product('FOREIGN', 2n, '错误覆盖'), bagBrand: '不应创建' },
      product('OWN', 2n, '新名称'), { ...product('NEW', 2n), bagBrand: '新品牌' },
    ]);
    await scope(2n, () => (service as any).runXiyaSyncJob(10n, 30));
    const created = prisma.masterProduct.createMany.mock.calls[0][0].data;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ productId: 'NEW', companyId: 2n });
    expect(prisma.brand.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.brand.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { companyId: 2n, name: '新品牌' } }));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = (prisma.$executeRaw.mock.calls as unknown[][])[0][0] as { values: unknown[] };
    expect(sql.values).toContain('OWN');
    expect(sql.values).not.toContain('FOREIGN');
    expect(prisma.masterProductSyncRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fetchedCount: 3, createdCount: 1, updatedCount: 1,
        errorMessage: expect.stringContaining('FOREIGN') }),
    }));
    expect(companyContext.getStore()).toBeUndefined();
  });

  it('keeps an all-conflict batch successful and records the skip', async () => {
    const service = new MasterProductsService({} as any, {} as any);
    jest.spyOn(service as any, 'fetchXiyaImportRows').mockResolvedValue([product('FOREIGN', 1n)]);
    jest.spyOn(service as any, 'loadExistingMasterProducts').mockResolvedValue(new Map([['FOREIGN', product('FOREIGN', 1n)]]));
    const upsert = jest.spyOn(service as any, 'upsertImportRows');
    const result = await scope(2n, () => (service as any).performXiyaSync(30));
    expect(result).toMatchObject({ totalRows: 1, importedCount: 0, conflictIds: ['FOREIGN'] });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('requests each upstream company with header authentication', async () => {
    const service = new MasterProductsService({ company: companyModel() } as any, {} as any);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response([]));
    for (const id of [1n, 2n]) await scope(id, () => (service as any).fetchXiyaImportRows(30));
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[0].searchParams.get('company_name')).toBe('XYJG');
    expect(urls[1].searchParams.get('company_code')).toBe('CO260716362');
    expect(urls[1].searchParams.has('company_name')).toBe(false);
    expect(urls.every((url) => !url.searchParams.has('apiKey'))).toBe(true);
    expect(fetchMock.mock.calls[1][1]?.headers).toHaveProperty('x-api-key');
  });

  it('runs scheduled companies sequentially with independent records and default windows', async () => {
    let recordId = 0n;
    const prisma = { company: companyModel(), masterProductSyncRecord: {
      create: jest.fn(async () => ({ id: ++recordId })), update: jest.fn(), updateMany: jest.fn(),
    } };
    const service = new MasterProductsService(prisma as any, {} as any);
    const seen: Array<[bigint | undefined, number]> = [];
    jest.spyOn(service as any, 'performXiyaSync').mockImplementation(async (days: any) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      seen.push([companyContext.getStore()?.companyId, days]);
      return { totalRows: 0, createdCount: 0, updatedCount: 0, conflictIds: [] };
    });
    await service.runScheduledMasterProductSync();
    expect(seen).toEqual([[1n, 10], [2n, 30]]);
    expect(prisma.masterProductSyncRecord.create).toHaveBeenCalledTimes(2);
    expect(prisma.masterProductSyncRecord.update).toHaveBeenCalledTimes(2);
  });
});

describe('Qilin logistics sync', () => {
  it('queries all stores, prefers logistics_order_id with tracking_number fallback and ignores blank or unknown rows', async () => {
    const prisma = { company: companyModel(), shop: { findMany: jest.fn().mockResolvedValue([
      { name: '护鞋俱乐部', platform: 'rakuten', status: 1 },
      { name: 'Iforwishyou旗舰店', platform: 'custom', status: 1 },
    ]) } };
    const service = new OrdersService(prisma as any);
    const apply = jest.spyOn(service as any, 'applyXiyaTrackingCandidates').mockResolvedValue({ updatedCount: 0, skippedUnmatchedCount: 0 });
    const row = { store_name: '护鞋俱乐部', sales_order_id: 'ORDER', logistics_order_id: 'INTERNAL', tracking_number: 'TRACK', created_at: '2026-11-05T10:00:00+08:00' };
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response([
      row, { ...row, sales_order_id: 'FALLBACK', logistics_order_id: '', tracking_number: 'FALLBACK-TRACK' },
      { ...row, sales_order_id: 'BLANK', logistics_order_id: '', tracking_number: '' },
      { ...row, store_name: '别家公司店铺', sales_order_id: 'UNKNOWN' },
    ]));
    const result = await scope(2n, () => service.syncXiyaTrackingNumbers());
    expect(result).toMatchObject({ days: 30, fetchedCount: 4, validCount: 2 });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('company_code')).toBe('CO260716362');
    expect(url.searchParams.has('company_name')).toBe(false);
    expect(url.searchParams.get('storeName')).toBe('all');
    expect(url.searchParams.get('days')).toBe('30');
    expect(apply).toHaveBeenCalledWith('rakuten', [expect.objectContaining({ trackingNo: 'INTERNAL' }), expect.objectContaining({ trackingNo: 'FALLBACK-TRACK' })]);
    expect(apply).toHaveBeenCalledWith('manual', expect.any(Array), false);
    fetchMock.mockResolvedValue(response([]));
    await expect(scope(2n, () => service.syncXiyaTrackingNumbers(90))).resolves.toMatchObject({ days: 90, fetchedCount: 0 });
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('days')).toBe('90');
    await expect(scope(2n, () => service.syncXiyaTrackingNumbers(0))).rejects.toThrow('1 到 365');
  });

  it('maps upstream aliases only to enabled shops in the selected company', async () => {
    const service = new OrdersService({ shop: { findMany: jest.fn().mockResolvedValue([
      { name: '本地店铺', platform: 'rakuten', status: 1 },
      { name: '停用店铺', platform: 'amazon', status: 0 },
    ]) } } as any);
    const map = await (service as any).loadXiyaLogisticsStoreSources({ allStores: true,
      storeAliases: { '护鞋俱乐部': '本地店铺', '不应启用': '停用店铺' } });
    expect(map.get('护鞋俱乐部')).toBe('rakuten');
    expect(map.has('不应启用')).toBe(false);
    expect(map.has('DGAZ乐天日本')).toBe(false);
  });
});


describe('Qilin blogger cooperation status is deferred', () => {
  it('does not push status for a Qilin-owned order even in warehouse context', async () => {
    const prisma = { company: companyModel(), manualOrderRecord: { findMany: jest.fn() } };
    const service = new OrdersService(prisma as any);
    const fetchMock = jest.spyOn(global, 'fetch');
    await companyContext.run({ systemAdmin: false, warehouse: true, userId: 9n }, () =>
      (service as any).syncManualOrdersToXyjgBestEffort([
        { id: 1n, companyId: 2n, orderId: 'Q-ORDER', bloggerCooperationId: '123',
          shipmentNo: 'TRACK', dispatchMode: 'china_no_stock' },
      ]));
    expect(prisma.company.findUnique).toHaveBeenCalledWith({ where: { id: 2n } });
    expect(prisma.manualOrderRecord.findMany).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe('XYJG legacy compatibility', () => {
  it('keeps the warehouse sync action in XYJG scope with the legacy five-day window', async () => {
    const seen: Array<bigint | undefined> = [];
    const prisma = { company: companyModel(), shop: { findMany: jest.fn(async () => {
      seen.push(companyContext.getStore()?.companyId);
      return [{ name: '原店铺', platform: 'amazon', status: 1 }];
    }) } };
    const service = new OrdersService(prisma as any);
    jest.spyOn(service as any, 'applyXiyaTrackingCandidates').mockResolvedValue({ updatedCount: 0, skippedUnmatchedCount: 0 });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response([]));
    await companyContext.run({ systemAdmin: false, warehouse: true, userId: 9n }, () => service.syncXiyaTrackingNumbers());
    expect(seen).toEqual([1n]);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('company_name')).toBe('XYJG');
    expect(url.searchParams.get('days')).toBe('5');
    expect(url.searchParams.get('storeName')).toContain('原店铺');
  });

  it.each(['china_no_stock', 'overseas'])('preserves XYJG blogger status push for %s and deduplicates repeats', async (dispatchMode) => {
    const row: any = { id: 11n, companyId: 1n, orderId: 'XYJG-ORDER', bloggerCooperationId: '123', shipmentNo: 'TRACK', dispatchMode };
    const prisma = { company: companyModel(), manualOrderRecord: {
      findMany: jest.fn().mockResolvedValue([row]),
      updateMany: jest.fn(async ({ data }) => { Object.assign(row, data); return { count: 1 }; }),
    } };
    const service = new OrdersService(prisma as any);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => JSON.stringify({ code: 0 }) } as Response);
    await scope(1n, () => (service as any).syncManualOrdersToXyjgBestEffort([row]));
    const payload = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(payload).toEqual({ company_name: 'XYJG', blogger_cooperation_id: '123',
      switch_to_china_ship: dispatchMode === 'china_no_stock',
      ...(dispatchMode === 'overseas' ? { tracking_number: 'TRACK' } : {}),
    });
    expect(prisma.manualOrderRecord.findMany).toHaveBeenCalledWith({ where: { orderId: 'XYJG-ORDER', companyId: 1n } });
    await scope(1n, () => (service as any).syncManualOrdersToXyjgBestEffort([row]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('product sync scope by account', () => {
  const fixture = () => {
    let recordId = 0n;
    const recordOwners: bigint[] = [];
    const prisma = { company: companyModel(), masterProductSyncRecord: {
      create: jest.fn(async () => { recordOwners.push(companyContext.getStore()!.companyId!); return { id: ++recordId }; }),
      update: jest.fn(), updateMany: jest.fn(),
    } };
    const service = new MasterProductsService(prisma as any, {} as any);
    const seen: Array<[bigint | undefined, number]> = [];
    const perform = jest.spyOn(service as any, 'performXiyaSync').mockImplementation(async (days: any) => {
      seen.push([companyContext.getStore()?.companyId, days]);
      expect((service as any).masterProductSyncRunning).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { totalRows: 0, createdCount: 0, updatedCount: 0, conflictIds: [] };
    });
    return { service, prisma, seen, recordOwners, perform };
  };

  it.each([undefined, 45])('syncs both companies for warehouse users, with independent records (days=%s)', async (days) => {
    const { service, prisma, seen, recordOwners } = fixture();
    const result = await companyContext.run({ systemAdmin: false, warehouse: true, userId: 9n }, () =>
      service.triggerXiyaSync(days, { operationType: 'manual_sync', operatorName: '仓库操作员' }, true));
    expect(seen).toEqual([[1n, days ?? 10], [2n, days ?? 30]]);
    expect(recordOwners).toEqual([1n, 2n]);
    expect(result.recordIds).toEqual(['1', '2']);
    expect(result.message).toContain('全部 2 家公司');
    expect(prisma.masterProductSyncRecord.update).toHaveBeenCalledTimes(2);
    expect((service as any).masterProductSyncRunning).toBe(false);
  });

  it.each([1n, 2n])('only syncs the signed-in Chinese company %s', async (companyId) => {
    const { service, prisma, seen, recordOwners } = fixture();
    await companyContext.run({ companyId, systemAdmin: false, warehouse: false, userId: 10n }, () =>
      service.triggerXiyaSync(undefined, { operationType: 'manual_sync' }, true));
    expect(seen).toEqual([[companyId, companyId === 1n ? 10 : 30]]);
    expect(recordOwners).toEqual([companyId]);
    expect(prisma.company.findMany).not.toHaveBeenCalled();
  });

  it('keeps the global lock between company jobs and continues after one company fails', async () => {
    const { service, prisma, seen, perform } = fixture();
    perform.mockImplementation(async (days: any) => {
      const id = companyContext.getStore()!.companyId;
      seen.push([id, days]);
      await expect(scope(1n, () => service.triggerXiyaSync())).rejects.toThrow('已有产品主表同步');
      if (id === 1n) throw new Error('XYJG upstream unavailable');
      return { totalRows: 0, createdCount: 0, updatedCount: 0, conflictIds: [] };
    });
    await companyContext.run({ systemAdmin: false, warehouse: true, userId: 9n }, () =>
      service.triggerXiyaSync(undefined, undefined, true));
    expect(seen).toEqual([[1n, 10], [2n, 30]]);
    expect(prisma.masterProductSyncRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1n }, data: expect.objectContaining({ status: 'failed' }),
    }));
    expect(prisma.masterProductSyncRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 2n }, data: expect.objectContaining({ status: 'success' }),
    }));
    expect((service as any).masterProductSyncRunning).toBe(false);
  });
});
