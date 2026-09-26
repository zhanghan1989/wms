import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

describe('operation audit display', () => {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const constant = (name: string) => {
    const start = source.indexOf(`const ${name} =`);
    return source.slice(start, source.indexOf('\n};', start) + 3);
  };
  const context: any = { state: { auditFbaRequestNoById: {} } };
  runInNewContext(
    constant('AUDIT_ENTITY_TEXT_MAP') + constant('AUDIT_EVENT_TEXT_MAP')
      + source.slice(source.indexOf('function toAuditRecord('), source.indexOf('function renderAuditTable(')),
    context,
  );

  it('shows product identity and stock changes from historical data', () => {
    const item = { entityType: 'master_product', entityId: '7', eventType: 'inventory_adjust_confirmed',
      beforeData: { productId: 'P001', productName: '测试商品', stockQty: 10 },
      afterData: { productId: 'P001', productName: '测试商品', stockQty: 8, qtyDelta: -2, boxCode: '505' } };
    expect(context.formatAuditEntity(item)).toBe('商品：P001 / 测试商品');
    expect(context.formatAuditEvent(item)).toContain('总库存：10 → 8');
    expect(context.formatAuditEvent(item)).toContain('数量减少 2');
    expect(context.formatAuditEvent(item)).toContain('箱号：505');
  });

  it('prefers recorded box names and identifies deleted legacy entities by ID', () => {
    expect(context.formatAuditEntity({ entityType: 'box', entityId: '1', afterData: { boxCode: 'OLD' }, entityDisplayName: 'NEW' })).toBe('箱号：OLD');
    expect(context.formatAuditEntity({ entityType: 'box', entityId: '2', entityDisplayName: '505' })).toBe('箱号：505');
    expect(context.formatAuditEntity({ entityType: 'box', entityId: '3' })).toBe('箱号（编号 3）');
  });

  it('shows renamed fields without exposing unknown sensitive fields', () => {
    const item = { eventType: 'box_field_updated', changedFields: [
      { field: 'boxCode', before: 'A', after: 'B' },
      { field: 'passwordHash', before: 'SECRET1', after: 'SECRET2' },
    ] };
    expect(context.formatAuditEvent(item)).toContain('箱号：A → B');
    expect(context.formatAuditEvent(item)).not.toContain('SECRET');
  });
});
