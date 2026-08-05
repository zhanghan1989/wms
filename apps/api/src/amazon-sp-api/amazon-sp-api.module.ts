import { Module } from '@nestjs/common';
import { AmazonSpApiClient } from './amazon-sp-api.client';
import { AmazonSpApiController } from './amazon-sp-api.controller';
import { AmazonSpApiCryptoService } from './amazon-sp-api-crypto.service';
import { AmazonSpApiOAuthController } from './amazon-sp-api-oauth.controller';
import { AmazonSpApiService } from './amazon-sp-api.service';

@Module({
  controllers: [AmazonSpApiController, AmazonSpApiOAuthController],
  providers: [AmazonSpApiService, AmazonSpApiClient, AmazonSpApiCryptoService],
  exports: [AmazonSpApiService],
})
export class AmazonSpApiModule {}
