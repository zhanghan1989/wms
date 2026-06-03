import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createReadStream, createWriteStream } from 'fs';
import JSZip = require('jszip');
import { mkdir, open, readdir, readFile, rm, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { pipeline } from 'stream/promises';
import { APP_TIMEZONE, getZonedDateParts } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

type BackupSource = 'manual' | 'schedule' | 'legacy';

export type BackupSummary = {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  hasFile: boolean;
  fileDeletedAt: string | null;
  source: BackupSource;
};

const WEEKLY_BACKUP_CRON = '0 59 23 * * 0';
const BACKUP_TIMEZONE = APP_TIMEZONE;
const DEFAULT_KEEP_ZIP_COUNT = 5;
const DEFAULT_SQL_ROW_BATCH_SIZE = 200;
const DEFAULT_ZIP_COMPRESSION_LEVEL = 1;

@Injectable()
export class BackupsService implements OnModuleInit {
  private readonly logger = new Logger(BackupsService.name);
  private readonly backupDir = this.resolveBackupDir();
  private readonly keepZipCount = this.resolveKeepZipCount();
  private readonly sqlRowBatchSize = this.resolveSqlRowBatchSize();
  private readonly zipCompressionLevel = this.resolveZipCompressionLevel();
  private isCreating = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.reconcileBackupRecordsAndFiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`初始化备份记录失败: ${message}`);
    }
  }

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
    await this.reconcileBackupRecordsAndFiles();
    const rows = await this.prisma.backupRecord.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map((row) => ({
      fileName: row.fileName,
      sizeBytes: this.toSafeNumber(row.sizeBytes),
      createdAt: row.createdAt.toISOString(),
      hasFile: row.hasFile,
      fileDeletedAt: row.fileDeletedAt ? row.fileDeletedAt.toISOString() : null,
      source: this.normalizeSource(row.source),
    }));
  }

  async getBackupFileForDownload(fileNameRaw: string): Promise<{
    fileName: string;
    sizeBytes: number;
    content: Buffer;
  }> {
    const fileName = this.normalizeBackupFileName(fileNameRaw);
    const record = await this.prisma.backupRecord.findUnique({
      where: { fileName },
    });
    if (!record) {
      throw new NotFoundException(`备份文件不存在: ${fileName}`);
    }
    if (!record.hasFile) {
      throw new BadRequestException('该备份仅保留记录，不提供下载');
    }

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
      await this.markBackupFileRemoved(record.id);
      throw new BadRequestException('该备份仅保留记录，不提供下载');
    }
  }

  async createBackupNow(source: BackupSource = 'manual'): Promise<{
    fileName: string;
    sizeBytes: number;
    createdAt: string;
    source: BackupSource;
    hasFile: boolean;
  }> {
    if (this.isCreating) {
      throw new BadRequestException('备份任务正在执行中，请稍后重试');
    }

    this.isCreating = true;
    let tempSqlPath: string | null = null;
    try {
      await this.ensureBackupDir();
      const now = new Date();
      const stamp = this.formatTimestamp(now);
      const baseName = `wms-db-backup-${stamp}`;
      const sqlFileName = `${baseName}.sql`;
      const zipFileName = `${baseName}.zip`;
      const zipPath = join(this.backupDir, zipFileName);
      tempSqlPath = join(this.backupDir, `${sqlFileName}.tmp`);

      await this.writeSqlDumpToFile(tempSqlPath, now);
      const zipSizeBytes = await this.writeZipFromSqlFile({
        sqlFileName,
        sqlPath: tempSqlPath,
        zipPath,
        date: now,
      });
      await rm(tempSqlPath, { force: true });
      tempSqlPath = null;

      await this.prisma.backupRecord.upsert({
        where: { fileName: zipFileName },
        create: {
          fileName: zipFileName,
          source,
          sizeBytes: BigInt(zipSizeBytes),
          createdAt: now,
          hasFile: true,
          fileDeletedAt: null,
        },
        update: {
          source,
          sizeBytes: BigInt(zipSizeBytes),
          createdAt: now,
          hasFile: true,
          fileDeletedAt: null,
        },
      });

      await this.reconcileBackupRecordsAndFiles();
      this.logger.log(`数据库备份完成: ${zipFileName} (${zipSizeBytes} bytes)`);

      return {
        fileName: zipFileName,
        sizeBytes: zipSizeBytes,
        createdAt: now.toISOString(),
        source,
        hasFile: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(`数据库备份失败: ${message}`);
    } finally {
      if (tempSqlPath) {
        await rm(tempSqlPath, { force: true }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`清理临时备份文件失败: ${message}`);
        });
      }
      this.isCreating = false;
    }
  }

  private async reconcileBackupRecordsAndFiles(): Promise<void> {
    await this.ensureBackupDir();
    await this.syncRecordsFromFilesystem();
    await this.markMissingFilesAsRemoved();
    await this.enforceZipRetention();
  }

  private async syncRecordsFromFilesystem(): Promise<void> {
    const names = await readdir(this.backupDir);
    const zipNames = names.filter((name) => name.toLowerCase().endsWith('.zip'));
    if (!zipNames.length) return;

    await Promise.all(
      zipNames.map(async (fileName) => {
        const filePath = join(this.backupDir, fileName);
        const fileStat = await stat(filePath);
        await this.prisma.backupRecord.upsert({
          where: { fileName },
          create: {
            fileName,
            source: 'legacy',
            sizeBytes: BigInt(fileStat.size || 0),
            createdAt: fileStat.mtime,
            hasFile: true,
            fileDeletedAt: null,
          },
          update: {
            sizeBytes: BigInt(fileStat.size || 0),
            hasFile: true,
            fileDeletedAt: null,
          },
        });
      }),
    );
  }

  private async markMissingFilesAsRemoved(): Promise<void> {
    const rows = await this.prisma.backupRecord.findMany({
      where: { hasFile: true },
      select: { id: true, fileName: true },
    });
    if (!rows.length) return;

    const missingIds: bigint[] = [];
    await Promise.all(
      rows.map(async (row) => {
        const exists = await this.backupFileExists(row.fileName);
        if (!exists) {
          missingIds.push(row.id);
        }
      }),
    );
    if (!missingIds.length) return;

    const now = new Date();
    await Promise.all(missingIds.map((id) => this.markBackupFileRemoved(id, now)));
  }

  private async enforceZipRetention(): Promise<void> {
    const rows = await this.prisma.backupRecord.findMany({
      where: { hasFile: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, fileName: true },
    });
    if (rows.length <= this.keepZipCount) return;

    const removeRows = rows.slice(this.keepZipCount);
    const now = new Date();
    await Promise.all(
      removeRows.map(async (row) => {
        await rm(join(this.backupDir, row.fileName), { force: true });
        await this.markBackupFileRemoved(row.id, now);
      }),
    );
  }

  private async markBackupFileRemoved(id: bigint, removedAt = new Date()): Promise<void> {
    await this.prisma.backupRecord.update({
      where: { id },
      data: {
        hasFile: false,
        fileDeletedAt: removedAt,
      },
    });
  }

  private async writeSqlDumpToFile(filePath: string, generatedAt: Date): Promise<void> {
    const handle = await open(filePath, 'w');
    try {
      await this.writeSqlDump(handle, generatedAt);
    } finally {
      await handle.close();
    }
  }

  private async writeSqlDump(handle: Awaited<ReturnType<typeof open>>, generatedAt: Date): Promise<void> {
    const tableRows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SHOW TABLES',
    );
    const tableNames = tableRows
      .map((row) => String(Object.values(row)[0] || '').trim())
      .filter((name) => name.length > 0);

    await handle.write('-- WMS Database Backup\n');
    await handle.write(`-- Generated At: ${generatedAt.toISOString()}\n`);
    await handle.write('SET FOREIGN_KEY_CHECKS=0;\n\n');

    for (const tableName of tableNames) {
      await this.writeTableDump(handle, tableName);
      await handle.write('\n');
    }

    await handle.write('SET FOREIGN_KEY_CHECKS=1;\n\n');
  }

  private async writeTableDump(
    handle: Awaited<ReturnType<typeof open>>,
    tableName: string,
  ): Promise<void> {
    const safeTable = this.quoteIdentifier(tableName);
    const createRows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SHOW CREATE TABLE ${safeTable}`,
    );
    const createRow = createRows[0] || {};
    const createSqlRaw =
      Object.entries(createRow).find(([key]) => key.toLowerCase().includes('create table'))?.[1] ??
      Object.values(createRow)[1];
    const createSql = String(createSqlRaw || '');

    const columnRows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SHOW COLUMNS FROM ${safeTable}`,
    );
    const columns = columnRows
      .map((row) => String(row.Field || '').trim())
      .filter((name) => name.length > 0);

    await handle.write(`-- Table: ${tableName}\n`);
    await handle.write(`DROP TABLE IF EXISTS ${safeTable};\n`);
    await handle.write(`${createSql};\n`);

    if (!columns.length) {
      return;
    }

    const columnSql = columns.map((name) => this.quoteIdentifier(name)).join(', ');
    for (let offset = 0; ; offset += this.sqlRowBatchSize) {
      const dataRows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM ${safeTable} LIMIT ${this.sqlRowBatchSize} OFFSET ${offset}`,
      );
      if (!dataRows.length) break;

      const valuesSql = dataRows
        .map((row) => {
          const values = columns.map((column) => this.toSqlValue(row[column]));
          return `(${values.join(', ')})`;
        })
        .join(',\n');
      await handle.write(`INSERT INTO ${safeTable} (${columnSql}) VALUES\n${valuesSql};\n`);
    }
  }

  private async writeZipFromSqlFile({
    sqlFileName,
    sqlPath,
    zipPath,
    date,
  }: {
    sqlFileName: string;
    sqlPath: string;
    zipPath: string;
    date: Date;
  }): Promise<number> {
    const zip = new JSZip();
    zip.file(sqlFileName, createReadStream(sqlPath), { date });

    const compression = this.zipCompressionLevel === 0 ? 'STORE' : 'DEFLATE';
    const compressionOptions =
      this.zipCompressionLevel === 0 ? undefined : { level: this.zipCompressionLevel };

    await pipeline(
      zip.generateNodeStream({
        type: 'nodebuffer',
        streamFiles: true,
        compression,
        compressionOptions,
      }),
      createWriteStream(zipPath),
    );

    const fileStat = await stat(zipPath);
    return Number(fileStat.size || 0);
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
          JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
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
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
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

  private async backupFileExists(fileName: string): Promise<boolean> {
    try {
      await stat(join(this.backupDir, fileName));
      return true;
    } catch {
      return false;
    }
  }

  private toSafeNumber(value: bigint): number {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (value > max) return Number.MAX_SAFE_INTEGER;
    return Number(value);
  }

  private normalizeSource(source: string): BackupSource {
    if (source === 'manual' || source === 'schedule' || source === 'legacy') {
      return source;
    }
    return 'legacy';
  }

  private resolveKeepZipCount(): number {
    const raw = String(process.env.BACKUP_ZIP_KEEP_COUNT ?? '').trim();
    const parsed = Number(raw);
    if (!raw) return DEFAULT_KEEP_ZIP_COUNT;
    if (!Number.isFinite(parsed)) return DEFAULT_KEEP_ZIP_COUNT;
    const normalized = Math.floor(parsed);
    if (normalized < 1) return DEFAULT_KEEP_ZIP_COUNT;
    return normalized;
  }

  private resolveSqlRowBatchSize(): number {
    const raw = String(process.env.BACKUP_SQL_ROW_BATCH_SIZE ?? '').trim();
    const parsed = Number(raw);
    if (!raw) return DEFAULT_SQL_ROW_BATCH_SIZE;
    if (!Number.isFinite(parsed)) return DEFAULT_SQL_ROW_BATCH_SIZE;
    const normalized = Math.floor(parsed);
    if (normalized < 1) return DEFAULT_SQL_ROW_BATCH_SIZE;
    return normalized;
  }

  private resolveZipCompressionLevel(): number {
    const raw = String(process.env.BACKUP_ZIP_COMPRESSION_LEVEL ?? '').trim();
    const parsed = Number(raw);
    if (!raw) return DEFAULT_ZIP_COMPRESSION_LEVEL;
    if (!Number.isFinite(parsed)) return DEFAULT_ZIP_COMPRESSION_LEVEL;
    const normalized = Math.floor(parsed);
    if (normalized < 0) return DEFAULT_ZIP_COMPRESSION_LEVEL;
    if (normalized > 9) return 9;
    return normalized;
  }

  private resolveBackupDir(): string {
    const raw = String(process.env.BACKUP_DIR ?? '').trim();
    if (raw) {
      return resolve(raw);
    }
    return resolve(process.cwd(), 'storage', 'backups');
  }
}
