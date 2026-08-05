import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  AmazonFulfilledBy,
  AmazonInventoryResponse,
  AmazonInventorySummaryPayload,
  AmazonOrderPayload,
  AmazonSearchOrdersResponse,
  AmazonSpApiRegion,
} from './amazon-sp-api.types';

const REGION_ENDPOINTS: Record<AmazonSpApiRegion, string> = {
  NA: 'https://sellingpartnerapi-na.amazon.com',
  EU: 'https://sellingpartnerapi-eu.amazon.com',
  FE: 'https://sellingpartnerapi-fe.amazon.com',
};

@Injectable()
export class AmazonSpApiClient {
  async exchangeAuthorizationCode(code: string, redirectUri: string): Promise<{
    refreshToken: string;
    accessToken: string;
  }> {
    const { clientId, clientSecret } = this.getLwaCredentials();
    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const payload = (await this.readJson(response)) as {
      refresh_token?: string;
      access_token?: string;
      error_description?: string;
    };
    if (!response.ok || !payload.refresh_token || !payload.access_token) {
      throw new ServiceUnavailableException(
        `Amazon OAuth授权码交换失败（HTTP ${response.status}）：${payload.error_description || '未返回授权令牌'}`,
      );
    }
    return { refreshToken: payload.refresh_token, accessToken: payload.access_token };
  }

  async exchangeRefreshToken(refreshToken: string): Promise<string> {
    const { clientId, clientSecret } = this.getLwaCredentials();

    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const payload = (await this.readJson(response)) as { access_token?: string; error_description?: string };
    if (!response.ok || !payload.access_token) {
      throw new ServiceUnavailableException(
        `Amazon LWA授权失败（HTTP ${response.status}）：${payload.error_description || '未返回Access Token'}`,
      );
    }
    return payload.access_token;
  }

  private getLwaCredentials(): { clientId: string; clientSecret: string } {
    const clientId = String(process.env.AMAZON_SP_API_LWA_CLIENT_ID ?? '').trim();
    const clientSecret = String(process.env.AMAZON_SP_API_LWA_CLIENT_SECRET ?? '').trim();
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException(
        '请配置 AMAZON_SP_API_LWA_CLIENT_ID 和 AMAZON_SP_API_LWA_CLIENT_SECRET',
      );
    }
    return { clientId, clientSecret };
  }

  async testConnection(accessToken: string, region: AmazonSpApiRegion): Promise<unknown> {
    return this.requestJson(accessToken, region, '/sellers/v1/marketplaceParticipations');
  }

  async searchOrders(options: {
    accessToken: string;
    region: AmazonSpApiRegion;
    marketplaceIds: string[];
    fulfilledBy: AmazonFulfilledBy;
    lastUpdatedAfter: Date;
    includeRecipient: boolean;
  }): Promise<AmazonOrderPayload[]> {
    const rows: AmazonOrderPayload[] = [];
    let paginationToken: string | undefined;
    do {
      const params = new URLSearchParams({
        marketplaceIds: options.marketplaceIds.join(','),
        fulfilledBy: options.fulfilledBy,
        lastUpdatedAfter: options.lastUpdatedAfter.toISOString(),
        maxResultsPerPage: '100',
        includedData: options.fulfilledBy === 'MERCHANT' && options.includeRecipient
          ? 'RECIPIENT,FULFILLMENT,CANCELLATION,PACKAGES'
          : 'FULFILLMENT,CANCELLATION',
      });
      if (paginationToken) params.set('paginationToken', paginationToken);
      const payload = await this.requestJson<AmazonSearchOrdersResponse>(
        options.accessToken,
        options.region,
        `/orders/2026-01-01/orders?${params.toString()}`,
      );
      rows.push(...(payload.orders ?? []));
      paginationToken = payload.pagination?.nextToken;
    } while (paginationToken);
    return rows;
  }

  async getInventorySummaries(options: {
    accessToken: string;
    region: AmazonSpApiRegion;
    marketplaceId: string;
  }): Promise<AmazonInventorySummaryPayload[]> {
    const rows: AmazonInventorySummaryPayload[] = [];
    let nextToken: string | undefined;
    do {
      const params = new URLSearchParams({
        details: 'true',
        granularityType: 'Marketplace',
        granularityId: options.marketplaceId,
        marketplaceIds: options.marketplaceId,
      });
      if (nextToken) params.set('nextToken', nextToken);
      const response = await this.requestJson<AmazonInventoryResponse>(
        options.accessToken,
        options.region,
        `/fba/inventory/v1/summaries?${params.toString()}`,
      );
      rows.push(...(response.payload?.inventorySummaries ?? []));
      nextToken = response.pagination?.nextToken ?? response.payload?.pagination?.nextToken;
    } while (nextToken);
    return rows;
  }

  private async requestJson<T = unknown>(
    accessToken: string,
    region: AmazonSpApiRegion,
    path: string,
  ): Promise<T> {
    const endpoint = REGION_ENDPOINTS[region];
    let response = await fetch(`${endpoint}${path}`, {
      headers: {
        accept: 'application/json',
        'x-amz-access-token': accessToken,
        'user-agent': '001-wms-amazon-sync/1.0',
      },
    });
    if (response.status === 429 || response.status >= 500) {
      const retryAfterSeconds = Math.min(Number(response.headers.get('retry-after') ?? 1) || 1, 5);
      await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
      response = await fetch(`${endpoint}${path}`, {
        headers: {
          accept: 'application/json',
          'x-amz-access-token': accessToken,
          'user-agent': '001-wms-amazon-sync/1.0',
        },
      });
    }
    const payload = await this.readJson(response);
    if (!response.ok) {
      const message = this.extractErrorMessage(payload);
      throw new ServiceUnavailableException(`Amazon SP-API请求失败（HTTP ${response.status}）：${message}`);
    }
    return payload as T;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { message: text.slice(0, 500) };
    }
  }

  private extractErrorMessage(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '未知错误';
    const record = payload as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    const errors = Array.isArray(record.errors) ? record.errors : [];
    const first = errors[0];
    if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).message === 'string') {
      return String((first as Record<string, unknown>).message);
    }
    return '未知错误';
  }
}
