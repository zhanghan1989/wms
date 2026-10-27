import { RakutenInventorySchedulerService } from './rakuten-inventory-scheduler.service';
import { RakutenInventoryCatalogService } from './rakuten-inventory-catalog.service';
import { RakutenInventoryService } from './rakuten-inventory.service';
import { RakutenInventoryController } from './rakuten-inventory.controller';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OrdersModule } from '../orders/orders.module';
import { RakutenOrderSchedulerService } from './rakuten-order-scheduler.service';
import { RakutenRmsApiClient } from './rakuten-rms-api.client';
import { RakutenRmsApiController } from './rakuten-rms-api.controller';
import { RakutenRmsApiCryptoService } from './rakuten-rms-api-crypto.service';
import { RakutenRmsApiService } from './rakuten-rms-api.service';
import { RakutenRmsAutomationService } from './rakuten-rms-automation.service';
import { RakutenScheduleControlService } from './rakuten-schedule-control.service';
import { RakutenSalesService } from './rakuten-sales.service';

@Module({
  imports: [AuditModule, OrdersModule],
  controllers: [RakutenRmsApiController, RakutenInventoryController],
  providers: [RakutenSalesService, RakutenInventorySchedulerService, RakutenInventoryCatalogService, RakutenInventoryService, RakutenRmsApiService, RakutenRmsApiClient, RakutenRmsApiCryptoService, RakutenRmsAutomationService, RakutenOrderSchedulerService, RakutenScheduleControlService],
  exports: [RakutenRmsApiService],
})
export class RakutenRmsApiModule {}
