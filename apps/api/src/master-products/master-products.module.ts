import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { OrdersModule } from '../orders/orders.module';
import { ThirdPartyApiKeyGuard } from '../orders/third-party-api-key.guard';
import { MasterProductsController, MasterProductsThirdPartyController } from './master-products.controller';
import { MasterProductsService } from './master-products.service';

@Module({
  imports: [AuditModule, OrdersModule],
  controllers: [MasterProductsController, MasterProductsThirdPartyController],
  providers: [MasterProductsService, ThirdPartyApiKeyGuard],
})
export class MasterProductsModule {}
