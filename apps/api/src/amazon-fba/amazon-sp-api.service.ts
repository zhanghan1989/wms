import { Injectable } from '@nestjs/common';

interface AmazonShipFromAddress {
  name: string;
  addressLine1: string;
  city: string;
  countryCode: string;
  postalCode: string;
  phoneNumber: string;
  addressLine2?: string;
  stateOrProvinceCode?: string;
  districtOrCounty?: string;
  companyName?: string;
}

export interface AmazonConnectionAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  shipFromAddress: AmazonShipFromAddress;
  destinationMarketplaces?: string[];
  labelOwner?: 'AMAZON' | 'SELLER';
  prepOwner?: 'AMAZON' | 'SELLER';
  appName?: string;
  appVersion?: string;
  applicationId?: string;
  sellerCentralUrl?: string;
  authorizationVersion?: 'published' | 'beta';
  oauthState?: string;
  oauthStateExpiresAt?: string;
  oauthLastAuthorizedAt?: string;
  oauthLastError?: string;
  oauthSellingPartnerId?: string;
}

export interface AmazonSpApiCallResult {
  status: number;
  body: unknown;
}

export class AmazonSpApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface AmazonAuthorizationCodeExchangeResult {
  refreshToken: string;
  accessToken?: string;
  expiresIn?: number;
}

@Injectable()
export class AmazonSpApiService {
  async createInboundPlan(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    return this.callJsonApi(
      region,
      'POST',
      '/inbound/fba/2024-03-20/inboundPlans',
      authConfig,
      accessToken,
      payload,
      idempotencyKey,
    );
  }

  async getInboundOperation(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    operationId: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedOperationId = encodeURIComponent(operationId);
    return this.callJsonApi(
      region,
      'GET',
      `/inbound/fba/2024-03-20/operations/${encodedOperationId}`,
      authConfig,
      accessToken,
    );
  }

  async generatePlacementOptions(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    idempotencyKey?: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    return this.callJsonApi(
      region,
      'POST',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/placementOptions`,
      authConfig,
      accessToken,
      undefined,
      idempotencyKey,
    );
  }

  async generatePackingOptions(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    idempotencyKey?: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    return this.callJsonApi(
      region,
      'POST',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/packingOptions`,
      authConfig,
      accessToken,
      undefined,
      idempotencyKey,
    );
  }

  async listPackingOptions(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    return this.callJsonApi(
      region,
      'GET',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/packingOptions`,
      authConfig,
      accessToken,
    );
  }

  async confirmPackingOption(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    packingOptionId: string,
    idempotencyKey?: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    const encodedPackingOptionId = encodeURIComponent(packingOptionId);
    return this.callJsonApi(
      region,
      'POST',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/packingOptions/${encodedPackingOptionId}/confirmation`,
      authConfig,
      accessToken,
      undefined,
      idempotencyKey,
    );
  }

  async setPackingInformation(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    return this.callJsonApi(
      region,
      'POST',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/packingInformation`,
      authConfig,
      accessToken,
      payload,
      idempotencyKey,
    );
  }

  async listPlacementOptions(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    return this.callJsonApi(
      region,
      'GET',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/placementOptions`,
      authConfig,
      accessToken,
    );
  }

  async confirmPlacementOption(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    placementOptionId: string,
    idempotencyKey?: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    const encodedPlacementOptionId = encodeURIComponent(placementOptionId);
    return this.callJsonApi(
      region,
      'POST',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/placementOptions/${encodedPlacementOptionId}/confirmation`,
      authConfig,
      accessToken,
      undefined,
      idempotencyKey,
    );
  }

  async generateTransportationOptions(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    return this.callJsonApi(
      region,
      'POST',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/transportationOptions`,
      authConfig,
      accessToken,
      payload,
      idempotencyKey,
    );
  }

  async listTransportationOptions(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    placementOptionId: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    const query = new URLSearchParams({ placementOptionId }).toString();
    return this.callJsonApi(
      region,
      'GET',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/transportationOptions?${query}`,
      authConfig,
      accessToken,
    );
  }

  async confirmTransportationOptions(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    return this.callJsonApi(
      region,
      'POST',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/transportationOptions/confirmation`,
      authConfig,
      accessToken,
      payload,
      idempotencyKey,
    );
  }

  async getShipment(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    shipmentId: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    const encodedShipmentId = encodeURIComponent(shipmentId);
    return this.callJsonApi(
      region,
      'GET',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/shipments/${encodedShipmentId}`,
      authConfig,
      accessToken,
    );
  }

  async listShipmentBoxes(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    shipmentId: string,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    const encodedShipmentId = encodeURIComponent(shipmentId);
    return this.callJsonApi(
      region,
      'GET',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/shipments/${encodedShipmentId}/boxes`,
      authConfig,
      accessToken,
    );
  }

