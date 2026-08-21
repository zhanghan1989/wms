import { parseRakutenOrderDate } from '../src/common/rakuten-order-date';

describe('Rakuten order date normalization', () => {
  it.each([
    ['2026-07-02 09:10:11', '2026-07-02'],
    ['2026/7/2 09:10:11', '2026-07-02'],
    ['2026年7月2日 09時10分11秒', '2026-07-02'],
    ['20260702', '2026-07-02'],
    ['7/2/2026 09:10:11', '2026-07-02'],
    ['2026-07-02T09:10:11+0900', '2026-07-02'],
    ['2026-07-01T17:10:11Z', '2026-07-02'],
  ])('normalizes %s', (source, expected) => {
    expect(parseRakutenOrderDate(source)?.toISOString().slice(0, 10)).toBe(expected);
  });

  it.each(['', null, 'not-a-date', '2026/13/40'])('returns null for %s', (source) => {
    expect(parseRakutenOrderDate(source)).toBeNull();
  });
});
