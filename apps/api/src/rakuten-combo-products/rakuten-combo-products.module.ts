import { Module } from '@nestjs/common';
import { RakutenComboProductsController } from './rakuten-combo-products.controller';
import { RakutenComboProductsService } from './rakuten-combo-products.service';

@Module({
  controllers: [RakutenComboProductsController],
  providers: [RakutenComboProductsService],
})
export class RakutenComboProductsModule {}