  async getLabels(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    shipmentConfirmationId: string,
    query: Record<string, string>,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedShipmentConfirmationId = encodeURIComponent(shipmentConfirmationId);
    const search = new URLSearchParams(query).toString();
    return this.callJsonApi(
      region,
      'GET',
      `/fba/inbound/v0/shipments/${encodedShipmentConfirmationId}/labels${search ? `?${search}` : ''}`,
      authConfig,
      accessToken,
    );
  }

  async updateShipmentTrackingDetails(
    region: string,
    authConfig: AmazonConnectionAuthConfig,
    inboundPlanId: string,
    shipmentId: string,
    payload: Record<string, unknown>,
  ): Promise<AmazonSpApiCallResult> {
    const accessToken = await this.requestAccessToken(authConfig);
    const encodedInboundPlanId = encodeURIComponent(inboundPlanId);
    const encodedShipmentId = encodeURIComponent(shipmentId);
    return this.callJsonApi(
      region,
      'PUT',
      `/inbound/fba/2024-03-20/inboundPlans/${encodedInboundPlanId}/shipments/${encodedShipmentId}/trackingDetails`,
      authConfig,
      accessToken,
      payload,
    );
  }

  async exchangeAuthorizationCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<AmazonAuthorizationCodeExchangeResult> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: body.toString(),
    });

    const responseBody = await this.readResponseBody(response);
    if (!response.ok) {
      throw new AmazonSpApiRequestError('Amazon authorization code exchange failed', response.status, responseBody);
    }

    const record = typeof responseBody === 'object' && responseBody !== null
      ? responseBody as {
        refresh_token?: unknown;
        access_token?: unknown;
        expires_in?: unknown;
      }
      : null;
    const refreshToken = String(record?.refresh_token || '').trim();
    if (!refreshToken) {
      throw new AmazonSpApiRequestError(
        'Amazon authorization code exchange response missing refresh_token',
        response.status,
        responseBody,
      );
    }
    const accessToken = String(record?.access_token || '').trim() || undefined;
    const expiresRaw = Number(record?.expires_in);
    return {
      refreshToken,
      accessToken,
      expiresIn: Number.isFinite(expiresRaw) ? expiresRaw : undefined,
    };
  }

  private async requestAccessToken(authConfig: AmazonConnectionAuthConfig): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(authConfig.refreshToken || ''),
      client_id: authConfig.clientId,
      client_secret: authConfig.clientSecret,
    });

    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: body.toString(),
    });

    const responseBody = await this.readResponseBody(response);
    if (!response.ok) {
      throw new AmazonSpApiRequestError('Amazon LWA token request failed', response.status, responseBody);
    }

    const accessToken =
      typeof responseBody === 'object' && responseBody !== null
        ? String((responseBody as { access_token?: unknown }).access_token || '')
        : '';
    if (!accessToken) {
      throw new AmazonSpApiRequestError('Amazon LWA token response missing access_token', response.status, responseBody);
    }
    return accessToken;
  }

  private async callJsonApi(
    region: string,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    authConfig: AmazonConnectionAuthConfig,
    accessToken: string,
    payload?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<AmazonSpApiCallResult> {
    const url = `${this.resolveBaseUrl(region)}${path}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-amz-access-token': accessToken,
      'user-agent': this.buildUserAgent(authConfig),
    };
    if (method === 'POST' || method === 'PUT') {
      headers['content-type'] = 'application/json';
    }
    if (idempotencyKey) {
      headers['x-amzn-idempotency-key'] = idempotencyKey;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const responseBody = await this.readResponseBody(response);
    if (!response.ok) {
      throw new AmazonSpApiRequestError(`Amazon SP-API request failed: ${method} ${path}`, response.status, responseBody);
    }
    return {
      status: response.status,
      body: responseBody,
    };
  }

  private async readResponseBody(response: Response): Promise<unknown> {
    const rawText = await response.text();
    if (!rawText) {
      return null;
    }
    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      return rawText;
    }
  }

  private resolveBaseUrl(region: string): string {
    const normalized = String(region || '').trim().toLowerCase();
    if (normalized === 'na') return 'https://sellingpartnerapi-na.amazon.com';
    if (normalized === 'eu') return 'https://sellingpartnerapi-eu.amazon.com';
    if (normalized === 'fe') return 'https://sellingpartnerapi-fe.amazon.com';
    throw new Error(`Unsupported Amazon region: ${region}`);
  }

  private buildUserAgent(authConfig: AmazonConnectionAuthConfig): string {
    const appName = String(authConfig.appName || 'wms-api').trim();
    const appVersion = String(authConfig.appVersion || '1.0.0').trim();
    return `${appName}/${appVersion} (Language=TypeScript; Platform=Node.js 20)`;
  }
}
