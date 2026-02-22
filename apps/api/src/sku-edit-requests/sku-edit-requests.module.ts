import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SkuEditRequestsController } from './sku-edit-requests.controller';
import { SkuEditRequestsService } from './sku-edit-requests.service';

@Module({
  imports: [AuditModule],
  controllers: [SkuEditRequestsController],
  providers: [SkuEditRequestsService],
})
export class SkuEditRequestsModule {}
