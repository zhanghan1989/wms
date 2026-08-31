import { Body, Controller, ForbiddenException, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types/auth-user.type';
import { AmazonSpApiService } from './amazon-sp-api.service';
import { ContinueAmazonAppstoreOAuthDto } from './dto/continue-amazon-appstore-oauth.dto';
import { StartAmazonOAuthDto } from './dto/start-amazon-oauth.dto';
import { SyncAmazonConnectionDto } from './dto/sync-amazon-connection.dto';
import { UpdateAmazonConnectionDto } from './dto/update-amazon-connection.dto';

@Controller('amazon-sp-api')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AmazonSpApiController {
  constructor(private readonly service: AmazonSpApiService) {}

  @Get('connections')
  @Roles(Role.admin)
  async listConnections(): Promise<unknown[]> {
    return this.service.listConnections();
  }

  @Post('oauth/start')
  @Roles(Role.admin)
  async startOAuth(
    @Body() payload: StartAmazonOAuthDto,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.service.startOAuth(payload, user.id);
  }

  @Post('oauth/appstore/continue')
  @Roles(Role.admin)
  async continueAppstoreOAuth(
    @Body() payload: ContinueAmazonAppstoreOAuthDto,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.service.continueAppstoreOAuth(payload, user.id);
  }

  @Put('connections/:id')
  @Roles(Role.admin)
  async updateConnection(
    @Param('id') id: string,
    @Body() payload: UpdateAmazonConnectionDto,
  ): Promise<unknown> {
    return this.service.updateConnection(id, payload);
  }

  @Post('connections/:id/test')
  @Roles(Role.admin)
  async testConnection(@Param('id') id: string): Promise<unknown> {
    return this.service.testConnection(id);
  }

  @Post('connections/:id/sync')
  @Roles(Role.admin)
  async syncConnection(
    @Param('id') id: string,
    @Body() payload: SyncAmazonConnectionDto,
  ): Promise<unknown> {
    return this.service.syncConnection(id, payload);
  }

  @Post('sync-all')
  @Roles(Role.admin)
  async syncAllConnections(@CurrentUser() user: AuthUser): Promise<unknown> {
    if (String(user.username ?? '').trim() !== 'admin') {
      throw new ForbiddenException('仅用户名为 admin 的账号可以执行 Amazon API 订单拉取');
    }
    return this.service.syncAllConnections();
  }

  @Get('sync-runs')
  @Roles(Role.admin)
  async listSyncRuns(
    @Query('connectionId') connectionId?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown[]> {
    return this.service.listSyncRuns(connectionId, limit);
  }

  @Get('coverage')
  @Roles(Role.admin)
  async getCoverage(): Promise<unknown> {
    return this.service.getCoverage();
  }

  @Get('dashboard-snapshot/latest')
  async getLatestDashboardSnapshot(): Promise<unknown> {
    return this.service.getLatestDashboardSnapshot();
  }

  @Get('store-dashboard')
  async getStoreDashboard(
    @Query('connectionId') connectionId?: string,
    @Query('days') days?: string,
  ): Promise<unknown> {
    return this.service.getStoreDashboard(connectionId, days);
  }

  @Get('store-dashboard/factory-recommendations-excel')
  async downloadStoreFactoryRecommendationsExcel(
    @Res() res: Response,
    @Query('connectionId') connectionId?: string,
  ): Promise<void> {
    const file = await this.service.buildStoreFactoryRecommendationsExcel(connectionId);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.content);
  }
}
