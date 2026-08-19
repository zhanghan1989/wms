import { ShopPlatform } from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShopsService } from '../src/shops/shops.service';

describe('ShopsService', () => {
  it('persists the selected platform when creating a shop', async () => {
    const created = {
      id: 12n,
      name: '乐天-3号店',
      platform: ShopPlatform.rakuten,
      status: 1,
    };
    const create = jest.fn().mockResolvedValue(created);
    const prisma = {
      shop: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
        callback({ shop: { create } }),
      ),
    } as unknown as PrismaService;
    const auditService = { create: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const service = new ShopsService(prisma, auditService);

    await expect(
      service.create({ name: ' 乐天-3号店 ', platform: ShopPlatform.rakuten }, 8n),
    ).resolves.toBe(created);
    expect(create).toHaveBeenCalledWith({
      data: { name: '乐天-3号店', platform: ShopPlatform.rakuten, status: 1 },
    });
    expect(auditService.create).toHaveBeenCalled();
  });
});
