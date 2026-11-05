import * as XLSX from 'xlsx';
import { companyContext } from '../src/company-scope/company-context';
import { exportStoreDashboard } from '../src/common/store-dashboard-export';
import { RakutenRmsApiService } from '../src/rakuten-rms-api/rakuten-rms-api.service';

const current = new Date('2026-11-04T03:00:00Z');
const previous = new Date('2026-10-26T03:00:00Z');
// Prisma queries execute when awaited, rather than when constructed. Keep this
// behavior in the shared-store mocks to catch an ALS scope ending too early.
function lazyRead<T>(read: () => T): Promise<T> {
  return { then: (resolve: any, reject: any) => Promise.resolve().then(read).then(resolve, reject) } as Promise<T>;
}
function fixture() {
  const products = [
    { productId: 'A1', productName: 'Company A product', companyId: 1n, stockQty: 20, bomComponents: [] },
    { productId: 'A2', productName: 'Company A accessory', companyId: 1n, stockQty: 10, bomComponents: [] },
    { productId: 'B1', productName: 'PRIVATE_COMPANY_B_PRODUCT', companyId: 2n, stockQty: 50, bomComponents: [] },
  ];
  const combos = [
    { comboName: 'zh-A', items: [{ productId: 'A1' }, { productId: 'A2' }] },
    { comboName: 'zh-B', items: [{ productId: 'B1' }] },
    { comboName: 'zh-MIXED', items: [{ productId: 'A1' }, { productId: 'B1' }] },
  ];
  const row = (orderId: string, skuCode: string, orderQuantity: number, salesAmount: number, date = current, orderStatusText = '300') => ({
    orderId, skuCode, productName: skuCode === 'B1' ? 'PRIVATE_COMPANY_B_PRODUCT' : skuCode,
    orderQuantity, salesAmount, orderImportedAtRaw: date, orderStatusText,
    dispatchMode: null, shipmentNo: null, trackingIsDelivered: false,
  });
  // One original RMS order includes lines from both companies. The line amounts
  // already include each line's share of coupons; never use the full order total.
  const salesRows = [row('shared-order', 'A1', 2, 90), row('shared-order', 'B1', 3, 180),
    row('bundle-a', 'zh-A', 1, 120), row('bundle-b', 'zh-B', 1, 220),
    row('unknown', 'UNKNOWN', 1, 999), row('mixed-bundle', 'zh-MIXED', 1, 600),
    row('cancelled-a', 'A1', 99, 9999, current, '900'),
    row('previous-a', 'A1', 1, 30, previous), row('previous-b', 'B1', 1, 40, previous)];
  const connections = [1n, 2n].map(id => ({ id, companyId: 1n, shopId: id, shop: { id, name: `Japan store ${id}` },
    lastOrdersSyncedAt: null, lastSuccessfulSyncAt: null, licenseExpiresAt: null,
    lastSyncError: 'PRIVATE_OTHER_COMPANY_OPERATION_ERROR' }));
  const prisma: any = {
    rakutenRmsConnection: { findMany: jest.fn(() => lazyRead(() => {
      if (companyContext.getStore()?.systemAdmin === false && companyContext.getStore()?.warehouse === false) throw new Error('Shared store lookup was company-scoped');
      return connections;
    })) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    rakutenOrderRecord: { findMany: jest.fn().mockResolvedValue([]) },
    rakutenRmsSyncRun: { findFirst: jest.fn().mockResolvedValue({ status: 'success', startedAt: current, finishedAt: current,
      fetchedCount: 123456, errorMessage: 'PRIVATE_OTHER_COMPANY_SYNC_DATA' }) },
    rakutenComboProduct: { findMany: jest.fn(() => lazyRead(() => {
      expect(companyContext.getStore()?.warehouse).toBe(true);
      return combos;
    })) },
    masterProduct: { findMany: jest.fn(async ({ where }) => products.filter(product => where.productId.in.includes(product.productId)
      && (where.companyId === undefined || product.companyId === where.companyId))) },
    batchInboundItem: { findMany: jest.fn().mockResolvedValue([]) },
    batchInboundOrder: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const sales = { read: jest.fn(async (connectionId: bigint) => {
    expect(companyContext.getStore()?.warehouse).toBe(true);
    return { rows: salesRows.filter(row => connectionId === 1n || row.skuCode === 'B1').map(row => ({ ...row })),
      ready: true, coverageStart: null, coverageEnd: null, syncedAt: null, error: 'PRIVATE_OTHER_COMPANY_SALES_ERROR' };
  }) };
  const service = new RakutenRmsApiService(prisma, {} as any, {} as any, undefined, sales as any);
  return { service, prisma, sales };
}

describe('company-scoped Japanese Rakuten dashboard', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-05T03:00:00Z')); });
  afterEach(() => jest.useRealTimers());

  it.each([
    [1n, 210, 3, 30, ['A1', 'zh-A']],
    [2n, 400, 4, 40, ['B1', 'zh-B']],
  ] as const)('filters summary, trend, comparisons, bundles and Excel by product owner (case %#)', async (companyId, amount, units, previousAmount, skus) => {
    const { service, prisma } = fixture();
    const scope = { companyId, systemAdmin: false, warehouse: false, userId: 7n };
    await companyContext.run(scope, async () => {
      const payload: any = await service.getStoreDashboard('1', '7');
      expect(companyContext.getStore()).toBe(scope);
      expect(payload.dashboard.summary).toMatchObject({ orderCount: 2, unitCount: units, salesAmount: amount });
      expect(payload.dashboard.comparison.previous.salesAmount).toBe(previousAmount);
      expect(payload.dashboard.daily.reduce((sum: number, row: { salesAmount: number }) => sum + row.salesAmount, 0)).toBe(amount);
      expect(payload.dashboard.topProducts.map((row: { skuCode: string }) => row.skuCode).sort()).toEqual([...skus].sort());
      expect(payload.dashboard.topProducts.find((row: { skuCode: string }) => row.skuCode.startsWith('zh-')).componentProducts.every((product: { productId: string }) =>
        companyId === 1n ? product.productId.startsWith('A') : product.productId.startsWith('B'))).toBe(true);
      expect(payload.dashboard.matchCoverage.unmatchedCount).toBe(0);
      expect(payload.latestSyncRun).toBeNull();
      expect(payload.selectedShop.syncIssue).toBeNull();
      expect(payload.sourceSummary.sales.error).not.toContain('PRIVATE_');
      expect(payload.dashboard.factoryRecommendations.rows).toEqual([]);
      const file = exportStoreDashboard(payload, '乐天');
      const book = XLSX.read(file.content, { type: 'buffer' });
      expect(book.SheetNames).not.toContain('备货说明');
      expect(book.SheetNames).not.toContain('备货建议');
      const text = JSON.stringify(book.SheetNames.map(name => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 })));
      expect(text).not.toContain(companyId === 1n ? 'PRIVATE_COMPANY_B_PRODUCT' : 'Company A product');
      expect(text).not.toContain('UNKNOWN');
      expect(text).not.toContain('zh-MIXED');
    });
    expect(prisma.masterProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId }) }));
    expect(prisma.rakutenRmsSyncRun.findFirst).not.toHaveBeenCalled();
    expect(prisma.rakutenOrderRecord.findMany).not.toHaveBeenCalled();
    expect(prisma.batchInboundItem.findMany).not.toHaveBeenCalled();
    expect(prisma.batchInboundOrder.findMany).not.toHaveBeenCalled();
  });

  it('cannot reveal another company sales by selecting a shared Japan store', async () => {
    const { service } = fixture();
    const payload: any = await companyContext.run({ companyId: 1n, systemAdmin: false, warehouse: false, userId: 7n },
      () => service.getStoreDashboard('2', '7'));
    expect(payload.selectedShop.connectionId).toBe('2');
    expect(payload.dashboard.summary).toMatchObject({ orderCount: 0, unitCount: 0, salesAmount: 0 });
    expect(payload.dashboard.topProducts).toEqual([]);
  });

  it('preserves the complete warehouse view', async () => {
    const { service, prisma } = fixture();
    const payload: any = await companyContext.run({ warehouse: true, systemAdmin: false, userId: 8n },
      () => service.getStoreDashboard('1', '7'));
    expect(payload.dashboard.summary).toMatchObject({ orderCount: 5, unitCount: 9, salesAmount: 2209 });
    expect(payload.latestSyncRun.fetchedCount).toBe(123456);
    expect(prisma.rakutenRmsSyncRun.findFirst).toHaveBeenCalled();
    expect(prisma.rakutenOrderRecord.findMany).toHaveBeenCalled();
  });

  it('rejects a Chinese account without a company before reading sales', async () => {
    const { service, sales } = fixture();
    await companyContext.run({ systemAdmin: false, warehouse: false, userId: 7n }, async () => {
      await expect(service.getStoreDashboard()).rejects.toThrow('账号尚未分配公司');
    });
    expect(sales.read).not.toHaveBeenCalled();
  });
});
