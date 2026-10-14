import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

export const RAKUTEN_SCHEDULE_KEYS = ['import', 'tracking', 'shipping', 'mail'] as const;
export type RakutenScheduleKey = typeof RAKUTEN_SCHEDULE_KEYS[number];
export type ScheduleOutcome = { status: 'success' | 'partial' | 'failed' | 'paused' | 'busy'; errors: string[] };
const STALE_MS = 30 * 60_000;

@Injectable()
export class RakutenScheduleControlService {
  private readonly logger = new Logger(RakutenScheduleControlService.name);
  constructor(private readonly prisma: PrismaService, private readonly registry: SchedulerRegistry) {}

  private defaultEnabled(key: RakutenScheduleKey): boolean {
    if (key === 'tracking') return true;
    if (key === 'import') return String(process.env.RAKUTEN_RMS_API_SCHEDULED_SYNC_ENABLED ?? 'false').toLowerCase() === 'true'
      && String(process.env.RAKUTEN_RMS_API_SCHEDULED_SYNC_PAUSED ?? 'true').toLowerCase() === 'false';
    return String(process.env.RAKUTEN_RMS_AUTOMATION_SCHEDULED_PAUSED ?? 'true').toLowerCase() === 'false';
  }

  private ensure(key: RakutenScheduleKey) {
    // Environment flags seed the initial setting; subsequent UI changes persist across restarts.
    return this.prisma.rakutenScheduleControl.upsert({
      where: { key }, create: { key, enabled: this.defaultEnabled(key) }, update: {},
    });
  }

  async enabled(key: RakutenScheduleKey): Promise<boolean> { return (await this.ensure(key)).enabled; }

  async update(keyRaw: string, enabled: boolean) {
    if (!RAKUTEN_SCHEDULE_KEYS.includes(keyRaw as RakutenScheduleKey)) throw new BadRequestException('不支持的定时任务');
    if (typeof enabled !== 'boolean') throw new BadRequestException('定时开关必须为开启或关闭');
    const key = keyRaw as RakutenScheduleKey;
    await this.prisma.rakutenScheduleControl.upsert({ where: { key }, create: { key, enabled }, update: { enabled } });
    return this.status();
  }

  async status() {
    const rows = await Promise.all(RAKUTEN_SCHEDULE_KEYS.map((key) => this.ensure(key)));
    const job = this.registry.getCronJobs().get('rakuten-order-processing');
    const next = job?.isActive ? job.nextDate().toJSDate().toISOString() : null;
    const now = Date.now();
    return {
      timeZone: 'Asia/Tokyo', refreshSeconds: 5, serverTime: new Date(now).toISOString(),
      tasks: rows.map((row) => {
        const running = Boolean(row.runToken && row.heartbeatAt && row.heartbeatAt.getTime() > now - STALE_MS);
        const interrupted = Boolean(row.runToken && !running);
        return {
          key: row.key, enabled: row.enabled,
          status: running ? 'running' : interrupted ? 'interrupted' : row.enabled ? next ? 'waiting' : 'stopped' : 'paused',
          nextRunAt: row.enabled ? next : null,
          startedAt: row.startedAt?.toISOString() ?? null, finishedAt: interrupted ? null : row.finishedAt?.toISOString() ?? null,
          lastStatus: interrupted ? 'interrupted' : row.lastStatus,
          lastMessage: interrupted ? '上次执行中断，下一轮将重新检查' : row.lastMessage,
        };
      }),
    };
  }

  async execute<T>(key: RakutenScheduleKey, action: () => Promise<T>, outcome: (value: T) => ScheduleOutcome): Promise<T | undefined> {
    const row = await this.ensure(key);
    if (!row.enabled) return undefined;
    const token = randomUUID();
    const acquired = await this.prisma.rakutenScheduleControl.updateMany({
      where: { key, enabled: true, OR: [{ runToken: null }, { heartbeatAt: { lt: new Date(Date.now() - STALE_MS) } }] },
      data: { runToken: token, startedAt: new Date(), heartbeatAt: new Date() },
    });
    if (acquired.count !== 1) return undefined;
    const heartbeat = setInterval(() => {
      void this.prisma.rakutenScheduleControl.updateMany({ where: { key, runToken: token }, data: { heartbeatAt: new Date() } })
        .catch((error: unknown) => this.logger.error(`定时任务状态更新失败：${String(error)}`));
    }, 60_000);
    try {
      const value = await action();
      const result = outcome(value);
      await this.finish(key, token, result);
      return value;
    } catch (error) {
      await this.finish(key, token, { status: error instanceof ConflictException ? 'busy' : 'failed', errors: [error instanceof Error ? error.message : String(error)] });
      throw error;
    } finally { clearInterval(heartbeat); }
  }

  private async finish(key: RakutenScheduleKey, token: string, result: ScheduleOutcome) {
    await this.prisma.rakutenScheduleControl.updateMany({ where: { key, runToken: token }, data: {
      runToken: null, heartbeatAt: null, finishedAt: new Date(), lastStatus: result.status,
      lastMessage: result.errors.length ? result.errors.join('；') : '本轮检查完成',
    } });
  }
}
