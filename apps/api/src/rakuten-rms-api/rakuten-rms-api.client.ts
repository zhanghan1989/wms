import { BadRequestException, Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Dispatcher, ProxyAgent } from 'undici';
import {
  RakutenGetOrderResponse,
  RakutenJsonObject,
  RakutenMessage,
  RakutenOrderSearchOptions,
  RakutenSearchOrderResponse,
} from './rakuten-rms-api.types';

import { InventoryKey, InventoryRecord, InventoryWrite, RakutenCatalogPage, RakutenCatalogVariant, RAKUTEN_CATALOG_PAGE_SIZE } from './rakuten-inventory.types';

const RAKUTEN_API_BASE_URL = 'https://api.rms.rakuten.co.jp/es/2.0/order';
const SEARCH_PAGE_SIZE = 1000;
const GET_ORDER_BATCH_SIZE = 100;
const MAX_SEARCH_RANGE_MS = 62 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

@Injectable()
export class RakutenRmsApiClient implements OnModuleDestroy {
  private readonly logger = new Logger(RakutenRmsApiClient.name);
  private proxyDispatcher: ProxyAgent | null | undefined;

  async onModuleDestroy(): Promise<void> {
    await this.proxyDispatcher?.close();
  }

  async probeOrders(
    serviceSecret: string,
    licenseKey: string,
    options: RakutenOrderSearchOptions,
  ): Promise<{ matchedOrderCount: number; sampleOrderNumber: string | null }> {
    const payload = await this.request<RakutenSearchOrderResponse>(serviceSecret, licenseKey, 'searchOrder', {
      dateType: options.dateType ?? 1,
      startDatetime: this.formatRakutenDate(options.start),
      endDatetime: this.formatRakutenDate(options.end),
      ...(options.orderProgressList?.length ? { orderProgressList: options.orderProgressList } : {}),
      PaginationRequestModel: {
        requestRecordsAmount: 1,
        requestPage: 1,
        SortModelList: [{ sortColumn: 1, sortDirection: 1 }],
      },
    });
    this.assertNoApiErrors(payload.MessageModelList);
    const orderNumbers = Array.isArray(payload.orderNumberList)
      ? payload.orderNumberList.map((value) => String(value ?? '').trim()).filter(Boolean)
      : [];
    return {
      matchedOrderCount: Math.max(
        orderNumbers.length,
        Number(payload.PaginationResponseModel?.totalRecordsAmount ?? orderNumbers.length) || 0,
      ),
      sampleOrderNumber: orderNumbers[0] ?? null,
    };
  }

  async searchOrders(
    serviceSecret: string,
    licenseKey: string,
    options: RakutenOrderSearchOptions,
  ): Promise<string[]> {
    const orderNumbers: string[] = [];
    let rangeStart = new Date(options.start);
    while (rangeStart.getTime() <= options.end.getTime()) {
      const rangeEnd = new Date(Math.min(options.end.getTime(), rangeStart.getTime() + MAX_SEARCH_RANGE_MS));
      let page = 1;
      let totalPages = 1;
      do {
        const payload = await this.request<RakutenSearchOrderResponse>(
          serviceSecret,
          licenseKey,
          'searchOrder',
          {
            dateType: options.dateType ?? 1,
            startDatetime: this.formatRakutenDate(rangeStart),
            endDatetime: this.formatRakutenDate(rangeEnd),
            ...(options.orderProgressList?.length ? { orderProgressList: options.orderProgressList } : {}),
            PaginationRequestModel: {
              requestRecordsAmount: SEARCH_PAGE_SIZE,
              requestPage: page,
              SortModelList: [{ sortColumn: 1, sortDirection: 1 }],
            },
          },
        );
        this.assertNoApiErrors(payload.MessageModelList);
        const pages = Number(payload.PaginationResponseModel?.totalPages);
        if (!Array.isArray(payload.orderNumberList) || !Number.isInteger(pages) || pages < 0 || pages > 10000) {
          throw new ServiceUnavailableException('乐天 RMS 订单搜索结果格式不完整，未更新同步范围');
        }
        orderNumbers.push(...payload.orderNumberList);
        totalPages = Math.max(1, pages);
        page += 1;
      } while (page <= totalPages);
      if (rangeEnd.getTime() >= options.end.getTime()) break;
      rangeStart = new Date(rangeEnd.getTime() + 1000);
    }
    return Array.from(new Set(orderNumbers.map((value) => String(value ?? '').trim()).filter(Boolean)));
  }

