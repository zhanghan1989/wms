import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
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
  constructor(private readonly backupsService: BackupsService) {}

  @Get()
  async listBackups(): Promise<BackupSummary[]> {
    return this.backupsService.listBackups();
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
    const file = await this.backupsService.getBackupFileForDownload(fileName);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(file.content);
  }
}
