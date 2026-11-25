import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('async function createSkuFromModal()');
const createSkuScript = source.slice(start, source.indexOf('async function importSkusFromExcel(', start));

function createSkuForm(shop: string, existingShop: string) {
  const sku = 'sample-sku';
  const fields: Record<string, string> = { modalNewProductId: '123', modalNewSku: sku, modalNewShop: shop };
  const request = jest.fn(async (path: string) => {
    if (path.startsWith('/skus?')) return [{ sku, shop: existingShop }];
    if (shop === existingShop) throw new Error('SKU与所属店铺组合已存在');
  });
  const context = {
    $: (id: string) => ({ value: fields[id] ?? '' }),
    request,
    syncSkuProductName: async () => ({ productId: '123' }),
  };
  const submit = runInNewContext(`${createSkuScript}\ncreateSkuFromModal`, context) as () => Promise<void>;
  return { submit, request };
}

describe('single SKU creation', () => {
  it('submits a SKU already used by another shop', async () => {
    const { submit, request } = createSkuForm('乐天-2号店', '亚马逊日本站');
    await submit();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/skus', {
      method: 'POST',
      body: JSON.stringify({ productId: '123', shop: '乐天-2号店', sku: 'sample-sku' }),
    });
  });

  it('returns the server validation error for a duplicate in the same shop', async () => {
    const { submit, request } = createSkuForm('乐天-2号店', '乐天-2号店');
    await expect(submit()).rejects.toThrow('SKU与所属店铺组合已存在');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
