import { createHash } from 'crypto';
import { AmazonSpApiClient } from '../src/amazon-sp-api/amazon-sp-api.client';
import { AmazonSpApiCryptoService } from '../src/amazon-sp-api/amazon-sp-api-crypto.service';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Amazon public OAuth workflow', () => {
  const originalApplicationId = process.env.AMAZON_SP_API_APPLICATION_ID;
  const originalSellerCentralUrl = process.env.AMAZON_SP_API_SELLER_CENTRAL_URL;
  const originalDraft = process.env.AMAZON_SP_API_OAUTH_DRAFT;
  const originalRedirectUri = process.env.AMAZON_SP_API_OAUTH_REDIRECT_URI;

  afterEach(() => {
    jest.restoreAllMocks();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('AMAZON_SP_API_APPLICATION_ID', originalApplicationId);
    restore('AMAZON_SP_API_SELLER_CENTRAL_URL', originalSellerCentralUrl);
    restore('AMAZON_SP_API_OAUTH_DRAFT', originalDraft);
    restore('AMAZON_SP_API_OAUTH_REDIRECT_URI', originalRedirectUri);
  });

  it('stores only a hash of the short-lived state and returns the Amazon consent URL', async () => {
    process.env.AMAZON_SP_API_APPLICATION_ID = 'amzn1.sellerapps.app.test';
    process.env.AMAZON_SP_API_SELLER_CENTRAL_URL = 'https://sellercentral.amazon.co.jp';
    process.env.AMAZON_SP_API_OAUTH_DRAFT = 'true';
    const create = jest.fn().mockResolvedValue({});
    const prisma = {
      shop: { findUnique: jest.fn().mockResolvedValue({ id: 7n, name: 'JP Store' }) },
      amazonSpApiOAuthState: { create, deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(
      prisma,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await service.startOAuth({
      shopId: '7',
      region: 'FE',
      marketplaceIds: ['A1VC38T7YXB528'],
    }, 3n);

    const url = new URL(result.authorizationUrl);
    const rawState = String(url.searchParams.get('state'));
    const stored = create.mock.calls[0][0].data;
    expect(url.origin).toBe('https://sellercentral.amazon.co.jp');
    expect(url.searchParams.get('application_id')).toBe('amzn1.sellerapps.app.test');
    expect(url.searchParams.get('version')).toBe('beta');
    expect(rawState.length).toBeGreaterThan(30);
    expect(stored.stateHash).toBe(createHash('sha256').update(rawState).digest('hex'));
    expect(Object.values(stored).map((value) => String(value)).join('|')).not.toContain(rawState);
    expect(stored).toMatchObject({ shopId: 7n, createdBy: 3n, region: 'FE' });
  });

  it('continues an Appstore-initiated authorization with a seller-bound one-time state', async () => {
    process.env.AMAZON_SP_API_OAUTH_DRAFT = 'true';
    process.env.AMAZON_SP_API_OAUTH_REDIRECT_URI =
      'https://wms.fulangke.cn/api/amazon-sp-api/oauth/callback';
    const create = jest.fn().mockResolvedValue({});
    const prisma = {
      shop: { findUnique: jest.fn().mockResolvedValue({ id: 9n, name: 'Independent Store' }) },
      amazonSpApiConnection: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      amazonSpApiOAuthState: { create, deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(
      prisma,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    const result = await service.continueAppstoreOAuth({
      shopId: '9',
      region: 'FE',
      marketplaceIds: ['A1VC38T7YXB528'],
      amazonCallbackUri: 'https://sellercentral.amazon.co.jp/apps/authorize/confirm/app-id',
      amazonState: 'amazon-owned-state',
      sellingPartnerId: 'A1SELLERTEST123',
      version: 'beta',
    }, 4n);

    const url = new URL(result.amazonConfirmationUrl);
    const rawState = String(url.searchParams.get('state'));
    expect(url.hostname).toBe('sellercentral.amazon.co.jp');
    expect(url.searchParams.get('amazon_state')).toBe('amazon-owned-state');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://wms.fulangke.cn/api/amazon-sp-api/oauth/callback',
    );
    expect(url.searchParams.get('version')).toBe('beta');
    expect(create.mock.calls[0][0].data).toMatchObject({
      shopId: 9n,
      createdBy: 4n,
      expectedSellerId: 'A1SELLERTEST123',
      stateHash: createHash('sha256').update(rawState).digest('hex'),
    });
  });

  it('rejects a non-Amazon Appstore callback URI', async () => {
    const prisma = {
      shop: { findUnique: jest.fn() },
      amazonSpApiConnection: { findUnique: jest.fn(), findFirst: jest.fn() },
      amazonSpApiOAuthState: { create: jest.fn(), deleteMany: jest.fn() },
    } as unknown as PrismaService;
    const service = new AmazonSpApiService(
      prisma,
      {} as AmazonSpApiClient,
      {} as AmazonSpApiCryptoService,
    );

    await expect(service.continueAppstoreOAuth({
      shopId: '9',
      region: 'FE',
      marketplaceIds: ['A1VC38T7YXB528'],
      amazonCallbackUri: 'https://amazon.com.attacker.example/apps/authorize/confirm/app-id',
      amazonState: 'amazon-owned-state',
      sellingPartnerId: 'A1SELLERTEST123',
    }, 4n)).rejects.toThrow('Amazon callback URI未通过安全校验');
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
  });
});
