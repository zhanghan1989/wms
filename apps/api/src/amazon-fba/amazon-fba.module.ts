import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AmazonFbaController } from './amazon-fba.controller';
import { AmazonSpApiService } from './amazon-sp-api.service';
import { AmazonFbaService } from './amazon-fba.service';

@Module({
  imports: [AuditModule],
  controllers: [AmazonFbaController],
  providers: [AmazonFbaService, AmazonSpApiService],
})
export class AmazonFbaModule {}
