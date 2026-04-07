import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MasterProductsController } from './master-products.controller';
import { MasterProductsService } from './master-products.service';

@Module({
  imports: [AuditModule],
  controllers: [MasterProductsController],
  providers: [MasterProductsService],
})
export class MasterProductsModule {}
