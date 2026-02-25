import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import JSZip = require('jszip');
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';

type BackupSummary = {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
};

const WEEKLY_BACKUP_CRON = '0 59 23 * * 0';
const BACKUP_TIMEZONE = process.env.BACKUP_TIMEZONE || 'Asia/Shanghai';
const DEFAULT_KEEP_COUNT = 26;

@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);
  private readonly backupDir = resolve(process.cwd(), 'storage', 'backups');
  private readonly keepCount = Math.max(
    4,
    Number(process.env.BACKUP_KEEP_COUNT || DEFAULT_KEEP_COUNT),
  );
  private isCreating = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(WEEKLY_BACKUP_CRON, {
    name: 'weekly-database-backup',
    timeZone: BACKUP_TIMEZONE,
  })
  async runWeeklyBackup(): Promise<void> {
    try {
      await this.createBackupNow('schedule');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`定时数据库备份失败: ${message}`);
    }
  }

  async listBackups(): Promise<BackupSummary[]> {
    await this.ensureBackupDir();
    const names = await readdir(this.backupDir);
    const zipNames = names.filter((name) => name.toLowerCase().endsWith('.zip'));

    const rows = await Promise.all(
      zipNames.map(async (name) => {
        const filePath = join(this.backupDir, name);
        const fileStat = await stat(filePath);
        return {
          fileName: name,
          sizeBytes: Number(fileStat.size || 0),
          createdAt: fileStat.mtime.toISOString(),
        };
      }),
    );

    rows.sort((a, b) => Number(new Date(b.createdAt)) - Number(new Date(a.createdAt)));
    return rows;
  }

  async getBackupFileForDownload(fileNameRaw: string): Promise<{
    fileName: string;
    sizeBytes: number;
    content: Buffer;
  }> {
    const fileName = this.normalizeBackupFileName(fileNameRaw);
    await this.ensureBackupDir();
    const filePath = join(this.backupDir, fileName);
    try {
      const [content, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
      return {
        fileName,
        sizeBytes: Number(fileStat.size || 0),
        content,
      };
    } catch {
      throw new NotFoundException(`备份文件不存在: ${fileName}`);
    }
  }

  async createBackupNow(source: 'manual' | 'schedule' = 'manual'): Promise<{
    fileName: string;
    sizeBytes: number;
    createdAt: string;
    source: 'manual' | 'schedule';
  }> {
    if (this.isCreating) {
      throw new BadRequestException('备份任务正在执行中，请稍后重试');
    }

    this.isCreating = true;
    try {
      await this.ensureBackupDir();
      const now = new Date();
      const stamp = this.formatTimestamp(now);
      const baseName = `wms-db-backup-${stamp}`;
      const sqlFileName = `${baseName}.sql`;
      const zipFileName = `${baseName}.zip`;
      const zipPath = join(this.backupDir, zipFileName);

      const sqlContent = await this.buildSqlDump();
      const zip = new JSZip();
      zip.file(sqlFileName, sqlContent, { date: now });
      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });

      await writeFile(zipPath, zipBuffer);
      await this.pruneOldBackups();
      this.logger.log(`数据库备份完成: ${zipFileName} (${zipBuffer.byteLength} bytes)`);

      return {
        fileName: zipFileName,
        sizeBytes: zipBuffer.byteLength,
        createdAt: now.toISOString(),
        source,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(`数据库备份失败: ${message}`);
    } finally {
      this.isCreating = false;
    }
  }

  private async buildSqlDump(): Promise<string> {
    const tableRows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SHOW TABLES',
    );
    const tableNames = tableRows
      .map((row) => String(Object.values(row)[0] || '').trim())
      .filter((name) => name.length > 0);

    const lines: string[] = [];
    lines.push('-- WMS Database Backup');
    lines.push(`-- Generated At: ${new Date().toISOString()}`);
    lines.push('SET FOREIGN_KEY_CHECKS=0;');
    lines.push('');

    for (const tableName of tableNames) {
      const tableSql = await this.buildTableDump(tableName);
      lines.push(tableSql);
      lines.push('');
    }

    lines.push('SET FOREIGN_KEY_CHECKS=1;');
    lines.push('');
    return lines.join('\n');
  }

  private async buildTableDump(tableName: string): Promise<string> {
    const safeTable = this.quoteIdentifier(tableName);
    const createRows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SHOW CREATE TABLE ${safeTable}`,
    );
    const createRow = createRows[0] || {};
    const createSqlRaw =
      Object.entries(createRow).find(([key]) =>
        key.toLowerCase().includes('create table'),
      )?.[1] ?? Object.values(createRow)[1];
    const createSql = String(createSqlRaw || '');

    const columnRows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SHOW COLUMNS FROM ${safeTable}`,
    );
    const columns = columnRows
      .map((row) => String(row.Field || '').trim())
      .filter((name) => name.length > 0);

    const dataRows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM ${safeTable}`,
    );

    const lines: string[] = [];
    lines.push(`-- Table: ${tableName}`);
    lines.push(`DROP TABLE IF EXISTS ${safeTable};`);
    lines.push(`${createSql};`);

    if (!columns.length || !dataRows.length) {
      return lines.join('\n');
    }

    const columnSql = columns.map((name) => this.quoteIdentifier(name)).join(', ');
    const chunkSize = 200;
    for (let i = 0; i < dataRows.length; i += chunkSize) {
      const chunk = dataRows.slice(i, i + chunkSize);
      const valuesSql = chunk
        .map((row) => {
          const values = columns.map((column) => this.toSqlValue(row[column]));
          return `(${values.join(', ')})`;
        })
        .join(',\n');
      lines.push(`INSERT INTO ${safeTable} (${columnSql}) VALUES\n${valuesSql};`);
    }

    return lines.join('\n');
  }

  private toSqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value instanceof Date) return this.toSqlString(this.formatDateForSql(value));
    if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
    if (typeof value === 'object') {
      try {
        return this.toSqlString(
          JSON.stringify(value, (_key, item) =>
            typeof item === 'bigint' ? item.toString() : item,
          ),
        );
      } catch {
        return this.toSqlString(String(value));
      }
    }
    return this.toSqlString(String(value));
  }

  private toSqlString(value: string): string {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\u0000/g, '\\0')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `'${escaped}'`;
  }

  private formatDateForSql(date: Date): string {
    const iso = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000).toISOString();
    return iso.slice(0, 19).replace('T', ' ');
  }

  private quoteIdentifier(name: string): string {
    return `\`${String(name || '').replace(/`/g, '``')}\``;
  }

  private formatTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
      date.getHours(),
    )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  private normalizeBackupFileName(fileNameRaw: string): string {
    const fileName = String(fileNameRaw || '').trim();
    if (!/^[a-zA-Z0-9._-]+\.zip$/.test(fileName)) {
      throw new BadRequestException('备份文件名不合法');
    }
    return fileName;
  }

  private async ensureBackupDir(): Promise<void> {
    await mkdir(this.backupDir, { recursive: true });
  }

  private async pruneOldBackups(): Promise<void> {
    const backups = await this.listBackups();
    if (backups.length <= this.keepCount) return;
    const removeItems = backups.slice(this.keepCount);
    await Promise.all(
      removeItems.map((item) => rm(join(this.backupDir, item.fileName), { force: true })),
    );
  }
}
