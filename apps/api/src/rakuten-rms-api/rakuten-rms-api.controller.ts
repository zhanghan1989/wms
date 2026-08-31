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
import { RakutenRmsAutomationService } from './rakuten-rms-automation.service';

@Controller('rakuten-rms-api')
@UseGuards(JwtAuthGuard)
export class RakutenRmsApiController {
  constructor(
    private readonly service: RakutenRmsApiService,
    private readonly automation: RakutenRmsAutomationService,
  ) {}

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

  @Post('connections/:id/automation/run')
  async runAutomation(@Param('id') id: string): Promise<unknown> {
    return this.automation.runConnection(id);
  }

  @Post('connections/:id/smtp/test')
  async testSmtpConnection(@Param('id') id: string): Promise<unknown> {
    return this.automation.testSmtpConnection(id);
  }

  @Get('connections/:id/automation/status')
  async getAutomationStatus(@Param('id') id: string): Promise<unknown> {
    return this.automation.getConnectionStatus(id);
  }

  @Post('connections/:id/automation/retry')
  async retryAutomationJob(
    @Param('id') id: string,
    @Body() payload: { kind?: string; id?: string },
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.automation.retryJob(id, payload, user.id);
  }

  @Post('connections/:id/automation/circuits/:kind/reset')
  async resetAutomationCircuit(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.automation.resetCircuit(id, kind, user.id);
  }

  @Get('automation/summary')
  async getAutomationSummary(): Promise<unknown> {
    return this.automation.getSummary();
  }

  @Get('automation/health')
  async getAutomationHealth(): Promise<unknown> {
    return this.automation.getAutomationHealth();
  }

  @Get('automation/runs')
  async listAutomationRuns(
    @Query('connectionId') connectionId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.automation.listAutomationRuns({ connectionId, status, page, pageSize });
  }

  @Post('automation/manual-actions/preview')
  async previewManualAutomationActions(
    @Body() payload: { kind?: string },
  ): Promise<unknown> {
    return this.automation.prepareManualActions(payload?.kind);
  }

  @Post('automation/manual-actions/execute')
  async executeManualAutomationActions(
    @Body() payload: { items?: Array<{ kind?: string; id?: string }> },
  ): Promise<unknown> {
    return this.automation.executeManualActions(payload?.items ?? []);
  }

  @Get('connections/:id/mail-templates')
  async listMailTemplates(@Param('id') id: string): Promise<unknown> {
    return this.automation.listMailTemplates(id);
  }

  @Get('connections/:id/mail-templates/:event/history')
  async getMailTemplateHistory(
    @Param('id') id: string,
    @Param('event') event: string,
  ): Promise<unknown> {
    return this.automation.getMailTemplateHistory(id, event);
  }

  @Post('connections/:id/mail-templates/:event/preview')
  async previewMailTemplate(
    @Param('id') id: string,
    @Param('event') event: string,
    @Body() payload: { subjectTemplate?: string; bodyTemplate?: string; orderId?: string },
  ): Promise<unknown> {
    return this.automation.previewMailTemplate(id, event, payload);
  }

  @Post('connections/:id/mail-templates/:event')
  async saveMailTemplate(
    @Param('id') id: string,
    @Param('event') event: string,
    @Body() payload: { subjectTemplate?: string; bodyTemplate?: string },
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.automation.saveMailTemplate(id, event, payload, user.id);
  }

  @Post('connections/:id/mail-templates/:event/versions/:version/activate')
  async activateMailTemplateVersion(
    @Param('id') id: string,
    @Param('event') event: string,
    @Param('version') version: string,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    return this.automation.activateMailTemplateVersion(id, event, version, user.id);
  }

  @Get('mails')
  async listMails(
    @Query('connectionId') connectionId?: string,
    @Query('status') status?: string,
    @Query('event') event?: string,
    @Query('orderId') orderId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.automation.listMails({
      connectionId,
      status,
      event,
      orderId,
      dateFrom,
      dateTo,
      page,
      pageSize,
    });
  }

  @Get('mails/:id')
  async getMailDetail(@Param('id') id: string): Promise<unknown> {
    return this.automation.getMailDetail(id);
  }

  @Post('mails/:id/retry')
  async retryMail(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<unknown> {
    return this.automation.retryMail(id, user.id);
  }

  @Post('mails/:id/cancel')
  async cancelMail(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<unknown> {
    return this.automation.cancelMail(id, user.id);
  }

  @Post('mails/:id/mark-sent')
  async markMailAsSent(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<unknown> {
    return this.automation.markMailAsSent(id, user.id);
  }
}
