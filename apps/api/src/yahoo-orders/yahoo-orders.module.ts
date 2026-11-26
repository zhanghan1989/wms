import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { YahooOrdersClient } from './yahoo-orders.client';
import { YahooOrdersController } from './yahoo-orders.controller';
import { YahooOrdersService } from './yahoo-orders.service';

@Module({
  imports: [OrdersModule],
  controllers: [YahooOrdersController],
  providers: [YahooOrdersClient, YahooOrdersService],
})
export class YahooOrdersModule {}
