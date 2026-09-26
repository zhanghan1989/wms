import { pipeline } from 'stream/promises';
import {
  BadRequestException,
  HttpException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { BackupSummary, BackupsService } from './backups.service';

@Controller('backups')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BackupsController {
  private activeDownloads = 0;
  constructor(private readonly backupsService: BackupsService) {}

  @Get()
  async listBackups(@Query("page") page?: string, @Query("pageSize") pageSize?: string): Promise<BackupSummary[]> {
    return this.backupsService.listBackups(page, pageSize);
  }

  @Post('run')
  async runBackupNow(): Promise<unknown> {
    return this.backupsService.createBackupNow('manual');
  }

  @Get(':fileName/download')
  async downloadBackup(
    @Param('fileName') fileName: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!fileName) {
      throw new BadRequestException('备份文件名不能为空');
    }
    if (this.activeDownloads >= 2) throw new HttpException('同时下载人数较多，请稍后重试', 429);
    this.activeDownloads += 1;
    try {
      const file = await this.backupsService.getBackupFileForDownload(fileName);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      );
      res.setHeader('Content-Length', String(file.sizeBytes));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200);
      try { await pipeline(file.stream, res); }
      catch (error) { if (!res.destroyed) res.destroy(error as Error); }
    } finally { this.activeDownloads -= 1; }
  }
}
