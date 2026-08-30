import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RakutenRmsApiClient } from './rakuten-rms-api.client';
import { RakutenRmsApiController } from './rakuten-rms-api.controller';
import { RakutenRmsApiCryptoService } from './rakuten-rms-api-crypto.service';
import { RakutenRmsApiService } from './rakuten-rms-api.service';
import { RakutenRmsAutomationService } from './rakuten-rms-automation.service';

@Module({
  imports: [AuditModule],
  controllers: [RakutenRmsApiController],
  providers: [RakutenRmsApiService, RakutenRmsApiClient, RakutenRmsApiCryptoService, RakutenRmsAutomationService],
  exports: [RakutenRmsApiService],
})
export class RakutenRmsApiModule {}
