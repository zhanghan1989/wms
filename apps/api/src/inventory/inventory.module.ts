import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InventoryAdjustService } from './inventory-adjust.service';
import { FbaReplenishmentService } from './fba-replenishment.service';

@Module({
  imports: [AuditModule, InventoryAdjustService],
  controllers: [InventoryController],
  providers: [InventoryService, FbaReplenishmentService, InventoryAdjustService],
})
export class InventoryModule {}
