import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { fetch, ProxyAgent } from 'undici';

const authorizationEndpoint = 'https://auth.login.yahoo.co.jp/yconnect/v2/authorization';
const tokenEndpoint = 'https://auth.login.yahoo.co.jp/yconnect/v2/token';
const orderEndpoint = 'https://circus.shopping.yahooapis.jp/ShoppingWebService/V1/';
const formatTime = (date: Date) => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 19).replace(/\D/g, '');
const parser = new XMLParser({ parseTagValue: false, processEntities: true });

export interface YahooCredentials {
  clientId: string;
  clientSecret: string;
  publicKey: string;
  keyVersion: string;
  refreshToken?: string;
  accessToken?: string;
  accessUntil?: number;
}

interface YahooItem {
  LineId?: string;
  ItemId?: string;
  SubCode?: string;
  Title?: string;
  Quantity?: string;
}

export interface YahooOrder {
  OrderId?: string;
  OrderStatus?: string;
  OrderTime?: string;
  Suspect?: string;
  IsLineGiftOrder?: string;
  IsLineGiftShippable?: string;
  Ship?: {
    ShipStatus?: string;
    ShipLastName?: string;
    ShipFirstName?: string;
    ShipPhoneNumber?: string;
    ShipZipCode?: string;
    ShipPrefecture?: string;
    ShipCity?: string;
    ShipAddress1?: string;
    ShipAddress2?: string;
    ShipRequestDate?: string;
    ShipRequestTime?: string;
    ReceiveSatelliteType?: string;
  };
  Item?: YahooItem | YahooItem[];
}

export class YahooRequestError extends Error {}

