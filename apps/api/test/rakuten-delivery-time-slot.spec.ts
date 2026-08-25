import { normalizeRakutenDeliveryTimeSlot } from '../src/common/rakuten-delivery-time-slot';
import { PrismaService } from '../src/prisma/prisma.service';
import { RakutenRmsApiClient } from '../src/rakuten-rms-api/rakuten-rms-api.client';
import { RakutenRmsApiCryptoService } from '../src/rakuten-rms-api/rakuten-rms-api-crypto.service';
import { RakutenRmsApiService } from '../src/rakuten-rms-api/rakuten-rms-api.service';

describe('Rakuten delivery time slot', () => {
  it.each([
    ['1', '0812'],
    ['１', '0812'],
    ['午前中', '0812'],
    ['2', '1416'],
    ['２', '1416'],
    ['9', null],
    ['９', null],
    ['1416', '1416'],
    ['1618', '1618'],
    ['1820', '1820'],
    ['1921', '1921'],
    ['', null],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeRakutenDeliveryTimeSlot(input)).toBe(expected);
  });

  it('applies the manual-import normalization when mapping an API order', async () => {
    const service = new RakutenRmsApiService(
      {} as PrismaService,
      {} as RakutenRmsApiClient,
      {} as RakutenRmsApiCryptoService,
    );

    const rows = await (service as unknown as {
      mapOrders(orders: object[]): Promise<Array<{ deliveryTimeSlot: string | null; rawPayload: Record<string, unknown> }>>;
    }).mapOrders([
      {
        orderNumber: 'API-DELIVERY-TIME-1',
        shippingTerm: '1',
        PackageModelList: [
          {
            ItemModelList: [{ itemDetailId: 1, manageNumber: 'sku-1', units: 1 }],
          },
        ],
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryTimeSlot).toBe('0812');
    expect(rows[0].rawPayload['お届け時間帯']).toBe('0812');
  });
});
