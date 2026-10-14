import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { RakutenAutomationRunTrigger } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import { RakutenRmsApiService } from './rakuten-rms-api.service';
import { OrdersService } from '../orders/orders.service';
import { RakutenScheduleControlService, ScheduleOutcome } from './rakuten-schedule-control.service';
import { RAKUTEN_ORDER_PROCESSING_CRON, RakutenRmsAutomationService } from './rakuten-rms-automation.service';

type StageResult = { status: 'success' | 'partial' | 'failed' | 'paused' | 'busy'; errors: string[] };

@Injectable()
export class RakutenOrderSchedulerService {
  private readonly logger = new Logger(RakutenOrderSchedulerService.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly automation: RakutenRmsAutomationService,
    private readonly api: RakutenRmsApiService,
    private readonly schedules: RakutenScheduleControlService,
  ) {}

  private running = false;

  @Cron(RAKUTEN_ORDER_PROCESSING_CRON, {
    name: 'rakuten-order-processing',
    timeZone: 'Asia/Tokyo',
    waitForCompletion: true,
  })
  async runScheduledOrderProcessing(): Promise<void> {
    await this.runRound(false);
  }

  // Human check uses exactly the same stages and outbound pause policy.
  async runNow(): Promise<unknown> {
    return this.runRound(true);
  }

