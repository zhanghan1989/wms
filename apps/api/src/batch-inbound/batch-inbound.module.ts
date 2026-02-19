import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BatchInboundController } from './batch-inbound.controller';
import { BatchInboundService } from './batch-inbound.service';

@Module({
  imports: [AuditModule],
  controllers: [BatchInboundController],
  providers: [BatchInboundService],
})
export class BatchInboundModule {}

