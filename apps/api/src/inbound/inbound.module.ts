import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { InboundController } from './inbound.controller';
import { InboundService } from './inbound.service';

@Module({
  imports: [AuditModule],
  controllers: [InboundController],
  providers: [InboundService],
})
export class InboundModule {}
