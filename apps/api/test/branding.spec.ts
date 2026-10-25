import 'reflect-metadata';
import { validate } from 'class-validator';
import { Role } from '@prisma/client';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { BRANDING_DEFAULTS, BrandingController, UpdateBrandingDto } from '../src/branding/branding.module';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { PrismaService } from '../src/prisma/prisma.service';

describe('site branding', () => {
  it('returns defaults before any settings have been saved', async () => {
    const prisma = { siteBranding: { findUnique: jest.fn().mockResolvedValue(null) } };
    const controller = new BrandingController(prisma as unknown as PrismaService);
    expect(await controller.get()).toEqual({ settings: BRANDING_DEFAULTS, defaults: BRANDING_DEFAULTS });
  });

  it('limits writes to system administrators', () => {
    expect(Reflect.getMetadata(ROLES_KEY, BrandingController.prototype.update)).toEqual([Role.system_admin]);
  });

  it.each([
    [Role.employee, false],
    [Role.admin, false],
    [Role.system_admin, true],
  ])('checks branding write access for %s', (role, allowed) => {
    const context = {
      getHandler: () => BrandingController.prototype.update,
      getClass: () => BrandingController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
    expect(new RolesGuard(new Reflector()).canActivate(context)).toBe(allowed);
  });

  it.each([
    { siteName: '', logo: '', themeColor: '#0f8a5f' },
    { siteName: 'Test', logo: 'https://example.com/logo.svg', themeColor: '#0f8a5f' },
    { siteName: 'Test', logo: 'data:image/svg+xml;base64,AAAA', themeColor: '#0f8a5f' },
    { siteName: 'Test', logo: '', themeColor: 'red; color: white' },
  ])('rejects invalid configuration %j', async (data) => {
    expect((await validate(Object.assign(new UpdateBrandingDto(), data))).length).toBeGreaterThan(0);
  });

  it('trims the website name and persists shared settings', async () => {
    const data = { ...BRANDING_DEFAULTS, siteName: 'My WMS' };
    const prisma = { siteBranding: { upsert: jest.fn().mockResolvedValue(data) } };
    const controller = new BrandingController(prisma as unknown as PrismaService);
    await controller.update({ ...data, siteName: '  My WMS  ' });
    expect(prisma.siteBranding.upsert).toHaveBeenCalledWith({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    await expect(controller.update({ ...data, siteName: '  ' })).rejects.toThrow('网站名称不能为空');
  });
});
