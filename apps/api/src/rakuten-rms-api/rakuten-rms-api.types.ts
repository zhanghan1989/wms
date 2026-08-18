export type RakutenJsonObject = Record<string, unknown>;

export interface RakutenSearchOrderResponse extends RakutenJsonObject {
  orderNumberList?: string[];
  PaginationResponseModel?: {
    totalRecordsAmount?: number;
    totalPages?: number;
    requestPage?: number;
  };
  MessageModelList?: RakutenMessage[];
}

export interface RakutenGetOrderResponse extends RakutenJsonObject {
  OrderModelList?: RakutenJsonObject[];
  MessageModelList?: RakutenMessage[];
}

export interface RakutenMessage extends RakutenJsonObject {
  messageType?: string | number;
  messageCode?: string;
  message?: string;
}

export interface RakutenOrderSearchOptions {
  start: Date;
  end: Date;
  orderProgressList?: number[];
}
