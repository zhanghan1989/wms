export type AmazonSpApiRegion = 'NA' | 'EU' | 'FE';
export type AmazonFulfilledBy = 'MERCHANT' | 'AMAZON';

export interface AmazonMoney {
  amount?: string;
  currencyCode?: string;
}

export interface AmazonOrderItemPayload {
  orderItemId: string;
  quantityOrdered?: number;
  product?: {
    asin?: string;
    title?: string;
    sellerSku?: string;
    price?: {
      unitPrice?: AmazonMoney;
      listingPrice?: AmazonMoney;
      priceDesignation?: string;
    };
    customization?: {
      customizedUrl?: string;
    };
  };
  proceeds?: {
    proceedsTotal?: AmazonMoney;
    breakdowns?: Array<{ type?: string; subtotal?: AmazonMoney }>;
  };
  fulfillment?: {
    quantityFulfilled?: number;
    quantityUnfulfilled?: number;
  };
  cancellation?: {
    cancellationRequest?: {
      requester?: string;
      cancelReason?: string;
    };
  };
}

export interface AmazonOrderPayload {
  orderId: string;
  createdTime?: string;
  lastUpdatedTime?: string;
  programs?: string[];
  salesChannel?: {
    marketplaceId?: string;
    marketplaceName?: string;
    channelName?: string;
  };
  buyer?: {
    buyerName?: string;
    buyerEmail?: string;
    buyerPurchaseOrderNumber?: string;
  };
  recipient?: {
    deliveryAddress?: {
      name?: string;
      companyName?: string;
      addressLine1?: string;
      addressLine2?: string;
      addressLine3?: string;
      city?: string;
      stateOrRegion?: string;
      postalCode?: string;
      countryCode?: string;
      phone?: string;
    };
  };
  fulfillment?: {
    fulfillmentStatus?: string;
    fulfilledBy?: AmazonFulfilledBy;
    fulfillmentServiceLevel?: string;
  };
  orderItems?: AmazonOrderItemPayload[];
  packages?: Array<{
    carrier?: string;
    trackingNumber?: string;
  }>;
}

export interface AmazonSearchOrdersResponse {
  orders?: AmazonOrderPayload[];
  pagination?: { nextToken?: string };
}

export interface AmazonInventorySummaryPayload {
  asin?: string;
  fnSku?: string;
  sellerSku?: string;
  condition?: string;
  inventoryDetails?: {
    fulfillableQuantity?: number;
    inboundWorkingQuantity?: number;
    inboundShippedQuantity?: number;
    inboundReceivingQuantity?: number;
    reservedQuantity?: {
      totalReservedQuantity?: number;
    };
    unfulfillableQuantity?: {
      totalUnfulfillableQuantity?: number;
    };
  };
  totalQuantity?: number;
  productName?: string;
}

export interface AmazonInventoryResponse {
  payload?: {
    inventorySummaries?: AmazonInventorySummaryPayload[];
    pagination?: { nextToken?: string };
  };
  pagination?: { nextToken?: string };
}