  async getOrders(serviceSecret: string, licenseKey: string, orderNumbers: string[]): Promise<RakutenJsonObject[]> {
    const orders: RakutenJsonObject[] = [];
    for (let index = 0; index < orderNumbers.length; index += GET_ORDER_BATCH_SIZE) {
      const batch = orderNumbers.slice(index, index + GET_ORDER_BATCH_SIZE);
      const payload = await this.request<RakutenGetOrderResponse>(
        serviceSecret,
        licenseKey,
        'getOrder',
        { orderNumberList: batch, version: 7 },
      );
      this.assertNoApiErrors(payload.MessageModelList);
      orders.push(...(Array.isArray(payload.OrderModelList) ? payload.OrderModelList : []));
    }
    return orders;
  }

  async updateOrderShipping(
    serviceSecret: string,
    licenseKey: string,
    orderNumber: string,
    BasketidModelList: unknown[],
  ): Promise<RakutenJsonObject> {
    const payload = await this.request<RakutenJsonObject>(
      serviceSecret,
      licenseKey,
      'updateOrderShipping',
      { orderNumber, BasketidModelList },
    );
    this.assertNoApiErrors(Array.isArray(payload.MessageModelList) ? payload.MessageModelList as RakutenMessage[] : []);
    return payload;
  }

