import { readFileSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';

describe('Rakuten dashboard product links', () => {
  const source = readFileSync(join(__dirname, '../public/app.js'), 'utf8');
  const render = runInNewContext(`${source.slice(source.indexOf('function renderRakutenDashboardProduct('),
    source.indexOf('function renderRakutenStoreDashboard('))}; renderRakutenDashboardProduct`, {
    escapeHtml: (value: unknown) => String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    displayText: (value: unknown) => value || '-',
    renderMasterProductDetailLink: (id: string) => `<a data-product-id="${id}">${id}</a>`,
  });

  it('shows every original product with its detail link and escaped name', () => {
    const html = render({ skuCode: 'zh-12251', productId: null, componentProducts: [
      { productId: '12251', productName: '原始内胆包' },
      { productId: '1088', productName: '<script>配件</script>' },
    ] });
    expect(html).toContain('组合原始产品');
    expect(html).toContain('data-product-id="12251"');
    expect(html).toContain('data-product-id="1088"');
    expect(html).toContain('原始内胆包');
    expect(html).toContain('&lt;script&gt;配件&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('未匹配');
  });

  it('keeps direct product links and unresolved SKU labels', () => {
    expect(render({ productId: '12251', productName: '原始内胆包' })).toContain('data-product-id="12251"');
    expect(render({ productId: null, componentProducts: [], productName: '未配置组合' })).toContain('未匹配');
  });
});
