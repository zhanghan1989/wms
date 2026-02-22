import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SkuTypesController } from './sku-types.controller';
import { SkuTypesService } from './sku-types.service';

@Module({
  imports: [AuditModule],
  controllers: [SkuTypesController],
  providers: [SkuTypesService],
})
export class SkuTypesModule {}
