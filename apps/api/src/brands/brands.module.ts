import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';

@Module({
  imports: [AuditModule],
  controllers: [BrandsController],
  providers: [BrandsService],
})
export class BrandsModule {}
