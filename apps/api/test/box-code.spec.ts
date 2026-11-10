import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import { normalizeBoxCode, buildEquivalentBoxCodes } from '../src/common/box-code';
import { BatchInboundService } from '../src/batch-inbound/batch-inbound.service';

const app = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
const context: any = {};
for (const [start, end] of [
  ['function parseFixedDigits(', 'function buildShelfCode('],
  ['function normalizeBoxCodeInput(', 'function resolveEnabledBoxCode('],
]) {
  runInNewContext(app.slice(app.indexOf(start), app.indexOf(end)), context);
}

describe('four-digit box codes', () => {
  it.each([
    ['1', '0001'], ['001', '0001'], ['0001', '0001'], [' 999 ', '0999'],
    ['1000', '1000'], ['9999', '9999'], ['12345', '12345'],
  ])('normalizes %s consistently in the API and UI', (raw, expected) => {
    expect(normalizeBoxCode(raw)).toBe(expected);
    expect(context.normalizeBoxCodeInput(raw)).toBe(expected);
  });

  it('requires four digits when creating a box in either form', () => {
    expect(context.buildBoxCode('1234')).toBe('1234');
    expect(context.buildBoxCode('0001')).toBe('0001');
    expect(() => context.buildBoxCode('123')).toThrow('箱号必须是4位数字');
    expect(() => context.buildBoxCode('12345')).toThrow('箱号必须是4位数字');
  });

  it.each(['1', '001', '0001'])('finds legacy boxes and blocks equivalent duplicates for %s', raw => {
    expect(buildEquivalentBoxCodes(raw)).toEqual(['0001', '001', '1']);
  });

  it('generates four-digit numbers for batch inbound across the old boundary', () => {
    const format = (num: number) => (BatchInboundService.prototype as any).formatBoxCode(num);
    expect([1, 999, 1000, 9999].map(format)).toEqual(['0001', '0999', '1000', '9999']);
  });
});
