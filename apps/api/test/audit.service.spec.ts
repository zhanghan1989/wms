import { AuditService } from '../src/audit/audit.service';

describe('AuditService', () => {
  it('buildChangedFields returns only changed fields', () => {
    const service = new AuditService({} as any);

    const result = service.buildChangedFields(
      { a: 1, b: 'x', c: { nested: true } },
      { a: 1, b: 'y', c: { nested: true } },
    );

    expect(result).toEqual([{ field: 'b', before: 'x', after: 'y' }]);
  });
});
