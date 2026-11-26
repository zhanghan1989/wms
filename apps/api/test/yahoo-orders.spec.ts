import { generateKeyPairSync } from 'node:crypto';
import { YahooOrdersClient, normalizeYahooPublicKey } from '../src/yahoo-orders/yahoo-orders.client';
import { YahooOrdersService } from '../src/yahoo-orders/yahoo-orders.service';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024, publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const credentials = { clientId: 'client', clientSecret: 'secret', publicKey, keyVersion: '1', accessToken: 'token' };

describe('Yahoo order API', () => {
  const from = new Date('2026-11-26T00:00:00+09:00');
  const to = new Date('2026-11-26T10:00:00+09:00');

  it('uses JST and verifies pagination against the Yahoo total', async () => {
    const client = new YahooOrdersClient();
    const request = jest.spyOn(client as any, 'request').mockResolvedValue(new Response(
      '<Result><Status>OK</Status><Search><TotalCount>2</TotalCount><OrderInfo><OrderId>store-112</OrderId></OrderInfo></Search></Result>',
    ));
    await expect(client.list('store', credentials, from, to, 2, 1)).resolves.toEqual({ total: 2, ids: ['store-112'] });
    expect(request.mock.calls[0][1]).toMatchObject({ body: expect.stringContaining('<OrderTimeFrom>20261126000000</OrderTimeFrom>'),
      headers: { 'x-sws-signature': expect.any(String), 'x-sws-signature-version': '1' } });
    request.mockResolvedValue(new Response('<Result><Status>OK</Status><Search><TotalCount>2</TotalCount></Search></Result>'));
    await expect(client.list('store', credentials, from, to, 1, 2)).rejects.toThrow('分页结果不完整');
  });

  it('distinguishes denied outbound IPs from an unapproved Client ID', async () => {
    const client = new YahooOrdersClient();
    const request = jest.spyOn(client as any, 'request').mockResolvedValue(new Response('<Error><Code>px-04306</Code></Error>', { status: 403 }));
    await expect(client.list('store', credentials, from, to, 1, 1)).rejects.toThrow('未授权飞牛 OS');
    request.mockResolvedValue(new Response('<Error><Code>px-04303</Code></Error>', { status: 403 }));
    await expect(client.list('store', credentials, from, to, 1, 1)).rejects.toThrow('订单 API 未开通');
  });

  it('accepts bare public-key text and calls no network without the configured proxy', async () => {
    const previous = process.env.RAKUTEN_RMS_API_PROXY_URL;
    delete process.env.RAKUTEN_RMS_API_PROXY_URL;
    try {
      const encoded = publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
      expect(normalizeYahooPublicKey(encoded)).toBe(publicKey);
      await expect(new YahooOrdersClient().list('store', credentials, from, to, 1, 1)).rejects.toThrow('日本出口未配置');
    } finally {
      if (previous !== undefined) process.env.RAKUTEN_RMS_API_PROXY_URL = previous;
    }
  });

  it('keeps an entire order pending on unmapped variants and maps only the selected shop', async () => {
    const findMany = jest.fn().mockResolvedValue([{ sku: 'blue', productId: '123' }]);
    const service = new YahooOrdersService({ sku: { findMany } } as any, {} as any, {} as any);
    const row = { shop: { name: '雅虎-1号店', platformDefinition: { name: 'yahoo' } } };
    const ship = { ShipStatus: '1', ShipLastName: 'Test', ShipFirstName: 'Recipient', ShipPhoneNumber: '000',
      ShipZipCode: '0012345', ShipPrefecture: 'Tokyo', ShipCity: 'Port', ShipAddress1: '1-2-3' };
    const item = { LineId: '001', ItemId: 'parent', SubCode: 'blue', Quantity: '2' };
    const order = { OrderStatus: '2', Ship: ship, Item: [item, { ...item, LineId: '002', SubCode: 'red' }] };
    await expect((service as any).mapOrder(row, 'store-1', order)).rejects.toThrow('未匹配店铺 SKU：red');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ shop: '雅虎-1号店' }) }));
    const resolved = await (service as any).mapOrder(row, 'store-1', { ...order, Item: item });
    expect(resolved).toEqual([expect.objectContaining({ orderId: 'store-1', orderItemId: '001', sku: 'blue',
      productId: '123', shipPostalCode: '0012345', quantityPurchased: 2 })]);
    await expect((service as any).mapOrder(row, 'store-1', { ...order, OrderStatus: '4' })).resolves.toBeNull();
  });
});
