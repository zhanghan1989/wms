import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as vm from 'vm';

it('retains a successful lock and reports refresh failure separately', async () => {
  const source = readFileSync(resolve(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('    const boxLockButton = event.target.closest');
  const end = source.indexOf('    const boxManageClose', start);
  const button = { dataset: { id: '7', status: '1' }, disabled: false, textContent: '锁定箱号' };
  const request = jest.fn().mockResolvedValue({ status: 2 });
  const showToast = jest.fn();
  const state = { boxManageRows: [{ id: '7', status: 1 }], boxes: [{ id: '7' }], overviewDashboardCache: new Map() };
  const context = vm.createContext({ request, showToast, state,
    reloadBoxesAfterManageMutation: jest.fn().mockRejectedValue(new Error('refresh failed')),
    loadBoxes: jest.fn().mockResolvedValue(undefined), loadEmptyBoxes: jest.fn().mockResolvedValue(undefined),
    resetOverseasWarehouseMoveForms: jest.fn(), resetReplaceBoxForm: jest.fn(),
    refreshMoveProductOldBoxOptionsByProduct: jest.fn().mockResolvedValue(undefined),
  });
  const handle = vm.runInContext(`(async function(event) { ${source.slice(start, end)} })`, context);
  await handle({ target: { closest: () => button } });
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ status: 2 });
  expect(button.dataset.status).toBe('2');
  expect(button.textContent).toBe('解锁箱号');
  expect(button.disabled).toBe(false);
  expect(state.boxes).toEqual([]);
  expect(showToast).toHaveBeenCalledWith(expect.stringContaining('箱号已锁定'), true);
  expect(showToast).toHaveBeenCalledWith(expect.stringContaining('部分列表刷新失败'), true);
});
