import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrdersService } from '../src/orders/orders.service';

function fixture() {
  const ignores = new Map<string, any>();
  const rows: any[] = [
    { id: 1n, shipmentNo: 'OLD-A', orderId: 'ORDER-1', trackingError: '跟踪号码不存在', dispatchMode: 'china_pending',
      deletedAt: null, shopName: null, shipmentCompany: 'Xiya', trackingCheckedAt: new Date('2026-10-14T08:00:00Z'), rmsConnection: null },
    { id: 2n, shipmentNo: 'OLD-A', orderId: 'ORDER-1', trackingError: '跟踪号码不存在', dispatchMode: 'china_pending',
      deletedAt: null, shopName: null, shipmentCompany: 'Xiya', trackingCheckedAt: new Date('2026-10-14T08:00:00Z'), rmsConnection: null },
    { id: 3n, shipmentNo: 'OTHER-B', orderId: 'ORDER-2', trackingError: 'HTTP 503', dispatchMode: 'china_no_stock',
      deletedAt: null, shopName: 'Shop B', shipmentCompany: 'Sagawa', trackingCheckedAt: new Date('2026-10-14T08:00:01Z'), rmsConnection: null },
  ];
  const eligible = () => rows.filter(r => r.deletedAt === null && ['china_pending', 'china_no_stock'].includes(r.dispatchMode) && r.trackingError
    && !ignores.get(r.shipmentNo)?.isActive);
  const db: any = {
    rakutenTrackingQueryIgnore: {
      findMany: jest.fn(async ({ where }: any) => [...ignores.values()].filter(r =>
        (where.isActive === undefined || r.isActive === where.isActive) && (!where.trackingNo || where.trackingNo.in.includes(r.trackingNo)))),
      upsert: jest.fn(async ({ where, create, update }: any) => { const r = ignores.get(where.trackingNo); ignores.set(where.trackingNo, r ? { ...r, ...update } : create); }),
      updateMany: jest.fn(async ({ where, data }: any) => { let count = 0; for (const [no, r] of ignores) if (where.trackingNo.in.includes(no) && r.isActive) { ignores.set(no, { ...r, ...data }); count++; } return { count }; }),
    },
    rakutenOrderRecord: {
      findMany: jest.fn(async ({ where, distinct }: any) => {
        let result = rows.filter(r => r.deletedAt === null && (!where.dispatchMode || where.dispatchMode.in.includes(r.dispatchMode))
          && (!where.trackingError || Boolean(r.trackingError))
          && (!where.shipmentNo?.in || where.shipmentNo.in.includes(r.shipmentNo))
          && (!where.shipmentNo?.notIn || !where.shipmentNo.notIn.includes(r.shipmentNo)));
        if (distinct) result = [...new Map(result.map(r => [r.shipmentNo, r])).values()];
        return result;
      }),
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(async (sql: any) => sql.sql.includes('GROUP BY')
      ? [...new Set(eligible().map(r => r.shipmentNo))].map(trackingNo => ({ trackingNo }))
      : [{ count: BigInt(new Set(eligible().map(r => r.shipmentNo)).size) }]),
    $transaction: jest.fn(async (work: any) => work(db)),
  };
  const service = new OrdersService(db);
  const acquire = jest.spyOn(service as any, 'acquireRakutenTrackingSyncLock').mockResolvedValue(true);
  const release = jest.spyOn(service as any, 'releaseRakutenTrackingSyncLock').mockResolvedValue(undefined);
  jest.spyOn(service as any, 'startRakutenTrackingSyncLockHeartbeat').mockReturnValue(undefined);
  jest.spyOn(service, 'getRakutenTrackingStatusSummary').mockResolvedValue({ latestCheckedAt: null, pendingTrackingNoCount: 0, uncheckedTrackingNoCount: 0 });
  const refresh = jest.spyOn(service as any, 'refreshRakutenTrackingStatusesForRows').mockImplementation(async (selected: any) =>
    new Map(selected.map((r: any) => [r.shipmentNo, { trackingNo: r.shipmentNo, error: r.trackingError }])));
  return { service, db, ignores, rows, acquire, release, refresh };
}

describe('Rakuten tracking failure review and ignores', () => {
  afterEach(() => jest.restoreAllMocks());

  it('deduplicates item rows while retaining associated orders and the original error', async () => {
    const f = fixture();
    const result = await f.service.listRakutenTrackingQueryFailures();
    expect(result).toMatchObject({ total: 2, failedCount: 2, ignoredCount: 0 });
    expect(result.items[0]).toMatchObject({ trackingNo: 'OLD-A', recordCount: 2, orderIds: ['ORDER-1'], error: '跟踪号码不存在' });
  });

  it('skips all rows sharing an ignored number, preserves logistics facts, and resumes after restore', async () => {
    const f = fixture();
    const before = structuredClone(f.rows);
    expect(await f.service.updateRakutenTrackingQueryIgnores({ trackingNos: [' OLD-A ', 'OLD-A'], ignored: true }, 'operator'))
      .toEqual({ changedCount: 1, ignored: true });
    expect(f.ignores.get('OLD-A')).toMatchObject({ ignoredBy: 'operator', isActive: true, ignoredAt: expect.any(Date) });
    expect(await f.service.syncRakutenTrackingStatuses()).toMatchObject({ trackingNoCount: 1, failedCount: 1 });
    expect(f.refresh.mock.calls[0][0]).toHaveLength(1);
    expect((await f.service.listRakutenTrackingQueryFailures()).items.map(r => r.trackingNo)).toEqual(['OTHER-B']);
    const ignored = await f.service.listRakutenTrackingQueryFailures('ignored');
    expect(ignored).toMatchObject({ failedCount: 1, ignoredCount: 1 });
    expect(ignored.items[0]).toMatchObject({ trackingNo: 'OLD-A', recordCount: 2, error: '跟踪号码不存在', ignoredBy: 'operator' });
    await f.service.updateRakutenTrackingQueryIgnores({ trackingNos: ['OLD-A'], ignored: false }, 'restorer');
    expect(f.ignores.get('OLD-A')).toMatchObject({ isActive: false, restoredBy: 'restorer', restoredAt: expect.any(Date) });
    expect(await f.service.syncRakutenTrackingStatuses()).toMatchObject({ trackingNoCount: 2, failedCount: 2 });
    expect(f.rows).toEqual(before);
    expect(f.db.rakutenOrderRecord.updateMany).not.toHaveBeenCalled();
  });

  it('retains the original actor on duplicate ignore and keeps corrected/deleted numbers restorable', async () => {
    const f = fixture();
    await f.service.updateRakutenTrackingQueryIgnores({ trackingNos: ['OLD-A'], ignored: true }, 'first');
    expect(await f.service.updateRakutenTrackingQueryIgnores({ trackingNos: ['OLD-A'], ignored: true }, 'second'))
      .toEqual({ changedCount: 0, ignored: true });
    f.rows[0].shipmentNo = 'NEW-A'; f.rows[1].deletedAt = new Date();
    const result = await f.service.listRakutenTrackingQueryFailures('ignored', 'OLD-A');
    expect(result.items[0]).toMatchObject({ trackingNo: 'OLD-A', recordCount: 0, ignoredBy: 'first' });
    await f.service.syncRakutenTrackingStatuses();
    expect((f.refresh.mock.calls[0][0] as any[]).map(r => r.shipmentNo)).toContain('NEW-A');
    await f.service.updateRakutenTrackingQueryIgnores({ trackingNos: ['OLD-A'], ignored: false }, 'restorer');
    expect(f.ignores.get('OLD-A').isActive).toBe(false);
  });

  it('rejects a stale mixed batch before writing any ignores', async () => {
    const f = fixture();
    await expect(f.service.updateRakutenTrackingQueryIgnores({ trackingNos: ['OLD-A', 'NOT-FAILED'], ignored: true }, 'operator'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(f.db.rakutenTrackingQueryIgnore.upsert).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('blocks manual ignore while a query round holds the same lock', async () => {
    const f = fixture(); f.acquire.mockResolvedValue(false);
    await expect(f.service.updateRakutenTrackingQueryIgnores({ trackingNos: ['OLD-A'], ignored: true }, 'operator'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });

  it.each([
    { trackingNos: [], ignored: true }, { trackingNos: ['OLD-A'], ignored: 'true' },
    { trackingNos: [123], ignored: true }, { trackingNos: [' '], ignored: true },
    { trackingNos: Array(101).fill('OLD-A'), ignored: true },
  ])('rejects malformed actions before accessing the database: %j', async payload => {
    const f = fixture();
    await expect(f.service.updateRakutenTrackingQueryIgnores(payload, 'operator')).rejects.toBeInstanceOf(BadRequestException);
    expect(f.acquire).not.toHaveBeenCalled();
  });
});
