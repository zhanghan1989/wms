import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateRakutenRmsConnectionDto } from './dto/create-rakuten-rms-connection.dto';
import { PreviewRakutenRmsSyncDto } from './dto/preview-rakuten-rms-sync.dto';
import { SyncRakutenRmsConnectionDto } from './dto/sync-rakuten-rms-connection.dto';
import { UpdateRakutenRmsConnectionDto } from './dto/update-rakuten-rms-connection.dto';
import { RakutenRmsApiService } from './rakuten-rms-api.service';

@Controller('rakuten-rms-api')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.admin)
export class RakutenRmsApiController {
  constructor(private readonly service: RakutenRmsApiService) {}

  @Get('connections')
  async listConnections(): Promise<unknown[]> {
    return this.service.listConnections();
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
