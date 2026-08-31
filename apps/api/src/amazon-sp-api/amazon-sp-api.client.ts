import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
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
const MAX_REQUEST_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_DELAY_MS = 30_000;

@Injectable()
export class AmazonSpApiClient {
  private readonly logger = new Logger(AmazonSpApiClient.name);

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
    await this.forEachOrderPage(options, (page) => {
      rows.push(...page);
    });
    return rows;
  }

  async forEachOrderPage(
    options: {
      accessToken: string;
      region: AmazonSpApiRegion;
      marketplaceIds: string[];
      fulfilledBy: AmazonFulfilledBy;
      lastUpdatedAfter: Date;
      includeRecipient: boolean;
    },
    onPage: (orders: AmazonOrderPayload[]) => Promise<void> | void,
  ): Promise<void> {
    let paginationToken: string | undefined;
    const seenTokens = new Set<string>();
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
      await onPage(payload.orders ?? []);
      const nextToken = payload.pagination?.nextToken;
      if (nextToken && seenTokens.has(nextToken)) {
        throw new ServiceUnavailableException('Amazon SP-API订单分页令牌重复，已停止拉取以避免死循环');
      }
      if (nextToken) seenTokens.add(nextToken);
      paginationToken = nextToken;
    } while (paginationToken);
  }

  async getInventorySummaries(options: {
    accessToken: string;
    region: AmazonSpApiRegion;
    marketplaceId: string;
  }): Promise<AmazonInventorySummaryPayload[]> {
    const rows: AmazonInventorySummaryPayload[] = [];
    let nextToken: string | undefined;
    const seenTokens = new Set<string>();
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
      const responseNextToken = response.pagination?.nextToken ?? response.payload?.pagination?.nextToken;
      if (responseNextToken && seenTokens.has(responseNextToken)) {
        throw new ServiceUnavailableException('Amazon SP-API库存分页令牌重复，已停止拉取以避免死循环');
      }
      if (responseNextToken) seenTokens.add(responseNextToken);
      nextToken = responseNextToken;
    } while (nextToken);
    return rows;
  }

  private async requestJson<T = unknown>(
    accessToken: string,
    region: AmazonSpApiRegion,
    path: string,
  ): Promise<T> {
    const endpoint = REGION_ENDPOINTS[region];
    const requestUrl = `${endpoint}${path}`;
    let lastNetworkError: unknown;
    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(requestUrl, {
          signal: AbortSignal.timeout(this.requestTimeoutMs()),
          headers: {
            accept: 'application/json',
            'x-amz-access-token': accessToken,
            'user-agent': '001-wms-amazon-sync/1.0',
          },
        });
        const payload = await this.readJson(response);
        const requestId = this.responseRequestId(response);
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!response.ok && retryable && attempt < MAX_REQUEST_ATTEMPTS) {
          this.logger.warn(
            `Amazon SP-API retry ${attempt}/${MAX_REQUEST_ATTEMPTS - 1}: HTTP ${response.status}${
              requestId ? ` requestId=${requestId}` : ''
            } path=${path}`,
          );
          await this.waitBeforeRetry(response, attempt);
          continue;
        }
        if (!response.ok) {
          const message = this.extractErrorMessage(payload);
          throw new ServiceUnavailableException(
            `Amazon SP-API请求失败（HTTP ${response.status}${requestId ? `，Request ID ${requestId}` : ''}）：${message}`,
          );
        }
        return payload as T;
      } catch (error) {
        if (error instanceof ServiceUnavailableException) throw error;
        lastNetworkError = error;
        if (attempt < MAX_REQUEST_ATTEMPTS) {
          this.logger.warn(
            `Amazon SP-API network retry ${attempt}/${MAX_REQUEST_ATTEMPTS - 1}: path=${path} error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await this.delay(this.withJitter(Math.min(250 * 2 ** (attempt - 1), 1000)));
          continue;
        }
      }
    }
    const details = lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError ?? '未知错误');
    throw new ServiceUnavailableException(`无法连接 Amazon SP-API（网络或TLS错误）：${details}`);
  }

  private async waitBeforeRetry(response: Response, attempt: number): Promise<void> {
    const retryAfterMs = this.retryAfterMilliseconds(response.headers.get('retry-after'));
    const fallbackMs = this.withJitter(Math.min(250 * 2 ** (attempt - 1), 1000));
    await this.delay(retryAfterMs ?? fallbackMs);
  }

  private retryAfterMilliseconds(value: string | null): number | null {
    const normalized = String(value ?? '').trim();
    if (!normalized) return null;
    const seconds = Number(normalized);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
    const retryAt = Date.parse(normalized);
    if (!Number.isFinite(retryAt)) return null;
    return Math.min(Math.max(0, retryAt - Date.now()), MAX_RETRY_DELAY_MS);
  }

  private withJitter(milliseconds: number): number {
    return Math.round(milliseconds * (0.8 + Math.random() * 0.4));
  }

  private responseRequestId(response: Response): string {
    return String(
      response.headers.get('x-amzn-requestid')
      ?? response.headers.get('x-amz-request-id')
      ?? '',
    ).trim();
  }

  private requestTimeoutMs(): number {
    const configured = Number(process.env.AMAZON_SP_API_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 1000
      ? Math.min(configured, 120_000)
      : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
