import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BatchInboundModule } from './batch-inbound/batch-inbound.module';
import { BrandsModule } from './brands/brands.module';
import { BoxesModule } from './boxes/boxes.module';
import { InboundModule } from './inbound/inbound.module';
import { InventoryModule } from './inventory/inventory.module';
import { PrismaModule } from './prisma/prisma.module';
import { ShelvesModule } from './shelves/shelves.module';
import { ShopsModule } from './shops/shops.module';
import { SkuTypesModule } from './sku-types/sku-types.module';
import { SkuEditRequestsModule } from './sku-edit-requests/sku-edit-requests.module';
import { SkusModule } from './skus/skus.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    SkusModule,
    SkuEditRequestsModule,
    BrandsModule,
    SkuTypesModule,
    ShopsModule,
    ShelvesModule,
    BoxesModule,
    BatchInboundModule,
    InboundModule,
    InventoryModule,
    AuditModule,
  ],
})
export class AppModule {}
