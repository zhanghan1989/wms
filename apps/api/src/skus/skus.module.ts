import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SkusController } from './skus.controller';
import { SkusService } from './skus.service';

@Module({
  imports: [AuditModule],
  controllers: [SkusController],
  providers: [SkusService],
})
export class SkusModule {}
