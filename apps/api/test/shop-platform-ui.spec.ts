import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

const app = readFileSync(join(__dirname, '../public/app.js'), 'utf8');

function setup() {
  const elements: Record<string, any> = {};
  for (const id of ['shopsBody', 'shopsHead', 'shopPlatformTabs', 'shopNameInput', 'amazonManualMallName', 'amazonManualShopName']) {
    elements[id] = { value: '', innerHTML: '', disabled: false };
  }
  const submit = { disabled: false };
  elements.shopForm = { querySelector: () => submit };
  const state = {
    shopPlatforms: [{ key: 'amazon', name: 'Amazon' }, { key: 'rakuten', name: 'Rakuten' }, { key: 'custom', name: 'Yahoo' }],
    shopManagePlatform: 'custom',
    shops: [
      { id: '1', name: 'Amazon Store', platform: 'amazon', status: 1 },
      { id: '2', name: 'Rakuten Store', platform: 'rakuten', status: 1 },
      { id: '3', name: 'Yahoo Store', platform: 'custom', status: 1 },
      { id: '4', name: 'Disabled Store', platform: 'custom', status: 0 },
    ],
    shopEditingIds: new Set(),
    amazonSpApiConnections: [],
    rakutenRmsConnections: [{ id: '10', shop: { id: '2' }, status: 1 }],
    rakutenShopAutomationHealthItems: [],
  };
  const context: any = { state, $: (id: string) => elements[id], escapeHtml: (s: string) => s };
  runInNewContext(app.slice(app.indexOf('function renderShopsTable()'), app.indexOf('async function loadAmazonSpApiConnections()')), context);
  runInNewContext(app.slice(app.indexOf('function renderManualOrderShopOptions()'), app.indexOf('async function openAmazonManualOrderModal()')), context);
  return { context, elements, state };
}

describe('dynamic shop platform UI', () => {
  it('submits a new platform, selects its tab and refreshes the management list', async () => {
    const { context, elements, state } = setup();
    const button = { dataset: {}, textContent: '新增平台', disabled: false };
    let submit!: (event: any) => Promise<void>;
    elements.shopPlatformNameInput = { value: ' Yahoo Japan ' };
    elements.shopPlatformForm = {
      addEventListener: (_event: string, handler: typeof submit) => { submit = handler; },
      querySelector: () => button,
    };
    context.HTMLButtonElement = class {};
    context.request = jest.fn().mockResolvedValue({ key: 'new-platform', name: 'Yahoo Japan' });
    context.loadShops = jest.fn();
    context.loadAudit = jest.fn();
    context.showToast = jest.fn();
    runInNewContext(app.slice(app.indexOf('function getSubmitButton('), app.indexOf('function openDeleteConfirmModal(')), context);
    const start = app.indexOf('  $("shopPlatformForm")?.addEventListener');
    runInNewContext(app.slice(start, app.indexOf('  $("shopForm").addEventListener', start)), context);
    await submit({ preventDefault: jest.fn(), currentTarget: elements.shopPlatformForm });
    expect(context.request).toHaveBeenCalledWith('/shops/platforms', {
      method: 'POST', body: JSON.stringify({ name: 'Yahoo Japan' }),
    });
    expect(state.shopManagePlatform).toBe('new-platform');
    expect(elements.shopPlatformNameInput.value).toBe('');
    expect(context.loadShops).toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(context.showToast).toHaveBeenCalledWith('平台已新增');
  });

  it('shows every platform tab, including platforms with no shops', () => {
    const { context, elements, state } = setup();
    state.shopPlatforms.push({ key: 'empty', name: 'Empty Platform' });
    context.renderShopsTable();
    expect(elements.shopPlatformTabs.innerHTML).toContain('Amazon');
    expect(elements.shopPlatformTabs.innerHTML).toContain('Rakuten');
    expect(elements.shopPlatformTabs.innerHTML).toContain('Empty Platform');
    expect(elements.shopsBody.innerHTML).toContain('Yahoo Store');
    expect(elements.shopsBody.innerHTML).not.toContain('Amazon Store');
    expect(elements.shopsBody.innerHTML).not.toContain('data-action="rakutenRmsApi"');
    expect(elements.shopsHead.innerHTML).not.toContain('API');
  });

  it('preserves Amazon and Rakuten connection controls', () => {
    const { context, elements, state } = setup();
    state.shopManagePlatform = 'amazon';
    context.renderShopsTable();
    expect(elements.shopsBody.innerHTML).toContain('data-action="amazonSpApi"');
    state.shopManagePlatform = 'rakuten';
    context.renderShopsTable();
    expect(elements.shopsBody.innerHTML).toContain('data-action="rakutenRmsApi"');
    expect(elements.shopsBody.innerHTML).toContain('data-action="manageRakutenMail"');
    expect(elements.shopsBody.innerHTML).toContain('data-action="manageRakutenShipping"');
  });

  it('filters manual order shops by platform and removes a previous platform selection', () => {
    const { context, elements } = setup();
    context.renderManualOrderPlatformOptions();
    expect(elements.amazonManualMallName.innerHTML).toContain('value="Yahoo"');
    expect(elements.amazonManualShopName.disabled).toBe(true);
    elements.amazonManualMallName.value = 'Amazon';
    context.renderManualOrderShopOptions();
    elements.amazonManualShopName.value = 'Amazon Store';
    elements.amazonManualMallName.value = 'Yahoo';
    context.renderManualOrderShopOptions();
    expect(elements.amazonManualShopName.value).toBe('');
    expect(elements.amazonManualShopName.disabled).toBe(false);
    expect(elements.amazonManualShopName.innerHTML).toContain('Yahoo Store');
    expect(elements.amazonManualShopName.innerHTML).not.toContain('Amazon Store');
    expect(elements.amazonManualShopName.innerHTML).not.toContain('Disabled Store');
  });

  it('clears a deleted shop and handles platforms without shops', () => {
    const { context, elements, state } = setup();
    elements.amazonManualMallName.value = 'Yahoo';
    elements.amazonManualShopName.value = 'Yahoo Store';
    state.shops = [];
    context.renderManualOrderPlatformOptions();
    expect(elements.amazonManualMallName.value).toBe('Yahoo');
    expect(elements.amazonManualShopName.value).toBe('');
    expect(elements.amazonManualShopName.disabled).toBe(true);
    expect(elements.amazonManualShopName.innerHTML).toContain('该平台暂无店铺');
  });
});