  private async request<T extends RakutenJsonObject>(
    serviceSecret: string,
    licenseKey: string,
    operation: 'searchOrder' | 'getOrder' | 'updateOrderShipping',
    body: RakutenJsonObject,
  ): Promise<T> {
    const authorization = Buffer.from(`${serviceSecret}:${licenseKey}`, 'utf8').toString('base64');
    const url = `${RAKUTEN_API_BASE_URL}/${operation}/`;
    const dispatcher = this.getProxyDispatcher();
    const maxAttempts = operation === 'updateOrderShipping' ? 1 : 3;
    let lastResponse: Response | null = null;
    let lastNetworkError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response: Response;
      try {
        const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `ESA ${authorization}`,
            'content-type': 'application/json; charset=utf-8',
            'user-agent': '001-wms-rakuten-sync/1.0',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(operation === 'updateOrderShipping' ? REQUEST_TIMEOUT_MS : 60_000),
          ...(dispatcher ? { dispatcher } : {}),
        };
        response = await fetch(url, requestInit);
      } catch (error) {
        lastNetworkError = error;
        if (attempt + 1 < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 250));
          continue;
        }
        break;
      }
      lastResponse = response;
      if (response.status !== 429 && response.status < 500) {
        try {
          return await this.readResponse<T>(response);
        } catch (error) {
          // A response body can time out after fetch has returned its headers.
          // Only read operations may be replayed; shipment writes remain single-attempt.
          if (!response.ok || attempt + 1 >= maxAttempts) throw error;
          lastResponse = null;
          lastNetworkError = error;
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 250));
          continue;
        }
      }
      const retryAfter = Math.min(Number(response.headers.get('retry-after') ?? attempt + 1) || attempt + 1, 5);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    }
    if (!lastResponse) {
      const details = this.networkErrorMessage(lastNetworkError);
      this.logger.error(`Rakuten RMS ${operation} network request failed after 3 attempts: ${details}`);
      throw new ServiceUnavailableException(`无法连接乐天 RMS API（网络或TLS错误）：${details}`);
    }
    return this.readResponse<T>(lastResponse as Response);
  }

  private inventoryLastRequestAt = 0;
  private inventoryThrottle: Promise<void> = Promise.resolve();

  private reserveInventoryRequest(interval: number): Promise<void> {
    const next = this.inventoryThrottle.then(async () => {
      const wait = Math.max(0, interval - (Date.now() - this.inventoryLastRequestAt));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      this.inventoryLastRequestAt = Date.now();
    });
    this.inventoryThrottle = next.catch(() => undefined);
    return next;
  }

  async getInventory(serviceSecret: string, licenseKey: string, inventories: InventoryKey[]): Promise<InventoryRecord[]> {
    if (!inventories.length || inventories.length > 1000) throw new ServiceUnavailableException('库存读取批量必须为1～1000条');
    const payload = await this.inventoryRequest(serviceSecret, licenseKey, '/es/2.1/inventories/bulk-get', { inventories: inventories.map(({ manageNumber, variantId }) => ({ manageNumber, variantId })) });
    if (!payload || !Array.isArray(payload.inventories)) throw new ServiceUnavailableException('乐天库存读取返回格式异常');
    return payload.inventories.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object') throw new ServiceUnavailableException('乐天库存记录格式异常');
      const row = raw as Record<string, unknown>;
      if (typeof row.manageNumber !== 'string' || typeof row.variantId !== 'string' || !Number.isInteger(row.quantity)) {
        throw new ServiceUnavailableException('乐天库存记录缺少编号或数量');
      }
      const record: InventoryRecord = { manageNumber: row.manageNumber, variantId: row.variantId, quantity: row.quantity as number };
      if (row.operationLeadTime != null) {
        if (typeof row.operationLeadTime !== 'object' || Array.isArray(row.operationLeadTime)) throw new ServiceUnavailableException('乐天出荷设置格式异常');
        record.operationLeadTime = {};
        for (const key of ['normalDeliveryTimeId', 'backOrderDeliveryTimeId'] as const) {
          const value = (row.operationLeadTime as Record<string, unknown>)[key];
          if (value == null) continue;
          if (!Number.isInteger(value) || Number(value) < 0) throw new ServiceUnavailableException('乐天出荷设置ID异常');
          record.operationLeadTime[key] = Number(value);
        }
      }
      if (row.shipFromIds != null) {
        if (!Array.isArray(row.shipFromIds) || row.shipFromIds.some((id) => !Number.isInteger(id) || id < 0)) throw new ServiceUnavailableException('乐天配送设置ID异常');
        record.shipFromIds = row.shipFromIds as number[];
      }
      return record;
    });
  }

  async upsertInventory(serviceSecret: string, licenseKey: string, inventories: InventoryWrite[]): Promise<void> {
    if (!inventories.length || inventories.length > 400 || inventories.some((row) => row.mode !== 'ABSOLUTE' || !Number.isInteger(row.quantity) || row.quantity < 0 || row.quantity > 99999)) {
      throw new ServiceUnavailableException('库存更新数量或批量不合法');
    }
    await this.inventoryRequest(serviceSecret, licenseKey, '/es/2.1/inventories/bulk-upsert', { inventories }, true);
  }

  async getItemVariantIds(serviceSecret: string, licenseKey: string, manageNumber: string): Promise<string[]> {
    const payload = await this.inventoryRequest(serviceSecret, licenseKey, `/es/2.0/items/manage-numbers/${encodeURIComponent(manageNumber)}`);
    if (!payload || typeof payload.variants !== 'object' || payload.variants === null || Array.isArray(payload.variants)) {
      throw new ServiceUnavailableException('商品查询未返回有效SKU，请确认已授权 items.get 并开通商品API');
    }
    return Object.keys(payload.variants);
  }

  async searchCatalogPage(serviceSecret: string, licenseKey: string, cursorMark: string): Promise<RakutenCatalogPage> {
    const query = new URLSearchParams({ cursorMark, hits: String(RAKUTEN_CATALOG_PAGE_SIZE), isHiddenItem: 'false', isHiddenVariant: 'false', isInventoryIncluded: 'false' });
    // No stockout filter: zero-stock SKUs must remain eligible for restocking.
    const payload = await this.inventoryRequest(serviceSecret, licenseKey, `/es/2.0/items/search?${query}`);
    if (!payload || !Number.isInteger(payload.numFound) || payload.numFound < 0 || !Array.isArray(payload.results)
      || payload.results.length > RAKUTEN_CATALOG_PAGE_SIZE || typeof payload.nextCursorMark !== 'string' || !payload.nextCursorMark) {
      throw new ServiceUnavailableException('乐天商品清单返回格式或游标异常，未更新同步范围');
    }
    return { numFound: payload.numFound, nextCursorMark: payload.nextCursorMark,
      variants: this.catalogVariants(payload.results.map((result: { item?: unknown }) => result?.item)), itemCount: payload.results.length };
  }

  /** Official items.bulk.get: 50 products per request, one request per second. */
  async getItemsVariantIds(serviceSecret: string, licenseKey: string, manageNumbers: string[], allowMissing = false): Promise<Map<string, string[]>> {
    if (!manageNumbers.length || manageNumbers.length > 50 || new Set(manageNumbers).size !== manageNumbers.length
      || manageNumbers.some((value) => !/^[a-z0-9_-]{1,32}$/.test(value))) throw new BadRequestException('批量商品查询需指定1至50个不重复的商品管理番号');
    const payload = await this.inventoryRequest(serviceSecret, licenseKey, '/es/2.0/items/bulk-get', { manageNumbers });
    if (!payload || !Array.isArray(payload.results) || (allowMissing ? payload.results.length > manageNumbers.length : payload.results.length !== manageNumbers.length)) {
      throw new ServiceUnavailableException('批量商品查询结果不完整，请确认已授权 items.bulk.get；已停止同步');
    }
    const found = new Set<string>();
    for (const item of payload.results) {
      if (!item || !manageNumbers.includes(item.manageNumber) || found.has(item.manageNumber)) throw new ServiceUnavailableException('批量商品查询返回未知或重复商品，已停止同步');
      found.add(item.manageNumber);
    }
    const result = new Map(manageNumbers.map((value) => [value, [] as string[]]));
    const now = Date.now();
    for (const variant of this.catalogVariants(payload.results)) {
      if (!variant.hidden && !variant.unlimitedStock && (!variant.salesStart || Date.parse(variant.salesStart) <= now)
        && (!variant.salesEnd || Date.parse(variant.salesEnd) >= now)) result.get(variant.manageNumber)!.push(variant.variantId);
    }
    return result;
  }

  private catalogVariants(items: unknown[]): RakutenCatalogVariant[] {
    const variants: RakutenCatalogVariant[] = [];
    for (const rawItem of items) {
      const item = rawItem as Record<string, any> | null;
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.manageNumber !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(item.manageNumber)) {
        throw new ServiceUnavailableException('乐天商品清单缺少有效商品管理番号，未更新同步范围');
      }
      // The official search API returns only manageNumber for deleted products.
      if (Object.keys(item).length === 1) continue;
      if (typeof item.title !== 'string' || typeof item.hideItem !== 'boolean' || typeof item.unlimitedInventoryFlag !== 'boolean'
        || !item.variants || typeof item.variants !== 'object' || Array.isArray(item.variants) || !Object.keys(item.variants).length) {
        throw new ServiceUnavailableException('乐天商品状态或SKU列表不完整，未更新同步范围');
      }
      const dates = [item.purchasablePeriod?.start ?? null, item.purchasablePeriod?.end ?? null];
      if (dates.some((value) => value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value))))) {
        throw new ServiceUnavailableException('乐天商品销售时间格式异常，未更新同步范围');
      }
      for (const [variantId, raw] of Object.entries(item.variants)) {
        const variant = raw as Record<string, unknown> | null;
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(variantId) || !variant || typeof variant !== 'object' || Array.isArray(variant)
          || (variant.hidden != null && typeof variant.hidden !== 'boolean')
          || (variant.merchantDefinedSkuId != null && typeof variant.merchantDefinedSkuId !== 'string')) {
          throw new ServiceUnavailableException('乐天SKU管理番号或状态格式异常，未更新同步范围');
        }
        variants.push({ manageNumber: item.manageNumber.toLowerCase(), variantId,
          merchantDefinedSkuId: typeof variant.merchantDefinedSkuId === 'string' ? variant.merchantDefinedSkuId.trim() || null : null,
          title: item.title, hidden: item.hideItem || variant.hidden === true,
          unlimitedStock: item.unlimitedInventoryFlag, salesStart: dates[0], salesEnd: dates[1] });
      }
    }
    return variants;
  }

  private async inventoryRequest(
    serviceSecret: string, licenseKey: string, path: string,
    body?: unknown, write = false,
  ): Promise<Record<string, any> | undefined> {
    // Writes are never automatically replayed after an ambiguous timeout.
    const attempts = write ? 1 : 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // ItemAPI items.get permits 5 requests/sec; Inventory writes permit 1/sec.
      // One serialized caller holds the cross-process inventory lease.
      const interval = (path.startsWith('/es/2.0/items/manage-numbers/') || path.startsWith('/es/2.0/items/search?') || path === '/es/2.1/inventories/bulk-get') ? 250 : 1100;
      await this.reserveInventoryRequest(interval);
      const requestStartedAt = Date.now();
      let response: Response;
      try {
        const dispatcher = this.getProxyDispatcher();
        const options: RequestInit & { dispatcher?: Dispatcher } = {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `ESA ${Buffer.from(`${serviceSecret}:${licenseKey}`).toString('base64')}`, 'content-type': 'application/json', accept: 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          // Catalog pages include full product data and can exceed 10 MB.
          // The timeout covers both headers and the complete response body.
          signal: AbortSignal.timeout(!write && path.startsWith('/es/2.0/items/search?') ? 60_000 : 20_000), ...(dispatcher ? { dispatcher } : {}),
        };
        response = await fetch(`https://api.rms.rakuten.co.jp${path}`, options);
      } catch {
        this.logger.warn(`Inventory API path=${path.split('?')[0]} attempt=${attempt + 1}/${attempts} networkFailure elapsedMs=${Date.now() - requestStartedAt}`);
        if (attempt + 1 < attempts) continue;
        throw new ServiceUnavailableException(write ? '乐天库存写入结果未知（网络超时），请重新预览并回读确认，未自动重试' : '无法连接乐天库存API');
      }
      this.logger.log(`Inventory API path=${path.split('?')[0]} attempt=${attempt + 1}/${attempts} status=${response.status} headersMs=${Date.now() - requestStartedAt}`);
      if (!write && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
        // A truncated error body must not bypass the bounded status retry.
        try { await response.text(); } catch { /* Classification is already known from HTTP status. */ }
        await new Promise((resolve) => setTimeout(resolve, Math.min(30, Math.max(1, Number(response.headers.get('retry-after')) || attempt + 1)) * 1000));
        continue;
      }
      if (write && response.status === 204) return;
      let payload: Record<string, any>;
      const bodyStartedAt = Date.now();
      const memoryBefore = process.memoryUsage();
      let responseText = '';
      let bodyRead = false;
      try {
        responseText = await response.text();
        bodyRead = true;
        payload = JSON.parse(responseText);
        const memoryAfter = process.memoryUsage();
        this.logger.log(`Inventory response path=${path.split('?')[0]} rssBytes=${memoryAfter.rss} heapBytes=${memoryAfter.heapUsed} heapDeltaBytes=${memoryAfter.heapUsed - memoryBefore.heapUsed} externalBytes=${memoryAfter.external}`);
        this.logger.log(`Inventory API path=${path.split('?')[0]} attempt=${attempt + 1}/${attempts} bodyBytes=${Buffer.byteLength(responseText, 'utf8')} bodyMs=${Date.now() - bodyStartedAt} elapsedMs=${Date.now() - requestStartedAt}`);
      } catch (error) {
        // Log classifications only: remote bodies and headers may contain secrets.
        const kind = !bodyRead ? 'body-read-failed' : !responseText.trim() ? 'empty' : /^\s*</.test(responseText) ? 'markup' : 'invalid-json';
        const timeout = !bodyRead && typeof error === 'object' && error !== null && 'name' in error && ['TimeoutError', 'AbortError'].includes(String(error.name));
        this.logger.warn(`Inventory API path=${path.split('?')[0]} attempt=${attempt + 1}/${attempts} status=${response.status} bodyKind=${kind} bodyChars=${responseText.length} timeout=${timeout} elapsedMs=${Date.now() - requestStartedAt}`);
        if (!write && response.ok && attempt + 1 < attempts) continue;
        const detail = !bodyRead ? timeout ? '响应正文读取超时或中断' : '响应正文读取失败' : kind === 'empty' ? '响应正文为空' : kind === 'markup' ? '响应为HTML/XML，非JSON' : '响应正文不是有效JSON';
        throw new ServiceUnavailableException(`乐天库存API返回格式异常（HTTP ${response.status}，${detail}）${write ? '；写入结果未知，请重新预览并回读确认，未自动重试' : ''}`);
      }
      if (!response.ok || !payload || payload.errors?.length) {
        // Do not persist arbitrary remote response text, which could contain credentials.
        const codes = Array.isArray(payload?.errors) ? payload.errors.map((e: { code?: unknown }) => String(e.code ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)).join(',') : '';
        throw new ServiceUnavailableException(`乐天库存API失败（HTTP ${response.status}${codes ? `，${codes}` : ''}），请检查权限、编号及参数`);
      }
      if (write) throw new ServiceUnavailableException('乐天库存写入返回非预期状态，请回读核对');
      return payload;
    }
    throw new ServiceUnavailableException('乐天库存API读取失败');
  }

  private getProxyDispatcher(): ProxyAgent | undefined {
    if (this.proxyDispatcher !== undefined) return this.proxyDispatcher ?? undefined;

    const rawProxyUrl = String(process.env.RAKUTEN_RMS_API_PROXY_URL ?? '').trim();
    if (!rawProxyUrl) {
      this.proxyDispatcher = null;
      return undefined;
    }

    let proxyUrl: URL;
    try {
      proxyUrl = new URL(rawProxyUrl);
    } catch {
      throw new ServiceUnavailableException('RAKUTEN_RMS_API_PROXY_URL 格式无效');
    }
    if (!['http:', 'https:'].includes(proxyUrl.protocol)) {
      throw new ServiceUnavailableException('RAKUTEN_RMS_API_PROXY_URL 仅支持 http:// 或 https://');
    }

    this.proxyDispatcher = new ProxyAgent(rawProxyUrl);
    this.logger.log('Rakuten RMS requests will use the configured private proxy');
    return this.proxyDispatcher;
  }

  private networkErrorMessage(error: unknown): string {
    const details: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 3 && current !== null && current !== undefined; depth += 1) {
      if (typeof current === 'string') {
        details.push(current);
        break;
      }
      if (typeof current !== 'object') {
        details.push(String(current));
        break;
      }
      const record = current as { cause?: unknown; code?: unknown; message?: unknown; name?: unknown };
      for (const value of [record.name, record.code, record.message]) {
        if (typeof value === 'string' && value.trim() && !details.includes(value.trim())) {
          details.push(value.trim());
        }
      }
      current = record.cause;
    }
    return details.join(': ').replace(/[\r\n]+/g, ' ').slice(0, 300) || '未知网络错误';
  }

  private async readResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = JSON.parse(text);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid object');
    } catch {
      if (response.ok) throw new ServiceUnavailableException('乐天 RMS API 响应不是有效JSON对象，未更新同步范围');
      payload = { message: text.slice(0, 500) };
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `乐天 RMS API 请求失败（HTTP ${response.status}）：${this.extractError(payload)}`,
      );
    }
    return payload as T;
  }

  private assertNoApiErrors(messages: RakutenMessage[] | undefined): void {
    const errors = (Array.isArray(messages) ? messages : []).filter((message) => {
      const type = String(message?.messageType ?? '').toLowerCase();
      return type === 'error' || type === 'e' || Number(message?.messageType) === 2;
    });
    if (errors.length) {
      throw new ServiceUnavailableException(
        `乐天 RMS API 返回错误：${errors.map((row) => row.message || row.messageCode || '未知错误').join('；')}`,
      );
    }
  }

  private extractError(payload: unknown): string {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '未知错误';
    const record = payload as RakutenJsonObject;
    const results = record.Results;
    if (results && typeof results === 'object' && !Array.isArray(results)) {
      const result = results as RakutenJsonObject;
      return String(result.message ?? result.errorCode ?? '未知错误');
    }
    return String(record.message ?? '未知错误');
  }

  private formatRakutenDate(value: Date): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+0900`;
  }
}
