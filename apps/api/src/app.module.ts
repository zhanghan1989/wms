import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditModule } from './audit/audit.module';
import { AmazonSpApiModule } from './amazon-sp-api/amazon-sp-api.module';
import { AuthModule } from './auth/auth.module';
import { BackupsModule } from './backups/backups.module';
import { BatchInboundModule } from './batch-inbound/batch-inbound.module';
import { BrandsModule } from './brands/brands.module';
import { BoxesModule } from './boxes/boxes.module';
import { InboundModule } from './inbound/inbound.module';
import { InventoryModule } from './inventory/inventory.module';
import { MasterProductsModule } from './master-products/master-products.module';
import { OrdersModule } from './orders/orders.module';
import { PrintAgentModule } from './print-agent/print-agent.module';
import { PrismaModule } from './prisma/prisma.module';
import { RakutenComboProductsModule } from './rakuten-combo-products/rakuten-combo-products.module';
import { ReturnRecordsModule } from './return-records/return-records.module';
import { ShelvesModule } from './shelves/shelves.module';
import { ShopsModule } from './shops/shops.module';
import { SkuTypesModule } from './sku-types/sku-types.module';
import { SkuEditRequestsModule } from './sku-edit-requests/sku-edit-requests.module';
import { SkusModule } from './skus/skus.module';
import { StocktakePlannerModule } from './stocktake-planner/stocktake-planner.module';
import { UserOptionsModule } from './user-options/user-options.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AmazonSpApiModule,
    AuthModule,
    BackupsModule,
    UserOptionsModule,
    UsersModule,
    SkusModule,
    SkuEditRequestsModule,
    BrandsModule,
    SkuTypesModule,
    ShopsModule,
    ShelvesModule,
    StocktakePlannerModule,
    BoxesModule,
    BatchInboundModule,
    InboundModule,
    InventoryModule,
    MasterProductsModule,
    OrdersModule,
    PrintAgentModule,
    RakutenComboProductsModule,
    ReturnRecordsModule,
    AuditModule,
  ],
})
export class AppModule {}
