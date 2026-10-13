import { Prisma } from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShopsService } from '../src/shops/shops.service';

describe('ShopsService', () => {
  it('creates a named platform and records its audit log atomically', async () => {
    const created = { id: 3n, key: 'custom-platform', name: 'Yahoo' };
    const create = jest.fn().mockResolvedValue(created);
    const tx = { shopPlatformDefinition: { create } };
    const audit = { create: jest.fn() };
    const service = new ShopsService({ $transaction: (work: any) => work(tx) } as any, audit as any);
    await expect(service.createPlatform({ name: ' Yahoo ' }, 8n)).resolves.toEqual(created);
    expect(create).toHaveBeenCalledWith({ data: { name: 'Yahoo' } });
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({
      db: tx, entityType: 'shop_platform', entityId: 3n, eventType: 'shop_platform_created',
    }));
  });

  it('rejects whitespace-only and duplicate platform names', async () => {
    const transaction = jest.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      'duplicate', { code: 'P2002', clientVersion: '6' },
    ));
    const service = new ShopsService({ $transaction: transaction } as any, {} as any);
    await expect(service.createPlatform({ name: '   ' }, 8n)).rejects.toThrow('平台名称不能为空');
    expect(transaction).not.toHaveBeenCalled();
    await expect(service.createPlatform({ name: 'Amazon' }, 8n)).rejects.toThrow('平台已存在');
  });

  it('rejects shops assigned to a missing platform', async () => {
    const transaction = jest.fn();
    const service = new ShopsService({
      shopPlatformDefinition: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: transaction,
    } as any, {} as any);
    await expect(service.create({ name: 'Store', platform: 'missing' }, 8n)).rejects.toThrow('平台不存在');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('accepts a shop belonging to a custom platform', async () => {
    const created = { id: 3n, name: 'Yahoo Store', platform: 'custom-platform', status: 1 };
    const create = jest.fn().mockResolvedValue(created);
    const service = new ShopsService({
      shopPlatformDefinition: { findUnique: jest.fn().mockResolvedValue({ key: 'custom-platform' }) },
      shop: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: (work: any) => work({ shop: { create } }),
    } as any, { create: jest.fn() } as any);
    await expect(service.create({ name: 'Yahoo Store', platform: 'custom-platform' }, 8n)).resolves.toEqual(created);
  });

  it('persists the selected platform when creating a shop', async () => {
    const created = {
      id: 12n,
      name: '乐天-3号店',
      platform: 'rakuten',
      status: 1,
    };
    const create = jest.fn().mockResolvedValue(created);
    const prisma = {
      shop: { findUnique: jest.fn().mockResolvedValue(null) },
      shopPlatformDefinition: { findUnique: jest.fn().mockResolvedValue({ key: 'rakuten' }) },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
        callback({ shop: { create } }),
      ),
    } as unknown as PrismaService;
    const auditService = { create: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const service = new ShopsService(prisma, auditService);

    await expect(
      service.create({ name: ' 乐天-3号店 ', platform: 'rakuten' }, 8n),
    ).resolves.toBe(created);
    expect(create).toHaveBeenCalledWith({
      data: { name: '乐天-3号店', platform: 'rakuten', status: 1 },
    });
    expect(auditService.create).toHaveBeenCalled();
  });
});