export function normalizeYahooPublicKey(value: string): string {
  const compact = value.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
  try {
    const key = createPublicKey({ key: Buffer.from(compact, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa') throw new Error();
    return key.export({ format: 'pem', type: 'spki' }).toString();
  } catch {
    throw new YahooRequestError('Yahoo RSA 公开密钥格式无效');
  }
}

export function yahooItems(order: YahooOrder): YahooItem[] {
  if (!order.Item) return [];
  return Array.isArray(order.Item) ? order.Item : [order.Item];
}

@Injectable()
export class YahooOrdersClient implements OnModuleDestroy {
  private proxy?: ProxyAgent;

  get callbackUrl(): string {
    return process.env.YAHOO_ORDERS_REDIRECT_URI || 'https://wms.fulangke.cn/api/yahoo-orders/oauth/callback';
  }

  get proxyConfigured(): boolean {
    return Boolean(process.env.RAKUTEN_RMS_API_PROXY_URL?.trim());
  }

  authorizationUrl(clientId: string, state: string, challenge: string): string {
    const params = new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: this.callbackUrl, scope: 'openid profile',
      state, code_challenge: challenge, code_challenge_method: 'S256', bail: '1',
    });
    return authorizationEndpoint + '?' + params;
  }

  private getDispatcher(): ProxyAgent {
    const url = process.env.RAKUTEN_RMS_API_PROXY_URL?.trim();
    if (!url) throw new YahooRequestError('飞牛 OS 日本出口未配置');
    return this.proxy ??= new ProxyAgent(url);
  }

  async exchange(credentials: YahooCredentials, parameters: Record<string, string>, signal?: AbortSignal): Promise<YahooCredentials> {
    const response = await this.request(tokenEndpoint, {
      headers: {
        authorization: 'Basic ' + Buffer.from(credentials.clientId + ':' + credentials.clientSecret).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(parameters),
    }, signal);
    const token = await response.json().catch(() => null) as {
      access_token?: string; refresh_token?: string; expires_in?: number; error?: string;
    } | null;
    const expires = Number(token?.expires_in);
    const refreshToken = token?.refresh_token || credentials.refreshToken;
    if (!response.ok || !token?.access_token || !refreshToken || !Number.isFinite(expires) || expires <= 0) {
      if (token?.error === 'invalid_grant') throw new YahooRequestError('Yahoo 授权已失效，请重新授权');
      throw new YahooRequestError('Yahoo 授权失败（HTTP ' + response.status + '）');
    }
    return { ...credentials, accessToken: token.access_token, refreshToken, accessUntil: Date.now() + expires * 1000 };
  }

  async list(seller: string, credentials: YahooCredentials, from: Date, to: Date, start: number, count: number, signal?: AbortSignal) {
    const body = '<Req><Search><Result>' + count + '</Result><Start>' + start + '</Start><Sort>+order_time</Sort>'
      + '<Condition><OrderTimeFrom>' + formatTime(from) + '</OrderTimeFrom><OrderTimeTo>' + formatTime(to)
      + '</OrderTimeTo><OrderStatus>2</OrderStatus><ShipStatus>1</ShipStatus><FraudHoldDisplayType>0</FraudHoldDisplayType>'
      + '</Condition><Field>OrderId</Field></Search><SellerId>' + seller + '</SellerId></Req>';
    const result = (await this.call('orderList', seller, credentials, body, signal)).Result;
    const total = Number(result?.Search?.TotalCount);
    const orders = result?.Search?.OrderInfo;
    const rows = orders ? (Array.isArray(orders) ? orders : [orders]) : [];
    const ids: string[] = rows.map((row: { OrderId?: string }) => row?.OrderId ?? '');
    if (result?.Status !== 'OK' || result?.Search?.TotalCount === '' || !Number.isSafeInteger(total) || total < 0 ||
        ids.length !== Math.min(count, Math.max(0, total - start + 1)) || ids.some(id => !/^[a-zA-Z0-9-]{1,50}$/.test(id))) {
      throw new YahooRequestError('Yahoo 订单搜索分页结果不完整');
    }
    return { total, ids };
  }

  async detail(seller: string, credentials: YahooCredentials, orderId: string, signal?: AbortSignal): Promise<YahooOrder> {
    const fields = [
      'OrderId', 'OrderStatus', 'OrderTime', 'Suspect', 'IsLineGiftOrder', 'IsLineGiftShippable', 'ShipStatus',
      'ShipLastName', 'ShipFirstName', 'ShipPhoneNumber', 'ShipZipCode', 'ShipPrefecture', 'ShipCity',
      'ShipAddress1', 'ShipAddress2', 'ShipRequestDate', 'ShipRequestTime', 'ReceiveSatelliteType', 'LineId', 'ItemId', 'SubCode', 'Title', 'Quantity',
    ];
    const body = '<Req><Target><OrderId>' + orderId + '</OrderId><Field>' + fields.join(',')
      + '</Field></Target><SellerId>' + seller + '</SellerId></Req>';
    const result = (await this.call('orderInfo', seller, credentials, body, signal)).ResultSet?.Result;
    if (result?.Status !== 'OK' || result.OrderInfo?.OrderId !== orderId) {
      throw new YahooRequestError('Yahoo 订单明细结果与订单号不一致');
    }
    return result.OrderInfo;
  }

  private async call(endpoint: string, seller: string, credentials: YahooCredentials, body: string, signal?: AbortSignal) {
    const signature = publicEncrypt(
      { key: credentials.publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(seller + ':' + Math.floor(Date.now() / 1000)),
    ).toString('base64');
    const response = await this.request(orderEndpoint + endpoint, {
      headers: {
        authorization: 'Bearer ' + credentials.accessToken,
        'content-type': 'application/xml; charset=utf-8',
        'x-sws-signature': signature,
        'x-sws-signature-version': credentials.keyVersion,
      },
      body,
    }, signal);
    const xml = await response.text();
    if (xml.length > 5000000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
      throw new YahooRequestError('Yahoo 返回无效的订单响应（HTTP ' + response.status + '）');
    }
    const data = parser.parse(xml);
    const error = data.Error ?? data.Result?.Error ?? data.ResultSet?.Result?.Error;
    if (!response.ok || error || data.Result?.Status === 'NG' || data.ResultSet?.Result?.Status === 'NG') {
      const code = typeof error?.Code === 'string' && /^[a-z0-9-]{1,40}$/i.test(error.Code) ? error.Code : '';
      const messages: Record<string, string> = {
        'px-04303': '此 Client ID 的订单 API 未开通',
        'px-04306': 'Yahoo 未授权飞牛 OS 的当前公网出口',
        'px-04102': 'Yahoo 授权已失效，请重新授权',
      };
      throw new YahooRequestError((messages[code] || 'Yahoo 订单查询被拒绝') + '（HTTP ' + response.status + (code ? ' / ' + code : '') + '）');
    }
    return data;
  }

  private async request(url: string, options: { headers: Record<string, string>; body: string | URLSearchParams }, signal?: AbortSignal) {
    const dispatcher = this.getDispatcher();
    const timeout = AbortSignal.timeout(20000);
    try {
      return await fetch(url, {
        ...options, dispatcher, method: 'POST', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new YahooRequestError('通过飞牛 OS 日本出口请求 Yahoo 失败或超时');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.proxy?.close();
  }
}
