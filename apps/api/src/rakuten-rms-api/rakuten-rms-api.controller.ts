import { Body, Controller, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user.type';
import { CreateRakutenRmsConnectionDto } from './dto/create-rakuten-rms-connection.dto';
import { IgnoreRakutenRmsConflictsDto } from './dto/ignore-rakuten-rms-conflicts.dto';
import { PreviewRakutenRmsSyncDto } from './dto/preview-rakuten-rms-sync.dto';
import { SyncRakutenRmsConnectionDto } from './dto/sync-rakuten-rms-connection.dto';
import { UpdateRakutenRmsConnectionDto } from './dto/update-rakuten-rms-connection.dto';
import { RakutenRmsApiService } from './rakuten-rms-api.service';

@Controller('rakuten-rms-api')
@UseGuards(JwtAuthGuard)
export class RakutenRmsApiController {
  constructor(private readonly service: RakutenRmsApiService) {}

  @Get('connections')
  async listConnections(): Promise<unknown[]> {
    return this.service.listConnections();
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
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('Content-Length', String(file.content.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(file.content);
  }

  @Post('connections')
  async createConnection(@Body() payload: CreateRakutenRmsConnectionDto): Promise<unknown> {
    return this.service.createConnection(payload);
  }

  @Put('connections/:id')
  async updateConnection(
    @Param('id') id: string,
    @Body() payload: UpdateRakutenRmsConnectionDto,
  ): Promise<unknown> {
    return this.service.updateConnection(id, payload);
  }

  @Post('connections/:id/test')
  async testConnection(@Param('id') id: string): Promise<unknown> {
    return this.service.testConnection(id);
  }

  @Post('connections/:id/sync')
  async syncConnection(
    @Param('id') id: string,
    @Body() payload: SyncRakutenRmsConnectionDto,
  ): Promise<unknown> {
    return this.service.syncConnection(id, payload);
  }

  @Post('connections/:id/preview')
  async previewConnection(
    @Param('id') id: string,
    @Body() payload: PreviewRakutenRmsSyncDto,
  ): Promise<unknown> {
    return this.service.previewConnection(id, payload);
  }

  @Post('connections/:id/conflicts/ignore')
  async ignorePreviewConflicts(
    @Param('id') id: string,
    @Body() payload: IgnoreRakutenRmsConflictsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.service.ignorePreviewConflicts(id, payload, user.id);
  }

  @Post('sync-runs/:id/rollback')
  async rollbackSyncRun(@Param('id') id: string): Promise<unknown> {
    return this.service.rollbackSyncRun(id);
  }

  @Post('sync-all')
  async syncAllConnections(): Promise<unknown> {
    return this.service.syncAllConnections();
  }

  @Get('sync-runs')
  async listSyncRuns(
    @Query('connectionId') connectionId?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown[]> {
    return this.service.listSyncRuns(connectionId, limit);
  }
}
