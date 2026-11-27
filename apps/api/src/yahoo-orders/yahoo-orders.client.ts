import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { fetch, ProxyAgent } from 'undici';

const authorizationEndpoint = 'https://auth.login.yahoo.co.jp/yconnect/v2/authorization';
const tokenEndpoint = 'https://auth.login.yahoo.co.jp/yconnect/v2/token';
const shoppingEndpoint = 'https://circus.shopping.yahooapis.jp/ShoppingWebService/V1/';
const formatTime = (date: Date) => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 19).replace(/\D/g, '');
const parser = new XMLParser({ parseTagValue: false, processEntities: true, ignoreAttributes: false });

export interface YahooCredentials {
  clientId: string;
  clientSecret: string;
  publicKey: string;
  keyVersion: string;
  refreshToken?: string;
  accessToken?: string;
  accessUntil?: number;
}

export interface YahooStockTarget { itemCode: string; subCode: string }
export interface YahooStockRecord extends YahooStockTarget {
  quantity: number | null;
  overdraft: '0' | '1' | null;
  present: boolean;
  published: boolean;
  closed: boolean;
  updatedAt: string | null;
}
export const yahooStockKey = ({ itemCode, subCode }: YahooStockTarget): string => subCode ? itemCode + ':' + subCode : itemCode;
const itemCodePattern = /^[a-zA-Z0-9-]{1,99}$/;
const rowsOf = <T>(value: T | T[] | undefined | null): T[] => value ? (Array.isArray(value) ? value : [value]) : [];

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
  private readonly nextCall = new Map<string, number>();

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
    const page = await this.listOrders(seller, credentials, from, to, start, count, false, signal);
    return { total: page.total, ids: page.rows.map(row => row.OrderId) };
  }

  async outstanding(seller: string, credentials: YahooCredentials, from: Date, to: Date, start: number, count: number, signal: AbortSignal) {
    const page = await this.listOrders(seller, credentials, from, to, start, count, true, signal);
    const statuses = page.rows.map(row => {
      if (!row.OrderStatus || !row.ShipStatus || !/^[1-5]$/.test(row.OrderStatus) || !/^[0-4]$/.test(row.ShipStatus)) {
        throw new YahooRequestError('Yahoo 返回的订单或出荷状态无效');
      }
      return { id: row.OrderId, outstanding: row.OrderStatus !== '4' && Number(row.ShipStatus) < 3 };
    });
    return { total: page.total, statuses };
  }

  private async listOrders(seller: string, credentials: YahooCredentials, from: Date, to: Date, start: number, count: number,
    allStatuses: boolean, signal?: AbortSignal) {
    await this.limit('orderList', signal);
    const body = '<Req><Search><Result>' + count + '</Result><Start>' + start + '</Start><Sort>+order_time</Sort>'
      + '<Condition><OrderTimeFrom>' + formatTime(from) + '</OrderTimeFrom><OrderTimeTo>' + formatTime(to)
      + '</OrderTimeTo>' + (allStatuses
        ? '<FraudHoldDisplayType>1</FraudHoldDisplayType>'
        : '<OrderStatus>2</OrderStatus><ShipStatus>1</ShipStatus><FraudHoldDisplayType>0</FraudHoldDisplayType>')
      + '</Condition><Field>' + (allStatuses ? 'OrderId,OrderStatus,ShipStatus' : 'OrderId')
      + '</Field></Search><SellerId>' + seller + '</SellerId></Req>';
    const result = (await this.call('orderList', seller, credentials, body, signal)).Result;
    const total = Number(result?.Search?.TotalCount);
    const rows = rowsOf<{ OrderId: string; OrderStatus?: string; ShipStatus?: string }>(result?.Search?.OrderInfo);
    if (result?.Status !== 'OK' || result?.Search?.TotalCount === '' || !Number.isSafeInteger(total) || total < 0 ||
        rows.length !== Math.min(count, Math.max(0, total - start + 1)) ||
        rows.some(row => !/^[a-zA-Z0-9-]{1,50}$/.test(row?.OrderId ?? ''))) {
      throw new YahooRequestError('Yahoo 订单搜索分页结果不完整');
    }
    return { total, rows };
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
    const response = await this.request(shoppingEndpoint + endpoint, {
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

  /** getItem validates the listing independently of stock, which can have orphan records. */
  async getStockProduct(seller: string, credentials: YahooCredentials, itemCode: string, signal: AbortSignal) {
    const result = await this.stockCall('getItem', credentials, { seller_id: seller, item_code: itemCode }, signal);
    if (result === null) return null;
    const rows = rowsOf(result.Result);
    const item = rows[0];
    if (rows.length !== 1 || item?.ItemCode !== itemCode || !['0', '1'].includes(item.Display)) {
      throw new YahooRequestError('Yahoo 返回的商品资料无效');
    }
    const subCodes: string[] = rowsOf<{ '@_code'?: string }>(item.SubCodes?.SubCode).map(row => row['@_code'] ?? '');
    if (subCodes.some(code => !itemCodePattern.test(code)) || new Set(subCodes).size !== subCodes.length) {
      throw new YahooRequestError('Yahoo 返回的商品规格无效');
    }
    const from = item.SalePeriodStart ? Date.parse(item.SalePeriodStart) : -Infinity;
    const to = item.SalePeriodEnd ? Date.parse(item.SalePeriodEnd) : Infinity;
    if (Number.isNaN(from) || Number.isNaN(to)) throw new YahooRequestError('Yahoo 返回的商品销售期间无效');
    return { subCodes, onSale: item.Display === '1' && from <= Date.now() && Date.now() <= to };
  }

  async getStock(seller: string, credentials: YahooCredentials, targets: YahooStockTarget[], signal: AbortSignal) {
    const keys = targets.map(yahooStockKey);
    const result = await this.stockCall('getStock', credentials, { seller_id: seller, item_code: keys.join(',') }, signal);
    const remote = new Map<string, YahooStockRecord>();
    for (const row of rowsOf(result?.Result)) {
      const target = { itemCode: String(row?.ItemCode ?? ''), subCode: String(row?.SubCode ?? '') };
      const key = yahooStockKey(target);
      if (!keys.includes(key) || remote.has(key) || !['0','1'].includes(row.Status)) {
        throw new YahooRequestError('Yahoo 返回未知、重复或无效的库存行');
      }
      const raw = row.Quantity;
      const quantity = typeof raw === 'string' && /^-?\d{1,9}$/.test(raw) ? Number(raw) : null;
      if (row.Status === '1' && raw !== undefined && raw !== '' && quantity === null) {
        throw new YahooRequestError('Yahoo 返回的库存数量无效');
      }
      remote.set(key, {
        ...target, quantity, present: row.Status === '1', published: row.IsPublished === '1',
        overdraft: row.AllowOverdraft === '0' || row.AllowOverdraft === '1' ? row.AllowOverdraft : null,
        closed: row.StockClose === '1', updatedAt: typeof row.UpdateTime === 'string' ? row.UpdateTime : null,
      });
    }
    if (remote.size !== keys.length) throw new YahooRequestError('Yahoo 库存结果不完整');
    return remote;
  }

  async setStock(seller: string, credentials: YahooCredentials,
    targets: (YahooStockTarget & { quantity: number; overdraft: '0' | '1' })[], signal: AbortSignal) {
    if (targets.some(row => !Number.isInteger(row.quantity) || row.quantity < 0 || row.quantity > 99999)) {
      throw new YahooRequestError('库存写入值超出范围');
    }
    const result = await this.stockCall('setStock', credentials, {
      seller_id: seller,
      item_code: targets.map(yahooStockKey).join(','),
      quantity: targets.map(row => String(row.quantity)).join(','),
      // Yahoo applies the shop default if this field is omitted. Keep the current SKU setting.
      allow_overdraft: targets.map(row => row.overdraft).join(','),
    }, signal);
    const acknowledgements = new Map<string, string>();
    for (const response of rowsOf(result?.Result)) {
      const key = yahooStockKey({ itemCode: response?.ItemCode ?? '', subCode: response?.SubCode ?? '' });
      if (response.ErrorCode || acknowledgements.has(key)) throw new YahooRequestError('Yahoo 库存写入回执不完整');
      acknowledgements.set(key, response.Quantity);
    }
    if (acknowledgements.size !== targets.length ||
      targets.some(row => acknowledgements.get(yahooStockKey(row)) !== String(row.quantity))) {
      throw new YahooRequestError('Yahoo 库存写入回执与计划不一致');
    }
  }

  private async stockCall(endpoint: 'getItem' | 'getStock' | 'setStock', credentials: YahooCredentials,
    parameters: Record<string, string>, signal: AbortSignal) {
    await this.limit(endpoint, signal);
    const query = new URLSearchParams(parameters);
    const readItem = endpoint === 'getItem';
    const response = await this.request(shoppingEndpoint + endpoint + (readItem ? '?' + query : ''), {
      headers: { authorization: 'Bearer ' + credentials.accessToken,
        ...(readItem ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) },
      body: readItem ? undefined : query,
    }, signal);
    const xml = await response.text();
    if (xml.length > 5000000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
      throw new YahooRequestError('Yahoo ' + endpoint + ' 返回无效响应（HTTP ' + response.status + '）');
    }
    const data = parser.parse(xml);
    const error = data.Error ?? data.ResultSet?.Error;
    const code = error?.Code ?? error?.['@_code'];
    if (readItem && code === 'it-05002') return null;
    if (response.status !== 200 || error || !data.ResultSet) {
      const safeCode = typeof code === 'string' && /^[a-z0-9-]{1,24}$/i.test(code) ? ' / ' + code : '';
      throw new YahooRequestError('Yahoo ' + endpoint + ' 未成功（HTTP ' + response.status + safeCode + '）');
    }
    return data.ResultSet;
  }

  private async limit(endpoint: string, signal?: AbortSignal) {
    const next = Math.max(this.nextCall.get(endpoint) ?? 0, Date.now());
    this.nextCall.set(endpoint, next + 1050);
    if (next > Date.now()) await delay(next - Date.now(), undefined, { signal });
    signal?.throwIfAborted();
  }

  private async request(url: string, options: { headers: Record<string, string>; body?: string | URLSearchParams }, signal?: AbortSignal) {
    const dispatcher = this.getDispatcher();
    const timeout = AbortSignal.timeout(20000);
    try {
      return await fetch(url, {
        ...options, dispatcher, method: options.body === undefined ? 'GET' : 'POST', redirect: 'error',
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
