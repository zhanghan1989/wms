import { AuditService } from '../src/audit/audit.service';

describe('AuditService', () => {
  it('resolves legacy box labels in one batch and preserves historical snapshots', async () => {
    const rows = [
      { entityType: 'box', entityId: 1n, afterData: { boxCode: 'OLD-BOX' } },
      { entityType: 'box', entityId: 2n, afterData: {} },
      { entityType: 'master_product', entityId: 3n, afterData: { productId: 'P001' } },
    ];
    const prisma = {
      operationAuditLog: { count: jest.fn(), findMany: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([3, rows]),
      box: { findMany: jest.fn().mockResolvedValue([{ id: 1n, boxCode: 'NEW-BOX' }]) },
    };
    const result = await new AuditService(prisma as any).query({ page: 1, pageSize: 20 });
    expect(prisma.box.findMany).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([
      { ...rows[0], entityDisplayName: 'NEW-BOX' },
      { ...rows[1], entityDisplayName: null },
      { ...rows[2], entityDisplayName: null },
    ]);
    expect((result.items[0] as any).afterData.boxCode).toBe('OLD-BOX');
  });

  it('buildChangedFields returns only changed fields', () => {
    const service = new AuditService({} as any);

    const result = service.buildChangedFields(
      { a: 1, b: 'x', c: { nested: true } },
      { a: 1, b: 'y', c: { nested: true } },
    );

    expect(result).toEqual([{ field: 'b', before: 'x', after: 'y' }]);
  });
});
