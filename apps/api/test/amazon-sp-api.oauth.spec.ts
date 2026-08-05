import { createHash } from 'crypto';
import { AmazonSpApiClient } from '../src/amazon-sp-api/amazon-sp-api.client';
import { AmazonSpApiCryptoService } from '../src/amazon-sp-api/amazon-sp-api-crypto.service';
import { AmazonSpApiService } from '../src/amazon-sp-api/amazon-sp-api.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Amazon public OAuth workflow', () => {
  const originalApplicationId = process.env.AMAZON_SP_API_APPLICATION_ID;
  const originalSellerCentralUrl = process.env.AMAZON_SP_API_SELLER_CENTRAL_URL;
  const originalDraft = process.env.AMAZON_SP_API_OAUTH_DRAFT;

  afterEach(() => {
    jest.restoreAllMocks();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('AMAZON_SP_API_APPLICATION_ID', originalApplicationId);
    restore('AMAZON_SP_API_SELLER_CENTRAL_URL', originalSellerCentralUrl);
    restore('AMAZON_SP_API_OAUTH_DRAFT', originalDraft);
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
});