  private async runRound(manual: boolean): Promise<unknown> {
    if (this.running) {
      if (manual) throw new ConflictException('乐天处理流程正在执行，请稍后查看结果');
      return;
    }
    this.running = true;
    try {
      const stages: Record<'import' | 'tracking' | 'shipping' | 'mail' | 'automation', StageResult> = {
        import: { status: 'success', errors: [] }, tracking: { status: 'success', errors: [] },
        automation: { status: 'success', errors: [] }, shipping: { status: 'paused', errors: [] }, mail: { status: 'paused', errors: [] },
      };
      const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
      let imported: unknown;
      try {
        imported = await this.schedules.execute('import',
          () => manual ? this.api.syncAllConnections() : this.api.runScheduledSync(true),
          (value) => this.importOutcome(value));
        if (imported === undefined) stages.import = await this.schedules.enabled('import')
          ? { status: 'busy', errors: ['订单导入已在其他流程执行'] } : { status: 'paused', errors: [] };
        else stages.import = this.importOutcome(imported);
      } catch (error) {
        this.logger.warn(`Rakuten import unavailable; existing tasks remain eligible: ${error instanceof Error ? error.message : String(error)}`);
        imported = { error: error instanceof Error ? error.message : String(error) };
        stages.import = { status: error instanceof ConflictException ? 'busy' : 'failed', errors: [messageOf(error)] };
      }
      let tracking: unknown;
      // Await enabled tracking queries so this round uses persisted clearance dates.
      try {
        const result = await this.schedules.execute('tracking', () => this.orders.syncRakutenTrackingStatuses(),
          (value) => this.trackingOutcome(value));
        tracking = result;
        if (result === undefined) stages.tracking = await this.schedules.enabled('tracking')
          ? { status: 'busy', errors: ['物流查询已在其他流程执行'] } : { status: 'paused', errors: [] };
        else {
          stages.tracking = this.trackingOutcome(result);
          this.logger.log(
            `Rakuten tracking sync completed: trackingNos=${result.trackingNoCount}, customsClearance=${result.customsClearanceCount}, failed=${result.failedCount}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Rakuten tracking sync unavailable; order processing will use saved tracking data: ${message}`);
        tracking = { error: message };
        stages.tracking = { status: error instanceof ConflictException ? 'busy' : 'failed', errors: [message] };
      }
      // A tracking outage must not stop unrelated Japan shipments. The automation
      // service enforces its pause switch, shop circuits and per-order conditions.
      const automation: Partial<Record<'shipping' | 'mail', Awaited<ReturnType<RakutenRmsAutomationService['runScheduledAutomation']>>>> = {};
      for (const key of ['shipping', 'mail'] as const) {
        try {
          const result = await this.schedules.execute(key,
            () => this.automation.runScheduledAutomation(manual ? RakutenAutomationRunTrigger.manual : RakutenAutomationRunTrigger.scheduled, key),
            (value) => this.automationOutcome(value));
          if (result) {
            automation[key] = result;
            stages[key] = this.automationOutcome(result);
          } else if (await this.schedules.enabled(key)) {
            stages[key] = { status: 'busy', errors: ['该任务已在其他流程执行'] };
          }
        } catch (error) {
          stages[key] = { status: error instanceof ConflictException ? 'busy' : 'failed', errors: [messageOf(error)] };
        }
      }
      const outbound = [stages.shipping, stages.mail];
      stages.automation = {
        status: outbound.every((stage) => stage.status === 'paused') ? 'paused'
          : outbound.every((stage) => stage.status === 'failed') ? 'failed'
          : outbound.some((stage) => ['partial', 'failed', 'busy'].includes(stage.status)) ? 'partial' : 'success',
        errors: [...new Set(outbound.flatMap((stage) => stage.errors))],
      };
      const hasIssues = Object.values(stages).some((stage) => ['partial', 'failed', 'busy'].includes(stage.status));
      return { imported, tracking, automation, stages, checked: !hasIssues,
        status: hasIssues ? 'partial' : 'success' };
    } finally {
      this.running = false;
    }
  }
  private importOutcome(value: unknown): ScheduleOutcome {
    const results = (value as { results?: Array<{ shopName?: string; error?: string; comboMissingOrderCount?: number; catalogMissingOrderCount?: number; importWarning?: string | null }> } | undefined)?.results ?? [];
    const errors = results.filter((row) => row.error).map((row) => `${row.shopName ? `${row.shopName}：` : ''}${row.error}`);
    const warnings = results.filter((row) => row.importWarning || Number(row.catalogMissingOrderCount ?? row.comboMissingOrderCount) > 0).map((row) =>
      `${row.shopName ? `${row.shopName}：` : ''}${row.importWarning || `${row.catalogMissingOrderCount ?? row.comboMissingOrderCount} 个订单商品配置缺失，已跳过并等待人工处理`}`);
    return { status: errors.length === results.length && errors.length > 0 ? 'failed'
      : errors.length || warnings.length ? 'partial' : 'success', errors: [...errors, ...warnings] };
  }

  private trackingOutcome(value: Awaited<ReturnType<OrdersService['syncRakutenTrackingStatuses']>>): ScheduleOutcome {
    return value.failedCount > 0
      ? { status: 'partial', errors: [`${value.failedCount} 个快递单号查询失败`] }
      : { status: 'success', errors: [] };
  }

  private automationOutcome(value: Awaited<ReturnType<RakutenRmsAutomationService['runScheduledAutomation']>> | undefined): ScheduleOutcome {
    if (value?.status === 'paused') return { status: 'paused', errors: [] };
    if (value?.status === 'failed') return { status: 'failed', errors: [value.error ?? '订单处理失败'] };
    if (!value?.result) return { status: 'success', errors: [] };
    const result = value.result;
    const errors = result.connectionRuns.flatMap((run) => run.errors);
    const failed = result.shipping.failed + result.mail.failed;
    if (failed) errors.push(`${failed} 项回传或邮件任务失败`);
    if (result.mail.blocked) errors.push(`${result.mail.blocked} 封邮件等待条件或人工处理`);
    if (result.lockedConnections) errors.push(`${result.lockedConnections} 个店铺正在执行其他任务`);
    return { status: !errors.length ? 'success'
      : result.alreadyRunning || !result.connectionRuns.length && result.lockedConnections > 0 ? 'busy'
      : result.connectionRuns.length > 0 && result.connectionRuns.every((run) => run.status === 'failed') ? 'failed' : 'partial', errors };
  }

}
