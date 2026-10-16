import { Injectable, Logger } from '@nestjs/common';
import { RAKUTEN_INVENTORY_JOB_NAME } from './rakuten-inventory.types';
import { Cron } from '@nestjs/schedule';
import { RakutenInventoryService } from './rakuten-inventory.service';
import { RakutenScheduleControlService } from './rakuten-schedule-control.service';

export const RAKUTEN_INVENTORY_CRON = '0 30 * * * *';

@Injectable()
export class RakutenInventorySchedulerService {
  private readonly logger = new Logger(RakutenInventorySchedulerService.name);
  constructor(private readonly inventory: RakutenInventoryService, private readonly schedules: RakutenScheduleControlService) {}

  @Cron('0 10 3 * * *', { name: 'rakuten-inventory-history-cleanup', timeZone: 'Asia/Tokyo', waitForCompletion: true })
  async cleanupHistory(): Promise<void> {
    try { await this.inventory.cleanupHistory(); }
    catch (error) { this.logger.warn(`库存历史清理未完成，下次再试：${error instanceof Error ? error.message : '未知错误'}`); }
  }

  @Cron(RAKUTEN_INVENTORY_CRON, { name: RAKUTEN_INVENTORY_JOB_NAME, timeZone: 'Asia/Tokyo', waitForCompletion: true })
  async runScheduledInventorySync(): Promise<void> {
    try {
      await this.schedules.execute('inventory', () => this.inventory.runScheduled(), (value) => value);
    } catch (error) {
      this.logger.warn(`库存定时检查未完成：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }
}
