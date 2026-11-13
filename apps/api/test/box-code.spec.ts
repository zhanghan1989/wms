import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import { normalizeBoxCode, buildEquivalentBoxCodes } from '../src/common/box-code';
import { BoxesService } from '../src/boxes/boxes.service';

const app = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
const context: any = {};
for (const [start, end] of [
  ['function parseFixedDigits(', 'function buildShelfCode('],
  ['function normalizeBoxCodeInput(', 'function resolveEnabledBoxCode('],
]) {
  runInNewContext(app.slice(app.indexOf(start), app.indexOf(end)), context);
}

describe('box codes without leading zeros', () => {
  it.each([
    ['1', '1'], ['001', '1'], ['0001', '1'], [' 999 ', '999'],
    ['0841', '841'], ['0000', '0'],
    ['1000', '1000'], ['9999', '9999'], ['12345', '12345'],
  ])('normalizes %s consistently in the API and UI', (raw, expected) => {
    expect(normalizeBoxCode(raw)).toBe(expected);
    expect(context.normalizeBoxCodeInput(raw)).toBe(expected);
  });

  it('accepts up to four digits when creating a box', () => {
    expect(context.buildBoxCode('1234')).toBe('1234');
    expect(context.buildBoxCode('0001')).toBe('1');
    expect(context.buildBoxCode('123')).toBe('123');
    expect(() => context.buildBoxCode('12345')).toThrow('箱号必须是1至4位数字');
  });

  it.each(['1', '001', '0001'])('finds legacy boxes and blocks equivalent duplicates for %s', raw => {
    expect(buildEquivalentBoxCodes(raw)).toEqual(['1', '01', '001', '0001', '00001', '000001']);
  });

  it.each(['841', '0841'])('resolves %s in the inbound dialog via the live lookup', async (storedCode) => {
    const enabledBox = { id: 1, boxCode: storedCode, status: 1 };
    const disabledBox = { id: 2, boxCode: '00841', status: 2 };
    const findMany = jest.fn(async ({ where }) => [disabledBox, enabledBox].filter(box =>
      box.status === where.status && where.boxCode.in.includes(box.boxCode),
    ));
    const service = new BoxesService({ box: { findMany } } as never, {} as never);
    const input = { value: '0841' };
    const hint = { classList: { add: jest.fn(), remove: jest.fn() } };
    const dialog: any = {
      state: { boxes: [] },
      request: (path: string) => {
        const url = new URL(path, 'https://example.test');
        expect(url.pathname).toBe('/boxes/options');
        return service.listOptions(undefined, url.searchParams.get('boxCode') ?? undefined);
      },
      $: (id: string) => id === 'inventoryDetailInboundBoxCode' ? input : hint,
      inventoryDetailInboundBoxValidationToken: 0,
      renderInventoryDetailInboundBoxSuggestions: jest.fn(),
    };
    runInNewContext(app.slice(app.indexOf('function normalizeBoxCodeInput('), app.indexOf('function getEnabledShelvesSorted(')), dialog);
    runInNewContext(app.slice(app.indexOf('async function validateInventoryDetailInboundBoxInput('), app.indexOf('function resetInventoryDetailInboundForm(')), dialog);

    await expect(dialog.validateInventoryDetailInboundBoxInput(input.value, { normalizeInput: true })).resolves.toBe(storedCode);
    expect(input.value).toBe('841');
    expect(hint.classList.add).toHaveBeenCalledWith('hidden');
    expect(dialog.state.boxes).toEqual([enabledBox]);
  });
});
