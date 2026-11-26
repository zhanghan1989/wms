import { BadRequestException, Body, Controller, Get, Headers, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { YahooOrdersService } from './yahoo-orders.service';

const cookieName = '__Secure-wms-yahoo-oauth';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/api/yahoo-orders/oauth/callback' };

@Controller('yahoo-orders')
@Roles(Role.admin)
export class YahooOrdersController {
  constructor(private readonly service: YahooOrdersService) {}

  @Get('status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  status() {
    return this.service.status();
  }

  @Post('authorize')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async authorize(@Body() input: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    const result = await this.service.startAuthorization(input ?? {});
    res.cookie(cookieName, result.state, { ...cookieOptions, maxAge: 10 * 60 * 1000 });
    return { url: result.url };
  }

  @Get('oauth/callback')
  async callback(@Query('state') state: unknown, @Query('code') code: unknown, @Headers('cookie') header: string, @Res() res: Response) {
    const cookie = header?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.split('=')[1] ?? '';
    const ok = await this.service.completeAuthorization(typeof state === 'string' ? state : '', typeof code === 'string' ? code : '', cookie);
    res.clearCookie(cookieName, cookieOptions);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, '/?yahooOrders=' + (ok ? 'authorized' : 'failed'));
  }

  @Post('test')
  @UseGuards(JwtAuthGuard, RolesGuard)
  test() {
    return this.service.test();
  }

  @Post('enabled')
  @UseGuards(JwtAuthGuard, RolesGuard)
  setEnabled(@Body('enabled') enabled: unknown) {
    if (typeof enabled !== 'boolean') throw new BadRequestException('请指定是否开启雅虎自动拉单');
    return this.service.setEnabled(enabled);
  }

  @Post('sync')
  @UseGuards(JwtAuthGuard, RolesGuard)
  sync() {
    return this.service.syncNow();
  }
}
