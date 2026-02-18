import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BoxesModule } from './boxes/boxes.module';
import { InboundModule } from './inbound/inbound.module';
import { InventoryModule } from './inventory/inventory.module';
import { PrismaModule } from './prisma/prisma.module';
import { ShelvesModule } from './shelves/shelves.module';
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
    ShelvesModule,
    BoxesModule,
    InboundModule,
    InventoryModule,
    AuditModule,
  ],
})
export class AppModule {}
