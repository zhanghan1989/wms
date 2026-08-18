import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  RakutenGetOrderResponse,
  RakutenJsonObject,
  RakutenMessage,
  RakutenOrderSearchOptions,
  RakutenSearchOrderResponse,
} from './rakuten-rms-api.types';

const RAKUTEN_API_BASE_URL = 'https://api.rms.rakuten.co.jp/es/2.0/order';
const SEARCH_PAGE_SIZE = 1000;
const GET_ORDER_BATCH_SIZE = 100;
const MAX_SEARCH_RANGE_MS = 62 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

@Injectable()
export class RakutenRmsApiClient {
  private readonly logger = new Logger(RakutenRmsApiClient.name);

  async probeOrders(
    serviceSecret: string,
    licenseKey: string,
    options: RakutenOrderSearchOptions,
  ): Promise<{ matchedOrderCount: number; sampleOrderNumber: string | null }> {
    const payload = await this.request<RakutenSearchOrderResponse>(serviceSecret, licenseKey, 'searchOrder', {
      dateType: 1,
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
            dateType: 1,
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
        orderNumbers.push(...(Array.isArray(payload.orderNumberList) ? payload.orderNumberList : []));
        totalPages = Math.max(1, Number(payload.PaginationResponseModel?.totalPages ?? 1));
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

  private async request<T extends RakutenJsonObject>(
    serviceSecret: string,
    licenseKey: string,
    operation: 'searchOrder' | 'getOrder',
    body: RakutenJsonObject,
  ): Promise<T> {
    const authorization = Buffer.from(`${serviceSecret}:${licenseKey}`, 'utf8').toString('base64');
    const url = `${RAKUTEN_API_BASE_URL}/${operation}/`;
    let lastResponse: Response | null = null;
    let lastNetworkError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `ESA ${authorization}`,
            'content-type': 'application/json; charset=utf-8',
            'user-agent': '001-wms-rakuten-sync/1.0',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        lastNetworkError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 250));
          continue;
        }
        break;
      }
      lastResponse = response;
      if (response.status !== 429 && response.status < 500) {
        return this.readResponse<T>(response);
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
      payload = text ? JSON.parse(text) : {};
    } catch {
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
