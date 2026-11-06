import { OrdersModule } from '../orders/orders.module';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BatchInboundController } from './batch-inbound.controller';
import { BatchInboundService } from './batch-inbound.service';

@Module({
  imports: [AuditModule, OrdersModule],
  controllers: [BatchInboundController],
  providers: [BatchInboundService],
})
export class BatchInboundModule {}

