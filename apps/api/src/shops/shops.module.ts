import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';

@Module({
  imports: [AuditModule],
  controllers: [ShopsController],
  providers: [ShopsService],
})
export class ShopsModule {}

