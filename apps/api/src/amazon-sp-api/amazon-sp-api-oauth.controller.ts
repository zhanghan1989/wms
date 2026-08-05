import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { AmazonSpApiService } from './amazon-sp-api.service';

@Controller('amazon-sp-api/oauth')
export class AmazonSpApiOAuthController {
  constructor(private readonly service: AmazonSpApiService) {}

  @Get('callback')
  async callback(
    @Query('state') state: string | undefined,
    @Query('spapi_oauth_code') authorizationCode: string | undefined,
    @Query('selling_partner_id') sellingPartnerId: string | undefined,
    @Query('error') error: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    try {
      if (error) {
        response.redirect(this.service.getOAuthReturnUrl('error', 'amazon_denied'));
        return;
      }
      await this.service.completeOAuth({ state, authorizationCode, sellingPartnerId });
      response.redirect(this.service.getOAuthReturnUrl('success'));
    } catch {
      response.redirect(this.service.getOAuthReturnUrl('error', 'callback_failed'));
    }
  }
}
