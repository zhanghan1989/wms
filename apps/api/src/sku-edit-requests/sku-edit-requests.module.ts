import { Module } from '@nestjs/common';
import { SkuEditRequestsController } from './sku-edit-requests.controller';
import { SkuEditRequestsService } from './sku-edit-requests.service';

@Module({
  controllers: [SkuEditRequestsController],
  providers: [SkuEditRequestsService],
})
export class SkuEditRequestsModule {}
