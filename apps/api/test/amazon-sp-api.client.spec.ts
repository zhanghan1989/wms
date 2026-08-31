import { AmazonSpApiClient } from '../src/amazon-sp-api/amazon-sp-api.client';
import { AmazonSpApiCryptoService } from '../src/amazon-sp-api/amazon-sp-api-crypto.service';

describe('Amazon SP-API integration primitives', () => {
  const originalEncryptionKey = process.env.AMAZON_SP_API_ENCRYPTION_KEY;
  const originalClientId = process.env.AMAZON_SP_API_LWA_CLIENT_ID;
  const originalClientSecret = process.env.AMAZON_SP_API_LWA_CLIENT_SECRET;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalEncryptionKey === undefined) {
      delete process.env.AMAZON_SP_API_ENCRYPTION_KEY;
    } else {
      process.env.AMAZON_SP_API_ENCRYPTION_KEY = originalEncryptionKey;
    }
    if (originalClientId === undefined) delete process.env.AMAZON_SP_API_LWA_CLIENT_ID;
    else process.env.AMAZON_SP_API_LWA_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.AMAZON_SP_API_LWA_CLIENT_SECRET;
    else process.env.AMAZON_SP_API_LWA_CLIENT_SECRET = originalClientSecret;
  });

  it('exchanges a public OAuth authorization code without exposing credentials in the URL', async () => {
    process.env.AMAZON_SP_API_LWA_CLIENT_ID = 'amzn-client-id';
    process.env.AMAZON_SP_API_LWA_CLIENT_SECRET = 'client-secret';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        access_token: 'access-token',
        refresh_token: 'Atzr|oauth-refresh-token',
      }), { status: 200 }),
    );
    const client = new AmazonSpApiClient();
    const result = await client.exchangeAuthorizationCode(
      'spapi-oauth-code',
      'https://wms.example.com/api/amazon-sp-api/oauth/callback',
    );

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'Atzr|oauth-refresh-token',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.amazon.com/auth/o2/token');
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(String(request.body)).toContain('grant_type=authorization_code');
    expect(String(request.body)).toContain('code=spapi-oauth-code');
    expect(String(request.body)).toContain('client_secret=client-secret');
  });

  it('encrypts refresh tokens with authenticated encryption', () => {
    process.env.AMAZON_SP_API_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const service = new AmazonSpApiCryptoService();
    const encrypted = service.encrypt('Atzr|refresh-token-value');

    expect(encrypted.encryptedValue).not.toContain('refresh-token-value');
    expect(service.decrypt(encrypted.encryptedValue, encrypted.iv, encrypted.authTag)).toBe(
      'Atzr|refresh-token-value',
    );
  });

  it('uses Orders v2026 and separates FBM from FBA at the API filter', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ orders: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new AmazonSpApiClient();
    await client.searchOrders({
      accessToken: 'access-token',
      region: 'FE',
      marketplaceIds: ['A1VC38T7YXB528'],
      fulfilledBy: 'MERCHANT',
      lastUpdatedAfter: new Date('2026-07-01T00:00:00.000Z'),
      includeRecipient: true,
    });

    const requestUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestUrl).toContain('sellingpartnerapi-fe.amazon.com/orders/2026-01-01/orders?');
    expect(requestUrl).toContain('fulfilledBy=MERCHANT');
    expect(requestUrl).toContain('marketplaceIds=A1VC38T7YXB528');
    expect(decodeURIComponent(requestUrl)).toContain(
      'includedData=RECIPIENT,FULFILLMENT,CANCELLATION,PACKAGES',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ 'x-amz-access-token': 'access-token' }),
    });
  });

  it('follows inventory pagination and preserves marketplace scope', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payload: { inventorySummaries: [{ sellerSku: 'SKU-1' }] },
        pagination: { nextToken: 'page-2' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payload: { inventorySummaries: [{ sellerSku: 'SKU-2' }] },
      }), { status: 200 }));
    const client = new AmazonSpApiClient();
    const rows = await client.getInventorySummaries({
      accessToken: 'access-token',
      region: 'FE',
      marketplaceId: 'A1VC38T7YXB528',
    });

    expect(rows.map((row) => row.sellerSku)).toEqual(['SKU-1', 'SKU-2']);
    expect(String(fetchMock.mock.calls[1][0])).toContain('nextToken=page-2');
    expect(String(fetchMock.mock.calls[1][0])).toContain('marketplaceIds=A1VC38T7YXB528');
  });

  it('retries throttled order requests up to a successful response', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: 'throttled' }] }), {
        status: 429,
        headers: { 'retry-after': '0' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ orders: [{ orderId: '503-1' }] }), {
        status: 200,
      }));
    const client = new AmazonSpApiClient();

    const rows = await client.searchOrders({
      accessToken: 'access-token',
      region: 'FE',
      marketplaceIds: ['A1VC38T7YXB528'],
      fulfilledBy: 'MERCHANT',
      lastUpdatedAfter: new Date('2026-08-01T00:00:00.000Z'),
      includeRecipient: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows).toEqual([{ orderId: '503-1' }]);
  });

  it('stops when Amazon repeats the same order pagination token', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orders: [{ orderId: '503-1' }],
        pagination: { nextToken: 'same-token' },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        orders: [{ orderId: '503-2' }],
        pagination: { nextToken: 'same-token' },
      }), { status: 200 }));
    const client = new AmazonSpApiClient();

    await expect(client.searchOrders({
      accessToken: 'access-token',
      region: 'FE',
      marketplaceIds: ['A1VC38T7YXB528'],
      fulfilledBy: 'MERCHANT',
      lastUpdatedAfter: new Date('2026-08-01T00:00:00.000Z'),
      includeRecipient: false,
    })).rejects.toThrow('分页令牌重复');
  });

  it('parses both seconds and HTTP-date Retry-After headers', () => {
    const client = new AmazonSpApiClient();
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-31T00:00:00.000Z').getTime());

    expect((client as any).retryAfterMilliseconds('2')).toBe(2000);
    expect((client as any).retryAfterMilliseconds('Mon, 31 Aug 2026 00:00:03 GMT')).toBe(3000);
  });

  it('includes the Amazon request id in terminal API errors', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message: 'forbidden' }],
    }), {
      status: 403,
      headers: { 'x-amzn-requestid': 'request-123' },
    }));
    const client = new AmazonSpApiClient();

    await expect(client.searchOrders({
      accessToken: 'access-token',
      region: 'FE',
      marketplaceIds: ['A1VC38T7YXB528'],
      fulfilledBy: 'MERCHANT',
      lastUpdatedAfter: new Date('2026-08-01T00:00:00.000Z'),
      includeRecipient: false,
    })).rejects.toThrow('request-123');
  });
});
