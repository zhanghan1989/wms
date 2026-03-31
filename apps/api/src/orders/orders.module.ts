import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ThirdPartyApiKeyGuard } from './third-party-api-key.guard';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, ThirdPartyApiKeyGuard],
})
export class OrdersModule {}
