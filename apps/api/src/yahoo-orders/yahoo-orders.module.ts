import { Module } from '@nestjs/common';
import { RakutenRmsApiModule } from '../rakuten-rms-api/rakuten-rms-api.module';
import { YahooInventoryController } from './yahoo-inventory.controller';
import { YahooInventoryService } from './yahoo-inventory.service';
import { OrdersModule } from '../orders/orders.module';
import { YahooOrdersClient } from './yahoo-orders.client';
import { YahooOrdersController } from './yahoo-orders.controller';
import { YahooOrdersService } from './yahoo-orders.service';

@Module({
  imports: [OrdersModule, RakutenRmsApiModule],
  controllers: [YahooOrdersController, YahooInventoryController],
  providers: [YahooOrdersClient, YahooOrdersService, YahooInventoryService],
})
export class YahooOrdersModule {}
