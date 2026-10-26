import { rakutenOrderRemarkNeedsConfirmation } from '../common/rakuten-order-remark';
import { originalRakutenOrderId, rakutenOrderIdentityWhere } from '../common/rakuten-order-identity';
import { basketIdOf, productIdWasManuallyEdited } from '../rakuten-rms-api/rakuten-order-workflow';
import { stockTransaction, lockStockProducts } from '../inventory/stock-transaction';
import { availableStock } from '../inventory/stock-availability';
import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import {
  AmazonOrderRecord,
  OrderSendStatus,
  PrintJobStatus,
  Prisma,
  RakutenOrderRecord,
  RakutenAutomationStatus,
  YamatoShipmentBatch,
  YamatoShipmentBatchPage,
} from '@prisma/client';
import * as iconv from 'iconv-lite';
import * as JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { join, resolve } from 'path';
import { promisify } from 'util';
import * as XLSX from 'xlsx';
import { rakutenDeliveryCompanyCode } from '../common/rakuten-delivery-company';
import { APP_TIMEZONE, getZonedDateParts, parseId } from '../common/utils';
import { calculateProductStockAvailability } from '../master-products/master-product-bom-stock';
import { PrismaService } from '../prisma/prisma.service';

const execFileAsync = promisify(execFile);

// SP-API FBM rows are analytics-only because the Orders API does not provide the
// recipient details required by the fulfilment workflow. Keep this boundary in
// the order-processing service; the Amazon dashboard reads those rows directly.
const PROCESSABLE_AMAZON_ORDER_WHERE = {
  sourceKind: { not: 'sp_api' },
} satisfies Prisma.AmazonOrderRecordWhereInput;

const ORDER_CSV_COLUMNS = [
  { header: '注文ID', key: 'orderId' },
  { header: '商品明細ステータス', key: 'itemDetailStatus' },
  { header: 'SKUコード', key: 'skuCode' },
  { header: 'セット構成品SKUコード', key: 'setComponentSkuCode' },
  { header: '注文個数', key: 'orderQuantityRaw' },
  { header: '商品名', key: 'productName' },
  { header: 'モール名', key: 'mallName' },
  { header: 'ショップ名', key: 'shopName' },
  { header: 'モール注文番号', key: 'mallOrderNo' },
  { header: '注文ステータス', key: 'orderStatusText' },
  { header: '注文取込日時', key: 'orderImportedAtRaw' },
  { header: '注文備考', key: 'orderRemark' },
  { header: '送付先氏名', key: 'shippingName' },
  { header: '送付先郵便番号', key: 'shippingPostalCode' },
  { header: '送付先都道府県', key: 'shippingPrefecture' },
  { header: '送付先市区町村', key: 'shippingCity' },
  { header: '送付先町名・番地以降', key: 'shippingAddress' },
  { header: '送付先電話番号', key: 'shippingPhone' },
  { header: '配送方法', key: 'deliveryMethod' },
  { header: 'お届け指定日', key: 'deliveryDateRaw' },
  { header: 'お届け指定時間帯', key: 'deliveryTimeSlot' },
  { header: '出荷依頼番号', key: 'shipmentRequestNo' },
  { header: '商品名１', key: 'productNameExtra' },
] as const;

// Retain these source keys for delivery preferences on historical orders.
const RAKUTEN_ORDER_HEADERS = {
  deliveryTimeSlot: 'お届け時間帯',
  deliveryDateRaw: 'お届け日指定',
} as const;

void ORDER_CSV_COLUMNS;

type OrderFulfillmentMode = 'overseas_warehouse' | 'xiya_api';

interface OrderListItem extends RakutenOrderRecord {
  resolvedProductId: string | null;
  resolvedProductName: string | null;
  availableStock: number;
  assemblableStock: number;
  assemblableStockApplicable: boolean;
  fulfillmentMode: OrderFulfillmentMode;
  trackingClearanceStatus?: RakutenTrackingClearanceStatus;
}

interface RakutenTrackingClearanceStatus {
  trackingNo: string | null;
  label: string;
  hasCustomsClearance: boolean;
  isDelivered: boolean;
  occurredAt: string | null;
  customsClearanceDate?: string | null;
  checkedAt: string | null;
  error?: string | null;
}

interface UpdateRakutenOrderPayload {
  orderId?: string | null;
  skuCode?: string | null;
  orderQuantity?: string | number | null;
  productName?: string | null;
  mallName?: string | null;
  shopName?: string | null;
  productId?: string | null;
  shippingName?: string | null;
  shippingPostalCode?: string | null;
  shippingPrefecture?: string | null;
  shippingCity?: string | null;
  shippingAddress?: string | null;
  shippingPhone?: string | null;
  shipmentCompany?: string | null;
  shipmentNo?: string | null;
  shipmentEditMode?: 'correction' | 'replacement';
  expectedShipmentNo?: string;
  expectedShipmentCompany?: string;
  expectedWarehouseShippedAt?: string;
  deliveryDateRaw?: string | null;
  deliveryTimeSlot?: string | null;
  orderRemark?: string | null;
}

const AMAZON_ORDER_TXT_COLUMNS = [
  { header: 'order-id', key: 'orderId' },
  { header: 'order-item-id', key: 'orderItemId' },
  { header: 'purchase-date', key: 'purchaseDateRaw' },
  { header: 'payments-date', key: 'paymentsDateRaw' },
  { header: 'reporting-date', key: 'reportingDateRaw' },
  { header: 'promise-date', key: 'promiseDateRaw' },
  { header: 'days-past-promise', key: 'daysPastPromiseRaw' },
  { header: 'buyer-email', key: 'buyerEmail' },
  { header: 'buyer-name', key: 'buyerName' },
  { header: 'buyer-phone-number', key: 'buyerPhoneNumber' },
  { header: 'sku', key: 'sku' },
  { header: 'product-name', key: 'productName' },
  { header: 'quantity-purchased', key: 'quantityPurchasedRaw' },
  { header: 'quantity-shipped', key: 'quantityShippedRaw' },
  { header: 'quantity-to-ship', key: 'quantityToShipRaw' },
  { header: 'ship-service-level', key: 'shipServiceLevel' },
  { header: 'recipient-name', key: 'recipientName' },
  { header: 'ship-address-1', key: 'shipAddress1' },
  { header: 'ship-address-2', key: 'shipAddress2' },
  { header: 'ship-address-3', key: 'shipAddress3' },
  { header: 'ship-city', key: 'shipCity' },
  { header: 'ship-state', key: 'shipState' },
  { header: 'ship-postal-code', key: 'shipPostalCode' },
  { header: 'ship-country', key: 'shipCountry' },
  { header: 'customized-url', key: 'customizedUrl' },
  { header: 'customized-page', key: 'customizedPage' },
  { header: 'is-business-order', key: 'isBusinessOrderRaw' },
  { header: 'purchase-order-number', key: 'purchaseOrderNumber' },
  { header: 'price-designation', key: 'priceDesignation' },
  { header: 'verge-of-cancellation', key: 'vergeOfCancellationRaw' },
  { header: 'verge-of-lateShipment', key: 'vergeOfLateShipmentRaw' },
] as const;

const OPTIONAL_AMAZON_ORDER_TXT_HEADERS = new Set<string>([
  'customized-url',
  'customized-page',
  'is-business-order',
  'purchase-order-number',
  'price-designation',
]);

type AmazonOrderTxtColumn = (typeof AMAZON_ORDER_TXT_COLUMNS)[number];
type AmazonOrderTxtHeader = AmazonOrderTxtColumn['header'];

interface ParsedAmazonOrderRow {
  rowHash: string;
  orderId: string | null;
  orderItemId: string | null;
  purchaseDateRaw: string | null;
  paymentsDateRaw: string | null;
  reportingDateRaw: string | null;
  promiseDateRaw: string | null;
  daysPastPromise: number | null;
  buyerEmail: string | null;
  buyerName: string | null;
  buyerPhoneNumber: string | null;
  sku: string | null;
  productName: string | null;
  quantityPurchased: number | null;
  quantityShipped: number | null;
  quantityToShip: number | null;
  shipServiceLevel: string | null;
  recipientName: string | null;
  shipAddress1: string | null;
  shipAddress2: string | null;
  shipAddress3: string | null;
  shipCity: string | null;
  shipState: string | null;
  shipPostalCode: string | null;
  shipCountry: string | null;
  customizedUrl: string | null;
  customizedPage: string | null;
  isBusinessOrder: boolean | null;
  purchaseOrderNumber: string | null;
  priceDesignation: string | null;
  vergeOfCancellation: boolean | null;
  vergeOfLateShipment: boolean | null;
  mallName: string | null;
  shopName: string | null;
  shipmentCompany: string | null;
  shipmentNo: string | null;
  shipmentNoRegisteredAt: Date | null;
  rawPayload: Record<AmazonOrderTxtHeader, string | null>;
}

interface AmazonOrderImportResult {
  sourceFileName: string;
  sourceFilePath: string;
  csvImportedAt: string;
  totalRows: number;
  uniqueRows: number;
  createdCount: number;
  skippedCount: number;
  duplicateInFileCount: number;
  existingDuplicateCount: number;
}

interface AmazonShipmentConfirmationFileResult {
  fileName: string;
  content: Buffer;
  rowCount: number;
  fileCount?: number;
}

interface ManualOrderXyjgFields {
  bloggerCooperationId?: string | null;
  xyjgPushStatus?: string | null;
  xyjgPushMode?: string | null;
  xyjgPushTrackingNo?: string | null;
  xyjgPushedAt?: Date | null;
  xyjgPushError?: string | null;
  xyjgPushResponse?: Prisma.JsonValue | null;
}

interface AmazonOrderListItem extends AmazonOrderRecord {
  resolvedProductId: string | null;
  resolvedProductName: string | null;
  resolvedShopName: string | null;
  amazonObservedOrderStatus?: string | null;
  amazonObservedQuantityToShip?: number | null;
  amazonObservedAt?: Date | null;
  amazonFreezeReason?: string | null;
  amazonStateMismatch?: boolean;
}
type ManualOrderRecordLike = AmazonOrderRecord & ManualOrderXyjgFields;
type ManualOrderListItem = AmazonOrderListItem & ManualOrderXyjgFields;

type AmazonFulfillmentMode = 'overseas_warehouse' | 'xiya_api';

interface AmazonEnrichedOrderListItem extends AmazonOrderListItem {
  availableStock: number;
  assemblableStock: number;
  assemblableStockApplicable: boolean;
  fulfillmentMode: AmazonFulfillmentMode;
}
type ManualEnrichedOrderListItem = AmazonEnrichedOrderListItem & ManualOrderXyjgFields;

interface UpdateAmazonOrderPayload {
  orderId?: string | null;
  orderItemId?: string | null;
  sku?: string | null;
  quantityPurchased?: string | number | null;
  productName?: string | null;
  mallName?: string | null;
  shopName?: string | null;
  productId?: string | null;
  recipientName?: string | null;
  buyerPhoneNumber?: string | null;
  shipPostalCode?: string | null;
  shipState?: string | null;
  shipAddress1?: string | null;
  shipAddress2?: string | null;
  shipAddress3?: string | null;
  shipmentCompany?: string | null;
  shipmentNo?: string | null;
  bloggerCooperationId?: string | null;
  blogger_cooperation_id?: string | null;
}

interface CreateAmazonManualOrderPayload extends UpdateAmazonOrderPayload {}
interface BatchCreateAmazonManualOrdersPayload {
  items?: CreateAmazonManualOrderPayload[];
}

type ManualOrderCreateOrigin = 'system_single' | 'system_batch' | 'xiya_push';

interface ManualOrderFileImportResult {
  sourceFileName: string;
  importedAt: string;
  totalRows: number;
  requestedCount: number;
  createdCount: number;
  updatedCount: number;
  rows: AmazonManualOrderBatchCreateRowResult[];
}

interface DeleteAmazonManualOrdersForXiyaPayload {
  orderId?: string | null;
  orderIds?: Array<string | number | null>;
  bloggerCooperationId?: string | null;
  blogger_cooperation_id?: string | null;
}

type ThirdPartyExportSource = 'rakuten' | 'amazon' | 'manual';

type UnifiedOrderSearchSource = 'rakuten' | 'amazon' | 'manual';
type UnifiedOrderSearchMode = 'order' | 'customer';

interface UnifiedOrderSearchRow {
  source: UnifiedOrderSearchSource;
  sourceLabel: string;
  id: string;
  orderId: string | null;
  sku: string | null;
  productId: string | null;
  productName: string | null;
  quantity: number | null;
  mallName: string | null;
  shopName: string | null;
  recipientName: string | null;
  phone: string | null;
  fulfillmentMode: string | null;
  shipmentCompany: string | null;
  shipmentNo: string | null;
  shipmentNoRegisteredAt: string | null;
  csvImportedAt: string | null;
  createdAt: string | null;
}

interface UnifiedOrderSearchResult {
  query: string;
  mode: UnifiedOrderSearchMode;
  matches: UnifiedOrderSearchRow[];
  history: UnifiedOrderSearchRow[];
}

type UnifiedOrderSearchSuggestionType = 'orderId' | 'recipientName' | 'phone';

interface UnifiedOrderSearchSuggestion {
  type: UnifiedOrderSearchSuggestionType;
  value: string;
  label: string;
  sourceLabel: string;
}

interface ThirdPartyExportRowInput {
  source: ThirdPartyExportSource;
  sourceLabel: string;
  id: string;
  rowHash: string;
  resolvedProductId: string | null;
  resolvedProductName: string | null;
  availableStock: number;
  fulfillmentMode: string;
  dispatchMode: string | null;
  sourceFileName: string | null;
  sourceFilePath: string | null;
  csvImportedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  orderId: string | null;
  itemDetailStatus: string | null;
  skuCode: string | null;
  setComponentSkuCode: string | null;
  orderQuantity: number | null;
  productName: string | null;
  mallName: string | null;
  shopName: string | null;
  mallOrderNo: string | null;
  orderStatusText: string | null;
  orderImportedAtRaw: string | null;
  orderRemark: string | null;
  shippingName: string | null;
  shippingPostalCode: string | null;
  shippingPrefecture: string | null;
  shippingCity: string | null;
  shippingAddress: string | null;
  shippingPhone: string | null;
  shipmentCompany: string | null;
  shipmentNo: string | null;
  shipmentNoRegisteredAt: Date | null;
  deliveryMethod: string | null;
  deliveryDateRaw: string | null;
  deliveryTimeSlot: string | null;
  shipmentRequestNo: string | null;
  productNameExtra: string | null;
}

interface OverseasWarehouseOrderListItem {
  source: 'rakuten' | 'amazon' | 'manual';
  id?: string;
  sourceLabel: string;
  csvImportedAt: Date;
  createdAt: Date;
  orderId: string | null;
  skuCode: string | null;
  resolvedProductId: string | null;
  resolvedProductName?: string | null;
  orderQuantity: number | null;
  shopName: string | null;
  shippingName: string | null;
  availableStock: number;
  assemblableStock?: number;
  assemblableStockApplicable?: boolean;
  orderImportedAtRaw?: string | null;
  productName?: string | null;
  productNameExtra?: string | null;
  shippingPhone?: string | null;
  shippingPostalCode?: string | null;
  shippingPrefecture?: string | null;
  shippingCity?: string | null;
  shippingAddress?: string | null;
  deliveryDateRaw?: string | null;
  deliveryTimeSlot?: string | null;
  rawPayload?: Prisma.JsonValue | null;
  purchaseDateRaw?: string | null;
  buyerPhoneNumber?: string | null;
  shipPostalCode?: string | null;
  shipState?: string | null;
  shipAddress1?: string | null;
  shipAddress2?: string | null;
  shipAddress3?: string | null;
  dispatchMode?: string | null;
  chinaDispatchReason?: string | null;
  xiyaExportedAt?: string | null;
  xiyaStatus?: 'pending_tracking' | 'tracking_registered' | 'acknowledged';
  shipmentCompany?: string | null;
  shipmentNo?: string | null;
  shipmentNoRegisteredAt?: string | null;
}

interface OrderProcessingExportFile {
  fileName: string;
  content: Buffer;
}

interface SelectedOverseasWarehouseOrderRef {
  source?: 'rakuten' | 'amazon' | 'manual';
  id?: string | number;
}

interface ThirdPartyExportAckItem {
  source?: 'rakuten' | 'amazon' | 'manual';
  id?: string | number;
}

interface XiyaLogisticsRow {
  id?: string | number | null;
  logistics_order_id?: string | null;
  tracking_number?: string | null;
  sales_order_id?: string | null;
  store_name?: string | null;
  created_at?: string | null;
  logistics_status?: string | null;
  shipping_method?: string | null;
  shipping_method_name?: string | null;
  delivery_method_name?: string | null;
  logistics_method_name?: string | null;
  transport_method_name?: string | null;
  运输方式名称?: string | null;
}

interface XiyaTrackingCandidate {
  source: ThirdPartyExportSource;
  orderId: string;
  trackingNo: string;
  storeName: string;
  shipmentCompany: string;
  registeredAt: Date;
  rowCreatedAtMs: number;
}

interface AmazonManualOrderBatchCreateRowResult {
  id: string;
  orderId: string | null;
  orderItemId: string | null;
  sku: string | null;
  productId: string | null;
  productName: string | null;
  quantityPurchased: number | null;
  mallName: string | null;
  shopName: string | null;
  bloggerCooperationId: string | null;
  dispatchMode: string | null;
  shippingOrigin: string | null;
}

interface OverseasPickingBatchSummary {
  id: string;
  batchNo: string;
  status: string;
  completionGateRequired: boolean;
  orderCount: number;
  itemCount: number;
  totalQty: number;
  createdAt: string;
  confirmedAt: string | null;
  workCompletedAt: string | null;
  yamatoShipmentBatchId: string | null;
  yamatoShipmentBatchStatus: string | null;
  yamatoPrintedPageCount: number;
  yamatoPendingPageCount: number;
}

interface OverseasPickingBatchDetailItem {
  productId: string;
  productName: string | null;
  stockQty: number;
  requestedQty: number;
  actualQty: number;
  remainingQty: number;
  pickPlans: Array<{
    shelfCode: string | null;
    boxCode: string | null;
    boxQty: number;
    pickQty: number;
  }>;
}

interface OverseasPickingBatchDetailOrder {
  itemId: string;
  source: 'rakuten' | 'amazon' | 'manual';
  sourceLabel: string;
  sourceRecordId: string;
  csvImportedAt: string | null;
  createdAt: string | null;
  orderId: string | null;
  skuCode: string | null;
  productId: string;
  orderQuantity: number;
  actualQty: number;
  shopName: string | null;
  shippingName: string | null;
  shipmentCompany: string | null;
  shipmentTrackingNo: string | null;
  shipmentNoRegisteredAt: string | null;
  dispatchMode: string;
  chinaDispatchReason: string | null;
  yamatoPageNo: number | null;
  yamatoPrintedAt: string | null;
  orderStatusText: string;
  orderImportedAtRaw: string | null;
  purchaseDateRaw: string | null;
  productName: string | null;
  productNameExtra: string | null;
  shippingPhone: string | null;
  shippingPostalCode: string | null;
  shippingPrefecture: string | null;
  shippingCity: string | null;
  shippingAddress: string | null;
  deliveryDateRaw: string | null;
  deliveryTimeSlot: string | null;
  buyerPhoneNumber: string | null;
  shipPostalCode: string | null;
  shipState: string | null;
  shipAddress1: string | null;
  shipAddress2: string | null;
  shipAddress3: string | null;
  rawPayload: Prisma.JsonValue | null;
}

interface OverseasPickingBatchDetail extends OverseasPickingBatchSummary {
  remark: string | null;
  items: OverseasPickingBatchDetailItem[];
  orders: OverseasPickingBatchDetailOrder[];
}

interface OverseasPickingScopePickedItem {
  sourceLabel: string;
  productId: string;
  actualQty: number;
}

interface OverseasPickingBatchCreateResult {
  batches?: OverseasPickingBatchCreateResult[];
  orderCount?: number;
  id: string;
  batchNo: string;
  status: string;
  itemCount: number;
}

interface OverseasPickingBatchConfirmPayload {
  items?: Array<{ id?: string | number; actualQty?: string | number }>;
}

interface OverseasPickingBatchConfirmResult {
  id: string;
  batchNo: string;
  status: string;
  confirmedAt: string;
}

interface OverseasPickingBatchScanResult {
  id: string;
  productId: string;
  pickedQty: number;
  requestedQty: number;
  remainingQty: number;
}

interface OverseasPickingBatchItemSnapshot {
  source: 'rakuten' | 'amazon' | 'manual';
  sourceRecordId: bigint;
  orderId: string;
  skuCode: string;
  productId: string;
  requestedQty: number;
  availableStockSnapshot: number;
  shopName: string | null;
  shippingName: string | null;
  pickingPlanSnapshot?: OverseasPickingPlanSnapshotItem[];
  pickingRequirementSnapshot?: OverseasPickingRequirementSnapshotItem[];
  bomSnapshot?: ShoulderStrapBomSnapshotItem[];
}

type OverseasPickingPlanSnapshotItem = {
  shelfCode: string | null;
  boxCode: string | null;
  boxQty: number;
  pickQty: number;
};

type OverseasPickingRequirementSnapshotItem = {
  productId: string;
  productName: string;
  productType: string;
  requestedQty: number;
  pickedQty: number;
};

type ShoulderStrapBomSnapshotItem = {
  componentProductId: string;
  componentProductName: string;
  quantity: number;
};

interface YamatoImportFileResult {
  fileName: string;
  content: Buffer;
  batchId: string;
}

interface YamatoExportItem {
  source: 'rakuten' | 'amazon' | 'manual';
  id: string;
  orderId: string;
  productId: string;
  printerValue: string;
  components?: Array<{ componentProductId: string; quantity: number }>;
  quantity: number;
  deliveryDate: string;
  deliveryTimeSlot: string;
  phone: string;
  postalCode: string;
  address1: string;
  address2: string;
  recipientName: string;
}

interface YamatoMergedExportRow {
  orderId: string;
  printerValue: string;
  printerName: string;
  deliveryDate: string;
  deliveryTimeSlot: string;
  phone: string;
  postalCode: string;
  address1: string;
  address2: string;
  recipientName: string;
  itemSummary: string;
  isMergedDuplicate: boolean;
  productIds: string[];
}

interface YamatoShipmentBatchSummary {
  id: string;
  status: string;
  pageCount: number;
  printedPageCount: number;
  pendingPageCount: number;
  exportedFileName: string | null;
  pdfFileName: string | null;
  pdfUploadedAt: string | null;
  createdAt: string;
}

interface YamatoShipmentBatchUploadResult {
  id: string;
  status: string;
  pageCount: number;
  pdfFileName: string | null;
  pdfUploadedAt: string | null;
}

interface YamatoShipmentPdfUploadFile {
  buffer: Buffer;
  originalName?: string;
}

interface YamatoShipmentPrintFileResult {
  queueJobId?: string;
  reused?: boolean;
  batchId: string;
  fileName: string;
  content: Buffer;
  pageNo: number;
  trackingNo: string | null;
  productId: string;
  remainingMatchCount: number;
}

interface YamatoShipmentDirectPrintResult {
  queueJobId: string;
  reused?: boolean;
  batchId: string;
  fileName: string;
  pageNo: number;
  trackingNo: string | null;
  productId: string;
  remainingMatchCount: number;
  printerName: string | null;
  printJobId: string | null;
  mode: 'direct';
}

interface YamatoShipmentPrintConfig {
  mode: 'browser' | 'direct' | 'agent';
  printerName: string | null;
}

interface YamatoShipmentQueuedPrintResult {
  reused?: boolean;
  batchId: string;
  productId: string;
  pageNo: number;
  trackingNo: string | null;
  printerName: string | null;
  queueJobId: string;
  mode: 'agent';
}

interface YamatoShipmentPageProductDetail {
  productId: string;
  productName: string | null;
  quantity: number;
  finishedQuantity: number;
  assemblyQuantity: number;
  bodyProductIds: string[];
}

interface YamatoShipmentPageAssemblyPartDetail {
  componentProductId: string;
  componentProductName: string;
  componentProductType: string;
  requiredQty: number;
  stockQty: number;
  pickingConfirmedQty: number | null;
  parentProductIds: string[];
}

interface YamatoShipmentPagePreviewResult {
  batchId: string;
  pageNo: number;
  orderId: string | null;
  trackingNo: string | null;
  productId: string;
  productIds: string[];
  itemSummary: string | null;
  recipientName: string | null;
  products: YamatoShipmentPageProductDetail[];
  assemblyParts: YamatoShipmentPageAssemblyPartDetail[];
  remainingMatchCount: number;
  requiresSelection: boolean;
  candidates: Array<{ pageNo: number; orderId: string | null; productIds: string[]; itemSummary: string | null }>;
}

interface PreparedYamatoShipmentPrintResult {
  sourcePdfFilePath: string;
  isReprint: boolean;
  printRequestId?: string;
  confirmationSnapshot: Prisma.InputJsonValue;
  orderId: string | null;
  batchId: string;
  fileName: string;
  content: Buffer;
  pageId: bigint;
  pageNo: number;
  trackingNo: string | null;
  productId: string;
  productIds: string[];
  printerName: string | null;
  remainingMatchCount: number;
}

export interface YamatoShipmentPrintByProductPayload {
  productId?: string;
  pageNo?: string | number;
  scanRecords?: Array<{ productId: string; scannedCode: string; quantity: number }>;
  confirmedAssemblyParts?: Array<{ productId: string; quantity: number }>;
  operatorUsername?: string;
  stationId?: string;
  reprintConfirmed?: boolean;
  printRequestId?: string;
}

interface ParsedPdfPageText {
  pageNo: number;
  text: string;
}

interface UploadedYamatoPdfPage {
  fileIndex: number;
  fileBuffer: Buffer;
  fileName: string | null;
  sourcePageNo: number;
  text: string;
}

interface YamatoTemplateRowCell {
  column: string;
  styleId: string | null;
}

interface YamatoTemplateRow {
  rowAttributes: string;
  cells: YamatoTemplateRowCell[];
}

const YAMATO_IMPORT_TEMPLATE_FILE = 'ヤマト-インポート.xlsx';
const OVERSEAS_DISPATCH_MODE = {
  OVERSEAS: 'overseas',
  CHINA_PENDING: 'china_pending',
  CHINA_NO_STOCK: 'china_no_stock',
} as const;
const SHOULDER_STRAP_MATERIAL_TYPES = new Set(['肩带本体', '肩带配件']);
const AMAZON_MANUAL_ORDER_SOURCE_FILE_NAME = 'manual-amazon-order';
const AMAZON_MANUAL_ORDER_SOURCE_FILE_PATH = 'manual:amazon-order';
const XIYA_MANUAL_ORDER_SOURCE_FILE_NAME = 'xiya-manual-order';
const XIYA_MANUAL_ORDER_SOURCE_FILE_PATH = 'external:xiya-manual-order';
const MANUAL_ORDER_UPLOAD_TEMPLATE_FILE = '手动订单上传模板.xlsx';
const XIYA_LOGISTICS_EXPORT_URL =
  process.env.XIYA_LOGISTICS_EXPORT_URL || 'http://103.236.55.93/api/external/logistics/rakuten';
const XIYA_LOGISTICS_API_KEY = process.env.XIYA_EXPORT_API_KEY || '';
const XIYA_COMPANY_NAME = process.env.XIYA_COMPANY_NAME || 'XYJG';
const XIYA_SUCCESS_CODES = new Set([0, 200]);
const XIYA_LOGISTICS_SYNC_DAYS = 5;
const XIYA_TRACKING_SYNC_CRON = '0 0 17 * * *';
const UOF_TRACKING_API_URL =
  process.env.UOF_TRACKING_API_URL || 'http://oms.uofexp.com/webservice/PublicService.asmx/ServiceInterfaceUTF8';
const UOF_TRACKING_DEFAULT_APP_TOKEN = '';
const UOF_TRACKING_DEFAULT_APP_KEY = '';
const UOF_TRACKING_SERVICE_METHOD = 'gettrack';
const UOF_TRACKING_CUSTOMS_CLEARANCE_TEXT = '通関許可';
const UOF_TRACKING_DELIVERED_TEXT = '配達完了';
const UOF_TRACKING_FETCH_TIMEOUT_MS = 8000;
const UOF_TRACKING_SYNC_BATCH_SIZE = 100;
const UOF_TRACKING_SYNC_CONCURRENCY = 6;
const UOF_TRACKING_SYNC_MAX_PER_RUN_RAW = Number(process.env.UOF_TRACKING_SYNC_MAX_PER_RUN ?? 500);
const UOF_TRACKING_SYNC_MAX_PER_RUN =
  Number.isInteger(UOF_TRACKING_SYNC_MAX_PER_RUN_RAW) && UOF_TRACKING_SYNC_MAX_PER_RUN_RAW > 0
    ? Math.min(UOF_TRACKING_SYNC_MAX_PER_RUN_RAW, 5000)
    : 500;
const RAKUTEN_TRACKING_SYNC_LOCK_ID = 'rakuten-tracking-status-sync';
const RAKUTEN_TRACKING_SYNC_LOCK_STALE_MS = 10 * 60 * 1000;
const RAKUTEN_TRACKING_SYNC_LOCK_HEARTBEAT_MS = 60 * 1000;
const MANUAL_ORDER_UPLOAD_HEADERS = {
  orderId: ['订单号', '注文番号', 'orderId', 'order-id'],
  orderItemId: ['order-item-id', 'orderItemId', '订单商品ID', '明细ID'],
  sku: ['SKU', 'sku'],
  productId: ['产品ID', '商品ID', 'productId', 'product-id'],
  quantityPurchased: ['数量', '個数', 'quantity', 'quantityPurchased', 'quantity-purchased'],
  productName: ['产品名称', '商品名', 'productName', 'product-name'],
  mallName: ['平台', 'mallName', 'mall-name'],
  shopName: ['店铺', '店铺名', 'shopName', 'shop-name'],
  bloggerCooperationId: ['博主合作ID', 'bloggerCooperationId', 'blogger_cooperation_id'],
  recipientName: ['收件人', '收货人', 'recipientName', 'recipient-name'],
  buyerPhoneNumber: ['电话', '收件人电话', 'buyerPhoneNumber', 'buyer-phone-number', 'phone'],
  shipPostalCode: ['邮编', '郵便番号', 'shipPostalCode', 'ship-postal-code'],
  shipState: ['都道府县', '都道府県', 'shipState', 'ship-state'],
  shipAddress1: ['地址1', '地址一', 'shipAddress1', 'ship-address-1'],
  shipAddress2: ['地址2', '地址二', 'shipAddress2', 'ship-address-2'],
  shipAddress3: ['地址3', '地址三', 'shipAddress3', 'ship-address-3'],
  shipmentCompany: ['发货公司', '配送会社', 'shipmentCompany', 'shipment-company'],
  shipmentNo: ['发货单号', '运单号', 'tracking-number', 'shipmentNo', 'shipment-no'],
} as const;
const XYJG_BLOGGER_STATUS_PUSH_URL =
  process.env.XYJG_BLOGGER_STATUS_PUSH_URL || 'http://103.236.55.93/api/external/push';
const XYJG_PUSH_STATUS = {
  SYNCED: 'synced',
  FAILED: 'failed',
} as const;
const XYJG_PUSH_MODE = {
  CHINA_SHIP: 'china_ship',
  LOGISTICS_ORDER: 'logistics_order',
} as const;
// Existing Xiya names can differ from the configured WMS names, especially for Rakuten.
const XIYA_LEGACY_LOGISTICS_STORE_SOURCE: Record<string, ThirdPartyExportSource> = {
  DGAZ乐天日本: 'rakuten',
  DGAZ亚马逊日本站: 'amazon',
  ArcDiary亚马逊日本站: 'amazon',
};
const OVERSEAS_PICKING_BATCH_STATUS = {
  CREATED: 'created',
  PICKED: 'picked',
  YAMATO_EXPORTED: 'yamato_exported',
  COMPLETED: 'completed',
} as const;
const YAMATO_BATCH_STATUS = {
  EXCEL_EXPORTED: 'excel_exported',
  PDF_READY: 'pdf_ready',
} as const;
const YAMATO_DEFAULT_WINDOWS_PRINTER_NAME = 'yamato';
const YAMATO_PRODUCT_PRINTER_ALIASES: Record<string, string> = {
  '0': YAMATO_DEFAULT_WINDOWS_PRINTER_NAME,
  '０': YAMATO_DEFAULT_WINDOWS_PRINTER_NAME,
  A: 'nekoposu',
  yamato: YAMATO_DEFAULT_WINDOWS_PRINTER_NAME,
  nekoposu: 'nekoposu',
  ヤマト: YAMATO_DEFAULT_WINDOWS_PRINTER_NAME,
  ネコポス: 'nekoposu',
};
const YAMATO_EXPORT_FIXED_VALUES = {
  recipientSuffix: '様',
  senderPhone: '0477277616',
  senderPostalCode: '336-0015',
  senderAddress: '埼玉県さいたま市南区太田窪５丁目９－８',
  senderName: '株式会社Create Better',
  invoiceCustomerCode: '048762991602',
  coolType: '003',
  deliveryType: '01',
} as const;

const YAMATO_COLUMNS = {
  orderId: 0,
  printerValue: 1,
  shipDate: 4,
  deliveryDate: 5,
  deliveryTimeSlot: 6,
  phone: 8,
  postalCode: 10,
  address1: 11,
  address2: 12,
  recipientName: 15,
  recipientSuffix: 17,
  senderPhone: 19,
  senderPostalCode: 21,
  senderAddress: 22,
  senderName: 24,
  itemSummary: 27,
  invoiceCustomerCode: 39,
  coolType: 40,
  deliveryType: 41,
} as const;

const AMAZON_TXT_ENCODING_CANDIDATES = ['shift_jis', 'utf8', 'utf16le'] as const;
type AmazonTxtEncodingCandidate = (typeof AMAZON_TXT_ENCODING_CANDIDATES)[number];

let pdfJsModulePromise: Promise<{
  getDocument: (source: { data: Uint8Array; disableWorker?: boolean }) => { promise: Promise<unknown>;
  };
}> | null = null;

function normalizeAmazonSkuLookupKey(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private xiyaTrackingSyncRunning = false;
  private readonly deliveredRakutenTrackingStatusCache = new Map<string, RakutenTrackingClearanceStatus>();

  constructor(private readonly prisma: PrismaService) {}

  getYamatoShipmentPrintConfig(): YamatoShipmentPrintConfig {
    return {
      mode: this.getYamatoPrintMode(),
      printerName: this.getConfiguredYamatoPrinterName() || null,
    };
  }

  async listOverseasPickingBatches(limitParam?: string): Promise<OverseasPickingBatchSummary[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50) : 20;
    const [recentRows, activeRows] = await Promise.all([
      this.prisma.overseasPickingBatch.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
      this.prisma.overseasPickingBatch.findMany({
        where: { status: { not: OVERSEAS_PICKING_BATCH_STATUS.COMPLETED } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),

    ]);

    // Always retain unfinished work, even when one request creates more than the history limit.
    const rows = Array.from(new Map([...recentRows, ...activeRows].map((row) => [row.id.toString(), row])).values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const yamatoBatches = await this.prisma.yamatoShipmentBatch.findMany({
      where: { pickingBatchId: { in: rows.map(row => row.id) } },
      select: { id: true, pickingBatchId: true, status: true, pageCount: true,
        _count: { select: { pages: true } } },
    });
    const printedCounts = yamatoBatches.length ? await this.prisma.yamatoShipmentBatchPage.groupBy({
      by: ['batchId'], where: { batchId: { in: yamatoBatches.map(row => row.id) }, printedAt: { not: null } },
      _count: { _all: true },
    }) : [];
    const printedByBatch = new Map(printedCounts.map(row => [row.batchId.toString(), row._count._all]));
    const yamatoBatchByPickingBatchId = new Map(
      yamatoBatches
        .filter((row) => row.pickingBatchId !== null)
        .map((row) => [row.pickingBatchId!.toString(), row] as const),
    );

    return rows.map((row) => {
      const yamatoBatch = yamatoBatchByPickingBatchId.get(row.id.toString()) ?? null;
      const printedPageCount = yamatoBatch ? printedByBatch.get(yamatoBatch.id.toString()) ?? 0 : 0;
      const pageCount = Number(yamatoBatch?.pageCount ?? yamatoBatch?._count.pages ?? 0);
      return {
        id: row.id.toString(),
        batchNo: row.batchNo,
        status: row.status,
        completionGateRequired: row.completionGateRequired,
        orderCount: Number(row.orderCount ?? 0),
        itemCount: Number(row.itemCount ?? 0),
        totalQty: Number(row.totalQty ?? 0),
        createdAt: row.createdAt.toISOString(),
        confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
        workCompletedAt: row.workCompletedAt?.toISOString() ?? null,
        yamatoShipmentBatchId: yamatoBatch ? yamatoBatch.id.toString() : null,
        yamatoShipmentBatchStatus: yamatoBatch?.status ?? null,
        yamatoPrintedPageCount: printedPageCount,
        yamatoPendingPageCount: Math.max(pageCount - printedPageCount, 0),
      };
    });
  }

  async getOverseasPickingBatchCreationReadiness(): Promise<{ canCreate: boolean; unfinishedBatchNo: string | null }> {
    const unfinished = await this.prisma.overseasPickingBatch.findFirst({
      where: { completionGateRequired: true, status: { not: OVERSEAS_PICKING_BATCH_STATUS.COMPLETED } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { batchNo: true },
    });
    return { canCreate: !unfinished, unfinishedBatchNo: unfinished?.batchNo ?? null };
  }

  async completeOverseasPickingBatchWork(batchIdRaw: string, userId: bigint): Promise<{
    id: string;
    batchNo: string;
    status: string;
  }> {
    const batchId = parseId(batchIdRaw, 'batchId');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM overseas_picking_batches WHERE id = ${batchId} FOR UPDATE`);
      const batch = await tx.overseasPickingBatch.findUnique({
        where: { id: batchId },
        select: {
          id: true,
          batchNo: true,
          status: true,
          workCompletedAt: true,
          workCompletedBy: true,
        },
      });
      if (!batch) {
        throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
      }

      const yamatoBatch = await tx.yamatoShipmentBatch.findFirst({
        where: { pickingBatchId: batch.id },
        select: {
          id: true,
          status: true,
          pageCount: true,
          pages: {
            select: {
              printedAt: true,
            },
          },
        },
      });
      if (!yamatoBatch) {
        throw new BadRequestException('当前批次尚未生成 Yamato 面单批次，不能确认完成作业');
      }
      if (yamatoBatch.status !== YAMATO_BATCH_STATUS.PDF_READY) {
        throw new BadRequestException(
          `Yamato 批次 #${yamatoBatch.id.toString()} 尚未上传面单 PDF，不能确认完成作业`,
        );
      }

      await tx.$queryRaw(Prisma.sql`SELECT id FROM yamato_shipment_batch_pages WHERE batch_id = ${yamatoBatch.id} ORDER BY id FOR UPDATE`);
      const activeJobs = await tx.printJob.count({ where: { batchPage: { batchId: yamatoBatch.id }, status: { in: [PrintJobStatus.pending, PrintJobStatus.claimed] } } });
      if (activeJobs) throw new BadRequestException(`还有 ${activeJobs} 个打印或补打任务未确认出纸，不能完成作业`);
      const currentPages = await tx.yamatoShipmentBatchPage.findMany({ where: { batchId: yamatoBatch.id }, select: { printedAt: true } });
      yamatoBatch.pages = currentPages;
      const printedPageCount = yamatoBatch.pages.filter((page) => Boolean(page.printedAt)).length;
      const pageCount = Number(yamatoBatch.pageCount ?? yamatoBatch.pages.length ?? 0);
      const pendingPageCount = Math.max(pageCount - printedPageCount, 0);
      if (pageCount <= 0) {
        throw new BadRequestException('当前批次没有可检查的 Yamato 面单，不能确认完成作业');
      }
      if (pendingPageCount > 0) {
        throw new BadRequestException(
          `本批次作业未完成：还有 ${pendingPageCount} 张面单未打印。请完成后再次确认。`,
        );
      }

      if (batch.status !== OVERSEAS_PICKING_BATCH_STATUS.COMPLETED && batch.status !== OVERSEAS_PICKING_BATCH_STATUS.YAMATO_EXPORTED) {
        throw new BadRequestException(`当前批次状态为 ${batch.status}，不能确认完成作业`);
      }
      const completedAt = batch.workCompletedAt ?? new Date();
      const completedBy = batch.workCompletedBy ?? userId;
      const items = await tx.overseasPickingBatchItem.findMany({ where: {
        batchId, source: 'rakuten', dispatchMode: { notIn: ['china_pending', 'china_no_stock'] }, actualQty: { gt: 0 },
      }, select: { sourceRecordId: true, requestedQty: true, actualQty: true, shipmentTrackingNo: true } });
      for (const item of items) {
        const current = await tx.rakutenOrderRecord.findUnique({ where: { id: item.sourceRecordId, deletedAt: null },
          select: { shipmentNo: true, shipmentCompany: true, warehouseShippedAt: true, orderQuantity: true, dispatchMode: true } });
        if (!current || this.isChinaDispatchMode(current.dispatchMode)) continue;
        if (Number(item.actualQty) < Number(item.requestedQty) || !String(item.shipmentTrackingNo ?? '').trim()) {
          throw new ConflictException('日本侧实拣数量或批次单号不完整，不能确认本批次出货');
        }
        if (current.shipmentNo !== item.shipmentTrackingNo || Number(current.orderQuantity) > Number(item.actualQty)
          || rakutenDeliveryCompanyCode(current.shipmentCompany) !== '1001') {
          throw new ConflictException('订单单号或数量与批次出货资料不一致，请修正后再确认作业完成');
        }
        const confirmed = await tx.rakutenOrderRecord.updateMany({ where: { id: item.sourceRecordId, deletedAt: null,
          OR: [{ dispatchMode: null }, { dispatchMode: { notIn: ['china_pending', 'china_no_stock'] } }],
          shipmentNo: item.shipmentTrackingNo, shipmentCompany: current.shipmentCompany, orderQuantity: current.orderQuantity,
          warehouseShippedAt: null,
        }, data: { warehouseShippedAt: completedAt, warehouseShippedBy: completedBy } });
        if (!current.warehouseShippedAt && confirmed.count !== 1) {
          throw new ConflictException('订单出货资料在确认期间发生变化，请刷新后重新核对');
        }
      }
      if (!batch.workCompletedAt) {
        await tx.overseasPickingBatch.update({ where: { id: batch.id }, data: {
          status: OVERSEAS_PICKING_BATCH_STATUS.COMPLETED, workCompletedAt: completedAt, workCompletedBy: completedBy,
        } });
      }

      return {
        id: batch.id.toString(),
        batchNo: batch.batchNo,
        status: OVERSEAS_PICKING_BATCH_STATUS.COMPLETED,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }


  async getOverseasPickingBatchDetail(batchIdRaw: string): Promise<OverseasPickingBatchDetail> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const batch = await this.prisma.overseasPickingBatch.findUnique({
      where: { id: batchId },
      include: {
        items: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!batch) {
      throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
    }

    const yamatoBatch = await this.prisma.yamatoShipmentBatch.findFirst({
      where: { pickingBatchId: batch.id },
      include: {
        pages: {
          select: {
            orderId: true,
            pageNo: true,
            printedAt: true,
            trackingNo: true,
          },
        },
      },
    });
    const yamatoPageByOrderId = new Map(
      (yamatoBatch?.pages ?? [])
        .filter((page) => String(page.orderId ?? '').trim())
        .map((page) => [String(page.orderId ?? '').trim(), page] as const),
    );
    const rakutenSourceIds = Array.from(
      new Set(
        batch.items
          .filter((item) => item.source === 'rakuten')
          .map((item) => item.sourceRecordId)),
    );
    const amazonSourceIds = Array.from(
      new Set(
        batch.items
          .filter((item) => item.source === 'amazon')
          .map((item) => item.sourceRecordId)),
    );
    const manualSourceIds = Array.from(
      new Set(
        batch.items
          .filter((item) => item.source === 'manual')
          .map((item) => item.sourceRecordId)),
    );
    const [rakutenSourceRows, amazonSourceRows, manualSourceRows] = await Promise.all([
      rakutenSourceIds.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: { deletedAt: null,
              id: {
                in: rakutenSourceIds,
              },
            },
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonSourceIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: {
              ...PROCESSABLE_AMAZON_ORDER_WHERE,
              id: {
                in: amazonSourceIds,
              },
            },
          })
        : Promise.resolve([] as AmazonOrderRecord[]),
      manualSourceIds.length
        ? (this.prisma as any).manualOrderRecord.findMany({
            where: {
              id: {
                in: manualSourceIds,
              },
            },
          })
        : Promise.resolve([] as ManualOrderRecordLike[]),
    ]);
    const rakutenSourceMap = new Map(rakutenSourceRows.map((row) => [row.id.toString(), row] as const));
    const amazonSourceMap = new Map(amazonSourceRows.map((row) => [row.id.toString(), row] as const));
    const manualSourceMap = new Map(
      (manualSourceRows as ManualOrderRecordLike[]).map((row) => [row.id.toString(), row] as const),
    );
    const pickingRequirementsByItemId = new Map(
      batch.items.map((item) => {
        const parsed = this.parseOverseasPickingRequirementSnapshot(item.pickingRequirementSnapshot);
        return [item.id.toString(), parsed.length ? parsed : [{
          productId: item.productId,
          productName: item.productId,
          productType: '',
          requestedQty: Number(item.requestedQty ?? 0),
          pickedQty: Number(item.actualQty ?? 0),
        }]] as const;
      }),
    );
    const locationMetaByProductId = await this.loadOverseasPickingBatchLocationMeta(
      Array.from(pickingRequirementsByItemId.values()).flat().map((item) => item.productId),
    );
    const sortedItems = [...batch.items].sort((left, right) => {
      const leftMeta = locationMetaByProductId.get(left.productId) ?? null;
      const rightMeta = locationMetaByProductId.get(right.productId) ?? null;
      const leftKey = `${leftMeta?.shelfCode ?? 'ZZZ'}|${leftMeta?.boxCode ?? 'ZZZ'}|${left.productId}|${left.id.toString()}`;
      const rightKey = `${rightMeta?.shelfCode ?? 'ZZZ'}|${rightMeta?.boxCode ?? 'ZZZ'}|${right.productId}|${right.id.toString()}`;
      return leftKey.localeCompare(rightKey, 'zh-Hans-CN');
    });
    const toIsoString = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

    const resolvePickingLocation = (
      locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number;
      }>,
      pickedQty: number,
      requestedQty: number,
    ): {
      current: { shelfCode: string | null; boxCode: string | null; qty: number;
      } | null;
      next: { shelfCode: string | null; boxCode: string | null; qty: number;
      } | null;
    } => {
      if (!locations.length) {
        return { current: null, next: null };
      }
      let consumedQty = Math.max(pickedQty, 0);
      for (let index = 0; index < locations.length; index += 1) {
        const location = locations[index];
        if (consumedQty < location.qty) {
          let remainingDemand = Math.max(requestedQty - consumedQty, 0);
          let nextLocation: { shelfCode: string | null; boxCode: string | null; qty: number;
          } | null = null;
          if (remainingDemand > location.qty) {
            nextLocation = locations[index + 1] ?? null;
          }
          return {
            current: location,
            next: nextLocation,
          };
        }
        consumedQty -= location.qty;
      }
      return {
        current: locations[locations.length - 1] ?? null,
        next: null,
      };
    };
    const buildPickingPlans = (
      locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number;
      }>,
      requestedQty: number,
    ): Array<{ shelfCode: string | null; boxCode: string | null; boxQty: number; pickQty: number;
    }> => {
      let remaining = Math.max(requestedQty, 0);
      const plans: Array<{ shelfCode: string | null; boxCode: string | null; boxQty: number; pickQty: number;
      }> = [];
      for (const location of locations) {
        const boxQty = Number(location.qty ?? 0);
        if (boxQty <= 0 || remaining <= 0) continue;
        const pickQty = Math.min(boxQty, remaining);
        plans.push({
          shelfCode: location.shelfCode ?? null,
          boxCode: location.boxCode ?? null,
          boxQty,
          pickQty,
        });
        remaining -= pickQty;
      }
      return plans;
    };
    const groupedItems = new Map<
      string,
      {
        productId: string;
        sortKey: string;
        productName: string | null;
        stockQty: number;
        requestedQty: number;
        actualQty: number;
        locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number;
        }>;
      }
    >();

    sortedItems
      .filter(
        (item) =>
          !this.isChinaDispatchMode(item.dispatchMode))
      .forEach((item) => {
        const requirements = pickingRequirementsByItemId.get(item.id.toString()) ?? [];
        requirements.forEach((requirement) => {
          const locationMeta = locationMetaByProductId.get(requirement.productId) ?? null;
          const sortKey = `${locationMeta?.shelfCode ?? 'ZZZ'}|${locationMeta?.boxCode ?? 'ZZZ'}|${requirement.productId}`;
          const aggregate = groupedItems.get(requirement.productId) ?? {
            productId: requirement.productId,
            sortKey,
            productName: locationMeta?.productName ?? requirement.productName,
            stockQty: Number(locationMeta?.stockQty ?? 0),
            requestedQty: 0,
            actualQty: 0,
            locations: locationMeta?.locations ?? [],
          };
          aggregate.requestedQty += requirement.requestedQty;
          aggregate.actualQty += requirement.pickedQty;
          groupedItems.set(requirement.productId, aggregate);
        });
      });

    const groupedDetailItems = Array.from(groupedItems.values())
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey, 'zh-Hans-CN'))
      .map((item) => {
        const targetLocation = resolvePickingLocation(item.locations, item.actualQty, item.requestedQty);
        const pickPlans = buildPickingPlans(item.locations, item.requestedQty);
        return {
          productId: item.productId,
          productName: item.productName,
          stockQty: item.stockQty,
          requestedQty: item.requestedQty,
          actualQty: item.actualQty,
          remainingQty: Math.max(item.requestedQty - item.actualQty, 0),
          pickPlans:
            pickPlans.length > 0
              ? pickPlans
              : targetLocation.current
                ? [
                    {
                      shelfCode: targetLocation.current.shelfCode ?? null,
                      boxCode: targetLocation.current.boxCode ?? null,
                      boxQty: Number(targetLocation.current.qty ?? 0),
                      pickQty: 0,
                    },
                  ]
                : [],
        };
      });
    const detailOrders = sortedItems.map((item) => {
      const orderId = String(item.orderId ?? '').trim();
      const page = orderId ? (yamatoPageByOrderId.get(orderId) ?? null) : null;
      const sourceRecordId = item.sourceRecordId.toString();
      const source =
        item.source === 'amazon' ? ('amazon' as const) : item.source === 'manual' ? ('manual' as const) : ('rakuten' as const);
      const rakutenRow = item.source === 'rakuten' ? (rakutenSourceMap.get(sourceRecordId) ?? null) : null;
      const amazonRow = item.source === 'amazon' ? (amazonSourceMap.get(sourceRecordId) ?? null) : null;
      const manualRow = item.source === 'manual' ? (manualSourceMap.get(sourceRecordId) ?? null) : null;
      const shipmentTrackingNo = String(item.shipmentTrackingNo ?? page?.trackingNo ?? '').trim() || null;
      const yamatoPrintedAt = toIsoString(page?.printedAt);
      const dispatchMode =
        String(item.dispatchMode ?? OVERSEAS_DISPATCH_MODE.OVERSEAS).trim() || OVERSEAS_DISPATCH_MODE.OVERSEAS;
      let orderStatusText = '待拣货';
      if (this.isChinaDispatchMode(dispatchMode)) {
        orderStatusText = '中国发待处理';
      } else if (yamatoPrintedAt) {
        orderStatusText = '已打印面单';
      } else if (shipmentTrackingNo) {
        orderStatusText = '已绑定运单待打印';
      } else if (batch.status === OVERSEAS_PICKING_BATCH_STATUS.YAMATO_EXPORTED) {
        orderStatusText = '待上传Yamato PDF';
      } else if (batch.status === OVERSEAS_PICKING_BATCH_STATUS.PICKED) {
        orderStatusText = '待生成/上传面单';
      } else if (Number(item.actualQty ?? 0) > 0) {
        orderStatusText = '拣货中';
      }
      return {
        itemId: item.id.toString(),
        source,
        sourceLabel: source === 'amazon' ? '亚马逊' : source === 'manual' ? '手动订单' : '乐天',
        sourceRecordId,
        csvImportedAt:
          toIsoString(rakutenRow?.csvImportedAt) ?? toIsoString(amazonRow?.csvImportedAt) ?? toIsoString(manualRow?.csvImportedAt),
        createdAt: toIsoString(rakutenRow?.createdAt) ?? toIsoString(amazonRow?.createdAt) ?? toIsoString(manualRow?.createdAt),
        orderId: item.orderId ?? rakutenRow?.orderId ?? amazonRow?.orderId ?? manualRow?.orderId ?? null,
        skuCode: item.skuCode ?? rakutenRow?.skuCode ?? amazonRow?.sku ?? manualRow?.sku ?? null,
        productId: item.productId,
        orderQuantity: Number(item.requestedQty ?? 0),
        actualQty: Number(item.actualQty ?? 0),
        shopName: item.shopName ?? rakutenRow?.shopName ?? amazonRow?.shopName ?? manualRow?.shopName ?? null,
        shippingName: item.shippingName ?? rakutenRow?.shippingName ?? amazonRow?.recipientName ?? manualRow?.recipientName ?? null,
        shipmentCompany:
          rakutenRow?.shipmentCompany ?? amazonRow?.shipmentCompany ?? manualRow?.shipmentCompany ?? (shipmentTrackingNo ? 'Yamato' : null),
        shipmentTrackingNo,
        shipmentNoRegisteredAt:
          toIsoString(rakutenRow?.shipmentNoRegisteredAt) ??
          toIsoString(amazonRow?.shipmentNoRegisteredAt) ??
          toIsoString(manualRow?.shipmentNoRegisteredAt),
        dispatchMode,
        chinaDispatchReason: this.isChinaDispatchMode(dispatchMode) ? this.resolveChinaDispatchReason(dispatchMode) : null,
        yamatoPageNo: page?.pageNo ?? null,
        yamatoPrintedAt,
        orderStatusText,
        orderImportedAtRaw: rakutenRow?.orderImportedAtRaw ?? null,
        purchaseDateRaw: amazonRow?.purchaseDateRaw ?? manualRow?.purchaseDateRaw ?? null,
        productName: rakutenRow?.productName ?? amazonRow?.productName ?? manualRow?.productName ?? null,
        productNameExtra: rakutenRow?.productNameExtra ?? null,
        shippingPhone: rakutenRow?.shippingPhone ?? null,
        shippingPostalCode: rakutenRow?.shippingPostalCode ?? null,
        shippingPrefecture: rakutenRow?.shippingPrefecture ?? null,
        shippingCity: rakutenRow?.shippingCity ?? null,
        shippingAddress: rakutenRow?.shippingAddress ?? null,
        deliveryDateRaw: rakutenRow?.deliveryDateRaw ?? null,
        deliveryTimeSlot: rakutenRow?.deliveryTimeSlot ?? null,
        buyerPhoneNumber: amazonRow?.buyerPhoneNumber ?? manualRow?.buyerPhoneNumber ?? null,
        shipPostalCode: amazonRow?.shipPostalCode ?? manualRow?.shipPostalCode ?? null,
        shipState: amazonRow?.shipState ?? manualRow?.shipState ?? null,
        shipAddress1: amazonRow?.shipAddress1 ?? manualRow?.shipAddress1 ?? null,
        shipAddress2: amazonRow?.shipAddress2 ?? manualRow?.shipAddress2 ?? null,
        shipAddress3: amazonRow?.shipAddress3 ?? manualRow?.shipAddress3 ?? null,
        rawPayload: rakutenRow?.rawPayload ?? amazonRow?.rawPayload ?? manualRow?.rawPayload ?? null,
      };
    });

    return {
      id: batch.id.toString(),
      batchNo: batch.batchNo,
      status: batch.status,
      completionGateRequired: batch.completionGateRequired,
      orderCount: Number(batch.orderCount ?? 0),
      itemCount: Number(batch.itemCount ?? 0),
      totalQty: Number(batch.totalQty ?? 0),
      createdAt: batch.createdAt.toISOString(),
      confirmedAt: batch.confirmedAt ? batch.confirmedAt.toISOString() : null,
      workCompletedAt: batch.workCompletedAt?.toISOString() ?? null,
      remark: batch.remark ?? null,
      yamatoShipmentBatchId: yamatoBatch ? yamatoBatch.id.toString() : null,
      yamatoShipmentBatchStatus: yamatoBatch?.status ?? null,
      yamatoPrintedPageCount: yamatoBatch?.pages.filter((page) => Boolean(page.printedAt)).length ?? 0,
      yamatoPendingPageCount: yamatoBatch
        ? Math.max(
            Number(yamatoBatch.pageCount ?? yamatoBatch.pages.length ?? 0) -
              yamatoBatch.pages.filter((page) => Boolean(page.printedAt)).length,
            0,
          )
        : 0,
      items: groupedDetailItems,
      orders: detailOrders,
    };
  }

  async createOverseasPickingBatch(
    payload: { items?: SelectedOverseasWarehouseOrderRef[]; remark?: string },
    operatorId?: bigint,
  ): Promise<OverseasPickingBatchCreateResult> {
    const remark = String(payload?.remark ?? '').trim() || null;

    return stockTransaction(this.prisma, async (tx) => {
      const gate = await tx.$queryRaw<Array<{ id: number }>>(
        Prisma.sql`SELECT id FROM picking_batch_generation_locks WHERE id = 1 FOR UPDATE`,
      );
      if (gate.length !== 1) {
        throw new InternalServerErrorException('批次生成检查不可用，请联系管理员');
      }
      const unfinished = await tx.overseasPickingBatch.findFirst({
        where: { completionGateRequired: true, status: { not: OVERSEAS_PICKING_BATCH_STATUS.COMPLETED } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { batchNo: true },
      });
      if (unfinished) {
        throw new ConflictException(`请先完成之前的拣货批次 ${unfinished.batchNo}（状态须为“作业已完成”），再生成新批次`);
      }
      const snapshots = await this.collectOverseasPickingBatchItemSnapshots(payload?.items);
      const productIds = Array.from(new Set(snapshots.map((item) => item.productId))).sort();
      if (productIds.length) {
        await lockStockProducts(tx, productIds);
      }
      await this.attachOverseasPickingPlanSnapshots(snapshots, tx);
      await this.attachShoulderStrapBomSnapshots(snapshots, tx);
      await this.attachOverseasPickingRequirementSnapshots(snapshots, tx);
      const componentProductIds = Array.from(
        new Set(snapshots.flatMap((item) =>
          (item.bomSnapshot ?? []).map((component) => component.componentProductId))),
      ).sort();
      if (componentProductIds.length) {
        await lockStockProducts(tx, componentProductIds);
      }
      await this.assertOverseasPickingBatchDemandWithinStock(snapshots, tx);
      const activeDuplicates = await this.findActiveOverseasPickingBatchDuplicates(snapshots, tx);
      if (activeDuplicates.length) {
        throw new ConflictException(
          `以下订单已在进行中的拣货批次内：${activeDuplicates.join('、')}`);
      }
      const groups = this.splitOverseasPickingBatches(snapshots);
      const batches: OverseasPickingBatchCreateResult[] = [];
      for (const group of groups) {
        const orderCount = new Set(group.map((item) => JSON.stringify([item.source, item.orderId]))).size;
        const itemCount = group.length;
        const totalQty = group.reduce((sum, item) => sum + item.requestedQty, 0);
        const created = await tx.overseasPickingBatch.create({
          data: {
            batchNo: this.buildOverseasPickingBatchNo(),
            status: OVERSEAS_PICKING_BATCH_STATUS.CREATED,
            completionGateRequired: true,
            orderCount,
            itemCount,
            totalQty,
            createdBy: operatorId ?? null,
            remark,
            items: {
              create: group.map((item) => ({
                source: item.source,
                sourceRecordId: item.sourceRecordId,
                orderId: item.orderId,
                skuCode: item.skuCode,
                productId: item.productId,
                requestedQty: item.requestedQty,
                availableStockSnapshot: item.availableStockSnapshot,
                pickingPlanSnapshot: item.pickingPlanSnapshot ?? [],
                pickingRequirementSnapshot: item.pickingRequirementSnapshot ?? [],
                bomSnapshot: item.bomSnapshot ?? [],
                componentRefs: {
                  create: [...new Set((item.bomSnapshot ?? [])
                    .map((component) => component.componentProductId)
                    .filter(Boolean))].map((componentProductId) => ({ componentProductId })),
                },
                shopName: item.shopName,
                shippingName: item.shippingName,
              })),
            },
          },
        });
        batches.push({
          id: created.id.toString(),
          batchNo: created.batchNo,
          status: created.status,
          itemCount,
          orderCount,
        });
      }
      return { ...batches[0], batches };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 60000 });
  }

  async scanOverseasPickingBatchProduct(
    batchIdRaw: string,
    payload: { productId?: string },
  ): Promise<OverseasPickingBatchScanResult> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const productId = String(payload?.productId ?? '').trim();
    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }

    return this.prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM overseas_picking_batches WHERE id = ${batchId} FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM overseas_picking_batch_items WHERE batch_id = ${batchId} ORDER BY id FOR UPDATE`,
    );
    const batch = await tx.overseasPickingBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        batchNo: true,
        status: true,
      },
    });
    if (!batch) {
      throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
    }
    if (batch.status !== OVERSEAS_PICKING_BATCH_STATUS.CREATED) {
      throw new BadRequestException('当前拣货批次已确认，不能继续扫码拣货');
    }

    const batchItems = await tx.overseasPickingBatchItem.findMany({
      where: {
        batchId,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!batchItems.length) {
      throw new NotFoundException(`批次 ${batch.batchNo} 中暂无拣货明细`);
    }

    const requirementRows = batchItems
      .filter((item) => !this.isChinaDispatchMode(item.dispatchMode))
      .flatMap((item) => {
        const parsed = this.parseOverseasPickingRequirementSnapshot(item.pickingRequirementSnapshot);
        const requirements = parsed.length
          ? parsed
          : [{
              productId: item.productId,
              productName: item.productId,
              productType: '',
              requestedQty: Number(item.requestedQty ?? 0),
              pickedQty: Number(item.actualQty ?? 0),
            }];
        return requirements.map((requirement, index) => ({ item, requirement, index, requirements }));
      });
    const locationMetaByProductId = await this.loadOverseasPickingBatchLocationMeta(
      requirementRows.map((row) => row.requirement.productId),
      tx,
    );
    const nextExpectedProduct = requirementRows
      .filter((row) => row.requirement.pickedQty < row.requirement.requestedQty)
      .sort((left, right) => {
        const leftMeta = locationMetaByProductId.get(left.requirement.productId);
        const rightMeta = locationMetaByProductId.get(right.requirement.productId);
        const leftKey = `${leftMeta?.shelfCode ?? 'ZZZ'}|${leftMeta?.boxCode ?? 'ZZZ'}|${left.requirement.productId}`;
        const rightKey = `${rightMeta?.shelfCode ?? 'ZZZ'}|${rightMeta?.boxCode ?? 'ZZZ'}|${right.requirement.productId}`;
        return leftKey.localeCompare(rightKey, 'zh-Hans-CN');
      })[0];
    if (nextExpectedProduct && nextExpectedProduct.requirement.productId !== productId) {
      const locationMeta = locationMetaByProductId.get(nextExpectedProduct.requirement.productId);
      const locationText = [locationMeta?.shelfCode, locationMeta?.boxCode]
        .filter((value) => String(value ?? '').trim().length > 0)
        .join(' / ');
      const locationHint = locationText ? `${locationText} / ` : '';
      throw new BadRequestException(
        `请按顺序拣货，当前应先拣 ${locationHint}${nextExpectedProduct.requirement.productId}${
          nextExpectedProduct.requirement.productName ? `（${nextExpectedProduct.requirement.productName}）` : ''
        }`,
      );
    }

    const allRequirements = requirementRows.filter((row) => row.requirement.productId === productId);
    if (!allRequirements.length) {
      throw new NotFoundException(`批次 ${batch.batchNo} 中不存在产品 ${productId}`);
    }

    const target = allRequirements.find(
      (row) => row.requirement.pickedQty < row.requirement.requestedQty,
    );
    if (!target) {
      throw new BadRequestException(`批次 ${batch.batchNo} 中产品 ${productId} 已全部完成拣货`);
    }

    const updatedRequirements = target.requirements.map((requirement, index) => (
      index === target.index ? { ...requirement, pickedQty: requirement.pickedQty + 1 } : requirement
    ));
    const itemComplete = updatedRequirements.every(
      (requirement) => requirement.pickedQty >= requirement.requestedQty,
    );
    const updated = await tx.overseasPickingBatchItem.update({
      where: { id: target.item.id },
      data: {
        pickingRequirementSnapshot: updatedRequirements,
        actualQty: itemComplete ? Number(target.item.requestedQty ?? 0) : 0,
        pickedAt: new Date(),
      },
      select: {
        id: true,
        productId: true,
        actualQty: true,
        requestedQty: true,
      },
    });

    const totalRequestedQty = allRequirements.reduce(
      (sum, row) => sum + row.requirement.requestedQty,
      0,
    );
    const totalPickedQty = allRequirements.reduce((sum, row) => (
      sum + row.requirement.pickedQty + (row === target ? 1 : 0)
    ), 0);

    return {
      id: updated.id.toString(),
      productId,
      pickedQty: totalPickedQty,
      requestedQty: totalRequestedQty,
      remainingQty: Math.max(totalRequestedQty - totalPickedQty, 0),
    };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async switchOverseasPickingBatchProductToChina(
    batchIdRaw: string,
    productIdRaw: string,
  ): Promise<{ success: true; productId: string; dispatchMode: string; batchDeleted: boolean;
  }> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const productId = String(productIdRaw ?? '').trim();
    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }

    const batch = await this.prisma.overseasPickingBatch.findUnique({
      where: { id: batchId },
      select: { id: true, status: true },
    });
    if (!batch) {
      throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
    }
    if (batch.status !== OVERSEAS_PICKING_BATCH_STATUS.CREATED) {
      throw new BadRequestException('当前拣货批次已确认，不能再切换发货方式');
    }

    const items = await this.prisma.overseasPickingBatchItem.findMany({
      where: {
        batchId,
        productId,
      },
      select: {
        id: true,
        source: true,
        sourceRecordId: true,
        actualQty: true,
        dispatchMode: true,
        pickingRequirementSnapshot: true,
      },
    });
    if (!items.length) {
      throw new NotFoundException(`拣货批次中不存在产品 ${productId}`);
    }

    const activeItems = items.filter((item) => !this.isChinaDispatchMode(item.dispatchMode));
    if (!activeItems.length) {
      throw new NotFoundException(`拣货批次中不存在可切中国发的产品 ${productId}`);
    }
    if (activeItems.some((item) => (
      Number(item.actualQty ?? 0) > 0
      || this.parseOverseasPickingRequirementSnapshot(item.pickingRequirementSnapshot)
        .some((requirement) => requirement.pickedQty > 0)
    ))) {
      throw new BadRequestException(`产品 ${productId} 已开始扫码拣货，不能再切换到中国发`);
    }

    const itemIds = activeItems.map((item) => item.id);
    const rakutenIds = Array.from(
      new Set(
        activeItems
          .filter((item) => item.source === 'rakuten')
          .map((item) => item.sourceRecordId)),
    );
    const amazonIds = Array.from(
      new Set(
        activeItems
          .filter((item) => item.source === 'amazon')
          .map((item) => item.sourceRecordId)),
    );
    const manualIds = Array.from(
      new Set(
        activeItems
          .filter((item) => item.source === 'manual')
          .map((item) => item.sourceRecordId)),
    );
    const amazonSwitchScope = await this.resolveAmazonOrderSwitchScope(batchId, amazonIds);
    const targetAmazonIds = Array.from(
      new Set([...amazonIds, ...amazonSwitchScope.amazonIds].map((id) => id.toString())),
    ).map((id) => BigInt(id));
    const manualSwitchScope = await this.resolveXyjgManualOrderSwitchScope(batchId, manualIds);
    const targetManualIds = Array.from(
      new Set([...manualIds, ...manualSwitchScope.manualIds].map((id) => id.toString())),
    ).map((id) => BigInt(id));
    this.assertNoPickedItemsBeforeSwitchingOrderScopeToChina([
      ...amazonSwitchScope.pickedItems,
      ...manualSwitchScope.pickedItems,
    ]);
    const targetItemIds = Array.from(
      new Set([...itemIds, ...amazonSwitchScope.batchItemIds, ...manualSwitchScope.batchItemIds]),
    );

    const batchDeleted = await this.prisma.$transaction(async (tx) => {
      if (rakutenIds.length) {
        await tx.rakutenOrderRecord.updateMany({
          where: { deletedAt: null,
            id: {
              in: rakutenIds,
            },
          },
          data: {
            dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
          },
        });
      }
      if (targetAmazonIds.length) {
        await tx.amazonOrderRecord.updateMany({
          where: {
            id: {
              in: targetAmazonIds,
            },
          },
          data: {
            dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
          },
        });
      }
      if (targetManualIds.length) {
        await (tx as any).manualOrderRecord.updateMany({
          where: {
            id: {
              in: targetManualIds,
            },
          },
          data: {
            dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
          },
        });
      }
      await tx.overseasPickingBatchItem.deleteMany({
        where: {
          id: {
            in: targetItemIds,
          },
        },
      });

      return this.recalculateOverseasPickingBatchAfterItemRemoval(tx, batchId);
    });

    await this.syncManualOrderIdsToXyjgBestEffort(targetManualIds);
    return {
      success: true,
      productId,
      dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
      batchDeleted,
    };
  }

  async resetOverseasPickingBatchProductPicking(
    batchIdRaw: string,
    productIdRaw: string,
  ): Promise<{ success: true; productId: string; actualQty: number }> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const productId = String(productIdRaw ?? '').trim();
    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }

    const batch = await this.prisma.overseasPickingBatch.findUnique({
      where: { id: batchId },
      select: { id: true, status: true },
    });
    if (!batch) {
      throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
    }
    if (batch.status !== OVERSEAS_PICKING_BATCH_STATUS.CREATED) {
      throw new BadRequestException('当前拣货批次已确认，不能再变更拣货状态');
    }

    const items = await this.prisma.overseasPickingBatchItem.findMany({
      where: {
        batchId,
      },
      select: {
        id: true,
        productId: true,
        requestedQty: true,
        actualQty: true,
        dispatchMode: true,
        pickingRequirementSnapshot: true,
      },
    });
    const targetItems = items.map((item) => {
      if (this.isChinaDispatchMode(item.dispatchMode)) return null;
      const requirements = this.parseOverseasPickingRequirementSnapshot(item.pickingRequirementSnapshot);
      if (!requirements.length) {
        return item.productId === productId && Number(item.actualQty ?? 0) > 0
          ? { item, requirements: [], legacy: true }
          : null;
      }
      return requirements.some(
        (requirement) => requirement.productId === productId && requirement.pickedQty > 0,
      ) ? { item, requirements, legacy: false } : null;
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!items.length || !items.some((item) => (
      item.productId === productId
      || this.parseOverseasPickingRequirementSnapshot(item.pickingRequirementSnapshot)
        .some((requirement) => requirement.productId === productId)
    ))) {
      throw new NotFoundException(`拣货批次中不存在产品 ${productId}`);
    }
    if (!targetItems.length) {
      return {
        success: true,
        productId,
        actualQty: 0,
      };
    }

    await this.prisma.$transaction(targetItems.map(({ item, requirements, legacy }) => {
      const nextRequirements = legacy ? undefined : requirements.map((requirement) => (
        requirement.productId === productId ? { ...requirement, pickedQty: 0 } : requirement
      ));
      const complete = nextRequirements?.every(
        (requirement) => requirement.pickedQty >= requirement.requestedQty,
      ) ?? false;
      return this.prisma.overseasPickingBatchItem.update({
        where: { id: item.id },
        data: {
          ...(nextRequirements ? { pickingRequirementSnapshot: nextRequirements } : {}),
          actualQty: complete ? Number(item.requestedQty ?? 0) : 0,
          pickedAt: complete ? new Date() : null,
        },
      });
    }));

    return {
      success: true,
      productId,
      actualQty: 0,
    };
  }

  async switchOverseasPickingBatchItemToChina(
    batchIdRaw: string,
    itemIdRaw: string,
  ): Promise<{ success: true; itemId: string; dispatchMode: string; batchDeleted: boolean;
  }> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const itemId = parseId(itemIdRaw, 'itemId');
    const item = await this.prisma.overseasPickingBatchItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        batchId: true,
        source: true,
        sourceRecordId: true,
        productId: true,
        actualQty: true,
        dispatchMode: true,
        pickingRequirementSnapshot: true,
      },
    });
    if (!item || item.batchId !== batchId) {
      throw new NotFoundException(`拣货批次明细不存在: ${itemIdRaw}`);
    }

    const batch = await this.prisma.overseasPickingBatch.findUnique({
      where: { id: batchId },
      select: { id: true, status: true },
    });
    if (!batch) {
      throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
    }
    if (batch.status !== OVERSEAS_PICKING_BATCH_STATUS.CREATED) {
      throw new BadRequestException('当前拣货批次已确认，不能再切换发货方式');
    }
    if (this.isChinaDispatchMode(item.dispatchMode)) {
      throw new NotFoundException(`拣货批次明细不存在可切中国发的订单: ${itemIdRaw}`);
    }
    if (
      Number(item.actualQty ?? 0) > 0
      || this.parseOverseasPickingRequirementSnapshot(item.pickingRequirementSnapshot)
        .some((requirement) => requirement.pickedQty > 0)
    ) {
      throw new BadRequestException(`产品 ${item.productId} 已开始扫码拣货，不能再切换到中国发`);
    }

    const manualSwitchScope =
      item.source === 'manual'
        ? await this.resolveXyjgManualOrderSwitchScope(batchId, [item.sourceRecordId])
        : { manualIds: [] as bigint[], batchItemIds: [] as bigint[], pickedItems: [] as OverseasPickingScopePickedItem[],
          };
    const amazonSwitchScope =
      item.source === 'amazon'
        ? await this.resolveAmazonOrderSwitchScope(batchId, [item.sourceRecordId])
        : { amazonIds: [] as bigint[], batchItemIds: [] as bigint[], pickedItems: [] as OverseasPickingScopePickedItem[],
          };
    this.assertNoPickedItemsBeforeSwitchingOrderScopeToChina([
      ...amazonSwitchScope.pickedItems,
      ...manualSwitchScope.pickedItems,
    ]);
    const targetItemIds = Array.from(
      new Set([item.id, ...amazonSwitchScope.batchItemIds, ...manualSwitchScope.batchItemIds]),
    );

    const batchDeleted = await this.prisma.$transaction(async (tx) => {
      if (item.source === 'rakuten') {
        await tx.rakutenOrderRecord.update({
          where: { deletedAt: null, id: item.sourceRecordId },
          data: {
            dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
          },
        });
      } else if (item.source === 'amazon') {
        const targetAmazonIds = amazonSwitchScope.amazonIds.length
          ? amazonSwitchScope.amazonIds
          : [item.sourceRecordId];
        await tx.amazonOrderRecord.updateMany({
          where: { id: { in: targetAmazonIds } },
          data: {
            dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
          },
        });
      } else {
        const targetManualIds = manualSwitchScope.manualIds.length
          ? manualSwitchScope.manualIds
          : [item.sourceRecordId];
        await (tx as any).manualOrderRecord.updateMany({
          where: { id: { in: targetManualIds } },
          data: {
            dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
          },
        });
      }
      await tx.overseasPickingBatchItem.deleteMany({
        where: {
          id: {
            in: targetItemIds,
          },
        },
      });

      return this.recalculateOverseasPickingBatchAfterItemRemoval(tx, batchId);
    });

    if (item.source === 'manual') {
      await this.syncManualOrderIdsToXyjgBestEffort(
        manualSwitchScope.manualIds.length ? manualSwitchScope.manualIds : [item.sourceRecordId],
      );
    }
    return {
      success: true,
      itemId: item.id.toString(),
      dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
      batchDeleted,
    };
  }

  private async resolveAmazonOrderSwitchScope(
    batchId: bigint,
    seedAmazonIds: bigint[],
  ): Promise<{ amazonIds: bigint[]; batchItemIds: bigint[]; pickedItems: OverseasPickingScopePickedItem[];
  }> {
    const normalizedSeedIds = Array.from(new Set(seedAmazonIds.map((id) => id.toString()))).map((id) => BigInt(id));
    if (!normalizedSeedIds.length) {
      return { amazonIds: [], batchItemIds: [], pickedItems: [] };
    }

    const seedRows = await this.prisma.amazonOrderRecord.findMany({
      where: {
        ...PROCESSABLE_AMAZON_ORDER_WHERE,
        id: {
          in: normalizedSeedIds,
        },
      },
      select: {
        orderId: true,
      },
    });
    const orderIds = Array.from(
      new Set(seedRows.map((row) => String(row.orderId ?? '').trim()).filter((orderId) => orderId.length > 0)),
    );
    if (!orderIds.length) {
      return { amazonIds: normalizedSeedIds, batchItemIds: [], pickedItems: [],
      };
    }

    const scopedRows = await this.prisma.amazonOrderRecord.findMany({
      where: {
        ...PROCESSABLE_AMAZON_ORDER_WHERE,
        orderId: {
          in: orderIds,
        },
      },
      select: {
        id: true,
      },
    });
    const scopedAmazonIds = Array.from(new Set(scopedRows.map((row) => row.id.toString()))).map((id) => BigInt(id));
    if (!scopedAmazonIds.length) {
      return { amazonIds: normalizedSeedIds, batchItemIds: [], pickedItems: [],
      };
    }

    const batchItems = await this.prisma.overseasPickingBatchItem.findMany({
      where: {
        batchId,
        source: 'amazon',
        sourceRecordId: {
          in: scopedAmazonIds,
        },
        OR: [{ dispatchMode: '' }, { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }],
      },
      select: {
        id: true,
        sourceRecordId: true,
        productId: true,
        actualQty: true,
      },
    });

    return {
      amazonIds: Array.from(new Set(batchItems.map((item) => item.sourceRecordId.toString()))).map((id) => BigInt(id)),
      batchItemIds: batchItems.map((item) => item.id),
      pickedItems: this.buildPickedScopeItems(batchItems, '亚马逊订单'),
    };
  }

  private async resolveXyjgManualOrderSwitchScope(
    batchId: bigint,
    seedManualIds: bigint[],
  ): Promise<{ manualIds: bigint[]; batchItemIds: bigint[]; pickedItems: OverseasPickingScopePickedItem[];
  }> {
    const normalizedSeedIds = Array.from(new Set(seedManualIds.map((id) => id.toString()))).map((id) => BigInt(id));
    if (!normalizedSeedIds.length) {
      return { manualIds: [], batchItemIds: [], pickedItems: [] };
    }

    const seedRows = (await (this.prisma as any).manualOrderRecord.findMany({
      where: {
        id: {
          in: normalizedSeedIds,
        },
      },
    })) as ManualOrderRecordLike[];
    const xyjgSeeds = seedRows
      .map((row) => ({
        orderId: String(row.orderId ?? '').trim(),
        bloggerCooperationId: this.resolveManualOrderBloggerCooperationId(row),
      }))
      .filter((row) => row.orderId && row.bloggerCooperationId);
    if (!xyjgSeeds.length) {
      return { manualIds: normalizedSeedIds, batchItemIds: [], pickedItems: [],
      };
    }

    const orderIds = Array.from(new Set(xyjgSeeds.map((row) => row.orderId)));
    const candidateRows = (await (this.prisma as any).manualOrderRecord.findMany({
      where: {
        orderId: {
          in: orderIds,
        },
      },
    })) as ManualOrderRecordLike[];
    const seedKeys = new Set(xyjgSeeds.map((row) => `${row.orderId}\u001f${row.bloggerCooperationId}`));
    const scopedManualIds = Array.from(
      new Set(
        candidateRows
          .filter((row) =>
            seedKeys.has(
              `${String(row.orderId ?? '').trim()}\u001f${this.resolveManualOrderBloggerCooperationId(row) ?? ''}`,
            ),
          )
          .map((row) => row.id.toString()),
      ),
    ).map((id) => BigInt(id));

    if (!scopedManualIds.length) {
      return { manualIds: normalizedSeedIds, batchItemIds: [], pickedItems: [],
      };
    }

    const batchItems = await this.prisma.overseasPickingBatchItem.findMany({
      where: {
        batchId,
        source: 'manual',
        sourceRecordId: {
          in: scopedManualIds,
        },
        OR: [{ dispatchMode: '' }, { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }],
      },
      select: {
        id: true,
        sourceRecordId: true,
        productId: true,
        actualQty: true,
      },
    });

    return {
      manualIds: Array.from(new Set(batchItems.map((item) => item.sourceRecordId.toString()))).map((id) => BigInt(id)),
      batchItemIds: batchItems.map((item) => item.id),
      pickedItems: this.buildPickedScopeItems(batchItems, '手动订单'),
    };
  }

  private buildPickedScopeItems(
    items: Array<{ productId: string; actualQty: number | null }>,
    sourceLabel: string,
  ): OverseasPickingScopePickedItem[] {
    return items
      .filter((item) => Number(item.actualQty ?? 0) > 0)
      .map((item) => ({
        sourceLabel,
        productId: item.productId,
        actualQty: Number(item.actualQty ?? 0),
      }));
  }

  private assertNoPickedItemsBeforeSwitchingOrderScopeToChina(items: OverseasPickingScopePickedItem[]): void {
    if (!items.length) {
      return;
    }
    const itemText = items
      .map((item) => `${item.sourceLabel} 产品 ${item.productId} 已拣 ${item.actualQty} 个`)
      .join('、');
    throw new BadRequestException(`同一订单已有商品完成拣货，请先将商品放回并重置拣货后再踢出该批次：${itemText}`);
  }

  async resetOverseasPickingBatchItemPicking(
    batchIdRaw: string,
    itemIdRaw: string,
  ): Promise<{ success: true; itemId: string; actualQty: number }> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const itemId = parseId(itemIdRaw, 'itemId');
    const item = await this.prisma.overseasPickingBatchItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        batchId: true,
        productId: true,
        actualQty: true,
        dispatchMode: true,
      },
    });
    if (!item || item.batchId !== batchId) {
      throw new NotFoundException(`拣货批次明细不存在: ${itemIdRaw}`);
    }

    const batch = await this.prisma.overseasPickingBatch.findUnique({
      where: { id: batchId },
      select: { id: true, status: true },
    });
    if (!batch) {
      throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
    }
    if (batch.status !== OVERSEAS_PICKING_BATCH_STATUS.CREATED) {
      throw new BadRequestException('当前拣货批次已确认，不能再变更拣货状态');
    }
    if (this.isChinaDispatchMode(item.dispatchMode)) {
      throw new BadRequestException(`产品 ${item.productId} 已切换为中国发，不能重置为未拣货`);
    }
    if (Number(item.actualQty ?? 0) <= 0) {
      return {
        success: true,
        itemId: item.id.toString(),
        actualQty: 0,
      };
    }

    await this.prisma.overseasPickingBatchItem.update({
      where: { id: item.id },
      data: {
        actualQty: 0,
        pickedAt: null,
      },
    });

    return {
      success: true,
      itemId: item.id.toString(),
      actualQty: 0,
    };
  }

  async removeOverseasPickingBatchItem(
    batchIdRaw: string,
    itemIdRaw: string,
  ): Promise<{ success: true; itemId: string; removedItemIds: string[]; batchDeleted: boolean;
  }> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const itemId = parseId(itemIdRaw, 'itemId');
    const item = await this.prisma.overseasPickingBatchItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        batchId: true,
        source: true,
        sourceRecordId: true,
        dispatchMode: true,
      },
    });
    if (!item || item.batchId !== batchId) {
      throw new NotFoundException(`拣货批次明细不存在: ${itemIdRaw}`);
    }

    const batch = await this.prisma.overseasPickingBatch.findUnique({
      where: { id: batchId },
      select: { id: true, status: true },
    });
    if (!batch) {
      throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
    }
    if (batch.status !== OVERSEAS_PICKING_BATCH_STATUS.CREATED) {
      throw new BadRequestException('当前拣货批次已确认，不能再踢出订单');
    }

    const amazonRemoveScope =
      item.source === 'amazon' && !this.isChinaDispatchMode(item.dispatchMode)
        ? await this.resolveAmazonOrderSwitchScope(batchId, [item.sourceRecordId])
        : { amazonIds: [] as bigint[], batchItemIds: [] as bigint[], pickedItems: [] as OverseasPickingScopePickedItem[],
          };
    this.assertNoPickedItemsBeforeSwitchingOrderScopeToChina(amazonRemoveScope.pickedItems);
    const targetItemIds = Array.from(new Set([item.id, ...amazonRemoveScope.batchItemIds]));

    const batchDeleted = await this.prisma.$transaction(async (tx) => {
      await tx.overseasPickingBatchItem.deleteMany({
        where: {
          id: {
            in: targetItemIds,
          },
        },
      });

      const resetDispatchMode =
        this.isChinaDispatchMode(item.dispatchMode)
          ? OVERSEAS_DISPATCH_MODE.OVERSEAS
          : null;
      if (item.source === 'rakuten' && resetDispatchMode) {
        await tx.rakutenOrderRecord.update({
          where: { deletedAt: null, id: item.sourceRecordId },
          data: {
            dispatchMode: resetDispatchMode,
          },
        });
      }
      if (item.source === 'amazon' && resetDispatchMode) {
        await tx.amazonOrderRecord.update({
          where: { id: item.sourceRecordId },
          data: {
            dispatchMode: resetDispatchMode,
          },
        });
      }
      if (item.source === 'manual' && resetDispatchMode) {
        await (tx as any).manualOrderRecord.update({
          where: { id: item.sourceRecordId },
          data: {
            dispatchMode: resetDispatchMode,
          },
        });
      }

      return this.recalculateOverseasPickingBatchAfterItemRemoval(tx, batchId);
    });

    return {
      success: true,
      itemId: item.id.toString(),
      removedItemIds: targetItemIds.map((id) => id.toString()),
      batchDeleted,
    };
  }

  async confirmOverseasPickingBatch(
    batchIdRaw: string,
    payload: OverseasPickingBatchConfirmPayload,
    operatorId: bigint,
  ): Promise<OverseasPickingBatchConfirmResult> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const actualQtyByItemId = this.parseOverseasPickingBatchActualQtyPayload(payload);

    return stockTransaction(this.prisma, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM overseas_picking_batches WHERE id = ${batchId} FOR UPDATE`);
    const batch = await tx.overseasPickingBatch.findUnique({
      where: { id: batchId },
      include: {
        items: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!batch) {
      throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
    }
    if (batch.status === OVERSEAS_PICKING_BATCH_STATUS.PICKED && batch.confirmedAt) {
      return {
        id: batch.id.toString(),
        batchNo: batch.batchNo,
        status: batch.status,
        confirmedAt: batch.confirmedAt.toISOString(),
      };
    }
    if (batch.status !== OVERSEAS_PICKING_BATCH_STATUS.CREATED) {
      throw new BadRequestException('当前拣货批次已确认，不能重复扣库存');
    }
    if (!batch.items.length) {
      throw new BadRequestException('当前拣货批次没有可确认的明细');
    }

    const normalizedItems = batch.items.map((item) => {
      const requestedQty = Number(item.requestedQty ?? 0);
      const actualQty = actualQtyByItemId.get(item.id.toString()) ?? Number(item.actualQty ?? 0);
      const dispatchMode = String(item.dispatchMode ?? OVERSEAS_DISPATCH_MODE.OVERSEAS).trim();
      if (this.isChinaDispatchMode(dispatchMode)) {
        return {
          ...item,
          requestedQty,
          actualQty: 0,
          dispatchMode,
        };
      }
      const pickingRequirements = this.parseOverseasPickingRequirementSnapshot(
        item.pickingRequirementSnapshot,
      );
      const incompleteRequirement = pickingRequirements.find(
        (requirement) => requirement.pickedQty < requirement.requestedQty,
      );
      if (incompleteRequirement) {
        throw new BadRequestException(
          `产品 ${incompleteRequirement.productId} 拣货未完成，应拣 ${incompleteRequirement.requestedQty}，已拣 ${incompleteRequirement.pickedQty}`,
        );
      }
      if (!Number.isInteger(actualQty) || actualQty <= 0) {
        throw new BadRequestException(
          `产品 ${item.productId} 尚未完成拣货，请先扫码完成拣货；如需转中国发，请返回待处理订单汇总操作`,
        );
      }
      if (actualQty !== requestedQty) {
        throw new BadRequestException(`产品 ${item.productId} 拣货未完成，应拣 ${requestedQty}，已拣 ${actualQty}`);
      }
      return {
        ...item,
        requestedQty,
        actualQty,
        dispatchMode,
      };
    });
    this.assertOverseasPickingBatchMatchesOrders(normalizedItems);

      const demandByProductId = new Map<string, number>();
      normalizedItems.forEach((item) => {
        if (item.dispatchMode !== OVERSEAS_DISPATCH_MODE.OVERSEAS) {
          return;
        }
        const key = item.productId;
        demandByProductId.set(key, (demandByProductId.get(key) ?? 0) + item.actualQty);
      });

      const productIds = Array.from(demandByProductId.keys());
      if (productIds.length) {
        await lockStockProducts(tx, productIds);
      }
      const inventoryRows = await availableStock(tx, productIds, { excludePickingBatchId: batch.id });
      const inventoryRowsByProductId = new Map<string, typeof inventoryRows>();
      inventoryRows.forEach((row) => {
        const key = String(row.productId ?? '').trim();
        const list = inventoryRowsByProductId.get(key);
        if (list) {
          list.push(row);
        } else {
          inventoryRowsByProductId.set(key, [row]);
        }
      });

      const products = productIds.length
        ? await tx.masterProduct.findMany({
            where: { productId: { in: productIds } },
            select: {
              productId: true,
              productType: true,
              bomComponents: {
                orderBy: [{ position: 'asc' }, { id: 'asc' }],
                select: {
                  componentProductId: true,
                  quantity: true,
                  componentProduct: {
                    select: {
                      productId: true,
                      productName: true,
                      productType: true,
                      stockQty: true,
                      status: true,
                    },
                  },
                },
              },
            },
          })
        : [];
      const productById = new Map(products.map((row) => [row.productId, row] as const));
      const bomSnapshotByProductId = new Map<string, ShoulderStrapBomSnapshotItem[]>();
      for (const item of normalizedItems) {
        const snapshot = this.parseShoulderStrapBomSnapshot(item.bomSnapshot);
        if (snapshot === null) continue;
        const existing = bomSnapshotByProductId.get(item.productId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
          throw new ConflictException(`产品 ${item.productId} 的批次 BOM 快照不一致，请重新创建批次`);
        }
        bomSnapshotByProductId.set(item.productId, snapshot);
      }
      const snapshotComponentProductIds = Array.from(
        new Set(
          Array.from(bomSnapshotByProductId.values())
            .flat()
            .map((item) => item.componentProductId),
        ),
      );
      const snapshotComponents = snapshotComponentProductIds.length
        ? await tx.masterProduct.findMany({
            where: { productId: { in: snapshotComponentProductIds } },
            select: {
              productId: true,
              productName: true,
              productType: true,
              stockQty: true,
              status: true,
            },
          })
        : [];
      const snapshotComponentById = new Map(
        snapshotComponents.map((component) => [component.productId, component] as const),
      );
      const finishedDemandByProductId = new Map<string, number>();
      const componentDemandByProductId = new Map<
        string,
        {
          componentProductId: string;
          componentProductName: string;
          stockQty: number;
          requiredQty: number;
        }
      >();

      const frozenFinishedDemandByProductId = new Map<string, number>();
      normalizedItems.forEach((item) => {
        if (item.dispatchMode !== OVERSEAS_DISPATCH_MODE.OVERSEAS) return;
        const pickingRequirements = this.parseOverseasPickingRequirementSnapshot(
          item.pickingRequirementSnapshot,
        );
        const frozenFinishedQty = pickingRequirements.length
          ? pickingRequirements
              .filter((requirement) => requirement.productId === item.productId)
              .reduce((sum, requirement) => sum + requirement.requestedQty, 0)
          : this.parseOverseasPickingPlanSnapshot(item.pickingPlanSnapshot)
              .reduce((sum, plan) => sum + Number(plan.pickQty ?? 0), 0);
        frozenFinishedDemandByProductId.set(
          item.productId,
          (frozenFinishedDemandByProductId.get(item.productId) ?? 0) + frozenFinishedQty,
        );
      });

      for (const [productId, totalQty] of demandByProductId.entries()) {
        const rows = inventoryRowsByProductId.get(productId) ?? [];
        const finishedStock = rows.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
        const frozenFinishedDemand = frozenFinishedDemandByProductId.get(productId);
        const finishedDemand = frozenFinishedDemand === undefined
          ? Math.min(finishedStock, totalQty)
          : frozenFinishedDemand;
        if (finishedDemand < 0 || finishedDemand > totalQty) {
          throw new ConflictException(`产品 ${productId} 的冻结拣货方案无效，请重新创建批次`);
        }
        if (finishedStock < finishedDemand) {
          throw new ConflictException(
            `产品 ${productId} 的成品库存与冻结拣货方案不一致，计划扣减 ${finishedDemand}，当前仅 ${finishedStock}，请重新创建批次`,
          );
        }
        const assemblyDemand = totalQty - finishedDemand;
        finishedDemandByProductId.set(productId, finishedDemand);
        if (assemblyDemand <= 0) continue;

        const product = productById.get(productId);
        const storedSnapshot = bomSnapshotByProductId.get(productId);
        const bomItems = storedSnapshot
          ? storedSnapshot.map((item) => ({
              componentProductId: item.componentProductId,
              quantity: item.quantity,
              componentProduct: snapshotComponentById.get(item.componentProductId) ?? {
                productId: item.componentProductId,
                productName: item.componentProductName,
                productType: '',
                stockQty: 0,
                status: 0,
              },
            }))
          : (product?.bomComponents ?? []);
        if (String(product?.productType ?? '').trim() !== '肩带' || !bomItems.length) {
          throw new ConflictException(
            `产品 ${productId} 成品库存不足，当前成品 ${finishedStock}，需要 ${totalQty}`,
          );
        }
        const bodyCount = bomItems.filter(
          (item) => String(item.componentProduct.productType ?? '').trim() === '肩带本体',
        ).length;
        if (bodyCount !== 1) {
          throw new ConflictException(
            `肩带 ${productId} 的 BOM 必须且只能包含一种“肩带本体”，请重新设置 BOM 并创建批次`,
          );
        }
        const invalidComponent = bomItems.find((item) => (
          Number(item.componentProduct.status) !== 1
          || !SHOULDER_STRAP_MATERIAL_TYPES.has(String(item.componentProduct.productType ?? '').trim())
        ));
        if (invalidComponent) {
          throw new ConflictException(
            `肩带 ${productId} 的 BOM 材料 ${invalidComponent.componentProductId} 已停用或类型不正确，无法组装出库`,
          );
        }
        for (const item of bomItems) {
          const requiredQty = Number(item.quantity) * assemblyDemand;
          const key = item.componentProductId;
          const existing = componentDemandByProductId.get(key);
          if (existing) {
            existing.requiredQty += requiredQty;
          } else {
            componentDemandByProductId.set(key, {
              componentProductId: item.componentProductId,
              componentProductName: item.componentProduct.productName ?? item.componentProductId,
              stockQty: Number(item.componentProduct.stockQty ?? 0),
              requiredQty,
            });
          }
        }
      }

      const componentProductIds = Array.from(componentDemandByProductId.keys()).sort();
      if (componentProductIds.length) {
        await lockStockProducts(tx, componentProductIds);
      }
      const componentInventoryProductIds = componentProductIds.filter(
        (componentProductId) => !demandByProductId.has(componentProductId),
      );
      const componentInventoryRows = await availableStock(tx, componentInventoryProductIds, { excludePickingBatchId: batch.id });
      componentInventoryRows.forEach((row) => {
        const key = String(row.productId ?? '').trim();
        const list = inventoryRowsByProductId.get(key);
        if (list) list.push(row);
        else inventoryRowsByProductId.set(key, [row]);
      });

      for (const component of componentDemandByProductId.values()) {
        const rows = inventoryRowsByProductId.get(component.componentProductId) ?? [];
        const liveStockQty = rows.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
        if (liveStockQty < component.requiredQty) {
          throw new ConflictException(
            `BOM 材料 ${component.componentProductId}（${component.componentProductName}）库存不足，当前 ${liveStockQty}，需要 ${component.requiredQty}`,
          );
        }
        const allocations = this.allocateOverseasPickingQtyAcrossBoxes(
          rows,
          component.requiredQty,
          component.componentProductId,
        );
        for (const allocation of allocations) {
          const updated = await tx.masterProductBoxInventory.updateMany({
            where: {
              boxId: allocation.boxId,
              box: { status: 1 },
              productId: component.componentProductId,
              qty: { gte: allocation.qty },
            },
            data: { qty: { decrement: allocation.qty } },
          });
          if (Number(updated.count ?? 0) !== 1) {
            throw new ConflictException(
              `BOM 材料 ${component.componentProductId} 的箱内库存已发生变化，请刷新后重新确认出库`,
            );
          }
          await tx.stockMovement.create({
            data: {
              movementType: 'outbound',
              refType: 'overseas_picking_batch',
              refId: batch.id,
              boxId: allocation.boxId,
              productId: component.componentProductId,
              qtyDelta: -allocation.qty,
              operatorId,
            },
          });
        }
      }

      for (const item of normalizedItems) {
        if (item.dispatchMode !== OVERSEAS_DISPATCH_MODE.OVERSEAS) continue;
        const remainingFinishedDemand = finishedDemandByProductId.get(item.productId) ?? 0;
        const qty = Math.min(item.actualQty, remainingFinishedDemand);
        finishedDemandByProductId.set(item.productId, remainingFinishedDemand - qty);
        if (qty <= 0) continue;
        const allocations = this.allocateOverseasPickingQtyAcrossBoxes(
          inventoryRowsByProductId.get(item.productId) ?? [],
          qty,
          item.productId,
        );

        for (const allocation of allocations) {
          const updated = await tx.masterProductBoxInventory.updateMany({
            where: {
              boxId: allocation.boxId,
              box: { status: 1 },
              productId: item.productId,
              qty: { gte: allocation.qty },
            },
            data: { qty: { decrement: allocation.qty } },
          });
          if (Number(updated.count ?? 0) !== 1) {
            throw new ConflictException(
              `产品 ${item.productId} 的箱内库存已发生变化，请刷新后重新确认出库`,
            );
          }
          await tx.stockMovement.create({
            data: {
              movementType: 'outbound',
              refType: 'overseas_picking_batch',
              refId: batch.id,
              boxId: allocation.boxId,
              productId: item.productId,
              qtyDelta: -allocation.qty,
              operatorId,
            },
          });
        }
      }

      for (const productId of Array.from(new Set([...productIds, ...componentProductIds]))) {
        const totalQty = await tx.masterProductBoxInventory.aggregate({
          where: {
            box: { status: { not: 2 } }, productId },
          _sum: { qty: true },
        });
        await tx.masterProduct.updateMany({
          where: { productId },
          data: {
            stockQty: Number(totalQty._sum.qty ?? 0),
          },
        });
      }

      await tx.overseasPickingBatch.update({
        where: { id: batch.id },
        data: {
          status: OVERSEAS_PICKING_BATCH_STATUS.PICKED,
          confirmedBy: operatorId,
          confirmedAt: new Date(),
        },
      });

    const confirmed = await tx.overseasPickingBatch.findUnique({
      where: { id: batch.id },
      select: {
        id: true,
        batchNo: true,
        status: true,
        confirmedAt: true,
      },
    });
    if (!confirmed?.confirmedAt) {
      throw new NotFoundException('拣货批次确认结果不存在，请刷新后重试');
    }

    return {
      id: confirmed.id.toString(),
      batchNo: confirmed.batchNo,
      status: confirmed.status,
      confirmedAt: confirmed.confirmedAt.toISOString(),
    };
    });
  }

  async listYamatoShipmentBatches(limitParam?: string): Promise<YamatoShipmentBatchSummary[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50) : 20;
    const rows = await this.prisma.yamatoShipmentBatch.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: { _count: { select: { pages: true } } },
    });

    const printedCounts = rows.length ? await this.prisma.yamatoShipmentBatchPage.groupBy({
      by: ['batchId'], where: { batchId: { in: rows.map(row => row.id) }, printedAt: { not: null } },
      _count: { _all: true },
    }) : [];
    const printedByBatch = new Map(printedCounts.map(row => [row.batchId.toString(), row._count._all]));

    return rows.map((row) => {
      const printedPageCount = printedByBatch.get(row.id.toString()) ?? 0;
      const pageCount = Number(row.pageCount ?? row._count.pages ?? 0);
      return {
        id: row.id.toString(),
        status: row.status,
        pageCount,
        printedPageCount,
        pendingPageCount: Math.max(pageCount - printedPageCount, 0),
        exportedFileName: row.exportedFileName ?? null,
        pdfFileName: row.pdfFileName ?? null,
        pdfUploadedAt: row.pdfUploadedAt ? row.pdfUploadedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  async getOverdueOrders() {
    const now = new Date();
    const createdAt = { lt: new Date(now.getTime() - 72 * 60 * 60 * 1000) };
    // Read all aged candidates so whitespace-only tracking numbers are also detected.
    const [rakuten, amazon, manual] = await Promise.all([
      this.prisma.rakutenOrderRecord.findMany({ where: { deletedAt: null, createdAt } }),
      this.prisma.amazonOrderRecord.findMany({ where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, createdAt } }),
      this.prisma.manualOrderRecord.findMany({ where: { createdAt } }),
    ]);
    const withoutTracking = <T extends { shipmentNo: string | null }>(rows: T[]) =>
      rows.filter((row) => !String(row.shipmentNo ?? '').trim());
    const [rakutenPending, amazonPending, manualPending] = await Promise.all([
      this.enrichOrderRows(withoutTracking(rakuten)),
      this.enrichAmazonOrderRows(withoutTracking(amazon)),
      this.enrichManualOrderRows(withoutTracking(manual) as unknown as ManualOrderRecordLike[]),
    ]);
    const rows = [
      ...rakutenPending.map((row) => ({ ...row, source: 'rakuten' })),
      ...amazonPending.map((row) => ({ ...row, source: 'amazon' })),
      ...manualPending.map((row) => ({ ...row, source: 'manual' })),
    ]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const orders = new Map<string, { source: string; id: string; orderId: string | null; createdAt: Date; waitingHours: number; lineCount: number; fulfillmentModes: string[] }>();
    for (const row of rows) {
      const orderId = row.orderId;
      const key = `${row.source}:${orderId || `record:${row.id}`}`;
      const existing = orders.get(key);
      if (existing) {
        existing.lineCount += 1;
        if (!existing.fulfillmentModes.includes(row.fulfillmentMode)) existing.fulfillmentModes.push(row.fulfillmentMode);
        continue;
      }
      orders.set(key, { source: row.source, id: String(row.id), orderId,
        createdAt: row.createdAt, waitingHours: Math.floor((now.getTime() - row.createdAt.getTime()) / 3600000), lineCount: 1, fulfillmentModes: [row.fulfillmentMode] });
    }
    return { count: orders.size, checkedAt: now.toISOString(), items: [...orders.values()] };
  }

  async list(limitParam?: string, offsetParam?: string): Promise<OrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const parsedOffset = Number(offsetParam);
    const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    const rows = await this.prisma.rakutenOrderRecord.findMany({ where: { deletedAt: null },
      orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    });
    const enrichedRows = await this.enrichOrderRows(rows);
    return enrichedRows.map((row) => ({
      ...row,
      trackingClearanceStatus: this.resolveRakutenTrackingClearanceStatusFromRow(row),
    }));
  }

  async listAmazon(limitParam?: string, offsetParam?: string): Promise<AmazonOrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const parsedOffset = Number(offsetParam);
    const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    const rows = await this.prisma.amazonOrderRecord.findMany({
      where: PROCESSABLE_AMAZON_ORDER_WHERE,
      orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    });
    return this.enrichAmazonOrderRows(rows);
  }

  async resolveRakutenXiyaManualAction(
    idRaw: string,
    username: string,
  ): Promise<{
    orderId: string | null;
    resolvedCount: number;
    resolvedAt: string;
  }> {
    const id = parseId(idRaw, "id");
    const row = await this.prisma.rakutenOrderRecord.findUnique({
      where: { deletedAt: null, id },
    });
    if (!row) throw new NotFoundException("乐天订单不存在");
    if (!row.rmsManualActionDetectedAt || row.rmsManualActionResolvedAt) {
      throw new BadRequestException("该订单当前没有待处理的 Xiya 人工通知提醒");
    }
    const orderId = String(row.orderId ?? "").trim();
    const resolvedAt = new Date();
    const result = await this.prisma.rakutenOrderRecord.updateMany({
      where: { deletedAt: null,
        ...(orderId ? { orderId } : { id }),
        rmsManualActionDetectedAt: { not: null },
        rmsManualActionResolvedAt: null,
      },
      data: {
        rmsManualActionResolvedAt: resolvedAt,
        rmsManualActionResolvedBy:
          String(username ?? "")
            .trim()
            .slice(0, 64) || "unknown",
      },
    });
    return {
      orderId: orderId || null,
      resolvedCount: result.count,
      resolvedAt: resolvedAt.toISOString(),
    };
  }

  async listAmazonManualOrders(limitParam?: string, offsetParam?: string): Promise<ManualOrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const parsedOffset = Number(offsetParam);
    const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    const rows = await (this.prisma as any).manualOrderRecord.findMany({
      orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    });
    return this.enrichManualOrderRows(rows as ManualOrderRecordLike[]);
  }

  async searchOrders(queryRaw?: string): Promise<UnifiedOrderSearchResult> {
    const query = String(queryRaw ?? '').trim();
    if (!query) {
      throw new BadRequestException('请输入注文番号、收件人或电话');
    }

    const normalizedOrderId = this.normalizeSearchOrderId(query);
    const [rakutenExactIds, amazonExactIds, manualExactIds] = await Promise.all([
      this.findOrderIdsByNormalizedOrderId('rakuten', normalizedOrderId, 300),
      this.findOrderIdsByNormalizedOrderId('amazon', normalizedOrderId, 300),
      this.findOrderIdsByNormalizedOrderId('manual', normalizedOrderId, 300),
    ]);
    const [rakutenExactRows, amazonExactRows, manualExactRows]: [
      RakutenOrderRecord[],
      AmazonOrderRecord[],
      ManualOrderRecordLike[],
    ] = await Promise.all([
      rakutenExactIds.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: { deletedAt: null, id: { in: rakutenExactIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonExactIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, id: { in: amazonExactIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as AmazonOrderRecord[]),
      manualExactIds.length
        ? ((this.prisma as any).manualOrderRecord.findMany({
            where: { id: { in: manualExactIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          }) as Promise<ManualOrderRecordLike[]>)
        : Promise.resolve([] as ManualOrderRecordLike[]),
    ]);

    const hasExactMatch = Boolean(rakutenExactRows.length || amazonExactRows.length || manualExactRows.length);
    if (hasExactMatch) {
      const matches = await this.buildUnifiedOrderSearchRows(rakutenExactRows, amazonExactRows, manualExactRows);
      const customerKeys = this.extractUnifiedOrderCustomerKeys(rakutenExactRows, amazonExactRows, manualExactRows);
      const historyRows = await this.findUnifiedOrdersByCustomerKeys(
        customerKeys.names,
        customerKeys.phoneDigits,
        500);
      const matchedKeys = new Set(matches.map((row) => `${row.source}:${row.id}`));
      return {
        query,
        mode: 'order',
        matches,
        history: historyRows.filter((row) => !matchedKeys.has(`${row.source}:${row.id}`)),
      };
    }

    return {
      query,
      mode: 'customer',
      matches: await this.findUnifiedOrdersByCustomerQuery(query, 500),
      history: [],
    };
  }

  async searchOrderSuggestions(queryRaw?: string): Promise<UnifiedOrderSearchSuggestion[]> {
    const query = String(queryRaw ?? '').trim();
    if (!query) {
      return [];
    }

    const normalizedOrderId = this.normalizeSearchOrderId(query);
    const phoneDigits = this.normalizeSearchPhoneDigits(query);
    const limit = 20;
    const [orderIdSuggestions, phoneSuggestions, recipientNameSuggestions] = await Promise.all([
      normalizedOrderId
        ? this.findOrderSearchSuggestionsByNormalizedColumn('orderId', normalizedOrderId, limit)
        : Promise.resolve([]),
      phoneDigits ? this.findOrderSearchSuggestionsByNormalizedColumn('phone', phoneDigits, limit) : Promise.resolve([]),
      this.findRecipientNameSuggestions(query, limit),
    ]);

    const seen = new Set<string>();
    return [...orderIdSuggestions, ...recipientNameSuggestions, ...phoneSuggestions]
      .filter((suggestion) => {
        const key = `${suggestion.type}:${suggestion.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 50);
  }

  async getOrderDetail(sourceRaw: string, idRaw: string): Promise<unknown> {
    const source = String(sourceRaw ?? '').trim();
    const id = parseId(idRaw, 'id');

    if (source === 'rakuten') {
      const row = await this.prisma.rakutenOrderRecord.findUnique({ where: { deletedAt: null, id },
      });
      if (!row) {
        throw new NotFoundException(`乐天订单不存在: ${idRaw}`);
      }
      const [enriched] = await this.enrichOrderRows([row]);
      return enriched;
    }

    if (source === 'amazon') {
      const row = await this.prisma.amazonOrderRecord.findFirst({
        where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, id },
      });
      if (!row) {
        throw new NotFoundException(`亚马逊订单不存在: ${idRaw}`);
      }
      const [enriched] = await this.enrichAmazonOrderRows([row]);
      return enriched;
    }

    if (source === 'manual') {
      const row = await (this.prisma as any).manualOrderRecord.findUnique({ where: { id },
      });
      if (!row) {
        throw new NotFoundException(`手动订单不存在: ${idRaw}`);
      }
      const [enriched] = await this.enrichManualOrderRows([row as ManualOrderRecordLike]);
      return enriched;
    }

    throw new BadRequestException('source 只支持 rakuten、amazon 或 manual');
  }

  private async findOrderSearchSuggestionsByNormalizedColumn(
    type: 'orderId' | 'phone',
    normalizedFragment: string,
    limit: number,
  ): Promise<UnifiedOrderSearchSuggestion[]> {
    const configs = [
      {
        sourceLabel: '乐天',
        tableName: 'rakuten_order_records',
        valueColumn: type === 'orderId' ? 'order_id' : 'shipping_phone',
      },
      {
        sourceLabel: '亚马逊',
        tableName: 'amazon_order_records',
        valueColumn: type === 'orderId' ? 'order_id' : 'buyer_phone_number',
      },
      {
        sourceLabel: '手动订单',
        tableName: 'manual_order_records',
        valueColumn: type === 'orderId' ? 'order_id' : 'buyer_phone_number',
      },
    ];
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
    const normalizedSql =
      type === 'orderId'
        ? `UPPER(REGEXP_REPLACE(COALESCE(value_column_placeholder, ''), '[^0-9A-Za-z]', ''))`
        : `REGEXP_REPLACE(COALESCE(value_column_placeholder, ''), '[^0-9]', '')`;
    const rowsBySource = await Promise.all(
      configs.map(async (config) => {
        const sourceFilter = config.tableName === 'amazon_order_records'
          ? "AND source_kind <> 'sp_api'"
          : '';
        const rows = await this.prisma.$queryRawUnsafe<Array<{ value: string | null }>>(
          `SELECT ${config.valueColumn} AS value
           FROM ${config.tableName}
           WHERE ${normalizedSql.replace('value_column_placeholder', config.valueColumn)} LIKE ?
             ${sourceFilter}
             AND ${config.valueColumn} IS NOT NULL
             AND ${config.valueColumn} <> ''
           ORDER BY csv_imported_at DESC, id DESC
           LIMIT ?`,
          `%${normalizedFragment}%`,
          normalizedLimit,
        );
        return rows
          .map((row) => String(row.value ?? '').trim())
          .filter((value) => value.length > 0)
          .map((value) => ({
            type,
            value,
            sourceLabel: config.sourceLabel,
            label: `${config.sourceLabel} ${type === 'orderId' ? '注文番号' : '电话'}: ${value}`,
          }));
      }),
    );
    return rowsBySource.flat();
  }

  private async findRecipientNameSuggestions(
    query: string,
    limit: number): Promise<UnifiedOrderSearchSuggestion[]> {
    const keyword = String(query ?? '').trim();
    if (!keyword) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
    const [rakutenRows, amazonRows, manualRows] = await Promise.all([
      this.prisma.rakutenOrderRecord.findMany({
        where: { deletedAt: null, shippingName: { contains: keyword } },
        select: { shippingName: true },
        orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
        take: normalizedLimit,
      }),
      this.prisma.amazonOrderRecord.findMany({
        where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, recipientName: { contains: keyword } },
        select: { recipientName: true },
        orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
        take: normalizedLimit,
      }),
      (this.prisma as any).manualOrderRecord.findMany({
        where: { recipientName: { contains: keyword } },
        select: { recipientName: true },
        orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
        take: normalizedLimit,
      }) as Promise<Array<{ recipientName: string | null }>>,
    ]);
    return [
      ...rakutenRows.map((row) => ({ sourceLabel: '乐天', value: row.shippingName,
      })),
      ...amazonRows.map((row) => ({ sourceLabel: '亚马逊', value: row.recipientName,
      })),
      ...manualRows.map((row) => ({ sourceLabel: '手动订单', value: row.recipientName,
      })),
    ]
      .map((row) => ({ ...row, value: String(row.value ?? '').trim() }))
      .filter((row) => row.value.length > 0)
      .map((row) => ({
        type: 'recipientName' as const,
        value: row.value,
        sourceLabel: row.sourceLabel,
        label: `${row.sourceLabel} 收件人: ${row.value}`,
      }));
  }

  private async findUnifiedOrdersByCustomerQuery(
    query: string,
    limit: number): Promise<UnifiedOrderSearchRow[]> {
    const keyword = String(query ?? '').trim();
    const phoneDigits = this.normalizeSearchPhoneDigits(keyword);
    const [rakutenRows, amazonRows, manualRows] = await this.findUnifiedRawOrdersByCustomer({
      names: keyword ? [keyword] : [],
      phoneDigits: phoneDigits ? [phoneDigits] : [],
      phoneMatchMode: 'contains',
      limit,
    });
    return this.buildUnifiedOrderSearchRows(rakutenRows, amazonRows, manualRows);
  }

  private async findUnifiedOrdersByCustomerKeys(
    names: string[],
    phoneDigits: string[],
    limit: number,
  ): Promise<UnifiedOrderSearchRow[]> {
    const [rakutenRows, amazonRows, manualRows] = await this.findUnifiedRawOrdersByCustomer({
      names,
      phoneDigits,
      phoneMatchMode: 'exact',
      limit,
    });
    return this.buildUnifiedOrderSearchRows(rakutenRows, amazonRows, manualRows);
  }

  private async findUnifiedRawOrdersByCustomer(options: {
    names: string[];
    phoneDigits: string[];
    phoneMatchMode: 'contains' | 'exact';
    limit: number;
  }): Promise<[RakutenOrderRecord[], AmazonOrderRecord[], ManualOrderRecordLike[]]> {
    const names = Array.from(
      new Set(options.names.map((name) => String(name ?? '').trim()).filter((name) => name.length > 0)),
    ).slice(0, 10);
    const phoneDigits = Array.from(
      new Set(
        options.phoneDigits
          .map((phone) => this.normalizeSearchPhoneDigits(phone))
          .filter((phone) => phone.length > 0),
      ),
    ).slice(0, 10);
    if (!names.length && !phoneDigits.length) {
      return [[], [], []];
    }

    const limit = Math.max(1, Math.min(Number(options.limit) || 500, 1000));
    const [
      rakutenNameRows,
      amazonNameRows,
      manualNameRows,
      rakutenPhoneIds,
      amazonPhoneIds,
      manualPhoneIds] = await Promise.all([
      names.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: { deletedAt: null, OR: names.map((name) => ({ shippingName: { contains: name } })),
              },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
            take: limit,
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      names.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: {
              ...PROCESSABLE_AMAZON_ORDER_WHERE,
              OR: names.map((name) => ({ recipientName: { contains: name } })),
              },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
            take: limit,
          })
        : Promise.resolve([] as AmazonOrderRecord[]),
      names.length
        ? ((this.prisma as any).manualOrderRecord.findMany({
            where: { OR: names.map((name) => ({ recipientName: { contains: name } })),
              },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
            take: limit,
          }) as Promise<ManualOrderRecordLike[]>)
        : Promise.resolve([] as ManualOrderRecordLike[]),
      this.findOrderIdsByNormalizedPhone('rakuten', phoneDigits, options.phoneMatchMode, limit),
      this.findOrderIdsByNormalizedPhone('amazon', phoneDigits, options.phoneMatchMode, limit),
      this.findOrderIdsByNormalizedPhone('manual', phoneDigits, options.phoneMatchMode, limit),
    ]);

    const [rakutenPhoneRows, amazonPhoneRows, manualPhoneRows] = await Promise.all([
      rakutenPhoneIds.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: { deletedAt: null, id: { in: rakutenPhoneIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonPhoneIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, id: { in: amazonPhoneIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as AmazonOrderRecord[]),
      manualPhoneIds.length
        ? ((this.prisma as any).manualOrderRecord.findMany({
            where: { id: { in: manualPhoneIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          }) as Promise<ManualOrderRecordLike[]>)
        : Promise.resolve([] as ManualOrderRecordLike[]),
    ]);

    return [
      this.mergeRowsById(rakutenNameRows, rakutenPhoneRows).slice(0, limit),
      this.mergeRowsById(amazonNameRows, amazonPhoneRows).slice(0, limit),
      this.mergeRowsById(manualNameRows, manualPhoneRows).slice(0, limit),
    ];
  }

  private extractUnifiedOrderCustomerKeys(
    rakutenRows: RakutenOrderRecord[],
    amazonRows: AmazonOrderRecord[],
    manualRows: ManualOrderRecordLike[],
  ): { names: string[]; phoneDigits: string[] } {
    const names = new Set<string>();
    const phoneDigits = new Set<string>();
    rakutenRows.forEach((row) => {
      const name = String(row.shippingName ?? '').trim();
      const phone = this.normalizeSearchPhoneDigits(row.shippingPhone);
      if (name) names.add(name);
      if (phone) phoneDigits.add(phone);
    });
    [...amazonRows, ...manualRows].forEach((row) => {
      const name = String(row.recipientName ?? '').trim();
      const phone = this.normalizeSearchPhoneDigits(row.buyerPhoneNumber);
      if (name) names.add(name);
      if (phone) phoneDigits.add(phone);
    });
    return {
      names: Array.from(names),
      phoneDigits: Array.from(phoneDigits),
    };
  }

  private async findOrderIdsByNormalizedPhone(
    source: UnifiedOrderSearchSource,
    phoneDigits: string[],
    matchMode: 'contains' | 'exact',
    limit: number,
  ): Promise<bigint[]> {
    if (!phoneDigits.length) {
      return [];
    }

    const tableConfig = {
      rakuten: { tableName: 'rakuten_order_records', phoneColumn: 'shipping_phone',
      },
      amazon: { tableName: 'amazon_order_records', phoneColumn: 'buyer_phone_number',
      },
      manual: { tableName: 'manual_order_records', phoneColumn: 'buyer_phone_number',
      },
    }[source];
    const normalizedPhoneSql = `REGEXP_REPLACE(COALESCE(${tableConfig.phoneColumn}, ''), '[^0-9]', '')`;
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
    const params =
      matchMode === 'exact'
        ? [...phoneDigits, normalizedLimit]
        : [`%${phoneDigits[0]}%`, normalizedLimit];
    const whereSql =
      matchMode === 'exact'
        ? `${normalizedPhoneSql} IN (${phoneDigits.map(() => '?').join(', ')})`
        : `${normalizedPhoneSql} LIKE ?`;
    const sourceFilter = source === 'amazon' ? " AND source_kind <> 'sp_api'" : '';
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: bigint | number | string }>>(
      `SELECT id FROM ${tableConfig.tableName} WHERE ${whereSql}${sourceFilter} ORDER BY csv_imported_at DESC, id DESC LIMIT ?`,
      ...params,
    );
    return rows
      .map((row) => this.parseBigIntId(row.id))
      .filter((id): id is bigint => id !== null);
  }

  private async findOrderIdsByNormalizedOrderId(
    source: UnifiedOrderSearchSource,
    normalizedOrderId: string,
    limit: number,
  ): Promise<bigint[]> {
    if (!normalizedOrderId) {
      return [];
    }

    const tableName = {
      rakuten: 'rakuten_order_records',
      amazon: 'amazon_order_records',
      manual: 'manual_order_records',
    }[source];
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 300, 1000));
    const sourceFilter = source === 'amazon' ? " AND source_kind <> 'sp_api'" : '';
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: bigint | number | string }>>(
      `SELECT id FROM ${tableName}
       WHERE UPPER(REGEXP_REPLACE(COALESCE(order_id, ''), '[^0-9A-Za-z]', '')) = ?
       ${sourceFilter}
       ORDER BY csv_imported_at DESC, id DESC
       LIMIT ?`,
      normalizedOrderId,
      normalizedLimit,
    );
    return rows
      .map((row) => this.parseBigIntId(row.id))
      .filter((id): id is bigint => id !== null);
  }

  private async buildUnifiedOrderSearchRows(
    rakutenRows: RakutenOrderRecord[],
    amazonRows: AmazonOrderRecord[],
    manualRows: ManualOrderRecordLike[],
  ): Promise<UnifiedOrderSearchRow[]> {
    const [rakutenEnrichedRows, amazonEnrichedRows, manualEnrichedRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
      this.enrichManualOrderRows(manualRows),
    ]);

    const rows: UnifiedOrderSearchRow[] = [
      ...rakutenEnrichedRows.map((row) => this.toUnifiedOrderSearchRow('rakuten', row)),
      ...amazonEnrichedRows.map((row) => this.toUnifiedOrderSearchRow('amazon', row)),
      ...manualEnrichedRows.map((row) => this.toUnifiedOrderSearchRow('manual', row)),
    ];
    rows.sort((left, right) => {
      const leftTime = new Date(left.csvImportedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.csvImportedAt || right.createdAt || 0).getTime();
      if (rightTime !== leftTime) return rightTime - leftTime;
      return Number(right.id) - Number(left.id);
    });
    return rows;
  }

  private toUnifiedOrderSearchRow(
    source: 'rakuten',
    row: OrderListItem): UnifiedOrderSearchRow;
  private toUnifiedOrderSearchRow(
    source: 'amazon',
    row: AmazonEnrichedOrderListItem): UnifiedOrderSearchRow;
  private toUnifiedOrderSearchRow(
    source: 'manual',
    row: ManualEnrichedOrderListItem): UnifiedOrderSearchRow;
  private toUnifiedOrderSearchRow(
    source: UnifiedOrderSearchSource,
    row: OrderListItem | AmazonEnrichedOrderListItem | ManualEnrichedOrderListItem,
  ): UnifiedOrderSearchRow {
    if (source === 'rakuten') {
      const rakutenRow = row as OrderListItem;
      return {
        source,
        sourceLabel: '乐天',
        id: rakutenRow.id.toString(),
        orderId: rakutenRow.orderId,
        sku: rakutenRow.skuCode,
        productId: rakutenRow.resolvedProductId || rakutenRow.skuCode,
        productName: rakutenRow.resolvedProductName || rakutenRow.productName,
        quantity: rakutenRow.orderQuantity,
        mallName: rakutenRow.mallName,
        shopName: rakutenRow.shopName,
        recipientName: rakutenRow.shippingName,
        phone: rakutenRow.shippingPhone,
        fulfillmentMode: rakutenRow.fulfillmentMode,
        shipmentCompany: rakutenRow.shipmentCompany,
        shipmentNo: rakutenRow.shipmentNo,
        shipmentNoRegisteredAt: this.toIsoStringOrNull(rakutenRow.shipmentNoRegisteredAt),
        csvImportedAt: this.toIsoStringOrNull(rakutenRow.csvImportedAt),
        createdAt: this.toIsoStringOrNull(rakutenRow.createdAt),
      };
    }

    const amazonLikeRow = row as AmazonEnrichedOrderListItem | ManualEnrichedOrderListItem;
    return {
      source,
      sourceLabel: source === 'manual' ? '手动订单' : '亚马逊',
      id: amazonLikeRow.id.toString(),
      orderId: amazonLikeRow.orderId,
      sku: amazonLikeRow.sku,
      productId: amazonLikeRow.resolvedProductId,
      productName: amazonLikeRow.resolvedProductName || amazonLikeRow.productName,
      quantity: amazonLikeRow.quantityPurchased,
      mallName: amazonLikeRow.mallName,
      shopName: amazonLikeRow.resolvedShopName || amazonLikeRow.shopName,
      recipientName: amazonLikeRow.recipientName,
      phone: amazonLikeRow.buyerPhoneNumber,
      fulfillmentMode: amazonLikeRow.fulfillmentMode,
      shipmentCompany: amazonLikeRow.shipmentCompany,
      shipmentNo: amazonLikeRow.shipmentNo,
      shipmentNoRegisteredAt: this.toIsoStringOrNull(amazonLikeRow.shipmentNoRegisteredAt),
      csvImportedAt: this.toIsoStringOrNull(amazonLikeRow.csvImportedAt),
      createdAt: this.toIsoStringOrNull(amazonLikeRow.createdAt),
    };
  }

  private normalizeSearchPhoneDigits(value: unknown): string {
    return String(value ?? '').replace(/\D/g, '');
  }

  private normalizeSearchOrderId(value: unknown): string {
    return String(value ?? '')
      .replace(/[^0-9A-Za-z]/g, '')
      .toUpperCase();
  }

  private parseBigIntId(value: unknown): bigint | null {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) {
      return null;
    }
    return BigInt(text);
  }

  private toIsoStringOrNull(value: Date | string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
  }

  async updateRakutenOrder(idRaw: string, payload: UpdateRakutenOrderPayload,
    operatorUsername = "unknown",
  ): Promise<OrderListItem> {
    const id = parseId(idRaw, 'id');
    const current = await this.prisma.rakutenOrderRecord.findUnique({ where: { deletedAt: null, id },
    });
    if (!current) {
      throw new NotFoundException(`乐天订单不存在: ${idRaw}`);
    }
    if (payload.shipmentEditMode && !['correction', 'replacement'].includes(payload.shipmentEditMode)) {
      throw new BadRequestException('发货信息修改方式无效');
    }
    if (payload.shipmentEditMode === 'correction' && !this.hasRegisteredShipmentNo(current)) {
      throw new BadRequestException('仅已登记单号的出货包裹可更正，请先核对出货记录');
    }
    if (this.hasRegisteredShipmentNo(current)) {
      const shipmentCompany = this.normalizeEditableText(payload.shipmentCompany, '发货公司', 128);
      const shipmentNo = this.normalizeEditableText(payload.shipmentNo, '发货单号', 128);
      const changed = shipmentNo !== current.shipmentNo || shipmentCompany !== current.shipmentCompany;
      const correction = payload.shipmentEditMode === 'correction';
      if (correction) {
        if ((payload.expectedShipmentNo !== undefined && payload.expectedShipmentNo !== current.shipmentNo) ||
          (payload.expectedShipmentCompany !== undefined && payload.expectedShipmentCompany !== current.shipmentCompany) ||
          (payload.expectedWarehouseShippedAt !== undefined && payload.expectedWarehouseShippedAt !== current.warehouseShippedAt?.toISOString())) {
          throw new ConflictException('包裹信息已变化，请刷新后重新更正');
        }
        if (this.isChinaDispatchMode(current.dispatchMode) || !current.warehouseShippedAt || !shipmentNo || !shipmentCompany) {
          throw new BadRequestException('仅已确认实际出货的日本侧包裹可更正单号，请先核对出货记录');
        }
        try {
          rakutenDeliveryCompanyCode(shipmentCompany);
        } catch {
          throw new BadRequestException(`无法识别配送公司“${shipmentCompany}”，请修正后再保存`);
        }
      }
      const manualOverrideAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const token = correction && current.rmsConnectionId ? randomUUID() : null;
        if (token) {
          const locked = await tx.rakutenRmsConnection.updateMany({ where: { id: current.rmsConnectionId!, OR: [
            { automationLockToken: null }, { automationLockedAt: null },
            { automationLockedAt: { lt: new Date(Date.now() - 30 * 60_000) } },
          ] }, data: { automationLockToken: token, automationLockedAt: manualOverrideAt } });
          if (locked.count !== 1) throw new ConflictException('店铺正在回传或发送邮件，请稍后再更正单号');
        }
        // A correction must refer to the same confirmed parcel that was opened
        // for editing. Do not preserve confirmation across a concurrent change.
        if (correction) {
          await tx.$queryRaw(Prisma.sql`SELECT id FROM rakuten_order_records WHERE deleted_at IS NULL
            AND order_id = ${current.orderId} AND rms_connection_id <=> ${current.rmsConnectionId}
            AND shipment_no = ${current.shipmentNo} ORDER BY id FOR UPDATE`);
          const latest = await tx.rakutenOrderRecord.findUnique({ where: { id, deletedAt: null } });
          if (!latest || latest.shipmentNo !== current.shipmentNo || latest.shipmentCompany !== current.shipmentCompany ||
            latest.warehouseShippedAt?.getTime() !== current.warehouseShippedAt?.getTime() ||
            latest.warehouseShippedBy !== current.warehouseShippedBy || latest.dispatchMode !== current.dispatchMode ||
            latest.orderQuantity !== current.orderQuantity || latest.orderId !== current.orderId ||
            latest.rmsConnectionId !== current.rmsConnectionId || basketIdOf(latest) !== basketIdOf(current)) {
            throw new ConflictException('包裹或出货确认已变化，请刷新后重新更正');
          }
        }
        let editedRows = [current];
        if (correction && changed) {
          editedRows = (await tx.rakutenOrderRecord.findMany({ where: { deletedAt: null, orderId: current.orderId,
            rmsConnectionId: current.rmsConnectionId, shipmentNo: current.shipmentNo,
            ...(current.rmsConnectionId === null ? { shopName: current.shopName } : {}),
          }, orderBy: { id: 'asc' } })).filter((row) => basketIdOf(row) === basketIdOf(current) &&
            !this.isChinaDispatchMode(row.dispatchMode) && row.shipmentCompany === current.shipmentCompany);
          if (!editedRows.some((row) => row.id === id) || editedRows.some((row) => !row.warehouseShippedAt ||
            row.warehouseShippedAt.getTime() !== current.warehouseShippedAt!.getTime() ||
            row.warehouseShippedBy !== current.warehouseShippedBy)) {
            throw new ConflictException('同包裹明细的实际出货确认不一致，请先核对');
          }
        }
        for (const edited of editedRows) {
          await tx.rakutenOrderRecord.update({
            where: { deletedAt: null, id: edited.id },
            data: {
              shipmentCompany,
              shipmentNo,
              shipmentNoRegisteredAt: this.resolveEditedShipmentRegisteredAt(edited.shipmentNo, edited.shipmentNoRegisteredAt, shipmentNo),
              ...(changed ? {
                ...(correction ? {} : { warehouseShippedAt: null, warehouseShippedBy: null }),
                trackingStatusLabel: null,
                trackingHasCustomsClearance: false,
                trackingIsDelivered: false,
                trackingCustomsClearanceDate: null,
                trackingStatusOccurredAt: null,
                trackingCheckedAt: null,
                trackingError: null,
              } : {}),
              ...(correction && changed ? { rawPayload: {
                ...(edited.rawPayload && typeof edited.rawPayload === 'object' && !Array.isArray(edited.rawPayload) ? edited.rawPayload : {}),
                _wmsShipmentCorrectionHistory: [
                  ...(Array.isArray((edited.rawPayload as Prisma.JsonObject | null)?._wmsShipmentCorrectionHistory)
                    ? (edited.rawPayload as Prisma.JsonObject)._wmsShipmentCorrectionHistory as Prisma.JsonArray : []),
                  { at: manualOverrideAt.toISOString(), operator: this.normalizeRakutenManualOperator(operatorUsername),
                    previousShipmentNo: current.shipmentNo, shipmentNo, previousCompany: current.shipmentCompany, shipmentCompany,
                    warehouseShippedAt: current.warehouseShippedAt!.toISOString(),
                  },
                ],
              } as Prisma.InputJsonObject } : {}),
              sendStatus: this.resolveSendStatus(shipmentNo),
              rmsManualOverrideAt: manualOverrideAt,
              rmsManualOverrideBy: this.normalizeRakutenManualOperator(operatorUsername),
            },
          });
        }
        await this.freezeRelatedRakutenOrderRowsAfterManualEdit(
          tx,
          current.orderId,
          id,
          manualOverrideAt,
          operatorUsername,
        );
        if (token) await tx.rakutenRmsConnection.updateMany({ where: { id: current.rmsConnectionId!, automationLockToken: token },
          data: { automationLockToken: null, automationLockedAt: null } });
      });
      const updated = await this.prisma.rakutenOrderRecord.findUniqueOrThrow({ where: { deletedAt: null, id } });
      const [enriched] = await this.enrichOrderRows([updated]);
      return enriched;
    }
    await this.assertEditableOrderNotInActiveOverseasPickingBatch('rakuten', id);

    const orderId = this.normalizeEditableText(payload.orderId, '订单号', 64);
    let skuCode = this.normalizeEditableText(payload.skuCode, 'SKU', 128);
    const productId = this.normalizeEditableText(payload.productId, '产品ID', 64) || skuCode;
    if (productId) {
      skuCode = productId;
    }
    const orderQuantity = this.normalizeEditablePositiveInt(payload.orderQuantity, '数量');
    const productName = this.normalizeEditableText(payload.productName, '商品名', 5000);
    const mallName = this.normalizeEditableText(payload.mallName, '平台', 128);
    const shopName = this.normalizeEditableText(payload.shopName, '店铺', 128);
    const shippingName = this.normalizeEditableText(payload.shippingName, '收件人', 128);
    const shippingPostalCode = this.normalizeEditableText(payload.shippingPostalCode, '邮编', 32);
    const shippingPrefecture = this.normalizeEditableText(payload.shippingPrefecture, '都道府县', 64);
    const shippingCity = this.normalizeEditableText(payload.shippingCity, '市区町村', 128);
    const shippingAddress = this.normalizeEditableText(payload.shippingAddress, '地址', 5000);
    const shippingPhone = this.normalizeEditableText(payload.shippingPhone, '电话', 64);
    const dispatchMode = await this.resolveDispatchModeForProductId(productId, orderQuantity ?? 1);
    const shipmentCompany = this.normalizeEditableText(payload.shipmentCompany, '发货公司', 128);
    const shipmentNo = this.normalizeEditableText(payload.shipmentNo, '发货单号', 128);
    const deliveryDateRaw = this.normalizeEditableText(payload.deliveryDateRaw, 'お届け日指定', 32);
    const deliveryTimeSlot = this.normalizeEditableText(payload.deliveryTimeSlot, 'お届け時間帯', 64);
    const orderRemark = this.normalizeEditableText(payload.orderRemark, '订单备注', 5000);
    const shipmentNoRegisteredAt = this.resolveEditedShipmentRegisteredAt(
      current.shipmentNo,
      current.shipmentNoRegisteredAt,
      shipmentNo,
    );
    await this.assertEditedOrderIdentityDoesNotConflict('rakuten', id, current.orderId, orderId);

    const manualOverrideAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.rakutenOrderRecord.update({
      where: { deletedAt: null, id },
      data: {
        orderId,
        rmsOrderId: current.rmsConnectionId || (current.rawPayload as Prisma.JsonObject | null)?._wmsOriginalOrderId
          ? originalRakutenOrderId(current) : orderId,
        skuCode,
        orderQuantity,
        productName,
        mallName,
        shopName,
        shippingName,
        shippingPostalCode,
        shippingPrefecture,
        shippingCity,
        shippingAddress,
        shippingPhone,
        dispatchMode,
        shipmentCompany,
        shipmentNo,
        shipmentNoRegisteredAt,
        sendStatus: this.resolveSendStatus(shipmentNo),
        deliveryDateRaw,
        deliveryTimeSlot,
        orderRemark,
          rmsManualOverrideAt: manualOverrideAt,
          rmsManualOverrideBy: this.normalizeRakutenManualOperator(operatorUsername),
          rawPayload: this.mergeRawPayload(current.rawPayload, {
            _wmsRemarkConfirmedValue: orderRemark ?? "",
            _wmsRemarkConfirmedAt: manualOverrideAt.toISOString(),
            _wmsProductIdEdited: productIdWasManuallyEdited(current) ||
              String(current.skuCode ?? '').trim() !== String(skuCode ?? '').trim(),
            _wmsManualOverrideFields: [
              "orderId",
              "skuCode",
              "orderQuantity",
              "productName",
              "mallName",
              "shopName",
              "shippingName",
              "shippingPostalCode",
              "shippingPrefecture",
              "shippingCity",
              "shippingAddress",
              "shippingPhone",
              "deliveryDateRaw",
              "deliveryTimeSlot",
              "orderRemark",
            ].join(","),
            _wmsManualOverrideUpdatedAt: manualOverrideAt.toISOString(),
            注文番号: orderId,
          注文ID: orderId,
          SKU管理番号: skuCode,
          SKUコード: skuCode,
          产品ID: productId,
          商品名: productName,
          個数: orderQuantity === null ? null : String(orderQuantity),
          注文個数: orderQuantity === null ? null : String(orderQuantity),
          モール名: mallName,
          ショップ名: shopName,
          送付先姓: shippingName,
          送付先名: null,
          送付先郵便番号1: shippingPostalCode,
          送付先郵便番号2: null,
          送付先住所都道府県: shippingPrefecture,
          送付先住所郡市区: shippingCity,
          送付先住所それ以降の住所: shippingAddress,
          送付先電話番号1: shippingPhone,
          送付先電話番号2: null,
          送付先電話番号3: null,
          お届け日指定: deliveryDateRaw,
          お届け時間帯: deliveryTimeSlot,
          コメント: orderRemark,
        }),
      },
    });
      await this.freezeRelatedRakutenOrderRowsAfterManualEdit(
        tx,
        current.orderId,
        id,
        manualOverrideAt,
        operatorUsername,
      );
    });

    const updated = await this.prisma.rakutenOrderRecord.findUniqueOrThrow({ where: { deletedAt: null, id } });
    const [enriched] = await this.enrichOrderRows([updated]);
    return enriched;
  }

  private normalizeRakutenManualOperator(username: string): string {
    return (
      String(username ?? "")
        .trim()
        .slice(0, 64) || "unknown"
    );
  }

  private async freezeRelatedRakutenOrderRowsAfterManualEdit(
    tx: Prisma.TransactionClient,
    originalOrderId: string | null,
    editedId: bigint,
    manualOverrideAt: Date,
    operatorUsername: string,
  ): Promise<void> {
    const orderId = String(originalOrderId ?? "").trim();
    if (!orderId) return;
    await tx.rakutenOrderRecord.updateMany({
      where: { deletedAt: null, orderId, id: { not: editedId } },
      data: {
        rmsManualOverrideAt: manualOverrideAt,
        rmsManualOverrideBy: this.normalizeRakutenManualOperator(operatorUsername),
      },
    });
  }

  async updateAmazonOrder(idRaw: string, payload: UpdateAmazonOrderPayload): Promise<AmazonEnrichedOrderListItem> {
    const id = parseId(idRaw, 'id');
    const current = await this.prisma.amazonOrderRecord.findFirst({
      where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, id },
    });
    if (!current) {
      throw new NotFoundException(`亚马逊订单不存在: ${idRaw}`);
    }
    if (this.hasRegisteredShipmentNo(current)) {
      const shipmentCompany = this.normalizeEditableText(payload.shipmentCompany, '发货公司', 128);
      const shipmentNo = this.normalizeEditableText(payload.shipmentNo, '发货单号', 128);
      const updated = await this.prisma.amazonOrderRecord.update({
        where: { id },
        data: {
          shipmentCompany,
          shipmentNo,
          shipmentNoRegisteredAt: shipmentNo ? new Date() : null,
        },
      });
      const [enriched] = await this.enrichAmazonOrderRows([updated]);
      return enriched;
    }
    await this.assertEditableOrderNotInActiveOverseasPickingBatch('amazon', id);

    const orderId = this.normalizeEditableText(payload.orderId, '订单号', 64);
    const orderItemId = this.normalizeEditableText(payload.orderItemId, 'order-item-id', 64);
    const sku = this.normalizeEditableText(payload.sku, 'SKU', 128);
    const productId =
      this.normalizeEditableText(payload.productId, '产品ID', 64) ||
      (await this.resolveAmazonProductIdForSku(sku));
    if (!productId) {
      throw new BadRequestException('请填写 SKU 或 产品ID');
    }
    const quantityPurchased = this.normalizeEditablePositiveInt(payload.quantityPurchased, '数量');
    const productName = this.normalizeEditableText(payload.productName, '商品名', 5000);
    const mallName = this.normalizeEditableText(payload.mallName, '平台', 128);
    const shopName = this.normalizeEditableText(payload.shopName, '店铺', 128);
    const recipientName = this.normalizeEditableText(payload.recipientName, '收件人', 255);
    const buyerPhoneNumber = this.normalizeEditableText(payload.buyerPhoneNumber, '电话', 64);
    const shipPostalCode = this.normalizeEditableText(payload.shipPostalCode, '邮编', 32);
    const shipState = this.normalizeEditableText(payload.shipState, '都道府县', 255);
    const shipAddress1 = this.normalizeEditableText(payload.shipAddress1, '地址1', 5000);
    const shipAddress2 = this.normalizeEditableText(payload.shipAddress2, '地址2', 5000);
    const shipAddress3 = this.normalizeEditableText(payload.shipAddress3, '地址3', 5000);
    const dispatchMode = await this.resolveDispatchModeForProductId(productId, quantityPurchased ?? 1);
    const shipmentCompany = this.normalizeEditableText(payload.shipmentCompany, '发货公司', 128);
    const shipmentNo = this.normalizeEditableText(payload.shipmentNo, '发货单号', 128);
    const shipmentNoRegisteredAt = this.resolveEditedShipmentRegisteredAt(
      current.shipmentNo,
      current.shipmentNoRegisteredAt,
      shipmentNo,
    );
    await this.assertEditedOrderIdentityDoesNotConflict(
      'amazon',
      id,
      current.orderId,
      orderId,
      current.orderItemId,
      orderItemId,
    );

    const updated = await this.prisma.amazonOrderRecord.update({
      where: { id },
      data: {
        orderId,
        orderItemId,
        sku,
        quantityPurchased,
        productName,
        mallName,
        shopName,
        recipientName,
        buyerPhoneNumber,
        shipPostalCode,
        shipState,
        shipAddress1,
        shipAddress2,
        shipAddress3,
        dispatchMode,
        shippingOrigin: this.resolveAmazonShippingOriginFromDispatchMode(dispatchMode),
        shipmentCompany,
        shipmentNo,
        shipmentNoRegisteredAt,
        rawPayload: this.mergeRawPayload(current.rawPayload, {
          _wmsManualOverrideFields: [
            'orderItemId',
            'sku',
            'quantityPurchased',
            'productName',
            'mallName',
            'shopName',
            'recipientName',
            'buyerPhoneNumber',
            'shipPostalCode',
            'shipState',
            'shipAddress1',
            'shipAddress2',
            'shipAddress3',
            'dispatchMode',
            'shippingOrigin',
          ].join(','),
          _wmsManualOverrideUpdatedAt: new Date().toISOString(),
          'order-id': orderId,
          'order-item-id': orderItemId,
          sku,
          产品ID: productId,
          'product-name': productName,
          'quantity-purchased': quantityPurchased === null ? null : String(quantityPurchased),
          'recipient-name': recipientName,
          'buyer-phone-number': buyerPhoneNumber,
          'ship-postal-code': shipPostalCode,
          'ship-state': shipState,
          'ship-address-1': shipAddress1,
          'ship-address-2': shipAddress2,
          'ship-address-3': shipAddress3,
        }),
      },
    });

    const [enriched] = await this.enrichAmazonOrderRows([updated]);
    return enriched;
  }

  async updateManualOrder(idRaw: string, payload: UpdateAmazonOrderPayload): Promise<ManualEnrichedOrderListItem> {
    const id = parseId(idRaw, 'id');
    const current = await (this.prisma as any).manualOrderRecord.findUnique({ where: { id },
    });
    if (!current) {
      throw new NotFoundException(`手动订单不存在: ${idRaw}`);
    }
    if (this.hasRegisteredShipmentNo(current)) {
      const shipmentCompany = this.normalizeEditableText(payload.shipmentCompany, '发货公司', 128);
      const shipmentNo = this.normalizeEditableText(payload.shipmentNo, '发货单号', 128);
      const updated = await (this.prisma as any).manualOrderRecord.update({
        where: { id },
        data: {
          shipmentCompany,
          shipmentNo,
          shipmentNoRegisteredAt: shipmentNo ? new Date() : null,
        },
      });
      await this.syncManualOrdersToXyjgBestEffort([updated as ManualOrderRecordLike]);
      const [enriched] = await this.enrichManualOrderRows([updated as ManualOrderRecordLike]);
      return enriched;
    }
    await this.assertEditableOrderNotInActiveOverseasPickingBatch('manual', id);

    const orderId = this.normalizeEditableText(payload.orderId, '订单号', 64);
    const orderItemId = this.normalizeEditableText(payload.orderItemId, 'order-item-id', 64);
    const sku = this.normalizeEditableText(payload.sku, 'SKU', 128);
    const productId =
      this.normalizeEditableText(payload.productId, '产品ID', 64) ||
      (await this.resolveAmazonProductIdForSku(sku));
    if (!productId) {
      throw new BadRequestException('请填写 SKU 或 产品ID');
    }
    const quantityPurchased = this.normalizeEditablePositiveInt(payload.quantityPurchased, '数量');
    const productName = this.normalizeEditableText(payload.productName, '商品名', 5000);
    const mallName = this.normalizeEditableText(payload.mallName, '平台', 128);
    const shopName = this.normalizeEditableText(payload.shopName, '店铺', 128);
    const bloggerCooperationId = this.normalizeEditableText(
      payload.bloggerCooperationId ?? payload.blogger_cooperation_id,
      'bloggerCooperationId',
      128,
    );
    const recipientName = this.normalizeEditableText(payload.recipientName, '收件人', 255);
    const buyerPhoneNumber = this.normalizeEditableText(payload.buyerPhoneNumber, '电话', 64);
    const shipPostalCode = this.normalizeEditableText(payload.shipPostalCode, '邮编', 32);
    const shipState = this.normalizeEditableText(payload.shipState, '都道府县', 255);
    const shipAddress1 = this.normalizeEditableText(payload.shipAddress1, '地址1', 5000);
    const shipAddress2 = this.normalizeEditableText(payload.shipAddress2, '地址2', 5000);
    const shipAddress3 = this.normalizeEditableText(payload.shipAddress3, '地址3', 5000);
    const dispatchMode = await this.resolveDispatchModeForProductId(productId, quantityPurchased ?? 1);
    const shipmentCompany = this.normalizeEditableText(payload.shipmentCompany, '发货公司', 128);
    const shipmentNo = this.normalizeEditableText(payload.shipmentNo, '发货单号', 128);
    const shipmentNoRegisteredAt = this.resolveEditedShipmentRegisteredAt(
      current.shipmentNo,
      current.shipmentNoRegisteredAt,
      shipmentNo,
    );
    await this.assertEditedOrderIdentityDoesNotConflict(
      'manual',
      id,
      current.orderId,
      orderId,
      current.orderItemId,
      orderItemId,
    );

    const updated = await (this.prisma as any).manualOrderRecord.update({
      where: { id },
      data: {
        orderId,
        orderItemId,
        sku,
        quantityPurchased,
        productName,
        mallName,
        shopName,
        bloggerCooperationId,
        recipientName,
        buyerPhoneNumber,
        shipPostalCode,
        shipState,
        shipAddress1,
        shipAddress2,
        shipAddress3,
        dispatchMode,
        shippingOrigin: this.resolveAmazonShippingOriginFromDispatchMode(dispatchMode),
        shipmentCompany,
        shipmentNo,
        shipmentNoRegisteredAt,
        rawPayload: this.mergeRawPayload(current.rawPayload, {
          'order-id': orderId,
          'order-item-id': orderItemId,
          sku,
          bloggerCooperationId,
          blogger_cooperation_id: bloggerCooperationId,
          产品ID: productId,
          'product-name': productName,
          'quantity-purchased': quantityPurchased === null ? null : String(quantityPurchased),
          'recipient-name': recipientName,
          'buyer-phone-number': buyerPhoneNumber,
          'ship-postal-code': shipPostalCode,
          'ship-state': shipState,
          'ship-address-1': shipAddress1,
          'ship-address-2': shipAddress2,
          'ship-address-3': shipAddress3,
        }),
      },
    });

    await this.syncManualOrdersToXyjgBestEffort([updated as ManualOrderRecordLike]);
    const [enriched] = await this.enrichManualOrderRows([updated as ManualOrderRecordLike]);
    return enriched;
  }

  async createAmazonManualOrder(payload: CreateAmazonManualOrderPayload): Promise<ManualEnrichedOrderListItem> {
    await this.assertManualOrderShopSelection(payload);
    const data = await this.buildAmazonManualOrderCreateData(payload, '', 'system_single');
    const row = await this.prisma.$transaction(
      async (tx) => {
        await this.assertManualOrderIdsDoNotExist([data], tx as any);
        return (tx as any).manualOrderRecord.create({
          data,
        }) as Promise<ManualOrderRecordLike>;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.syncManualOrdersToXyjgBestEffort([row as ManualOrderRecordLike]);
    const [enriched] = await this.enrichManualOrderRows([row as ManualOrderRecordLike]);
    return enriched;
  }

  private async assertManualOrderShopSelection(payload: CreateAmazonManualOrderPayload): Promise<void> {
    const mallName = this.normalizeEditableText(payload.mallName, 'mallName', 128);
    const shopName = this.normalizeEditableText(payload.shopName, 'shopName', 128);
    if (!mallName && !shopName) return;
    if (!mallName) throw new BadRequestException('请先选择平台');
    const platform = await this.prisma.shopPlatformDefinition.findUnique({ where: { name: mallName } });
    if (!platform) throw new BadRequestException('平台不存在，请重新选择');
    if (!shopName) return;
    const shop = await this.prisma.shop.findUnique({ where: { name: shopName } });
    if (!shop || shop.platform !== platform.key || shop.status !== 1) {
      throw new BadRequestException('店铺不属于所选平台或已停用，请重新选择');
    }
  }

  getAmazonManualOrderUploadTemplate(): { fileName: string; content: Buffer } {
    const headers = [
      '订单号',
      'order-item-id',
      'SKU',
      '产品ID',
      '数量',
      '产品名称',
      '平台',
      '店铺',
      '收件人',
      '电话',
      '邮编',
      '都道府县',
      '地址1',
      '地址2',
      '地址3',
      '发货公司',
      '发货单号',
    ];
    const rows = [
      headers,
      ['MANUAL-001', '', '', '8736', 1, '', '', '2号店-DGAZ store', '山田太郎', '090-0000-0000', '100-0001', '東京都', '千代田区', '千代田1-1', '', '', '',
      ],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '手动订单');
    return {
      fileName: MANUAL_ORDER_UPLOAD_TEMPLATE_FILE,
      content: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx',
      }) as Buffer,
    };
  }

  async importAmazonManualOrdersFile(
    fileBuffer: Buffer,
    originalName?: string): Promise<ManualOrderFileImportResult> {
    const sourceFileName = String(originalName ?? '').trim() || 'manual-orders.xlsx';
    const items = this.parseManualOrderUploadFile(fileBuffer, sourceFileName);
    const result = await this.batchCreateAmazonManualOrders({ items }, 'system_batch');
    return {
      sourceFileName,
      importedAt: result.createdAt,
      totalRows: items.length,
      requestedCount: result.requestedCount,
      createdCount: result.createdCount,
      updatedCount: result.updatedCount,
      rows: result.rows,
    };
  }

  async batchCreateAmazonManualOrders(
    payload: BatchCreateAmazonManualOrdersPayload,
    origin: ManualOrderCreateOrigin = 'system_batch',
  ): Promise<{
    createdAt: string;
    requestedCount: number;
    createdCount: number;
    updatedCount: number;
    rows: AmazonManualOrderBatchCreateRowResult[];
  }> {
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    if (!rawItems.length) {
      throw new BadRequestException('请至少提供一条手动订单');
    }
    if (rawItems.length > 500) {
      throw new BadRequestException('单次最多支持批量生成 500 条手动订单');
    }

    const normalizedItems = this.hydrateManualOrderItemsWithSharedFields(rawItems);
    const createDataList = await Promise.all(
      normalizedItems.map((item, index) => this.buildAmazonManualOrderCreateData(item, `items[${index}]`, origin)),
    );
    this.assertUniqueManualOrderDetails(createDataList);
    this.forceXyjgManualOrderGroupsToChinaWhenAnyItemIsChinaPending(createDataList);

    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.assertManualOrderIdsDoNotExist(createDataList, tx as any);
        const rows: ManualOrderRecordLike[] = [];
        for (const data of createDataList) {
          const created = (await (tx as any).manualOrderRecord.create({ data,
          })) as ManualOrderRecordLike;
          rows.push(created);
        }
        return { rows, createdCount: rows.length, updatedCount: 0 };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.syncManualOrdersToXyjgBestEffort(result.rows);
    const enrichedRows = await this.enrichManualOrderRows(result.rows);
    return {
      createdAt: new Date().toISOString(),
      requestedCount: rawItems.length,
      createdCount: result.createdCount,
      updatedCount: result.updatedCount,
      rows: enrichedRows.map((row) => ({
        id: row.id.toString(),
        orderId: row.orderId,
        orderItemId: row.orderItemId,
        sku: row.sku,
        productId: row.resolvedProductId,
        productName: row.resolvedProductName,
        quantityPurchased: row.quantityPurchased,
        mallName: row.mallName,
        shopName: row.resolvedShopName || row.shopName,
        bloggerCooperationId: row.bloggerCooperationId ?? null,
        dispatchMode: row.dispatchMode,
        shippingOrigin: row.shippingOrigin,
      })),
    };
  }

  async deleteAmazonManualOrdersForXiya(
    payload: DeleteAmazonManualOrdersForXiyaPayload): Promise<{
    requestedCount: number;
    matchedCount: number;
    deletedCount: number;
    deletedOrderIds: string[];
    notFoundOrderIds: string[];
  }> {
    const rawOrderIds = [payload?.orderId, ...(Array.isArray(payload?.orderIds) ? payload.orderIds : [])];
    const orderIds = Array.from(
      new Set(rawOrderIds.map((value) => String(value ?? '').trim()).filter((value) => value.length > 0)),
    );
    if (!orderIds.length) {
      throw new BadRequestException('请提供要删除的手动订单号');
    }
    if (orderIds.length > 500) {
      throw new BadRequestException('单次最多支持删除 500 个手动订单号');
    }

    const bloggerCooperationId = String(
      payload?.bloggerCooperationId ?? payload?.blogger_cooperation_id ?? '').trim();
    const rows = (await (this.prisma as any).manualOrderRecord.findMany({
      where: {
        orderId: { in: orderIds },
        OR: [
          { sourceFilePath: XIYA_MANUAL_ORDER_SOURCE_FILE_PATH },
          { bloggerCooperationId: { not: null } }],
        ...(bloggerCooperationId ? { bloggerCooperationId } : {}),
      },
    })) as ManualOrderRecordLike[];
    const matchedOrderIds = new Set(rows.map((row) => String(row.orderId ?? '').trim()).filter(Boolean));
    const notFoundOrderIds = orderIds.filter((orderId) => !matchedOrderIds.has(orderId));
    if (!rows.length) {
      throw new NotFoundException('未找到可删除的手动订单');
    }

    const rowWithShipment = rows.find((row) => String(row.shipmentNo ?? '').trim());
    if (rowWithShipment) {
      throw new ConflictException(`订单 ${rowWithShipment.orderId ?? ''} 已经有运单号，请联系海外仓处理`);
    }

    const rowIds = rows.map((row) => row.id);
    await this.assertOrderRecordsNotInOverseasPickingBatch('manual', rowIds);

    const deletedCount = await this.prisma.$transaction(async (tx) => {
      const result = await (tx as any).manualOrderRecord.deleteMany({
        where: {
          id: {
            in: rowIds,
          },
        },
      });
      return Number(result.count ?? 0);
    });

    return {
      requestedCount: orderIds.length,
      matchedCount: rows.length,
      deletedCount,
      deletedOrderIds: Array.from(matchedOrderIds),
      notFoundOrderIds,
    };
  }

  private async assertOrderRecordsNotInOverseasPickingBatch(
    source: 'rakuten' | 'amazon' | 'manual',
    ids: bigint[],
  ): Promise<void> {
    if (!ids.length) {
      return;
    }
    const pickingItem = await this.prisma.overseasPickingBatchItem.findFirst({
      where: {
        source,
        sourceRecordId: { in: ids },
      },
      include: {
        batch: {
          select: {
            id: true,
            batchNo: true,
            status: true,
          },
        },
      },
    });
    if (pickingItem) {
      throw new ConflictException(`订单 ${pickingItem.orderId ?? ''} 已拣货，请联系海外仓`);
    }
  }

  private async assertEditableOrderNotInActiveOverseasPickingBatch(
    source: 'rakuten' | 'amazon' | 'manual',
    id: bigint,
  ): Promise<void> {
    const pickingItem = await this.prisma.overseasPickingBatchItem.findFirst({
      where: {
        source,
        sourceRecordId: id,
        batch: {
          status: {
            in: [
              OVERSEAS_PICKING_BATCH_STATUS.CREATED,
              OVERSEAS_PICKING_BATCH_STATUS.PICKED,
              OVERSEAS_PICKING_BATCH_STATUS.YAMATO_EXPORTED,
            ],
          },
        },
      },
      select: {
        orderId: true,
      },
    });
    if (!pickingItem) {
      return;
    }
    const orderId = String(pickingItem.orderId ?? '').trim();
    throw new ConflictException(`订单${orderId ? ` ${orderId}` : ''}正在拣货中，请联系海外仓`);
  }

  private async assertEditedOrderIdentityDoesNotConflict(
    source: 'rakuten' | 'amazon' | 'manual',
    currentId: bigint,
    currentOrderIdRaw: string | null,
    nextOrderIdRaw: string | null,
    currentOrderItemIdRaw?: string | null,
    nextOrderItemIdRaw?: string | null,
  ): Promise<void> {
    const currentOrderId = String(currentOrderIdRaw ?? '').trim();
    const nextOrderId = String(nextOrderIdRaw ?? '').trim();
    if (!nextOrderId) {
      return;
    }

    const model =
      source === 'rakuten'
        ? this.prisma.rakutenOrderRecord
        : source === 'amazon'
          ? this.prisma.amazonOrderRecord
          : (this.prisma as any).manualOrderRecord;
    const sourceLabel = source === 'rakuten' ? '乐天订单' : source === 'amazon' ? '亚马逊订单' : '手动订单';

    if (nextOrderId !== currentOrderId) {
      const existing = await model.findFirst({
        where: {
          orderId: nextOrderId,
          id: { not: currentId },
        },
        select: {
          id: true,
          orderId: true,
        },
      });
      if (existing) {
        throw new ConflictException(`${sourceLabel} ${nextOrderId} 已存在，不能把当前订单改成相同订单号`);
      }
    }

    if (source === 'rakuten') {
      return;
    }

    const currentOrderItemId = String(currentOrderItemIdRaw ?? '').trim();
    const nextOrderItemId = String(nextOrderItemIdRaw ?? '').trim();
    if (!nextOrderItemId || (nextOrderId === currentOrderId && nextOrderItemId === currentOrderItemId)) {
      return;
    }

    const existingDetail = await model.findFirst({
      where: {
        orderId: nextOrderId,
        orderItemId: nextOrderItemId,
        id: { not: currentId },
      },
      select: {
        id: true,
        orderId: true,
        orderItemId: true,
      },
    });
    if (existingDetail) {
      throw new ConflictException(`${sourceLabel} ${nextOrderId} 的明细号 ${nextOrderItemId} 已存在，不能重复`);
    }
  }

  private async assertOrderRecordsHaveNoShipmentNo(
    source: 'rakuten' | 'amazon' | 'manual',
    ids: bigint[],
  ): Promise<void> {
    if (!ids.length) {
      return;
    }

    const model =
      source === 'rakuten'
        ? this.prisma.rakutenOrderRecord
        : source === 'amazon'
          ? this.prisma.amazonOrderRecord
          : (this.prisma as any).manualOrderRecord;
    const rows = (await model.findMany({
      where: {
        id: { in: ids },
      },
      select: {
        id: true,
        orderId: true,
        shipmentNo: true,
      },
    })) as Array<{ id: bigint; orderId: string | null; shipmentNo: string | null;
    }>;
    const rowWithShipment = rows.find((row) => String(row.shipmentNo ?? '').trim().length > 0);
    if (rowWithShipment) {
      throw new ConflictException(
        `订单 ${String(rowWithShipment.orderId ?? rowWithShipment.id.toString()).trim()} 已有运单号，不能批量删除`,
      );
    }
  }

  private hydrateManualOrderItemsWithSharedFields(
    rawItems: CreateAmazonManualOrderPayload[],
  ): CreateAmazonManualOrderPayload[] {
    const sharedFields: Array<keyof CreateAmazonManualOrderPayload> = [
      'mallName',
      'shopName',
      'bloggerCooperationId',
      'blogger_cooperation_id',
      'recipientName',
      'buyerPhoneNumber',
      'shipPostalCode',
      'shipState',
      'shipAddress1',
      'shipAddress2',
      'shipAddress3',
      'shipmentCompany',
      'shipmentNo',
    ];
    const hasText = (value: unknown) => String(value ?? '').trim().length > 0;
    const sharedByOrderId = new Map<string, Partial<CreateAmazonManualOrderPayload>>();

    rawItems.forEach((item) => {
      const orderId = String(item?.orderId ?? '').trim();
      if (!orderId) return;
      const shared = sharedByOrderId.get(orderId) ?? {};
      sharedFields.forEach((field) => {
        if (!hasText(shared[field]) && hasText(item[field])) {
          shared[field] = item[field] as any;
        }
      });
      sharedByOrderId.set(orderId, shared);
    });

    return rawItems.map((item) => {
      const orderId = String(item?.orderId ?? '').trim();
      const shared = orderId ? sharedByOrderId.get(orderId) : null;
      if (!shared) {
        return item;
      }
      const hydrated: CreateAmazonManualOrderPayload = { ...item };
      sharedFields.forEach((field) => {
        if (!hasText(hydrated[field]) && hasText(shared[field])) {
          hydrated[field] = shared[field] as any;
        }
      });
      return hydrated;
    });
  }

  private assertUniqueManualOrderDetails(createDataList: Prisma.ManualOrderRecordCreateInput[]): void {
    const detailKeys = new Set<string>();
    createDataList.forEach((data, index) => {
      const orderId = String(data.orderId ?? '').trim();
      const orderItemId = String(data.orderItemId ?? '').trim();
      const key = `${orderId}\u001f${orderItemId}`;
      if (detailKeys.has(key)) {
        throw new BadRequestException(`items[${index}] 订单 ${orderId} 的明细号 ${orderItemId} 重复`);
      }
      detailKeys.add(key);
    });
  }

  private async assertManualOrderIdsDoNotExist(
    createDataList: Prisma.ManualOrderRecordCreateInput[],
    client: any = this.prisma as any,
  ): Promise<void> {
    const orderIds = Array.from(
      new Set(createDataList.map((data) => String(data.orderId ?? '').trim()).filter((orderId) => orderId.length > 0)),
    );
    if (!orderIds.length) {
      return;
    }

    const existingRows = (await client.manualOrderRecord.findMany({
      where: {
        orderId: {
          in: orderIds,
        },
      },
      select: {
        orderId: true,
        shipmentNo: true,
      },
    })) as Array<{ orderId: string | null; shipmentNo: string | null }>;
    if (!existingRows.length) {
      return;
    }

    const rowWithShipment = existingRows.find((row) => String(row.shipmentNo ?? '').trim());
    if (rowWithShipment) {
      throw new ConflictException(`订单 ${String(rowWithShipment.orderId ?? '').trim()} 已经有运单号，请联系海外仓处理`,
      );
    }

    const existingOrderId = String(existingRows[0]?.orderId ?? '').trim();
    throw new ConflictException(`订单 ${existingOrderId} 已存在，请勿重复推送；如需修改请删除该订单后再操作`);
  }

  private forceXyjgManualOrderGroupsToChinaWhenAnyItemIsChinaPending(
    createDataList: Prisma.ManualOrderRecordCreateInput[],
  ): void {
    const groups = new Map<string, Prisma.ManualOrderRecordCreateInput[]>();
    createDataList.forEach((data) => {
      if (!this.isXyjgManualOrderCreateData(data)) {
        return;
      }
      const orderId = String(data.orderId ?? '').trim();
      if (!orderId) {
        return;
      }
      groups.set(orderId, [...(groups.get(orderId) ?? []), data]);
    });

    groups.forEach((groupRows) => {
      const chinaDispatchMode =
        groupRows
          .map((data) => String(data.dispatchMode ?? '').trim())
          .find((dispatchMode) => dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING) ??
        groupRows
          .map((data) => String(data.dispatchMode ?? '').trim())
          .find((dispatchMode) => dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK);
      if (!chinaDispatchMode) {
        return;
      }
      groupRows.forEach((data) => {
        data.dispatchMode = chinaDispatchMode;
        data.shippingOrigin = this.resolveAmazonShippingOriginFromDispatchMode(chinaDispatchMode);
      });
    });
  }

  private isXyjgManualOrderCreateData(data: Prisma.ManualOrderRecordCreateInput): boolean {
    const bloggerCooperationId = String(data.bloggerCooperationId ?? '').trim();
    return (
      Boolean(bloggerCooperationId) || String(data.sourceFilePath ?? '').trim() === XIYA_MANUAL_ORDER_SOURCE_FILE_PATH
    );
  }

  /** Additional reservations for unbatched warehouse orders. Picking/FBA claims are
   * already deducted by availableStock; never deduct the same source row twice. */
  async inventorySyncPendingDemands(database: Prisma.TransactionClient = this.prisma, productIds?: string[]): Promise<Array<{ productId: string; quantity: number }>> {
    const targets = productIds ? [...new Set(productIds)] : undefined;
    if (targets && !targets.length) return [];
    const targetSet = targets ? new Set(targets) : undefined;
    // Resolve all known SKU aliases once for this stock snapshot. Mapping validation
    // below still examines every candidate for each selected order.
    const targetSkus = targets ? await database.sku.findMany({ where: { status: 1, productId: { in: targets } },
      select: { sku: true, rbSku: true, fbmSku: true } }) : [];
    const codesForTargets = [...new Set(targetSkus.flatMap((row) => [row.sku, row.rbSku, row.fbmSku]).filter((code): code is string => Boolean(code)))];
    const scopedOrders = targets ? { OR: [
      { sku: { in: codesForTargets } },
      // Legacy overrides accept numbers and trimmed strings. Keep payload rows
      // as a conservative fallback rather than omit a real reservation.
      { rawPayload: { not: Prisma.DbNull } },
    ] } : undefined;
    const totals = new Map<string, number>();
    const dispatch = { OR: [{ dispatchMode: null }, { dispatchMode: '' }, { dispatchMode: 'overseas' }] };
    for (const source of ['rakuten', 'amazon', 'manual'] as const) {
      let lastId: bigint | undefined;
      while (true) {
        const page = { take: 500, orderBy: { id: 'asc' as const }, ...(lastId === undefined ? {} : { cursor: { id: lastId }, skip: 1 }) };
        const rows = source === 'rakuten'
          ? await database.rakutenOrderRecord.findMany({ ...page, select: { id: true, skuCode: true, setComponentSkuCode: true, orderQuantity: true }, where: {
            AND: [dispatch, ...(targets ? [{ OR: [{ skuCode: { in: targets } }, { setComponentSkuCode: { in: targets } }] }] : [])],
            deletedAt: null, warehouseShippedAt: null, sendStatus: OrderSendStatus.unsent,
          } })
          : source === 'amazon'
            ? await database.amazonOrderRecord.findMany({ ...page, select: { id: true, sku: true, shopName: true, rawPayload: true, quantityToShip: true, quantityPurchased: true }, where: { ...dispatch, ...PROCESSABLE_AMAZON_ORDER_WHERE,
              AND: [...(scopedOrders ? [scopedOrders] : []), { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                { OR: [{ orderStatus: null }, { orderStatus: { notIn: ['Canceled', 'Cancelled', 'Shipped'] } }] }],
            } })
            : await database.manualOrderRecord.findMany({ ...page, select: { id: true, sku: true, shopName: true, rawPayload: true, quantityToShip: true, quantityPurchased: true }, where: { ...dispatch, OR: dispatch.OR,
              AND: [...(scopedOrders ? [scopedOrders] : []), { OR: [{ shipmentNo: null }, { shipmentNo: '' }] }],
            } });
        if (!rows.length) break;
        const refs = await database.overseasPickingBatchItem.findMany({
          where: { source, sourceRecordId: { in: rows.map((row) => row.id) }, batch: { status: { in: ['created', 'picked', 'yamato_exported', 'completed'] } } },
          select: { sourceRecordId: true },
        });
        const reserved = new Set(refs.map((row) => row.sourceRecordId.toString()));
        const unbatched = rows.filter((row) => !reserved.has(row.id.toString()));
        const codes = source === 'rakuten' ? [] : [...new Set((unbatched as Array<{ sku: string | null }>).map((row) => row.sku ?? '').filter(Boolean))];
        const skuRows = codes.length ? await database.sku.findMany({
          where: { status: 1, productId: { not: null }, OR: [{ sku: { in: codes } }, { rbSku: { in: codes } }, { fbmSku: { in: codes } }] },
          select: { sku: true, rbSku: true, fbmSku: true, shop: true, productId: true },
        }) : [];
        const skuIndex = new Map<string, typeof skuRows>();
        for (const sku of skuRows) for (const code of new Set([sku.sku, sku.rbSku, sku.fbmSku].filter(Boolean))) {
          const key = normalizeAmazonSkuLookupKey(code);
          const bucket = skuIndex.get(key) ?? [];
          bucket.push(sku); skuIndex.set(key, bucket);
        }
        const mapped = source === 'rakuten'
          ? (unbatched as Array<{ skuCode: string | null; setComponentSkuCode: string | null; orderQuantity: number | null }>).map((row) => ({ productId: row.skuCode || row.setComponentSkuCode, quantity: row.orderQuantity ?? 1 }))
          : (unbatched as Array<{ sku: string | null; shopName: string | null; rawPayload: Prisma.JsonValue | null; quantityToShip: number | null; quantityPurchased: number | null }>).map((row) => {
            const override = this.getJsonObjectString(row.rawPayload, '产品ID');
            const matching = skuIndex.get(normalizeAmazonSkuLookupKey(row.sku)) ?? [];
            const scoped = matching.filter((sku) => sku.shop === row.shopName);
            const productIds = [...new Set((scoped.length ? scoped : matching).map((sku) => sku.productId).filter(Boolean))];
            if (!override && productIds.length > 1) throw new BadRequestException('待发货订单SKU对应多个产品，请先修复店铺映射');
            return { productId: override || productIds[0], quantity: row.quantityToShip ?? row.quantityPurchased ?? 1 };
          });
        for (const row of mapped) {
          if (targetSet && row.productId && !targetSet.has(row.productId)) continue;
          if (!Number.isInteger(row.quantity) || row.quantity < 0) throw new BadRequestException('待发货订单数量异常，库存同步已停止');
          if (!row.quantity) continue;
          if (!row.productId) throw new BadRequestException('待发货订单缺少产品对应关系，请先处理订单再同步库存');
          const quantity = (totals.get(row.productId) ?? 0) + row.quantity;
          if (!Number.isSafeInteger(quantity)) throw new BadRequestException('待发货预占总数异常，库存同步已停止');
          totals.set(row.productId, quantity);
        }
        lastId = rows[rows.length - 1].id;
        if (rows.length < 500) break;
      }
    }
    return [...totals].map(([productId, quantity]) => ({ productId, quantity }));
  }

  async getOverseasUnconfirmedOrderCount(target: 'overseas' | 'china' = 'overseas'): Promise<{ count: number }> {
    const orderIds = new Set<string>();
    let skip = 0;
    const take = 500;
    while (true) {
      const rows = await this.prisma.rakutenOrderRecord.findMany({
        where: target === 'china'
          ? { deletedAt: null, ...this.buildChinaOrderShipmentNoFilter('pending') }
          : { deletedAt: null, sendStatus: OrderSendStatus.unsent,
            OR: [{ dispatchMode: null }, { dispatchMode: '' }, { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }] },
        orderBy: { id: 'asc' }, skip, take,
      });
      const pending = rows.filter((row) => !String(row.shipmentNo ?? '').trim() && rakutenOrderRemarkNeedsConfirmation(row));
      const enriched = await this.enrichOrderRows(pending);
      const active = await this.loadActiveOverseasPickingBatchRefs(pending.map((row) => ({ source: 'rakuten' as const, sourceRecordId: row.id })));
      for (const row of enriched) {
        const eligible = target === 'china'
          ? this.shouldExportOrderToThirdParty('rakuten', row.id, row.dispatchMode, row.fulfillmentMode, active)
          : row.fulfillmentMode === 'overseas_warehouse' && !active.has(`rakuten:${row.id}`);
        if (eligible) orderIds.add(String(row.orderId || row.id));
      }
      if (rows.length < take) break;
      skip += rows.length;
    }
    return { count: orderIds.size };
  }

  async listOverseasWarehouse(
    limitParam?: string,
    includeAll = false): Promise<OverseasWarehouseOrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = includeAll
      ? Number.MAX_SAFE_INTEGER
      : Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 1000)
        : 200;
    const batchSize = Math.min(Math.max(limit, 200), 500);
    const collected: OverseasWarehouseOrderListItem[] = [];
    let rakutenSkip = 0;
    let amazonSkip = 0;
    let manualSkip = 0;
    let rakutenExhausted = false;
    let amazonExhausted = false;
    let manualExhausted = false;

    while (collected.length < limit && (!rakutenExhausted || !amazonExhausted || !manualExhausted)) {
      const [rakutenRows, amazonRows, manualRows]: [RakutenOrderRecord[], AmazonOrderRecord[], ManualOrderRecordLike[],
      ] = await Promise.all([
        rakutenExhausted
          ? Promise.resolve([] as RakutenOrderRecord[])
          : this.prisma.rakutenOrderRecord.findMany({
              where: { ...(includeAll
                ? {
                    OR: [
                      { dispatchMode: null },
                      { dispatchMode: '' },
                      { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS },
                    ],
                  }
                : {
                    sendStatus: OrderSendStatus.unsent,
                    OR: [
                      { dispatchMode: null },
                      { dispatchMode: '' },
                      { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS },
                    ],
                  }), deletedAt: null },
              orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
              skip: rakutenSkip,
              take: batchSize,
            }),
        amazonExhausted
          ? Promise.resolve([] as AmazonOrderRecord[])
          : this.prisma.amazonOrderRecord.findMany({
              where: includeAll
                ? {
                    ...PROCESSABLE_AMAZON_ORDER_WHERE,
                    OR: [
                      { dispatchMode: null },
                      { dispatchMode: '' },
                      { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS },
                    ],
                  }
                : {
                    AND: [
                      PROCESSABLE_AMAZON_ORDER_WHERE,
                      { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                      {
                        OR: [
                          { dispatchMode: null },
                          { dispatchMode: '' },
                          { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS },
                        ],
                      },
                    ],
                  },
              orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
              skip: amazonSkip,
              take: batchSize,
            }),
        manualExhausted
          ? Promise.resolve([] as ManualOrderRecordLike[])
          : (this.prisma as any).manualOrderRecord.findMany({
              where: includeAll
                ? {
                    OR: [
                      { dispatchMode: null },
                      { dispatchMode: '' },
                      { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS },
                    ],
                  }
                : {
                    AND: [
                      { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                      {
                        OR: [
                          { dispatchMode: null },
                          { dispatchMode: '' },
                          { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS },
                        ],
                      },
                    ],
                  },
              orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
              skip: manualSkip,
              take: batchSize,
            }),
      ]);

      rakutenSkip += rakutenRows.length;
      amazonSkip += amazonRows.length;
      manualSkip += manualRows.length;
      rakutenExhausted = rakutenRows.length < batchSize;
      amazonExhausted = amazonRows.length < batchSize;
      manualExhausted = manualRows.length < batchSize;

      const [enrichedRakutenRows, enrichedAmazonRows, enrichedManualRows] = await Promise.all([
        this.enrichOrderRows(rakutenRows),
        this.enrichAmazonOrderRows(amazonRows),
        this.enrichManualOrderRows(manualRows),
      ]);

      const activePickedRefs = includeAll
        ? new Set<string>()
        : await this.loadActiveOverseasPickingBatchRefs([
            ...enrichedRakutenRows.map((row) => ({
              source: 'rakuten' as const,
              sourceRecordId: row.id,
            })),
            ...enrichedAmazonRows.map((row) => ({
              source: 'amazon' as const,
              sourceRecordId: row.id,
            })),
            ...enrichedManualRows.map((row) => ({
              source: 'manual' as const,
              sourceRecordId: row.id,
            })),
          ]);

      collected.push(
        ...enrichedRakutenRows
          .filter(
            (row) =>
              row.fulfillmentMode === 'overseas_warehouse' &&
              (!rakutenOrderRemarkNeedsConfirmation(row) || (includeAll && Boolean(String(row.shipmentNo ?? "").trim()))) &&
              (includeAll ||
                !activePickedRefs.has(`rakuten:${row.id.toString()}`)),
          )
          .map((row) => ({
            source: 'rakuten' as const,
            id: row.id.toString(),
            sourceLabel: '乐天',
            csvImportedAt: row.csvImportedAt,
            createdAt: row.createdAt,
            orderId: row.orderId,
            skuCode: row.skuCode,
            resolvedProductId: row.resolvedProductId,
            resolvedProductName: row.resolvedProductName,
            orderQuantity: row.orderQuantity,
            shopName: row.shopName,
            shippingName: row.shippingName,
            availableStock: row.availableStock,
            assemblableStock: row.assemblableStock,
            assemblableStockApplicable: row.assemblableStockApplicable,
            orderImportedAtRaw: row.orderImportedAtRaw,
            productName: row.productName,
            productNameExtra: row.productNameExtra,
            shippingPhone: row.shippingPhone,
            shippingPostalCode: row.shippingPostalCode,
            shippingPrefecture: row.shippingPrefecture,
            shippingCity: row.shippingCity,
            shippingAddress: row.shippingAddress,
            deliveryDateRaw: row.deliveryDateRaw,
            deliveryTimeSlot: row.deliveryTimeSlot,
            rawPayload: row.rawPayload,
          })),
        ...enrichedAmazonRows
          .filter(
            (row) =>
              row.fulfillmentMode === 'overseas_warehouse' &&
              (includeAll ||
                !activePickedRefs.has(`amazon:${row.id.toString()}`)),
          )
          .map((row) => ({
            source: 'amazon' as const,
            id: row.id.toString(),
            sourceLabel: '亚马逊',
            csvImportedAt: row.csvImportedAt,
            createdAt: row.createdAt,
            orderId: row.orderId,
            skuCode: row.sku,
            resolvedProductId: row.resolvedProductId,
            resolvedProductName: row.resolvedProductName,
            orderQuantity: row.quantityPurchased,
            shopName: row.resolvedShopName || row.shopName,
            shippingName: row.recipientName,
            availableStock: row.availableStock,
            assemblableStock: row.assemblableStock,
            assemblableStockApplicable: row.assemblableStockApplicable,
            purchaseDateRaw: row.purchaseDateRaw,
            productName: row.productName,
            buyerPhoneNumber: row.buyerPhoneNumber,
            shipPostalCode: row.shipPostalCode,
            shipState: row.shipState,
            shipAddress1: row.shipAddress1,
            shipAddress2: row.shipAddress2,
            shipAddress3: row.shipAddress3,
            rawPayload: row.rawPayload,
          })),
        ...enrichedManualRows
          .filter(
            (row) =>
              row.fulfillmentMode === 'overseas_warehouse' &&
              (includeAll ||
                !activePickedRefs.has(`manual:${row.id.toString()}`)),
          )
          .map((row) => ({
            source: 'manual' as const,
            id: row.id.toString(),
            sourceLabel: '手动订单',
            csvImportedAt: row.csvImportedAt,
            createdAt: row.createdAt,
            orderId: row.orderId,
            skuCode: row.sku,
            resolvedProductId: row.resolvedProductId,
            resolvedProductName: row.resolvedProductName,
            orderQuantity: row.quantityPurchased,
            shopName: row.resolvedShopName || row.shopName,
            shippingName: row.recipientName,
            availableStock: row.availableStock,
            assemblableStock: row.assemblableStock,
            assemblableStockApplicable: row.assemblableStockApplicable,
            purchaseDateRaw: row.purchaseDateRaw,
            productName: row.productName,
            buyerPhoneNumber: row.buyerPhoneNumber,
            shipPostalCode: row.shipPostalCode,
            shipState: row.shipState,
            shipAddress1: row.shipAddress1,
            shipAddress2: row.shipAddress2,
            shipAddress3: row.shipAddress3,
            rawPayload: row.rawPayload,
          })),
      );
    }

    return collected
      .sort((a, b) => {
        const timeDiff = new Date(b.csvImportedAt).getTime() - new Date(a.csvImportedAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(0, limit);
  }

  async switchOverseasWarehouseOrderToChina(
    sourceRaw: string,
    idRaw: string,
  ): Promise<{
    success: true;
    source: 'rakuten' | 'amazon' | 'manual';
    id: string;
    dispatchMode: string;
    updatedIds?: string[];
  }> {
    const source = String(sourceRaw ?? '').trim();
    if (source !== 'rakuten' && source !== 'amazon' && source !== 'manual') {
      throw new BadRequestException('source 只支持 rakuten、amazon 或 manual');
    }
    const id = parseId(idRaw, 'id');

    if (source === 'rakuten') {
      const row = await this.prisma.rakutenOrderRecord.findFirst({
        where: { deletedAt: null,
          id,
          sendStatus: OrderSendStatus.unsent,
          OR: [{ dispatchMode: null }, { dispatchMode: '' }, { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }],
        },
      });
      if (!row) {
        throw new NotFoundException(`乐天订单不存在或当前不可切中国发: ${idRaw}`);
      }
      const [enrichedRows, activePickedRefs] = await Promise.all([
        this.enrichOrderRows([row]),
        this.loadActiveOverseasPickingBatchRefs([{ source: 'rakuten', sourceRecordId: id }]),
      ]);
      const enrichedRow = enrichedRows[0];
      if (
        !enrichedRow ||
        enrichedRow.fulfillmentMode !== 'overseas_warehouse' ||
        activePickedRefs.has(`rakuten:${id.toString()}`)
      ) {
        throw new BadRequestException('当前订单已不在海外仓待处理范围内，无法切中国发');
      }
      await this.prisma.rakutenOrderRecord.update({
        where: { deletedAt: null, id },
        data: {
          dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
        },
      });
      return {
        success: true,
        source: 'rakuten',
        id: id.toString(),
        dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
      };
    }

    const row =
      source === 'amazon'
        ? await this.prisma.amazonOrderRecord.findFirst({
            where: {
              ...PROCESSABLE_AMAZON_ORDER_WHERE,
              id,
              AND: [
                { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                {
                  OR: [
                    { dispatchMode: null },
                    { dispatchMode: '' },
                    { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }],
                },
              ],
            },
          })
        : await (this.prisma as any).manualOrderRecord.findFirst({
            where: {
              id,
              AND: [
                { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                {
                  OR: [
                    { dispatchMode: null },
                    { dispatchMode: '' },
                    { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }],
                },
              ],
            },
          });
    if (!row) {
      throw new NotFoundException(`${source === 'manual' ? '手动订单' : '亚马逊订单'}不存在或当前不可切中国发: ${idRaw}`,
      );
    }
    const [enrichedRows, activePickedRefs] = await Promise.all([
      source === 'amazon'
        ? this.enrichAmazonOrderRows([row as AmazonOrderRecord])
        : this.enrichManualOrderRows([row as ManualOrderRecordLike]),
      this.loadActiveOverseasPickingBatchRefs([{ source, sourceRecordId: id }]),
    ]);
    const enrichedRow = enrichedRows[0];
    if (
      !enrichedRow ||
      enrichedRow.fulfillmentMode !== 'overseas_warehouse' ||
      activePickedRefs.has(`${source}:${id.toString()}`)
    ) {
      throw new BadRequestException('当前订单已不在海外仓待处理范围内，无法切中国发');
    }
    if (source === 'amazon') {
      const orderId = String((row as AmazonOrderRecord).orderId ?? '').trim();
      const scopedRows = orderId
        ? await this.prisma.amazonOrderRecord.findMany({
            where: {
              ...PROCESSABLE_AMAZON_ORDER_WHERE,
              orderId,
              AND: [
                { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                {
                  OR: [
                    { dispatchMode: null },
                    { dispatchMode: '' },
                    { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }],
                },
              ],
            },
            select: {
              id: true,
            },
          })
        : [];
      const scopedIds = Array.from(
        new Set((scopedRows.length ? scopedRows.map((item) => item.id) : [id]).map((itemId) => itemId.toString())),
      ).map((itemId) => BigInt(itemId));
      await this.prisma.amazonOrderRecord.updateMany({
        where: { id: { in: scopedIds } },
        data: {
          dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
        },
      });
      return {
        success: true,
        source,
        id: id.toString(),
        dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
        updatedIds: scopedIds.map((itemId) => itemId.toString()),
      };
    } else {
      await (this.prisma as any).manualOrderRecord.update({
        where: { id },
        data: {
          dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
        },
      });
      await this.syncManualOrderIdsToXyjgBestEffort([id]);
    }
    return {
      success: true,
      source,
      id: id.toString(),
      dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
    };
  }

  async listChinaOrderProcessing(
    limitParam?: string,
    scopeParam?: string,
    offsetParam?: string,
    includeAll = false,
  ): Promise<OverseasWarehouseOrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = includeAll
      ? Number.MAX_SAFE_INTEGER
      : Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 1000)
        : 200;
    const parsedOffset = Number(offsetParam);
    const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? Math.min(parsedOffset, 100000) : 0;
    const collectTarget = offset + limit;
    const scope = this.normalizeChinaOrderScope(scopeParam);
    const batchSize = Math.min(Math.max(collectTarget, 200), 500);
    const collected: OverseasWarehouseOrderListItem[] = [];
    let rakutenSkip = 0;
    let amazonSkip = 0;
    let manualSkip = 0;
    let rakutenExhausted = false;
    let amazonExhausted = false;
    let manualExhausted = false;

    while (collected.length < collectTarget && (!rakutenExhausted || !amazonExhausted || !manualExhausted)) {
      const [rakutenRows, amazonRows, manualRows]: [RakutenOrderRecord[], AmazonOrderRecord[], ManualOrderRecordLike[],
      ] = await Promise.all([
        rakutenExhausted
          ? Promise.resolve([] as RakutenOrderRecord[])
          : this.prisma.rakutenOrderRecord.findMany({
              where: { deletedAt: null,
                ...this.buildChinaOrderShipmentNoFilter(scope),
              },
              orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
              skip: rakutenSkip,
              take: batchSize,
            }),
        amazonExhausted
          ? Promise.resolve([] as AmazonOrderRecord[])
          : this.prisma.amazonOrderRecord.findMany({
              where: {
                ...PROCESSABLE_AMAZON_ORDER_WHERE,
                ...this.buildChinaOrderShipmentNoFilter(scope),
              },
              orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
              skip: amazonSkip,
              take: batchSize,
            }),
        manualExhausted
          ? Promise.resolve([] as ManualOrderRecordLike[])
          : (this.prisma as any).manualOrderRecord.findMany({
              where: {
                ...this.buildChinaOrderShipmentNoFilter(scope),
              },
              orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
              skip: manualSkip,
              take: batchSize,
            }),
      ]);

      rakutenSkip += rakutenRows.length;
      amazonSkip += amazonRows.length;
      manualSkip += manualRows.length;
      rakutenExhausted = rakutenRows.length < batchSize;
      amazonExhausted = amazonRows.length < batchSize;
      manualExhausted = manualRows.length < batchSize;

      const [enrichedRakutenRows, enrichedAmazonRows, enrichedManualRows] = await Promise.all([
        this.enrichOrderRows(rakutenRows),
        this.enrichAmazonOrderRows(amazonRows),
        this.enrichManualOrderRows(manualRows),
      ]);

      const activePickedRefs = await this.loadActiveOverseasPickingBatchRefs([
        ...enrichedRakutenRows.map((row) => ({
          source: 'rakuten' as const,
          sourceRecordId: row.id,
        })),
        ...enrichedAmazonRows.map((row) => ({
          source: 'amazon' as const,
          sourceRecordId: row.id,
        })),
        ...enrichedManualRows.map((row) => ({
          source: 'manual' as const,
          sourceRecordId: row.id,
        })),
      ]);

      collected.push(
        ...enrichedRakutenRows
          .filter((row) => {
            if (!String(row.shipmentNo ?? '').trim() && rakutenOrderRemarkNeedsConfirmation(row)) return false;
            const dispatchMode = String(row.dispatchMode ?? '').trim();
            if (this.isChinaDispatchMode(dispatchMode)) {
              return true;
            }
            return row.fulfillmentMode === 'xiya_api' && !activePickedRefs.has(`rakuten:${row.id.toString()}`);
          })
          .map((row) => {
            const dispatchMode = String(row.dispatchMode ?? '').trim();
            return {
              source: 'rakuten' as const,
              id: row.id.toString(),
              sourceLabel: '乐天',
              csvImportedAt: row.csvImportedAt,
              createdAt: row.createdAt,
              orderId: row.orderId,
              skuCode: row.skuCode,
              resolvedProductId: row.resolvedProductId,
              resolvedProductName: row.resolvedProductName,
              orderQuantity: row.orderQuantity,
              shopName: row.shopName,
              shippingName: row.shippingName,
              availableStock: row.availableStock,
              orderImportedAtRaw: row.orderImportedAtRaw,
              productName: row.productName,
              productNameExtra: row.productNameExtra,
              shippingPhone: row.shippingPhone,
              shippingPostalCode: row.shippingPostalCode,
              shippingPrefecture: row.shippingPrefecture,
              shippingCity: row.shippingCity,
              shippingAddress: row.shippingAddress,
              deliveryDateRaw: row.deliveryDateRaw,
              deliveryTimeSlot: row.deliveryTimeSlot,
              rawPayload: row.rawPayload,
              dispatchMode: dispatchMode || null,
              chinaDispatchReason: this.resolveChinaDispatchReason(dispatchMode),
              xiyaExportedAt: row.xiyaExportedAt?.toISOString() ?? null,
              xiyaStatus: row.shipmentNo ? ('tracking_registered' as const) : ('pending_tracking' as const),
              shipmentCompany: row.shipmentCompany,
              shipmentNo: row.shipmentNo,
              shipmentNoRegisteredAt: row.shipmentNoRegisteredAt?.toISOString() ?? null,
            };
          }),
        ...enrichedAmazonRows
          .filter((row) => {
            const dispatchMode = String(row.dispatchMode ?? '').trim();
            if (this.isChinaDispatchMode(dispatchMode)) {
              return true;
            }
            return row.fulfillmentMode === 'xiya_api' && !activePickedRefs.has(`amazon:${row.id.toString()}`);
          })
          .map((row) => {
            const dispatchMode = String(row.dispatchMode ?? '').trim();
            return {
              source: 'amazon' as const,
              id: row.id.toString(),
              sourceLabel: '亚马逊',
              csvImportedAt: row.csvImportedAt,
              createdAt: row.createdAt,
              orderId: row.orderId,
              skuCode: row.sku,
              resolvedProductId: row.resolvedProductId,
              resolvedProductName: row.resolvedProductName,
              orderQuantity: row.quantityPurchased,
              shopName: row.resolvedShopName || row.shopName,
              shippingName: row.recipientName,
              availableStock: row.availableStock,
              purchaseDateRaw: row.purchaseDateRaw,
              productName: row.productName,
              buyerPhoneNumber: row.buyerPhoneNumber,
              shipPostalCode: row.shipPostalCode,
              shipState: row.shipState,
              shipAddress1: row.shipAddress1,
              shipAddress2: row.shipAddress2,
              shipAddress3: row.shipAddress3,
              rawPayload: row.rawPayload,
              dispatchMode: dispatchMode || null,
              chinaDispatchReason: this.resolveChinaDispatchReason(dispatchMode),
              xiyaExportedAt: row.xiyaExportedAt?.toISOString() ?? null,
              xiyaStatus: row.shipmentNo ? ('tracking_registered' as const) : ('pending_tracking' as const),
              shipmentCompany: row.shipmentCompany,
              shipmentNo: row.shipmentNo,
              shipmentNoRegisteredAt: row.shipmentNoRegisteredAt?.toISOString() ?? null,
            };
          }),
        ...enrichedManualRows
          .filter((row) => {
            const dispatchMode = String(row.dispatchMode ?? '').trim();
            if (this.isChinaDispatchMode(dispatchMode)) {
              return true;
            }
            return row.fulfillmentMode === 'xiya_api' && !activePickedRefs.has(`manual:${row.id.toString()}`);
          })
          .map((row) => {
            const dispatchMode = String(row.dispatchMode ?? '').trim();
            return {
              source: 'manual' as const,
              id: row.id.toString(),
              sourceLabel: '手动订单',
              csvImportedAt: row.csvImportedAt,
              createdAt: row.createdAt,
              orderId: row.orderId,
              skuCode: row.sku,
              resolvedProductId: row.resolvedProductId,
              resolvedProductName: row.resolvedProductName,
              orderQuantity: row.quantityPurchased,
              shopName: row.resolvedShopName || row.shopName,
              shippingName: row.recipientName,
              availableStock: row.availableStock,
              purchaseDateRaw: row.purchaseDateRaw,
              productName: row.productName,
              buyerPhoneNumber: row.buyerPhoneNumber,
              shipPostalCode: row.shipPostalCode,
              shipState: row.shipState,
              shipAddress1: row.shipAddress1,
              shipAddress2: row.shipAddress2,
              shipAddress3: row.shipAddress3,
              rawPayload: row.rawPayload,
              dispatchMode: dispatchMode || null,
              chinaDispatchReason: this.resolveChinaDispatchReason(dispatchMode),
              xiyaExportedAt: row.xiyaExportedAt?.toISOString() ?? null,
              xiyaStatus: row.shipmentNo ? ('tracking_registered' as const) : ('pending_tracking' as const),
              shipmentCompany: row.shipmentCompany,
              shipmentNo: row.shipmentNo,
              shipmentNoRegisteredAt: row.shipmentNoRegisteredAt?.toISOString() ?? null,
            };
          }),
      );
    }

    return collected
      .sort((a, b) => {
        const timeDiff = new Date(b.csvImportedAt).getTime() - new Date(a.csvImportedAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(offset, offset + limit);
  }

  async buildOrderProcessingExport(
    target: 'overseas' | 'china'): Promise<OrderProcessingExportFile> {
    const orders =
      target === 'overseas'
        ? await this.listOverseasWarehouse(undefined, true)
        : await this.listChinaOrderProcessing(undefined, 'all', undefined, true);
    const isChina = target === 'china';
    const headers = [
      '导入时间',
      '平台',
      '订单号',
      'SKU',
      '产品ID',
      '产品名称',
      '数量',
      '店铺',
      '收件人',
      '电话',
      '邮编',
      '地址',
      '可用库存',
      ...(isChina ? ['进入原因', '订单状态', '发货公司', '运单号', '登记时间'] : []),
    ];
    const rows = orders.map((order) => [
      this.formatOrderProcessingExportDate(order.csvImportedAt || order.createdAt),
      order.sourceLabel,
      order.orderId ?? '',
      order.skuCode ?? '',
      order.resolvedProductId ?? '',
      order.resolvedProductName ?? order.productName ?? '',
      order.orderQuantity ?? '',
      order.shopName ?? '',
      order.shippingName ?? '',
      order.shippingPhone ?? order.buyerPhoneNumber ?? '',
      order.shippingPostalCode ?? order.shipPostalCode ?? '',
      this.concatAddress([
        order.shippingPrefecture ?? order.shipState,
        order.shippingCity ?? order.shipAddress1,
        order.shippingAddress ?? order.shipAddress2,
        order.shipAddress3,
      ]),
      order.availableStock,
      ...(isChina
        ? [
            order.chinaDispatchReason ?? '',
            order.shipmentNo ? '已登记运单号' : '待 Xiya 拉取',
            order.shipmentCompany ?? '',
            order.shipmentNo ?? '',
            this.formatOrderProcessingExportDate(order.shipmentNoRegisteredAt),
          ]
        : []),
    ]);
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    worksheet['!cols'] = headers.map((header) => ({
      wch: ['产品名称', '地址'].includes(header) ? 32 : Math.max(12, header.length * 2 + 2),
    }));
    worksheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: rows.length, c: headers.length - 1 }),
    };
    const workbook = XLSX.utils.book_new();
    const sheetName = isChina ? '中国订单处理一览' : '海外仓订单处理一览';
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    const timestamp = this.formatYamatoFileNameStamp();
    return {
      fileName: `${sheetName}_${timestamp}.xlsx`,
      content: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx',
      }) as Buffer,
    };
  }

  async deleteAmazonBatch(payload: {
    ids?: Array<string | number>;
  }, createdBy?: bigint,
  ): Promise<{ deletedCount: number }> {
    const rawIds = Array.isArray(payload?.ids) ? payload.ids : [];
    const ids = Array.from(
      new Set(
        rawIds
          .map((id, index) => {
            const text = String(id ?? '').trim();
            return text ? parseId(text, `ids[${index}]`) : null;
          })
          .filter((id): id is bigint => id !== null),
      ),
    );

    if (!ids.length) {
      throw new BadRequestException('请至少选择一条亚马逊订单记录');
    }

    await this.assertOrderRecordsHaveNoShipmentNo('amazon', ids);
    await this.assertOrderRecordsNotInOverseasPickingBatch('amazon', ids);
    const selectedRows = await this.prisma.amazonOrderRecord.findMany({
      where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, id: { in: ids } },
    });
    const orderIds = Array.from(
      new Set(selectedRows.map((row) => String(row.orderId ?? '').trim()).filter(Boolean)));
    const allRows = orderIds.length
      ? await this.prisma.amazonOrderRecord.findMany({
          where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, orderId: { in: orderIds } },
        })
      : [];
    const selectedIdSet = new Set(selectedRows.map((row) => row.id.toString()));
    const exclusions: Array<{
      spApiConnectionId: bigint | null;
      orderId: string;
      orderItemId: string | null;
    }> = [];

    for (const orderId of orderIds) {
      const orderRows = allRows.filter((row) => row.orderId === orderId);
      const selectedOrderRows = orderRows.filter((row) => selectedIdSet.has(row.id.toString()));
      const remainingOrderRows = orderRows.filter((row) => !selectedIdSet.has(row.id.toString()));
      if (selectedOrderRows.length === orderRows.length) {
        const scopes = new Set(selectedOrderRows.map((row) => row.spApiConnectionId?.toString() ?? 'global'));
        for (const scope of scopes) {
          exclusions.push({
            spApiConnectionId: scope === 'global' ? null : BigInt(scope),
            orderId,
            orderItemId: null,
          });
        }
        continue;
      }
      for (const row of selectedOrderRows) {
        const orderItemId = this.resolveOriginalAmazonOrderItemId(row.rawPayload, row.orderItemId);
        if (!orderItemId) continue;
        const sameLogicalItemRemains = remainingOrderRows.some(
          (remaining) => this.resolveOriginalAmazonOrderItemId(remaining.rawPayload, remaining.orderItemId) === orderItemId,
        );
        if (!sameLogicalItemRemains) {
          exclusions.push({ spApiConnectionId: row.spApiConnectionId, orderId, orderItemId,
          });
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      for (const exclusion of exclusions) {
        await tx.amazonOrderSyncExclusion.create({
          data: { ...exclusion, reason: 'user_delete', createdBy: createdBy ?? null,
          },
        });
      }
      const result = await tx.amazonOrderRecord.deleteMany({
        where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, id: { in: ids } },
      });
      return { deletedCount: result.count };
    });
  }

  async listAmazonSyncExclusions(): Promise<unknown[]> {
    const rows = await this.prisma.amazonOrderSyncExclusion.findMany({
      where: { isActive: true },
      orderBy: { id: 'desc' },
      take: 500,
    });
    return rows.map((row) => ({
      id: row.id.toString(),
      connectionId: row.spApiConnectionId?.toString() ?? null,
      orderId: row.orderId,
      orderItemId: row.orderItemId,
      reason: row.reason,
      createdBy: row.createdBy?.toString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async restoreAmazonSyncExclusions(
    payload: { ids?: Array<string | number> },
    restoredBy?: bigint,
  ): Promise<{ restoredCount: number }> {
    const ids = Array.from(new Set((payload.ids ?? []).map((id, index) => parseId(String(id), `ids[${index}]`))));
    if (!ids.length) throw new BadRequestException('请至少选择一条已删除订单记录');
    const result = await this.prisma.amazonOrderSyncExclusion.updateMany({
      where: { id: { in: ids }, isActive: true },
      data: { isActive: false, restoredBy: restoredBy ?? null, restoredAt: new Date(),
      },
    });
    return { restoredCount: result.count };
  }

  async deleteManualBatch(payload: {
    ids?: Array<string | number> }): Promise<{ deletedCount: number }> {
    const rawIds = Array.isArray(payload?.ids) ? payload.ids : [];
    const ids = Array.from(
      new Set(
        rawIds
          .map((id, index) => {
            const text = String(id ?? '').trim();
            return text ? parseId(text, `ids[${index}]`) : null;
          })
          .filter((id): id is bigint => id !== null),
      ),
    );

    if (!ids.length) {
      throw new BadRequestException('请至少选择一条手动订单记录');
    }

    await this.assertOrderRecordsHaveNoShipmentNo('manual', ids);
    await this.assertOrderRecordsNotInOverseasPickingBatch('manual', ids);

    const result = await (this.prisma as any).manualOrderRecord.deleteMany({
      where: { id: { in: ids } },
    });

    return { deletedCount: result.count };
  }

  async buildAmazonShipmentConfirmationTxt(payload: {
    days?: string | number;
  }): Promise<AmazonShipmentConfirmationFileResult> {
    const scope = this.normalizeShipmentConfirmationScope(payload?.days, '订单');
    const importedAtStart = scope.days === 'all' ? null : this.getImportDateRangeStart(scope.days);

    const rows = await this.prisma.amazonOrderRecord.findMany({
      where: {
        ...PROCESSABLE_AMAZON_ORDER_WHERE,
        shipmentNo: { not: null },
        shipmentNoRegisteredAt: { not: null },
        ...(importedAtStart ? { csvImportedAt: { gte: importedAtStart } } : {}),
      },
      orderBy: [{ csvImportedAt: 'desc' }, { shipmentNoRegisteredAt: 'asc' }, { id: 'asc' }],
    });
    if (!rows.length) {
      throw new BadRequestException(`${scope.label}没有可下载的已登记发货单号亚马逊订单`);
    }

    const invalidRows = rows
      .map((row) => {
        const missingFields = [
          String(row.orderId ?? '').trim() ? null : 'order-id',
          String(row.orderItemId ?? '').trim() ? null : 'order-item-id',
          Number(row.quantityPurchased ?? 0) > 0 ? null : 'quantity',
          row.shipmentNoRegisteredAt ? null : 'ship-date',
          String(row.shipmentNo ?? '').trim() ? null : 'tracking-number',
        ].filter((item): item is string => Boolean(item));
        return missingFields.length ? `${row.orderId ?? row.id.toString()} 缺少 ${missingFields.join('、')}` : null;
      })
      .filter((item): item is string => Boolean(item));
    if (invalidRows.length) {
      throw new BadRequestException(`无法生成回传单号TXT：${invalidRows.join('；')}`);
    }

    const timestamp = this.formatYamatoFileNameStamp();
    return {
      fileName: `${timestamp}_${scope.fileLabel}_亚马逊回传单号.txt`,
      content: this.buildAmazonShipmentConfirmationTxtContent(rows),
      rowCount: rows.length,
      fileCount: 1,
    };
  }

  private buildAmazonShipmentConfirmationTxtContent(rows: Array<AmazonOrderRecord | AmazonEnrichedOrderListItem>,
  ): Buffer {
    const headers = [
      'order-id',
      'order-item-id',
      'quantity',
      'ship-date',
      'carrier-code',
      'carrier-name',
      'tracking-number',
      'ship-method',
      'transparency_code',
      'ship_from_address_name',
      'ship_from_address_line1',
      'ship_from_address_line2',
      'ship_from_address_line3',
      'ship_from_address_city',
      'ship_from_address_county',
      'ship_from_address_state_or_region',
      'ship_from_address_postalcode',
      'ship_from_address_countrycode',
    ];
    const lines = [
      headers.join('\t'),
      ...rows.map((row) =>
        {
          const shipmentProfile = this.resolveAmazonShipmentConfirmationProfile(row);
          return [
            row.orderId,
            row.orderItemId,
            String(row.quantityPurchased ?? ''),
            this.formatAmazonShipmentConfirmationDate(row.shipmentNoRegisteredAt as Date),
            shipmentProfile.carrierCode,
            '',
            this.normalizeAmazonTrackingNumber(row.shipmentNo),
            shipmentProfile.shipMethod,
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '',
          ]
            .map((value) => this.escapeTsvCell(value))
            .join('\t');
        }),
    ];
    return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
  }

  async deleteRakutenBatch(payload: { ids?: Array<string | number> }, createdBy?: bigint): Promise<{ deletedCount: number; fullOrderCount: number; partialOrderCount: number }> {
    const ids = Array.from(new Set((Array.isArray(payload?.ids) ? payload.ids : [])
      .map((value, index) => parseId(String(value ?? '').trim(), `ids[${index}]`))));
    if (!ids.length) throw new BadRequestException('请至少选择一条乐天订单记录');
    const selected = await this.prisma.rakutenOrderRecord.findMany({ where: { id: { in: ids }, deletedAt: null } });
    if (!selected.length) return { deletedCount: 0, fullOrderCount: 0, partialOrderCount: 0 };
    // API order identity is stable across shop renames; CSV orders retain shop isolation.
    const groups = Array.from(new Map(selected.filter((row) => row.orderId).map((row) => [
      row.rmsConnectionId ? `${row.rmsConnectionId}|${originalRakutenOrderId(row)}` : `csv|${row.shopName ?? ''}|${originalRakutenOrderId(row)}`,
      { orderId: originalRakutenOrderId(row), rmsConnectionId: row.rmsConnectionId, shopName: row.shopName },
    ])).values());
    const scope = { deletedAt: null, OR: [ ...groups.map((group) => group.rmsConnectionId
      ? { rmsConnectionId: group.rmsConnectionId, ...rakutenOrderIdentityWhere(group.orderId) }
      : { rmsConnectionId: null, shopName: group.shopName, ...rakutenOrderIdentityWhere(group.orderId) }), { id: { in: selected.filter((row) => !row.orderId).map((row) => row.id) } } ] };
    return this.prisma.$transaction(async (tx) => {
      const token = randomUUID();
      const connectionIds = Array.from(new Set(selected.flatMap((row) => row.rmsConnectionId ? [row.rmsConnectionId] : []))).sort((a, b) => a < b ? -1 : 1);
      for (const connectionId of connectionIds) {
        // Same lock used by outbound processing. Reject cancellation during an
        // in-flight external operation; never claim that an accepted email was undone.
        const lock = await tx.rakutenRmsConnection.updateMany({ where: { id: connectionId, OR: [
          { automationLockToken: null }, { automationLockedAt: null },
          { automationLockedAt: { lt: new Date(Date.now() - 30 * 60_000) } },
        ] }, data: { automationLockToken: token, automationLockedAt: new Date() } });
        if (lock.count !== 1) throw new ConflictException('店铺当前正在执行单号回传或邮件发送，请待本轮结束后再确认删除');
      }
      const allRows = await tx.rakutenOrderRecord.findMany({ where: scope });
      if (selected.some((row) => !allRows.some((current) => current.id === row.id))) {
        throw new ConflictException('选中产品已被删除或所属订单发生变化，请刷新后重试');
      }
      const rows = allRows.filter((row) => ids.includes(row.id));
      const rowIds = rows.map((row) => row.id);
      const picking = await tx.overseasPickingBatchItem.findFirst({ where: {
        source: 'rakuten', sourceRecordId: { in: rowIds },
      }, select: { id: true } });
      if (picking) throw new BadRequestException('订单已关联拣货批次，请先由仓库处理后再确认删除');
      const deletedAt = new Date();
      let fullOrderCount = 0;
      let partialOrderCount = 0;
      for (const group of groups) {
        const inGroup = (row: RakutenOrderRecord) => originalRakutenOrderId(row) === group.orderId &&
          row.rmsConnectionId === group.rmsConnectionId && (group.rmsConnectionId !== null || row.shopName === group.shopName);
        const remaining = allRows.filter((row) => inGroup(row) && !rowIds.includes(row.id));
        if (!remaining.length) {
          fullOrderCount += 1;
          await tx.rakutenOrderSyncExclusion.create({ data: { ...group, rmsItemKey: null, skuCode: null,
            reason: 'user_delete', createdBy: createdBy ?? null } });
        }
        if (remaining.length) {
          partialOrderCount += 1;
          for (const row of rows.filter(inGroup)) {
            const skuCode = String(row.skuCode ?? '').trim().toLowerCase() || null;
            if (!row.rmsItemKey && !skuCode) throw new BadRequestException('产品缺少商品标识，无法安全记录产品删除范围');
            await tx.rakutenOrderSyncExclusion.create({ data: {
              rmsConnectionId: row.rmsConnectionId, shopName: row.shopName, orderId: group.orderId,
              rmsItemKey: row.rmsItemKey, skuCode: row.rmsItemKey ? null : skuCode,
              reason: 'user_delete', createdBy: createdBy ?? null,
            } });
          }
          // Deleted products change the purchased content and original RMS totals.
          // Keep other products active, but require reviewed product-mail bodies.
          for (const row of remaining) {
            const updated = await tx.rakutenOrderRecord.updateMany({ where: { id: row.id, deletedAt: null, updatedAt: row.updatedAt }, data: {
              rawPayload: this.mergeRawPayload(row.rawPayload, { _wmsDeletedItemsAt: deletedAt.toISOString() }),
            } });
            if (updated.count !== 1) throw new ConflictException('剩余商品在删除期间发生变化，请刷新后重试');
          }
          continue;
        }
        if (!group.rmsConnectionId) continue;
        const jobScope = { connectionId: group.rmsConnectionId, orderId: group.orderId,
          status: { in: [RakutenAutomationStatus.pending, RakutenAutomationStatus.failed, RakutenAutomationStatus.dead_letter] } };
        const note = '全部产品已勾选删除，整单后续处理已终止';
        await tx.rakutenOrderMail.updateMany({ where: jobScope, data: {
          status: 'cancelled', nextAttemptAt: null, failureCategory: 'order_deleted',
          resolutionNote: note, resolvedAt: deletedAt, resolvedBy: createdBy ?? null, lastError: note,
        } });
        // Preserve completed and uncertain records as evidence.
        await tx.rakutenOrderShippingReport.updateMany({ where: jobScope, data: {
          status: 'skipped', nextAttemptAt: null, failureCategory: 'order_deleted', lastError: note,
        } });
      }
      const result = await tx.rakutenOrderRecord.updateMany({ where: { id: { in: rowIds }, deletedAt: null },
        data: { deletedAt, deletedBy: createdBy ?? null } });
      if (result.count !== rowIds.length) throw new ConflictException('产品在删除期间发生变化，请刷新后重试');
      for (const connectionId of connectionIds) {
        await tx.rakutenRmsConnection.updateMany({ where: { id: connectionId, automationLockToken: token },
          data: { automationLockToken: null, automationLockedAt: null } });
      }
      return { deletedCount: result.count, fullOrderCount, partialOrderCount };
    }, { maxWait: 10000, timeout: 30000 });
  }

  async changeRakutenOrderIdBatch(
    payload: { ids?: Array<string | number>; newOrderId?: string | null },
    operatorUsername = 'unknown',
  ): Promise<{ updatedCount: number; previousOrderId: string; newOrderId: string }> {
    const rawIds = Array.isArray(payload?.ids) ? payload.ids : [];
    const ids = Array.from(
      new Set(
        rawIds.map((value, index) => parseId(String(value ?? '').trim(), `ids[${index}]`)),
      ),
    );
    if (!ids.length) throw new BadRequestException('请至少选择一条乐天订单记录');

    const newOrderId = this.normalizeEditableText(payload?.newOrderId, '新订单号', 64);
    if (!newOrderId) throw new BadRequestException('请输入新订单号');

    const rows = await this.prisma.rakutenOrderRecord.findMany({ where: { deletedAt: null, id: { in: ids } } });
    if (rows.length !== ids.length) throw new NotFoundException('部分乐天订单记录不存在，请刷新列表后重试');
    const previousOrderIds = new Set(rows.map((row) => String(row.orderId ?? '').trim()));
    if (previousOrderIds.size !== 1 || previousOrderIds.has('')) {
      throw new BadRequestException('请选择订单号相同的乐天订单');
    }
    const previousOrderId = Array.from(previousOrderIds)[0];
    if (newOrderId === previousOrderId) throw new BadRequestException('新订单号不能与当前订单号相同');

    const rowWithShipment = rows.find((row) => String(row.shipmentNo ?? '').trim());
    if (rowWithShipment) {
      throw new ConflictException(
        `订单 ${String(rowWithShipment.orderId ?? rowWithShipment.id.toString()).trim()} 已有运单号，不能修改订单号`,
      );
    }
    await this.assertOrderRecordsNotInOverseasPickingBatch('rakuten', ids);
    const conflicting = await this.prisma.rakutenOrderRecord.findFirst({
      where: { deletedAt: null, orderId: newOrderId, id: { notIn: ids } },
      select: { id: true },
    });
    if (conflicting) throw new ConflictException(`乐天订单 ${newOrderId} 已存在，不能使用相同订单号`);

    const originalOrderIds = new Set(rows.map(originalRakutenOrderId));
    if (originalOrderIds.size !== 1 || new Set(rows.map((row) => row.rmsConnectionId ?? `csv:${row.shopName}`)).size !== 1) {
      throw new BadRequestException('只能拆分同一店铺的同一乐天原订单');
    }
    const originalOrderId = [...originalOrderIds][0];
    const manualOverrideAt = new Date();
    const operator = this.normalizeRakutenManualOperator(operatorUsername);
    await this.prisma.$transaction(async (tx) => {
      const token = randomUUID();
      const connectionIds = [...new Set(rows.flatMap((row) => row.rmsConnectionId ? [row.rmsConnectionId] : []))];
      for (const connectionId of connectionIds) {
        const locked = await tx.rakutenRmsConnection.updateMany({ where: { id: connectionId, OR: [
          { automationLockToken: null }, { automationLockedAt: null },
          { automationLockedAt: { lt: new Date(Date.now() - 30 * 60_000) } },
        ] }, data: { automationLockToken: token, automationLockedAt: new Date() } });
        if (locked.count !== 1) throw new ConflictException('店铺正在执行回传或邮件，暂不能拆分包裹');
      }
      // Lock the target index range, including an absent number. RepeatableRead
      // keeps concurrent CSV/cross-shop splits from both claiming the same number.
      const targetRows = await tx.$queryRaw<Array<{ id: bigint }>>(Prisma.sql`
        SELECT id FROM rakuten_order_records
        WHERE deleted_at IS NULL AND order_id = ${newOrderId} AND id NOT IN (${Prisma.join(ids)})
        FOR UPDATE
      `);
      if (targetRows.length) throw new ConflictException(`乐天订单 ${newOrderId} 已存在，不能使用相同订单号`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM rakuten_order_records WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
      const currentRows = await tx.rakutenOrderRecord.findMany({ where: { id: { in: ids }, deletedAt: null } });
      if (currentRows.length !== ids.length || currentRows.some((row) => row.orderId !== previousOrderId ||
        originalRakutenOrderId(row) !== originalOrderId || String(row.shipmentNo ?? '').trim())) {
        throw new ConflictException('选中产品在拆分期间发生变化，请刷新后重试');
      }
      const picking = await tx.overseasPickingBatchItem.findFirst({ where: { source: 'rakuten', sourceRecordId: { in: ids } } });
      if (picking) throw new ConflictException('产品已关联拣货批次，请先由仓库处理后再拆分');
      for (const row of currentRows) {
        await tx.rakutenOrderRecord.update({
          where: { deletedAt: null, id: row.id },
          data: {
            orderId: newOrderId,
            rmsOrderId: originalOrderId,
            rmsManualOverrideAt: manualOverrideAt,
            rmsManualOverrideBy: operator,
            rawPayload: this.mergeRawPayload(row.rawPayload, {
              _wmsOriginalOrderId: originalOrderId,
              _wmsManualOverrideFields: 'orderId',
              _wmsManualOverrideUpdatedAt: manualOverrideAt.toISOString(),
              注文番号: newOrderId,
              注文ID: newOrderId,
            }),
          },
        });
      }
      for (const connectionId of connectionIds) {
        await tx.rakutenRmsConnection.updateMany({ where: { id: connectionId, automationLockToken: token },
          data: { automationLockToken: null, automationLockedAt: null } });
      }
    }, { maxWait: 10000, timeout: 30000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034'
        || error.code === 'P2010' && ['1205', '1213'].includes(String(error.meta?.code)))) {
        throw new ConflictException('拆包操作发生并发冲突，请刷新后重新确认包裹订单号');
      }
      throw error;
    });
    return { updatedCount: rows.length, previousOrderId, newOrderId };
  }

  async buildOverseasPickingBatchYamatoImport(batchIdRaw: string): Promise<YamatoImportFileResult> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const batch = await this.prisma.overseasPickingBatch.findUnique({
      where: { id: batchId },
      include: {
        items: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!batch) {
      throw new NotFoundException(`拣货批次不存在: ${batchIdRaw}`);
    }
    if (
      batch.status !== OVERSEAS_PICKING_BATCH_STATUS.PICKED &&
      batch.status !== OVERSEAS_PICKING_BATCH_STATUS.YAMATO_EXPORTED
    ) {
      throw new BadRequestException('请先确认拣货并扣减实际库存，再生成 Yamato Excel');
    }
    if (!batch.items.length) {
      throw new BadRequestException('当前拣货批次没有可导出的明细');
    }

    const existingYamatoBatch = await this.prisma.yamatoShipmentBatch.findFirst({
      where: { pickingBatchId: batch.id },
      select: {
        id: true,
        status: true,
      },
    });
    if (existingYamatoBatch) {
      throw new BadRequestException(
        `当前拣货批次已生成 Yamato 批次 #${existingYamatoBatch.id.toString()}，请直接继续上传 PDF 或扫码打印`,
      );
    }

    const exportSourceItems = batch.items.filter(
      (item) =>
        String(item.dispatchMode ?? OVERSEAS_DISPATCH_MODE.OVERSEAS) === OVERSEAS_DISPATCH_MODE.OVERSEAS &&
        Number(item.actualQty ?? 0) > 0,
    );
    if (!exportSourceItems.length) {
      throw new BadRequestException('当前拣货批次没有可生成 Yamato 的海外仓拣货明细');
    }

    const exportItems = await this.buildYamatoExportItemsFromPickingBatchItems(exportSourceItems);
    const mergedRows = this.mergeYamatoExportItems(exportItems);
    if (!mergedRows.length) {
      throw new BadRequestException('当前拣货批次没有可生成打单导入文件的明细');
    }

    const currentDate = this.formatCurrentYamatoDate();
    const timestamp = this.formatYamatoFileNameStamp();
    const fileName = `ヤマト-インポート_${timestamp}.xlsx`;
    const content = await this.buildYamatoWorkbookBuffer(mergedRows, currentDate);

    const yamatoBatch = await this.prisma.$transaction(async (tx) => {
      const created = await tx.yamatoShipmentBatch.create({
        data: {
          pickingBatchId: batch.id,
          exportedFileName: fileName,
          pageCount: mergedRows.length,
          status: YAMATO_BATCH_STATUS.EXCEL_EXPORTED,
          pages: {
            create: mergedRows.map((row, index) => ({
              pageNo: index + 1,
              orderId: row.orderId,
              productIds: row.productIds,
              itemSummary: row.itemSummary,
              recipientName: row.recipientName,
            })),
          },
        },
      });
      await tx.overseasPickingBatch.update({
        where: { id: batch.id },
        data: {
          status: OVERSEAS_PICKING_BATCH_STATUS.YAMATO_EXPORTED,
        },
      });
      return created;
    });

    return {
      fileName,
      content,
      batchId: yamatoBatch.id.toString(),
    };
  }

  private parseSelectedOverseasOrderId(value: string | number | undefined, fieldName: string): bigint {
    const text = String(value ?? '').trim();
    if (!text) {
      throw new BadRequestException(`${fieldName} 不能为空`);
    }
    return parseId(text, fieldName);
  }

  private splitOverseasPickingBatches(items: OverseasPickingBatchItemSnapshot[]): OverseasPickingBatchItemSnapshot[][] {
    const orders = new Map<string, OverseasPickingBatchItemSnapshot[]>();
    for (const item of items) {
      const key = JSON.stringify([item.source, item.orderId]);
      const lines = orders.get(key) ?? [];
      lines.push(item);
      orders.set(key, lines);
    }
    const batches: OverseasPickingBatchItemSnapshot[][] = [];
    let current: OverseasPickingBatchItemSnapshot[] = [];
    let orderCount = 0;
    for (const lines of orders.values()) {
      if (orderCount === 30) {
        batches.push(current);
        current = [];
        orderCount = 0;
      }
      current.push(...lines);
      orderCount += 1;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  private async collectOverseasPickingBatchItemSnapshots(
    selectedItemsRaw: SelectedOverseasWarehouseOrderRef[] | undefined,
  ): Promise<OverseasPickingBatchItemSnapshot[]> {
    const selectedItems = Array.isArray(selectedItemsRaw) ? selectedItemsRaw : [];
    if (!selectedItems.length) {
      throw new BadRequestException('请至少选择一条海外仓订单');
    }

    const rakutenIds = Array.from(
      new Set(
        selectedItems
          .filter((item) => item?.source === 'rakuten')
          .map((item, index) => this.parseSelectedOverseasOrderId(item?.id, `items[${index}].id`)),
      ),
    );
    const amazonIds = Array.from(
      new Set(
        selectedItems
          .filter((item) => item?.source === 'amazon')
          .map((item, index) => this.parseSelectedOverseasOrderId(item?.id, `items[${index}].id`)),
      ),
    );
    const manualIds = Array.from(
      new Set(
        selectedItems
          .filter((item) => item?.source === 'manual')
          .map((item, index) => this.parseSelectedOverseasOrderId(item?.id, `items[${index}].id`)),
      ),
    );

    const [rakutenRows, amazonRows, manualRows] = await Promise.all([
      rakutenIds.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: { deletedAt: null, id: { in: rakutenIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, id: { in: amazonIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as AmazonOrderRecord[]),
      manualIds.length
        ? (this.prisma as any).manualOrderRecord.findMany({
            where: { id: { in: manualIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as ManualOrderRecordLike[]),
    ]);

    const unconfirmed = rakutenRows.find(rakutenOrderRemarkNeedsConfirmation);
    if (unconfirmed) {
      throw new BadRequestException(`乐天订单 ${unconfirmed.orderId ?? unconfirmed.id} 的备注待确认，请先打开编辑并保存后再生成拣货批次`);
    }

    const [enrichedRakutenRows, enrichedAmazonRows, enrichedManualRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
      this.enrichManualOrderRows(manualRows),
    ]);

    const rakutenMap = new Map(
      enrichedRakutenRows
        .filter((row) => row.fulfillmentMode === 'overseas_warehouse' && row.availableStock + (row.assemblableStock ?? 0) > 0)
        .map((row) => [row.id.toString(), row] as const),
    );
    const amazonMap = new Map(
      enrichedAmazonRows
        .filter((row) => row.fulfillmentMode === 'overseas_warehouse' && row.availableStock + (row.assemblableStock ?? 0) > 0)
        .map((row) => [row.id.toString(), row] as const),
    );
    const manualMap = new Map(
      enrichedManualRows
        .filter((row) => row.fulfillmentMode === 'overseas_warehouse' && row.availableStock + (row.assemblableStock ?? 0) > 0)
        .map((row) => [row.id.toString(), row] as const),
    );

    const items: OverseasPickingBatchItemSnapshot[] = [];
    const seen = new Set<string>();
    selectedItems.forEach((item, index) => {
      const source = item?.source;
      const id = String(item?.id ?? '').trim();
      if (!id || (source !== 'rakuten' && source !== 'amazon' && source !== 'manual')) {
        throw new BadRequestException(`items[${index}] 缺少有效的 source 或 id`);
      }

      const selectionKey = `${source}:${id}`;
      if (seen.has(selectionKey)) return;
      seen.add(selectionKey);
      if (source === 'rakuten') {
        const row = rakutenMap.get(id);
        if (!row) {
          throw new BadRequestException(`乐天订单 ${id} 不存在、无库存或已不在海外仓处理范围内`);
        }
        const orderId = String(row.orderId ?? '').trim();
        const productId = String(row.resolvedProductId ?? '').trim();
        const skuCode = String(row.skuCode ?? row.setComponentSkuCode ?? '').trim();
        const requestedQty = Number(row.orderQuantity ?? 0);
        if (!orderId || !productId || !skuCode || requestedQty <= 0) {
          throw new BadRequestException(`乐天订单 ${id} 缺少有效的订单号、产品ID、SKU 或数量`);
        }
        items.push({
          source,
          sourceRecordId: row.id,
          orderId,
          skuCode,
          productId,
          requestedQty,
          availableStockSnapshot: row.availableStock,
          shopName: row.shopName ?? null,
          shippingName: row.shippingName ?? null,
        });
        return;
      }

      const row = source === 'amazon' ? amazonMap.get(id) : manualMap.get(id);
      if (!row) {
        throw new BadRequestException(`${source === 'manual' ? '手动订单' : '亚马逊订单'} ${id} 不存在、无库存或已不在海外仓处理范围内`,
        );
      }
      const orderId = String(row.orderId ?? '').trim();
      const productId = String(row.resolvedProductId ?? '').trim();
      const skuCode = String(row.sku ?? (source === 'manual' ? productId : '')).trim();
      const requestedQty = Number(row.quantityPurchased ?? 0);
      if (!orderId || !productId || !skuCode || requestedQty <= 0) {
        const requiredFieldsText = source === 'manual' ? '订单号、产品ID 或数量' : '订单号、产品ID、SKU 或数量';
        throw new BadRequestException(`${source === 'manual' ? '手动订单' : '亚马逊订单'} ${id} 缺少有效的${requiredFieldsText}`,
        );
      }
      items.push({
        source,
        sourceRecordId: row.id,
        orderId,
        skuCode,
        productId,
        requestedQty,
        availableStockSnapshot: row.availableStock,
        shopName: row.resolvedShopName || row.shopName || null,
        shippingName: row.recipientName ?? null,
      });
    });

    return items;
  }

  private async assertOverseasPickingBatchDemandWithinStock(
    snapshots: OverseasPickingBatchItemSnapshot[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    if (!snapshots.length) return;
    const productIds = [...new Set(snapshots.map(item => item.productId))];
    const products = await db.masterProduct.findMany({
      where: { productId: { in: productIds } },
      select: {
        productId: true,
        productType: true,
        bomComponents: {
          select: {
            componentProductId: true,
            quantity: true,
            componentProduct: {
              select: { productName: true },
            },
          },
        },
      },
    });
    const productById = new Map(products.map((row) => [row.productId, row] as const));
    const shortageTexts: string[] = [];
    const newDemandByComponentProductId = new Map<string, number>();
    const componentNameByProductId = new Map<string, string>();
    const resolveBom = (productId: string, value: unknown): ShoulderStrapBomSnapshotItem[] => {
      const stored = this.parseShoulderStrapBomSnapshot(value);
      if (stored !== null) return stored;
      return (productById.get(productId)?.bomComponents ?? []).map((item) => ({
        componentProductId: item.componentProductId,
        componentProductName: item.componentProduct.productName ?? item.componentProductId,
        quantity: Number(item.quantity),
      }));
    };
    const addComponentDemand = (
      target: Map<string, number>,
      productId: string,
      requestedQty: number,
      pickingPlanSnapshot: unknown,
      bomSnapshot: unknown,
      validateProduct: boolean,
    ): void => {
      const finishedQty = this.parseOverseasPickingPlanSnapshot(pickingPlanSnapshot)
        .reduce((sum, plan) => sum + Number(plan.pickQty ?? 0), 0);
      const assemblyDemand = Math.max(requestedQty - finishedQty, 0);
      if (assemblyDemand <= 0) return;
      const product = productById.get(productId);
      const bomItems = resolveBom(productId, bomSnapshot);
      if (String(product?.productType ?? '').trim() !== '肩带' || !bomItems.length) {
        if (validateProduct) {
          shortageTexts.push(
            `产品 ${productId} 待拣 ${requestedQty}，已预留成品 ${finishedQty}，仍缺 ${assemblyDemand}`,
          );
        }
        return;
      }
      bomItems.forEach((item) => {
        const requiredQty = item.quantity * assemblyDemand;
        target.set(
          item.componentProductId,
          (target.get(item.componentProductId) ?? 0) + requiredQty,
        );
        componentNameByProductId.set(
          item.componentProductId,
          item.componentProductName,
        );
      });
    };

    snapshots.forEach((item) => addComponentDemand(
      newDemandByComponentProductId,
      item.productId,
      Number(item.requestedQty ?? 0),
      item.pickingPlanSnapshot,
      item.bomSnapshot,
      true,
    ));


    const componentProductIds = Array.from(newDemandByComponentProductId.keys());
    const liveComponents = componentProductIds.length
      ? await db.masterProduct.findMany({
          where: { productId: { in: componentProductIds } },
          select: {
            productId: true,
            productName: true,
            productType: true,
            stockQty: true,
            status: true,
            boxInventories: { select: { qty: true } },
          },
        })
      : [];
    const liveComponentByProductId = new Map(
      liveComponents.map((component) => [component.productId, component] as const),
    );
    const availableComponents = await availableStock(db, componentProductIds);
    for (const [componentProductId, newDemand] of newDemandByComponentProductId.entries()) {
      const component = liveComponentByProductId.get(componentProductId);
      const componentName = componentNameByProductId.get(componentProductId) || componentProductId;
      if (
        !component ||
        Number(component.status) !== 1 ||
        (component.productType !== '肩带本体' && component.productType !== '肩带配件')
      ) {
        shortageTexts.push(`BOM材料 ${componentProductId}（${componentName}）已停用、类型错误或不存在`);
        continue;
      }
      const boxStockQty = availableComponents.filter(row => row.productId === componentProductId)
        .reduce((sum, row) => sum + row.qty, 0);
      const reservedDemand = snapshots.filter(item => item.productId === componentProductId)
        .flatMap(item => this.parseOverseasPickingPlanSnapshot(item.pickingPlanSnapshot))
        .reduce((sum, plan) => sum + plan.pickQty, 0);
      const availableQty = Math.max(boxStockQty - reservedDemand, 0);
      if (availableQty < newDemand) {
        shortageTexts.push(
          `BOM材料 ${component.productId}（${component.productName ?? componentName}）可用库存 ${boxStockQty}，本批次成品占用 ${reservedDemand}，本批次需要 ${newDemand}`,
        );
      }
    }
    if (shortageTexts.length) {
      throw new ConflictException(`批次待拣数量超过库存：${shortageTexts.join('；')}`);
    }
  }

  private async findActiveOverseasPickingBatchDuplicates(
    snapshots: OverseasPickingBatchItemSnapshot[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string[]> {
    if (!snapshots.length) {
      return [];
    }
    const duplicateRows = await db.overseasPickingBatchItem.findMany({
      where: {
        OR: snapshots.map((item) => ({
          source: item.source,
          sourceRecordId: item.sourceRecordId,
        })),
        batch: {
          status: {
            in: [
              OVERSEAS_PICKING_BATCH_STATUS.CREATED,
              OVERSEAS_PICKING_BATCH_STATUS.PICKED,
              OVERSEAS_PICKING_BATCH_STATUS.YAMATO_EXPORTED,
            ],
          },
        },
      },
      include: {
        batch: {
          select: {
            batchNo: true,
          },
        },
      },
    });

    return duplicateRows.map(
      (row) =>
        `${row.source === 'amazon' ? '亚马逊' : row.source === 'manual' ? '手动订单' : '乐天'}:${row.orderId || row.sourceRecordId.toString()}(${row.batch.batchNo})`,
    );
  }

  private async attachOverseasPickingPlanSnapshots(
    snapshots: OverseasPickingBatchItemSnapshot[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const remainingLocationsByProductId = new Map<string,
      Array<{ shelfCode: string; boxCode: string; qty: number; originalQty: number }>>();
    const available = await availableStock(db, snapshots.map(item => item.productId));
    for (const row of available) {
      const list = remainingLocationsByProductId.get(row.productId) ?? [];
      list.push({ shelfCode: row.box.shelf.shelfCode, boxCode: row.box.boxCode,
        qty: row.qty, originalQty: row.qty });
      remainingLocationsByProductId.set(row.productId, list);
    }

    snapshots.forEach((snapshot) => {
      const locations = remainingLocationsByProductId.get(snapshot.productId) ?? [];
      let remainingQty = Math.max(Number(snapshot.requestedQty ?? 0), 0);
      const plans: OverseasPickingPlanSnapshotItem[] = [];

      for (const location of locations) {
        if (remainingQty <= 0) {
          break;
        }
        const currentQty = Number(location.qty ?? 0);
        if (currentQty <= 0) {
          continue;
        }
        const pickQty = Math.min(currentQty, remainingQty);
        plans.push({
          shelfCode: location.shelfCode ?? null,
          boxCode: location.boxCode ?? null,
          boxQty: Number(location.originalQty ?? currentQty),
          pickQty,
        });
        location.qty = currentQty - pickQty;
        remainingQty -= pickQty;
      }

      snapshot.pickingPlanSnapshot = plans;
    });
  }

  private async attachShoulderStrapBomSnapshots(
    snapshots: OverseasPickingBatchItemSnapshot[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const productIds = Array.from(
      new Set(snapshots.map((item) => String(item.productId ?? '').trim()).filter(Boolean)),
    );
    if (!productIds.length) return;
    const products = await db.masterProduct.findMany({
      where: { productId: { in: productIds }, productType: '肩带' },
      select: {
        productId: true,
        bomComponents: {
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: {
            componentProductId: true,
            quantity: true,
            componentProduct: { select: { productName: true, productType: true } },
          },
        },
      },
    });
    const bomByProductId = new Map<string, ShoulderStrapBomSnapshotItem[]>();
    products.forEach((product) => {
      if (product.bomComponents.length > 0) {
        const bodyCount = product.bomComponents.filter(
          (item) => String(item.componentProduct.productType ?? '').trim() === '肩带本体',
        ).length;
        if (bodyCount !== 1) {
          throw new BadRequestException(
            `肩带 ${product.productId} 的 BOM 必须且只能包含一种“肩带本体”，请先修正 BOM`,
          );
        }
      }
      bomByProductId.set(
        product.productId,
        product.bomComponents.map((item) => ({
          componentProductId: item.componentProductId,
          componentProductName: item.componentProduct.productName ?? item.componentProductId,
          quantity: Number(item.quantity),
        })),
      );
    });
    snapshots.forEach((snapshot) => {
      snapshot.bomSnapshot = bomByProductId.get(snapshot.productId) ?? [];
    });
  }

  private async attachOverseasPickingRequirementSnapshots(
    snapshots: OverseasPickingBatchItemSnapshot[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const productIds = Array.from(new Set(snapshots.flatMap((snapshot) => [
      snapshot.productId,
      ...(snapshot.bomSnapshot ?? []).map((component) => component.componentProductId),
    ]))).filter(Boolean);
    const products = productIds.length
      ? await db.masterProduct.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, productName: true, productType: true },
        })
      : [];
    const productById = new Map(products.map((product) => [product.productId, product] as const));

    snapshots.forEach((snapshot) => {
      const requestedQty = Math.max(0, Number(snapshot.requestedQty ?? 0));
      const finishedQty = this.parseOverseasPickingPlanSnapshot(snapshot.pickingPlanSnapshot)
        .reduce((sum, plan) => sum + Number(plan.pickQty ?? 0), 0);
      const bomItems = snapshot.bomSnapshot ?? [];
      const requirements = new Map<string, OverseasPickingRequirementSnapshotItem>();
      const addRequirement = (productId: string, quantity: number): void => {
        if (!productId || quantity <= 0) return;
        const product = productById.get(productId);
        const existing = requirements.get(productId);
        if (existing) {
          existing.requestedQty += quantity;
          return;
        }
        requirements.set(productId, {
          productId,
          productName: product?.productName ?? productId,
          productType: product?.productType ?? '',
          requestedQty: quantity,
          pickedQty: 0,
        });
      };

      if (!bomItems.length) {
        addRequirement(snapshot.productId, requestedQty);
      } else {
        addRequirement(snapshot.productId, Math.min(finishedQty, requestedQty));
        const assemblyQty = Math.max(requestedQty - finishedQty, 0);
        bomItems.forEach((component) => {
          addRequirement(component.componentProductId, Number(component.quantity) * assemblyQty);
        });
      }
      snapshot.pickingRequirementSnapshot = Array.from(requirements.values());
    });
  }

  private async loadActiveOverseasPickingBatchRefs(
    refs: Array<{ source: 'rakuten' | 'amazon' | 'manual'; sourceRecordId: bigint;
    }>,
  ): Promise<Set<string>> {
    if (!refs.length) {
      return new Set();
    }
    const rows = await this.prisma.overseasPickingBatchItem.findMany({
      where: {
        OR: refs.map((item) => ({
          source: item.source,
          sourceRecordId: item.sourceRecordId,
        })),
        batch: {
          status: {
            in: [
              OVERSEAS_PICKING_BATCH_STATUS.CREATED,
              OVERSEAS_PICKING_BATCH_STATUS.PICKED,
              OVERSEAS_PICKING_BATCH_STATUS.YAMATO_EXPORTED,
            ],
          },
        },
      },
      select: {
        source: true,
        sourceRecordId: true,
      },
    });
    return new Set(rows.map((row) => `${row.source}:${row.sourceRecordId.toString()}`));
  }

  private parseOverseasPickingBatchActualQtyPayload(
    payload: OverseasPickingBatchConfirmPayload): Map<string, number> {
    const rows = Array.isArray(payload?.items) ? payload.items : [];
    const actualQtyByItemId = new Map<string, number>();
    if (!rows.length) {
      return actualQtyByItemId;
    }
    rows.forEach((item, index) => {
      const idText = String(item?.id ?? '').trim();
      if (!idText) {
        throw new BadRequestException(`items[${index}].id 不能为空`);
      }
      const qty = Number(item?.actualQty);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new BadRequestException(`items[${index}].actualQty 必须为大于 0 的整数`);
      }
      actualQtyByItemId.set(idText, qty);
    });
    return actualQtyByItemId;
  }

  private async recalculateOverseasPickingBatchAfterItemRemoval(
    tx: Prisma.TransactionClient,
    batchId: bigint,
  ): Promise<boolean> {
    const remainingItems = await tx.overseasPickingBatchItem.findMany({
      where: { batchId },
      select: {
        id: true,
        orderId: true,
        requestedQty: true,
      },
    });
    if (!remainingItems.length) {
      await tx.overseasPickingBatch.delete({
        where: { id: batchId },
      });
      return true;
    }

    await tx.overseasPickingBatch.update({
      where: { id: batchId },
      data: {
        orderCount: new Set(
          remainingItems.map((row) => String(row.orderId ?? '').trim()).filter((value) => value.length > 0),
        ).size,
        itemCount: remainingItems.length,
        totalQty: remainingItems.reduce((sum, row) => sum + Number(row.requestedQty ?? 0), 0),
      },
    });
    return false;
  }

  private assertOverseasPickingBatchMatchesOrders(
    items: Array<{
      productId: string;
      requestedQty: number;
      actualQty: number;
      dispatchMode: string;
    }>,
  ): void {
    const requestedByProductId = new Map<string, number>();
    const actualByProductId = new Map<string, number>();

    items.forEach((item) => {
      if (String(item.dispatchMode ?? '').trim() !== OVERSEAS_DISPATCH_MODE.OVERSEAS) {
        return;
      }
      const productId = String(item.productId ?? '').trim();
      if (!productId) {
        return;
      }
      requestedByProductId.set(productId, (requestedByProductId.get(productId) ?? 0) + Number(item.requestedQty ?? 0));
      actualByProductId.set(productId, (actualByProductId.get(productId) ?? 0) + Number(item.actualQty ?? 0));
    });

    const productIds = Array.from(new Set([...requestedByProductId.keys(), ...actualByProductId.keys()])).sort();
    for (const productId of productIds) {
      const requestedQty = requestedByProductId.get(productId) ?? 0;
      const actualQty = actualByProductId.get(productId) ?? 0;
      if (requestedQty !== actualQty) {
        throw new BadRequestException(
          `拣货结果与订单不一致：产品 ${productId} 订单需要 ${requestedQty}，当前拣货 ${actualQty}`,
        );
      }
    }
  }

  private allocateOverseasPickingQtyAcrossBoxes(
    rows: Array<{ boxId: bigint; qty: number | null; productId: string }>,
    requestedQty: number,
    productId: string,
  ): Array<{ boxId: bigint; qty: number }> {
    let remaining = requestedQty;
    const allocations: Array<{ boxId: bigint; qty: number }> = [];

    for (const row of rows) {
      const currentQty = Number(row.qty ?? 0);
      if (currentQty <= 0 || remaining <= 0) continue;
      const allocateQty = Math.min(currentQty, remaining);
      remaining -= allocateQty;
      row.qty = currentQty - allocateQty;
      allocations.push({
        boxId: row.boxId,
        qty: allocateQty,
      });
    }

    if (remaining > 0) {
      throw new ConflictException(`产品 ${productId} 库存不足，仍缺少 ${remaining}`);
    }

    return allocations;
  }

  private parseOverseasPickingPlanSnapshot(value: unknown): OverseasPickingPlanSnapshotItem[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const row = item as Record<string, unknown>;
        const boxQty = Number(row.boxQty ?? 0);
        const pickQty = Number(row.pickQty ?? 0);
        if (!Number.isFinite(boxQty) || boxQty <= 0 || !Number.isFinite(pickQty) || pickQty < 0) {
          return null;
        }
        return {
          shelfCode: String(row.shelfCode ?? '').trim() || null,
          boxCode: String(row.boxCode ?? '').trim() || null,
          boxQty,
          pickQty,
        };
      })
      .filter((item): item is OverseasPickingPlanSnapshotItem => Boolean(item));
  }

  private parseShoulderStrapBomSnapshot(value: unknown): ShoulderStrapBomSnapshotItem[] | null {
    if (!Array.isArray(value)) return null;
    const items: ShoulderStrapBomSnapshotItem[] = [];
    for (const valueItem of value) {
      if (!valueItem || typeof valueItem !== 'object') return [];
      const row = valueItem as Record<string, unknown>;
      const componentProductId = String(row.componentProductId ?? row.partCode ?? '').trim();
      const quantity = Number(row.quantity ?? 0);
      if (!componentProductId || !Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
        return [];
      }
      items.push({
        componentProductId,
        componentProductName: String(row.componentProductName ?? row.partName ?? '').trim(),
        quantity,
      });
    }
    return items;
  }

  private parseOverseasPickingRequirementSnapshot(
    value: unknown,
  ): OverseasPickingRequirementSnapshotItem[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((valueItem) => {
        if (!valueItem || typeof valueItem !== 'object') return null;
        const row = valueItem as Record<string, unknown>;
        const productId = String(row.productId ?? '').trim();
        const requestedQty = Number(row.requestedQty ?? 0);
        const pickedQty = Number(row.pickedQty ?? 0);
        if (
          !productId
          || !Number.isInteger(requestedQty)
          || requestedQty <= 0
          || !Number.isInteger(pickedQty)
          || pickedQty < 0
          || pickedQty > requestedQty
        ) {
          return null;
        }
        return {
          productId,
          productName: String(row.productName ?? '').trim() || productId,
          productType: String(row.productType ?? '').trim(),
          requestedQty,
          pickedQty,
        };
      })
      .filter((item): item is OverseasPickingRequirementSnapshotItem => Boolean(item));
  }

  private async buildYamatoExportItemsFromPickingBatchItems(
    items: Array<{
      source: string;
      sourceRecordId: bigint;
      productId: string;
      actualQty: number | null;
      bomSnapshot?: unknown;
    }>,
  ): Promise<YamatoExportItem[]> {
    const rakutenIds = items
      .filter((item) => item.source === 'rakuten')
      .map((item) => item.sourceRecordId);
    const amazonIds = items
      .filter((item) => item.source === 'amazon')
      .map((item) => item.sourceRecordId);
    const manualIds = items
      .filter((item) => item.source === 'manual')
      .map((item) => item.sourceRecordId);
    const productIds = Array.from(
      new Set(
        items
          .map((item) => String(item.productId ?? '').trim())
          .filter((value) => value.length > 0)),
    );

    const [rakutenRows, amazonRows, manualRows, productRows]: [
      RakutenOrderRecord[],
      AmazonOrderRecord[],
      ManualOrderRecordLike[],
      Array<{ productId: string; yamatoPrinterName: string | null }>,
    ] = await Promise.all([
      rakutenIds.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: { deletedAt: null, id: { in: rakutenIds } },
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: { ...PROCESSABLE_AMAZON_ORDER_WHERE, id: { in: amazonIds } },
          })
        : Promise.resolve([] as AmazonOrderRecord[]),
      manualIds.length
        ? (this.prisma as any).manualOrderRecord.findMany({
            where: { id: { in: manualIds } },
          })
        : Promise.resolve([] as ManualOrderRecordLike[]),
      productIds.length
        ? this.prisma.masterProduct.findMany({
            where: { productId: { in: productIds } },
            select: {
              productId: true,
              yamatoPrinterName: true,
            },
          })
        : Promise.resolve([] as Array<{ productId: string; yamatoPrinterName: string | null;
            }>,
          ),
    ]);

    const rakutenMap = new Map(rakutenRows.map((row) => [row.id.toString(), row] as const));
    const amazonMap = new Map(amazonRows.map((row) => [row.id.toString(), row] as const));
    const manualMap = new Map(manualRows.map((row) => [row.id.toString(), row] as const));
    const printerValueByProductId = new Map(
      productRows.map((row) => [row.productId, String(row.yamatoPrinterName ?? '').trim() || '0'] as const),
    );

    return items.map((item) => {
      const components = this.parseShoulderStrapBomSnapshot(item.bomSnapshot) ?? [];
      const quantity = Number(item.actualQty ?? 0);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new BadRequestException(`产品 ${item.productId} 缺少有效的实际拣货数量`);
      }

      if (item.source === 'rakuten') {
        const row = rakutenMap.get(item.sourceRecordId.toString());
        if (!row) {
          throw new NotFoundException(`未找到乐天订单记录：${item.sourceRecordId.toString()}`);
        }
        const normalizedPhone = this.normalizeYamatoPhone(String(row.shippingPhone ?? '').trim());
        return {
          source: 'rakuten' as const,
          id: item.sourceRecordId.toString(),
          orderId: String(row.orderId ?? '').trim(),
          productId: item.productId,
          components,
          printerValue: printerValueByProductId.get(item.productId) ?? '0',
          quantity,
          deliveryDate: this.formatYamatoDeliveryDate(
            String(
              this.getJsonField(row.rawPayload, RAKUTEN_ORDER_HEADERS.deliveryDateRaw) ?? row.deliveryDateRaw ?? '',
            ),
          ),
          deliveryTimeSlot: String(
            this.getJsonField(row.rawPayload, RAKUTEN_ORDER_HEADERS.deliveryTimeSlot) ?? row.deliveryTimeSlot ?? '',
          ).trim(),
          phone: normalizedPhone || '-',
          postalCode: String(row.shippingPostalCode ?? '').trim() || '-',
          address1: this.buildRakutenFullShippingAddress(row.shippingPrefecture, row.shippingCity, row.shippingAddress),
          address2: '-',
          recipientName: String(row.shippingName ?? '').trim() || '-',
        };
      }

      if (item.source === 'amazon') {
        const row = amazonMap.get(item.sourceRecordId.toString());
        if (!row) {
          throw new NotFoundException(`未找到亚马逊订单记录：${item.sourceRecordId.toString()}`);
        }
        const normalizedPhone = this.normalizeYamatoPhone(String(row.buyerPhoneNumber ?? '').trim());
        return {
          source: 'amazon' as const,
          id: item.sourceRecordId.toString(),
          orderId: String(row.orderId ?? '').trim(),
          productId: item.productId,
          components,
          printerValue: printerValueByProductId.get(item.productId) ?? '0',
          quantity,
          deliveryDate: '-',
          deliveryTimeSlot: '-',
          phone: normalizedPhone || '-',
          postalCode: String(row.shipPostalCode ?? '').trim() || '-',
          address1: this.concatAddress([row.shipState, row.shipAddress1]),
          address2: this.concatAddress([row.shipAddress2, row.shipAddress3]),
          recipientName: String(row.recipientName ?? '').trim() || '-',
        };
      }

      const row = manualMap.get(item.sourceRecordId.toString());
      if (!row) {
        throw new NotFoundException(`未找到手动订单记录：${item.sourceRecordId.toString()}`);
      }
      const normalizedPhone = this.normalizeYamatoPhone(String(row.buyerPhoneNumber ?? '').trim());
      return {
        source: 'manual' as const,
        id: item.sourceRecordId.toString(),
        orderId: String(row.orderId ?? '').trim(),
        productId: item.productId,
        components,
        printerValue: printerValueByProductId.get(item.productId) ?? '0',
        quantity,
        deliveryDate: '-',
        deliveryTimeSlot: '-',
        phone: normalizedPhone || '-',
        postalCode: String(row.shipPostalCode ?? '').trim() || '-',
        address1: this.concatAddress([row.shipState, row.shipAddress1]),
        address2: this.concatAddress([row.shipAddress2, row.shipAddress3]),
        recipientName: String(row.recipientName ?? '').trim() || '-',
      };
    });
  }

  private async loadOverseasPickingBatchLocationMeta(
    productIdsRaw: string[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<
    Map<
      string,
      {
        shelfCode: string | null;
        boxCode: string | null;
        productName: string | null;
        stockQty: number;
        locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number;
        }>;
      }
    >
  > {
    const productIds = Array.from(
      new Set(productIdsRaw.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0)),
    );
    if (!productIds.length) {
      return new Map();
    }

    const [rows, productRows] = await Promise.all([
      db.masterProductBoxInventory.findMany({
        where: {
          productId: { in: productIds },
          qty: { gt: 0 },
        },
        include: {
          box: {
            include: {
              shelf: {
                select: {
                  shelfCode: true,
                },
              },
            },
          },
        },
      }),
      db.masterProduct.findMany({
        where: {
          productId: { in: productIds },
        },
        select: {
          productId: true,
          productName: true,
          stockQty: true,
        },
      }),
    ]);

    const rowsByProductId = new Map<
      string,
      Array<{ shelfCode: string | null; boxCode: string | null; qty: number }>
    >();
    rows.forEach((row) => {
      const productId = String(row.productId ?? '').trim();
      const list = rowsByProductId.get(productId) ?? [];
      list.push({
        shelfCode: String(row.box?.shelf?.shelfCode ?? '').trim() || null,
        boxCode: String(row.box?.boxCode ?? '').trim() || null,
        qty: Number(row.qty ?? 0),
      });
      rowsByProductId.set(productId, list);
    });

    const productMetaByProductId = new Map(
      productRows.map((row) => [
        String(row.productId ?? '').trim(),
        {
          productName: row.productName ?? null,
          stockQty: Number(row.stockQty ?? 0),
        },
      ]),
    );
    const metaByProductId = new Map<
      string,
      {
        shelfCode: string | null;
        boxCode: string | null;
        productName: string | null;
        stockQty: number;
        locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number;
        }>;
      }
    >();
    productIds.forEach((productId) => {
      const list = rowsByProductId.get(productId) ?? [];
      const sorted = [...list].sort((left, right) => {
        if (left.qty !== right.qty) {
          return left.qty - right.qty;
        }
        const leftKey = `${left.shelfCode ?? 'ZZZ'}|${left.boxCode ?? 'ZZZ'}`;
        const rightKey = `${right.shelfCode ?? 'ZZZ'}|${right.boxCode ?? 'ZZZ'}`;
        return leftKey.localeCompare(rightKey, 'zh-Hans-CN');
      });
      const primary = sorted[0] ?? null;
      const productMeta = productMetaByProductId.get(productId);
      metaByProductId.set(productId, {
        shelfCode: primary?.shelfCode ?? null,
        boxCode: primary?.boxCode ?? null,
        productName: productMeta?.productName ?? null,
        stockQty: Number(productMeta?.stockQty ?? 0),
        locations: sorted,
      });
    });

    return metaByProductId;
  }

  private mergeYamatoExportItems(items: YamatoExportItem[]): YamatoMergedExportRow[] {
    const mergedByOrderId = new Map<
      string,
      Omit<YamatoExportItem, 'source' | 'id' | 'productId' | 'quantity'> & {
        itemParts: string[];
        productIds: string[];
        printerValues: string[];
        lineCount: number;
      }
    >();

    items.forEach((item) => {
      const key = item.orderId || `${item.source}:${item.id}`;
      const componentNote = item.components?.length
        ? `(${item.components.map((component) => `${component.componentProductId}*${component.quantity * item.quantity}個`).join('、')})`
        : '';
      const itemPart = `${item.productId}*${item.quantity}個${componentNote}`;
      const existing = mergedByOrderId.get(key);
      if (!existing) {
        mergedByOrderId.set(key, {
          orderId: item.orderId || key,
          printerValue: item.printerValue || '0',
          deliveryDate: item.deliveryDate || '-',
          deliveryTimeSlot: item.deliveryTimeSlot || '-',
          phone: item.phone || '-',
          postalCode: item.postalCode || '-',
          address1: item.address1 || '-',
          address2: item.address2 || '-',
          recipientName: item.recipientName || '-',
          itemParts: [itemPart],
          productIds: [item.productId],
          printerValues: [item.printerValue || '0'],
          lineCount: 1,
        });
        return;
      }

      existing.itemParts.push(itemPart);
      existing.productIds.push(item.productId);
      existing.printerValues.push(item.printerValue || '0');
      existing.lineCount += 1;
    });

    return Array.from(mergedByOrderId.values()).map((row) => {
      const printerValue = this.resolveMergedYamatoPrinterValue(row.printerValues, row.lineCount);
      return {
        orderId: row.orderId,
        printerValue,
        printerName: this.resolveYamatoWindowsPrinterName(printerValue),
        deliveryDate: row.deliveryDate,
        deliveryTimeSlot: row.deliveryTimeSlot,
        phone: row.phone,
        postalCode: row.postalCode,
        address1: row.address1,
        address2: row.address2,
        recipientName: row.recipientName,
        itemSummary: `DGAZ ${row.itemParts.join(' / ')}`,
        isMergedDuplicate: row.lineCount > 1,
        productIds: Array.from(new Set(row.productIds.filter((item) => String(item || '').trim()))),
      };
    });
  }

  private resolveMergedYamatoPrinterValue(printerValuesRaw: string[], lineCount: number): string {
    const printerValues = printerValuesRaw.map((value) => String(value ?? '').trim() || '0');
    if (lineCount <= 1) {
      return printerValues[0] || '0';
    }
    return printerValues.length > 0 && printerValues.every((value) => value === 'A') ? 'A' : '0';
  }

  async uploadYamatoShipmentBatchPdf(
    batchIdRaw: string,
    files: YamatoShipmentPdfUploadFile[],
  ): Promise<YamatoShipmentBatchUploadResult> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const validFiles = files.filter((file) => file?.buffer?.length);
    if (!validFiles.length) {
      throw new BadRequestException('请选择 Yamato PDF 文件');
    }
    const batch = await this.prisma.yamatoShipmentBatch.findUnique({
      where: { id: batchId },
      include: {
        pages: {
          orderBy: [{ pageNo: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!batch) {
      throw new NotFoundException(`Yamato 批次不存在: ${batchIdRaw}`);
    }
    if (!batch.pages.length) {
      throw new BadRequestException('该 Yamato 批次没有可绑定的页面记录');
    }
    if (validFiles.length > 20 || validFiles.reduce((size, file) => size + file.buffer.length, 0) > 100 * 1024 * 1024) throw new BadRequestException('一次最多上传 20 个 PDF，总大小不能超过 100MB');
    validFiles.forEach((file, index) => {
      if (!this.isPdfFileBuffer(file.buffer)) {
        const fileLabel = file.originalName ? `「${file.originalName}」` : `第 ${index + 1} 个文件`;
        throw new BadRequestException(`${fileLabel} 不是有效的 PDF，请确认选择的是 Yamato 批量 PDF`);
      }
    });

    const uploadedPages = await this.extractUploadedYamatoPdfPages(validFiles);
    if (uploadedPages.length !== batch.pages.length) {
      throw new BadRequestException(
        `PDF 总页数与 Yamato 面单数不一致：上传 PDF 合计 ${uploadedPages.length} 页，当前批次应为 ${batch.pages.length} 张面单（相同订单号已按 1 张面单合并计算）`,
      );
    }

    const orderedUploadedPages = this.matchUploadedPdfPagesToBatchPages(uploadedPages, batch.pages);
    const parsedPages = orderedUploadedPages.map((page, index) => ({
      pageNo: index + 1,
      text: page.text,
    }));

    const trackingNumbers = parsedPages.map((page, index) =>
      this.extractTrackingNoFromPdfText(page?.text ?? '', [...this.getBatchPageProductIds(batch.pages[index]), batch.pages[index].orderId ?? '']));
    trackingNumbers.forEach((trackingNo, index) => {
      if (!trackingNo) {
        throw new BadRequestException(`PDF 第 ${parsedPages[index]?.pageNo ?? index + 1} 页未识别到快递单号`);
      }
    });

    if (new Set(trackingNumbers).size !== trackingNumbers.length) throw new BadRequestException('PDF 存在重复快递单号，请核对后重新上传');

    const mergedPdfBuffer = await this.mergeUploadedPdfPagesInBatchOrder(orderedUploadedPages);
    const sanitizedFileName = this.getYamatoUploadFileName(batch.id, validFiles);
    const pdfPath = this.buildYamatoBatchPdfPath(batch.id.toString(), `${randomUUID()}-${sanitizedFileName}`);
    await this.ensureYamatoBatchDir(batch.id.toString());
    await writeFile(pdfPath, mergedPdfBuffer);

    const manualOrderIdsForXyjg = new Set<bigint>();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM yamato_shipment_batch_pages WHERE batch_id = ${batch.id} ORDER BY id FOR UPDATE`);
        const printed = await tx.yamatoShipmentBatchPage.count({ where: { batchId: batch.id, printedAt: { not: null } } });
        const jobs = await tx.printJob.count({ where: { batchPage: { batchId: batch.id },
          status: { in: [PrintJobStatus.pending, PrintJobStatus.claimed, PrintJobStatus.completed] } } });
        if (printed || jobs) throw new BadRequestException('该批次已有打印记录或执行中任务，不能替换 PDF');
        await tx.yamatoShipmentBatch.update({
          where: { id: batch.id },
          data: {
            pdfFileName: sanitizedFileName,
            pdfFilePath: pdfPath,
            pdfUploadedAt: new Date(),
            status: YAMATO_BATCH_STATUS.PDF_READY,
            pageCount: parsedPages.length,
          },
        });

        for (let index = 0; index < batch.pages.length; index += 1) {
          const page = batch.pages[index];
          const parsedPage = parsedPages[index];
          const trackingNo = trackingNumbers[index];
          await tx.yamatoShipmentBatchPage.update({
            where: { id: page.id },
            data: {
              trackingNo,
              pageText: parsedPage?.text ?? null,
              printedAt: null,
              printedProductId: null,
            },
          });

          const updatedManualIds = await this.writeYamatoTrackingNoBackToOrders(
            tx,
            page.orderId,
            trackingNo,
            {
              pickingBatchId: batch.pickingBatchId,
              productIds: this.getBatchPageProductIds(page),
            });
          updatedManualIds.forEach((id) => manualOrderIdsForXyjg.add(id));

          if (batch.pickingBatchId && String(page.orderId ?? '').trim()) {
            await tx.overseasPickingBatchItem.updateMany({
              where: {
                batchId: batch.pickingBatchId,
                orderId: String(page.orderId ?? '').trim(),
                dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS,
                ...(this.getBatchPageProductIds(page).length
                  ? { productId: { in: this.getBatchPageProductIds(page) } }
                  : {}),
              },
              data: {
                shipmentTrackingNo: trackingNo,
              },
            });
          }
        }
      });
    } catch (error) {
      await rm(pdfPath, { force: true }).catch(() => {});
      throw error;
    }

    await this.syncManualOrderIdsToXyjgBestEffort(Array.from(manualOrderIdsForXyjg));
    return {
      id: batch.id.toString(),
      status: YAMATO_BATCH_STATUS.PDF_READY,
      pageCount: parsedPages.length,
      pdfFileName: sanitizedFileName,
      pdfUploadedAt: new Date().toISOString(),
    };
  }

  private async writeYamatoTrackingNoBackToOrders(
    tx: Prisma.TransactionClient,
    orderIdRaw: string | null | undefined,
    trackingNoRaw: string | null | undefined,
    options: { pickingBatchId?: bigint | null; productIds?: string[] } = {},
  ): Promise<bigint[]> {
    const orderId = String(orderIdRaw ?? '').trim();
    const trackingNo = String(trackingNoRaw ?? '').trim();
    if (!orderId || !trackingNo) {
      throw new BadRequestException('Yamato 面单缺少可回写的订单号或快递单号');
    }

    const registeredAt = new Date();
    const productIds = Array.from(
      new Set((options.productIds ?? []).map((productId) => String(productId ?? '').trim()).filter(Boolean)),
    );
    if (!options.pickingBatchId) {
      throw new BadRequestException('Yamato 运单号回写必须指定拣货批次');
    }

    const pickingItems = await tx.overseasPickingBatchItem.findMany({
      where: {
        batchId: options.pickingBatchId,
        orderId,
        dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS,
        actualQty: { gt: 0 },
        ...(productIds.length ? { productId: { in: productIds } } : {}),
      },
      select: {
        source: true,
        sourceRecordId: true,
      },
    });
    const rakutenIds = pickingItems
      .filter((item) => item.source === 'rakuten')
      .map((item) => item.sourceRecordId);
    const amazonIds = pickingItems
      .filter((item) => item.source === 'amazon')
      .map((item) => item.sourceRecordId);
    const manualIds = pickingItems
      .filter((item) => item.source === 'manual')
      .map((item) => item.sourceRecordId);
    const rakutenResult = rakutenIds.length
      ? await tx.rakutenOrderRecord.updateMany({
          where: { deletedAt: null, id: { in: rakutenIds }, orderId },
          data: {
            shipmentCompany: 'Yamato',
            shipmentNo: trackingNo,
            shipmentNoRegisteredAt: registeredAt,
            sendStatus: this.resolveSendStatus(trackingNo),
          },
        })
      : { count: 0 };
    const amazonResult = amazonIds.length
      ? await tx.amazonOrderRecord.updateMany({
          where: { id: { in: amazonIds }, orderId },
          data: {
            shipmentCompany: 'Yamato',
            shipmentNo: trackingNo,
            shipmentNoRegisteredAt: registeredAt,
          },
        })
      : { count: 0 };
    const manualResult = manualIds.length
      ? await (tx as any).manualOrderRecord.updateMany({
          where: { id: { in: manualIds }, orderId },
          data: {
            shipmentCompany: 'Yamato',
            shipmentNo: trackingNo,
            shipmentNoRegisteredAt: registeredAt,
          },
        })
      : { count: 0 };

    if (rakutenResult.count + amazonResult.count + Number(manualResult.count ?? 0) <= 0) {
      throw new NotFoundException(`未找到可回写快递单号的订单：${orderId}`);
    }
    return Number(manualResult.count ?? 0) > 0 ? manualIds : [];
  }

  private getYamatoUploadFileName(batchId: bigint, files: YamatoShipmentPdfUploadFile[]): string {
    if (files.length === 1) {
      const fileName = this.sanitizeYamatoFileName(files[0]?.originalName);
      if (!fileName) {
        return `yamato-batch-${batchId.toString()}.pdf`;
      }
      return /\.pdf$/i.test(fileName) ? fileName : `${fileName}.pdf`;
    }
    return `yamato-batch-${batchId.toString()}-${files.length}files.pdf`;
  }

  async printYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: YamatoShipmentPrintByProductPayload,
  ): Promise<YamatoShipmentPrintFileResult> {
    const prepared = await this.prepareYamatoShipmentLabelByProductId(batchIdRaw, payload);
    const queued = await this.reserveYamatoPrintJob(prepared, null, 'yamato_browser');

    return {
      queueJobId: queued.queueJobId,
      reused: queued.reused,
      batchId: prepared.batchId,
      fileName: prepared.fileName,
      content: prepared.content,
      pageNo: prepared.pageNo,
      trackingNo: prepared.trackingNo,
      productId: prepared.productId,
      remainingMatchCount: prepared.remainingMatchCount,
    };
  }

  async previewYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: YamatoShipmentPrintByProductPayload,
  ): Promise<YamatoShipmentPagePreviewResult> {
    const { batch, targetPage, productId, printablePages, isBodyScan } = await this.findPrintableYamatoShipmentPageByProductId(
      batchIdRaw,
      payload,
      { allowAmbiguous: true, allowPrinted: payload.reprintConfirmed === true, excludeActivePrintJobs: true },
    );
    const productIds = this.getBatchPageProductIds(targetPage);
    const assemblyParts = await this.buildYamatoShipmentPageAssemblyPartDetails(
      batch.pickingBatchId,
      targetPage,
    );
    return {
      batchId: batch.id.toString(),
      pageNo: targetPage.pageNo,
      orderId: targetPage.orderId ?? null,
      trackingNo: targetPage.trackingNo ?? null,
      productId,
      productIds,
      itemSummary: targetPage.itemSummary ?? null,
      recipientName: targetPage.recipientName ?? null,
      products: await this.buildYamatoShipmentPageProductDetails(targetPage, batch.pickingBatchId),
      assemblyParts,
      remainingMatchCount: Math.max(printablePages.length - 1, 0),
      requiresSelection: (isBodyScan || payload.reprintConfirmed === true) && payload.pageNo == null && printablePages.length > 1,
      candidates: printablePages.map((page) => ({
        pageNo: page.pageNo, orderId: page.orderId, productIds: this.getBatchPageProductIds(page), itemSummary: page.itemSummary,
      })),
    };
  }

  async directPrintYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: YamatoShipmentPrintByProductPayload,
  ): Promise<YamatoShipmentDirectPrintResult> {
    if (!this.isYamatoDirectPrintEnabled()) {
      throw new BadRequestException('Yamato 直打未启用，当前仍使用浏览器打印');
    }

    const prepared = await this.prepareYamatoShipmentLabelByProductId(batchIdRaw, payload);
    const printerName = await this.resolveYamatoPrinterNameForProductIds(prepared.productIds);
    const queued = await this.reserveYamatoPrintJob(prepared, printerName, 'yamato_direct');
    let printJob: { printerName: string | null; printJobId: string | null };
    try {
      printJob = queued.reused ? { printerName: queued.printerName, printJobId: null }
        : await this.sendPdfBufferToPrinter(prepared.content, prepared.fileName, printerName);
      if (!queued.reused) await this.prisma.printJob.updateMany({ where: { id: parseId(queued.queueJobId, 'jobId'), status: PrintJobStatus.claimed, confirmationSnapshot: { equals: prepared.confirmationSnapshot } }, data: { status: PrintJobStatus.pending, systemJobId: printJob.printJobId, printerName: printJob.printerName } });
    } catch (error) {
      await this.prisma.printJob.updateMany({ where: { id: parseId(queued.queueJobId, 'jobId'), status: PrintJobStatus.claimed, confirmationSnapshot: { equals: prepared.confirmationSnapshot } }, data: { status: PrintJobStatus.pending } });
      // Keep the reservation: a printer may have accepted the document before an error was returned.
      throw new BadRequestException(`直打任务 #${queued.queueJobId} 结果未确认，请重试进入出纸确认；系统不会重复提交原任务`);
    }

    return {
      batchId: prepared.batchId,
      fileName: prepared.fileName,
      pageNo: prepared.pageNo,
      trackingNo: prepared.trackingNo,
      productId: prepared.productId,
      remainingMatchCount: prepared.remainingMatchCount,
      printerName: printJob.printerName,
      printJobId: printJob.printJobId,
      queueJobId: queued.queueJobId, reused: queued.reused,
      mode: 'direct',
    };
  }

  async queueYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: YamatoShipmentPrintByProductPayload,
  ): Promise<YamatoShipmentQueuedPrintResult> {
    if (this.getYamatoPrintMode() !== 'agent') {
      throw new BadRequestException('Yamato 打印代理未启用');
    }

    if (!Number.isInteger(Number(payload.pageNo)) || Number(payload.pageNo) <= 0) throw new BadRequestException('请先预览并选择具体面单后再打印');
    if (payload.pageNo != null && !payload.reprintConfirmed) {
      const completed = await this.prisma.printJob.findFirst({ where: {
        jobType: 'yamato_label', status: PrintJobStatus.completed,
        AND: [{ confirmationSnapshot: { path: '$.requestId', equals: payload.printRequestId ?? '' } }, { confirmationSnapshot: { path: '$.operatorUsername', equals: payload.operatorUsername ?? '' } }, { confirmationSnapshot: { path: '$.stationId', equals: payload.stationId ?? '' } }],
        batchPage: { batchId: parseId(batchIdRaw, 'batchId'), pageNo: Number(payload.pageNo) },
      }, orderBy: [{ id: 'desc' }] });
      if (completed) return { batchId: batchIdRaw, productId: completed.productId, pageNo: Number(payload.pageNo),
        trackingNo: completed.trackingNo, printerName: completed.printerName, queueJobId: completed.id.toString(), reused: true, mode: 'agent' };
    }
    const prepared = await this.prepareYamatoShipmentLabelByProductId(batchIdRaw, payload);
    const printerName = await this.resolveYamatoPrinterNameForProductIds(prepared.productIds);
    return this.reserveYamatoPrintJob(prepared, printerName, 'yamato_label');
  }

  private async reserveYamatoPrintJob(prepared: PreparedYamatoShipmentPrintResult, printerName: string | null, jobType: string): Promise<YamatoShipmentQueuedPrintResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM yamato_shipment_batch_pages WHERE id = ${prepared.pageId} FOR UPDATE`);
      const page = await tx.yamatoShipmentBatchPage.findUnique({ where: { id: prepared.pageId } });
      if (!page || (page.printedAt && !prepared.isReprint)) throw new BadRequestException('该面单已打印，请刷新后重试');
      if (prepared.sourcePdfFilePath) {
        const batch = await tx.yamatoShipmentBatch.findUnique({ where: { id: parseId(prepared.batchId, 'batchId') }, select: { pdfFilePath: true } });
        if (batch?.pdfFilePath !== prepared.sourcePdfFilePath) throw new BadRequestException('面单 PDF 已变更，请重新预览并确认');
      }
      if (prepared.printRequestId) {
        const completed = await tx.printJob.findFirst({ where: {
          batchPageId: prepared.pageId, jobType, status: PrintJobStatus.completed,
          confirmationSnapshot: { path: '$.requestId', equals: prepared.printRequestId },
        }, orderBy: [{ id: 'desc' }] });
        if (completed) { this.assertYamatoPrintOwner(completed.confirmationSnapshot, prepared.confirmationSnapshot); return { batchId: prepared.batchId, productId: completed.productId, pageNo: prepared.pageNo,
          trackingNo: completed.trackingNo, printerName: completed.printerName, queueJobId: completed.id.toString(), reused: true, mode: 'agent' as const }; }
      }
      const active = await tx.printJob.findFirst({
        where: { batchPageId: prepared.pageId, status: { in: [PrintJobStatus.pending, PrintJobStatus.claimed] } },
        orderBy: [{ id: 'desc' }],
      });
      if (active) {
        this.assertYamatoPrintOwner(active.confirmationSnapshot, prepared.confirmationSnapshot, true);
        if (jobType === 'yamato_direct' && active.status === PrintJobStatus.claimed) throw new BadRequestException('该面单正在提交到打印机，请等待结果后再处理');
        const snapshot = active.confirmationSnapshot as { requestId?: string } | null;
        if (prepared.isReprint && snapshot?.requestId !== prepared.printRequestId) throw new BadRequestException('原面单仍有待打印或执行中任务，请先核对原任务结果');
        if (active.jobType !== jobType) throw new BadRequestException('该面单已有其他打印方式的任务，请先处理该任务');
        return { batchId: prepared.batchId, productId: active.productId, pageNo: prepared.pageNo,
          trackingNo: active.trackingNo, printerName: active.printerName, queueJobId: active.id.toString(), reused: true, mode: 'agent' as const };
      }
      return this.createYamatoShipmentPrintJob(prepared, printerName, tx, jobType);
    }, { timeout: 15000 });
  }

  private async createYamatoShipmentPrintJob(
    prepared: PreparedYamatoShipmentPrintResult,
    printerName: string | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    jobType = 'yamato_label',
  ): Promise<YamatoShipmentQueuedPrintResult> {
    const created = await db.printJob.create({
      data: {
        jobType,
        orderId: prepared.orderId,
        confirmationSnapshot: prepared.confirmationSnapshot,
        status: jobType === 'yamato_direct' ? PrintJobStatus.claimed : PrintJobStatus.pending,
        claimedAt: jobType === 'yamato_direct' ? new Date() : null,
        batchPageId: prepared.pageId,
        productId: prepared.productId,
        printerName,
        fileName: prepared.fileName,
        trackingNo: prepared.trackingNo,
      },
    });

    try {
      const filePath = this.buildPrintJobPdfPath(created.id.toString(), prepared.fileName);
      await this.ensurePrintJobDir(created.id.toString());
      await writeFile(filePath, prepared.content);
      await db.printJob.update({
        where: { id: created.id },
        data: {
          filePath,
        },
      });

      return {
        batchId: prepared.batchId,
        productId: prepared.productId,
        pageNo: prepared.pageNo,
        trackingNo: prepared.trackingNo,
        printerName,
        queueJobId: created.id.toString(),
        mode: 'agent',
      };
    } catch (error) {
      await db.printJob.update({
        where: { id: created.id },
        data: {
          status: PrintJobStatus.failed,
          failedAt: new Date(),
          errorMessage: error instanceof Error ? error.message.slice(0, 255) : '创建打印任务失败',
        },
      });
      throw error;
    }
  }

  async requeueYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: YamatoShipmentPrintByProductPayload,
  ): Promise<YamatoShipmentQueuedPrintResult & { clearedJobCount: number }> {
    if (this.getYamatoPrintMode() !== 'agent') {
      throw new BadRequestException('Yamato 打印代理未启用');
    }

    if (payload.reprintConfirmed !== true) throw new BadRequestException('请明确确认补打原快递单号的面单');
    const prepared = await this.prepareYamatoShipmentLabelByProductId(batchIdRaw, payload);
    const printerName = await this.resolveYamatoPrinterNameForProductIds(prepared.productIds);
    const queued = await this.reserveYamatoPrintJob(prepared, printerName, 'yamato_label');
    return { ...queued, clearedJobCount: 0 };
  }

  private assertYamatoPrintOwner(snapshot: unknown, expected: unknown, checkRequest = false): void {
    const owner = (snapshot ?? {}) as Record<string, unknown>;
    const caller = (expected ?? {}) as Record<string, unknown>;
    if ((owner.operatorUsername && owner.operatorUsername !== caller.operatorUsername)
      || (owner.stationId && owner.stationId !== caller.stationId)
      || (checkRequest && owner.requestId && owner.requestId !== caller.requestId)) {
      throw new BadRequestException('该面单已由其他操作员、工位或装包请求占用，请先处理原打印任务');
    }
  }

  async confirmYamatoLocalPrintJob(jobIdRaw: string, printed: boolean, operatorUsername = '', stationId = '', stopped = false): Promise<unknown> {
    const jobId = parseId(jobIdRaw, 'jobId');
    if (typeof printed !== 'boolean') throw new BadRequestException('请明确确认是否已出纸');
    return this.prisma.$transaction(async (tx) => {
      const initial = await tx.printJob.findUnique({ where: { id: jobId } });
      if (!initial || !['yamato_browser', 'yamato_direct', 'yamato_label'].includes(initial.jobType) || !initial.batchPageId) throw new NotFoundException('打印任务不存在');
      await tx.$queryRaw(Prisma.sql`SELECT id FROM yamato_shipment_batch_pages WHERE id = ${initial.batchPageId} FOR UPDATE`);
      const job = await tx.printJob.findUnique({ where: { id: jobId } });
      this.assertYamatoPrintOwner(job?.confirmationSnapshot, { operatorUsername, stationId });
      if (job?.status === PrintJobStatus.completed && printed) return job;
      if (job?.status === PrintJobStatus.failed && !printed) return job;
      if (printed && (job?.confirmationSnapshot as { cancelOnly?: boolean } | null)?.cancelOnly === true) throw new BadRequestException('原代理任务尚未提交，仅可确认取消且未出纸');
      const staleClaim = job?.status === PrintJobStatus.claimed && job.claimedAt
        && Date.now() - job.claimedAt.getTime() >= 5 * 60 * 1000;
      if (stopped && !staleClaim) throw new BadRequestException('任务仍可能执行，请等待五分钟并停止原打印程序、清空打印机队列后再恢复');
      const recovering = stopped && staleClaim;
      const agentSubmitted = job?.jobType === 'yamato_label' && job.status === PrintJobStatus.claimed
        && ((job.confirmationSnapshot as { submissionAccepted?: boolean; submissionUncertain?: boolean } | null)?.submissionAccepted === true
          || (job.confirmationSnapshot as { submissionUncertain?: boolean } | null)?.submissionUncertain === true);
      if (!job || !(recovering || agentSubmitted || (job.jobType !== 'yamato_label' && job.status === PrintJobStatus.pending) || (job.jobType === 'yamato_label' && job.status === PrintJobStatus.pending && !printed))) throw new BadRequestException('打印任务尚未提交完成或状态已变化，请刷新');
      const isReprint = (job.confirmationSnapshot as { isReprint?: boolean } | null)?.isReprint === true;
      if (printed) {
        const page = await tx.yamatoShipmentBatchPage.updateMany({ where: { id: initial.batchPageId, printedAt: null },
          data: { printedAt: new Date(), printedProductId: job.productId } });
        if (page.count !== 1 && !isReprint) throw new BadRequestException('该面单已经打印');
      }
      const changed = await tx.printJob.updateMany({ where: { id: jobId, status: job.status, claimToken: job.claimToken }, data: {
        claimToken: null,
        status: printed ? PrintJobStatus.completed : PrintJobStatus.failed,
        completedAt: printed ? new Date() : null, failedAt: printed ? null : new Date(),
        errorMessage: printed ? null : '操作员确认未出纸',
        confirmationSnapshot: { ...(job.confirmationSnapshot && typeof job.confirmationSnapshot === 'object' && !Array.isArray(job.confirmationSnapshot) ? job.confirmationSnapshot : {}),
          recoveryStopped: recovering ? true : false, paperConfirmedBy: operatorUsername, paperConfirmedAt: new Date().toISOString(), paperPrinted: printed },
      } });
      if (changed.count !== 1) throw new BadRequestException('任务正在被打印程序处理，请刷新并核对出纸结果');
      return tx.printJob.findUnique({ where: { id: jobId } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async takeOverYamatoPrintJob(jobIdRaw: string, operatorUsername: string, stationId: string, stopped: boolean): Promise<unknown> {
    if (!stopped || !/^[a-zA-Z0-9-]{16,64}$/.test(stationId)) throw new BadRequestException('接管前必须停止原打印程序、取消原队列并指定当前工位');
    const jobId = parseId(jobIdRaw, 'jobId');
    return this.prisma.$transaction(async (tx) => {
      const initial = await tx.printJob.findUnique({ where: { id: jobId } });
      if (!initial?.batchPageId || !['yamato_browser', 'yamato_direct', 'yamato_label'].includes(initial.jobType)) throw new NotFoundException('打印任务不存在');
      await tx.$queryRaw(Prisma.sql`SELECT id FROM yamato_shipment_batch_pages WHERE id = ${initial.batchPageId} FOR UPDATE`);
      const job = await tx.printJob.findUnique({ where: { id: jobId } });
      if (!job || ![PrintJobStatus.pending, PrintJobStatus.claimed].includes(job.status as 'pending' | 'claimed')) throw new BadRequestException('任务已结束，请刷新');
      if (job.status === PrintJobStatus.claimed && (!job.claimedAt || Date.now() - job.claimedAt.getTime() < 5 * 60000)) throw new BadRequestException('原任务仍可能执行，领取后五分钟内不能接管');
      const snapshot = (job.confirmationSnapshot ?? {}) as Record<string, Prisma.InputJsonValue>;
      const transfers = Array.isArray(snapshot.ownershipTransfers) ? snapshot.ownershipTransfers : [];
      const changed = await tx.printJob.updateMany({ where: { id: jobId, status: job.status, claimToken: job.claimToken }, data: {
        status: PrintJobStatus.claimed, claimToken: null, claimedAt: new Date(),
        confirmationSnapshot: { ...snapshot, operatorUsername, stationId, submissionUncertain: true,
          cancelOnly: snapshot.cancelOnly === true || (job.jobType === 'yamato_label' && job.status === PrintJobStatus.pending),
          ownershipTransfers: [...transfers, { previousOperator: snapshot.operatorUsername ?? '', previousStation: snapshot.stationId ?? '', operatorUsername, stationId, stopped: true, at: new Date().toISOString() }] },
      } });
      if (changed.count !== 1) throw new BadRequestException('原打印程序正在处理任务，请重新检查');
      return { id: jobId.toString(), status: 'awaiting_paper_confirmation' };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async listYamatoShipmentPrintJobs(batchIdRaw: string): Promise<unknown> {
    return this.prisma.printJob.findMany({
      where: { batchPage: { batchId: parseId(batchIdRaw, 'batchId') }, status: { in: [PrintJobStatus.pending, PrintJobStatus.claimed] } },
      orderBy: { id: 'desc' }, take: 200,
      select: { id: true, jobType: true, status: true, trackingNo: true, printerName: true, productId: true,
        claimedAt: true, confirmationSnapshot: true, batchPage: { select: { pageNo: true, orderId: true } } },
    });
  }

  async getYamatoShipmentPrintJobStatus(jobIdRaw: string): Promise<unknown> {
    const jobId = parseId(jobIdRaw, 'jobId');
    const job = await this.prisma.printJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        jobType: true,
        status: true,
        productId: true,
        printerName: true,
        fileName: true,
        trackingNo: true,
        agentName: true,
        systemJobId: true,
        errorMessage: true,
        queuedAt: true,
        claimedAt: true,
        completedAt: true,
        failedAt: true,
        confirmationSnapshot: true,
      },
    });
    if (!job || !['yamato_label', 'yamato_browser', 'yamato_direct'].includes(job.jobType)) {
      throw new NotFoundException(`Yamato 打印任务不存在: ${jobIdRaw}`);
    }
    return job;
  }

  private async prepareYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: YamatoShipmentPrintByProductPayload,
    options: { excludeActivePrintJobs?: boolean; allowAmbiguous?: boolean; allowPrinted?: boolean } = {},
  ): Promise<PreparedYamatoShipmentPrintResult> {
    if (!Number.isInteger(Number(payload.pageNo)) || Number(payload.pageNo) <= 0) throw new BadRequestException('请先预览并选择具体面单后再打印');
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(payload.printRequestId ?? '') || !/^[a-zA-Z0-9-]{16,64}$/.test(payload.stationId ?? '')) throw new BadRequestException('打印缺少工位或请求编号，请刷新页面后重试');
    const { batch, targetPage, productId, printablePages } = await this.findPrintableYamatoShipmentPageByProductId(
      batchIdRaw,
      payload,
      { ...options, allowPrinted: payload.reprintConfirmed === true },
    );
    const assemblyParts = await this.buildYamatoShipmentPageAssemblyPartDetails(
      batch.pickingBatchId,
      targetPage,
    );
    this.assertYamatoAssemblyPartsConfirmed(payload, assemblyParts);
    const products = await this.buildYamatoShipmentPageProductDetails(targetPage, batch.pickingBatchId);
    this.assertYamatoScannedProducts(payload, products);

    const pdfFilePath = batch.pdfFilePath;
    if (!pdfFilePath) {
      throw new BadRequestException('当前批次尚未上传可打印的 Yamato PDF');
    }
    try {
      await stat(pdfFilePath);
    } catch {
      throw new BadRequestException('当前批次的 Yamato PDF 文件不存在，请重新上传');
    }

    const targetPageProductIds = this.getBatchPageProductIds(targetPage);
    const pdfBuffer = await readFile(pdfFilePath);
    const singlePagePdf = await this.extractPdfSinglePage(pdfBuffer, targetPage.pageNo);

    return {
      sourcePdfFilePath: pdfFilePath,
      isReprint: payload.reprintConfirmed === true,
      printRequestId: payload.printRequestId,
      orderId: targetPage.orderId,
      confirmationSnapshot: {
        operatorUsername: payload.operatorUsername ?? '', stationId: payload.stationId ?? '', isReprint: payload.reprintConfirmed === true, requestId: payload.printRequestId ?? '',
        scanRecords: payload.scanRecords ?? [],
        confirmedAssemblyParts: payload.confirmedAssemblyParts ?? [], confirmedAt: new Date().toISOString(),
      },
      batchId: batch.id.toString(),
      fileName: `Yamato-${productId}-p${targetPage.pageNo}.pdf`,
      content: singlePagePdf,
      pageId: targetPage.id,
      pageNo: targetPage.pageNo,
      trackingNo: targetPage.trackingNo ?? null,
      productId,
      productIds: targetPageProductIds,
      printerName: String(targetPage.printerName ?? '').trim() || null,
      remainingMatchCount: Math.max(printablePages.length - 1, 0),
    };
  }

  private async findPrintableYamatoShipmentPageByProductId(
    batchIdRaw: string,
    payload: YamatoShipmentPrintByProductPayload,
    options: { excludeActivePrintJobs?: boolean; allowAmbiguous?: boolean; allowPrinted?: boolean } = {},
  ): Promise<{
    batch: YamatoShipmentBatch & { pages: YamatoShipmentBatchPage[] };
    targetPage: YamatoShipmentBatchPage;
    productId: string;
    printablePages: YamatoShipmentBatchPage[];
    isBodyScan: boolean;
  }> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const productId = String(payload?.productId ?? '').trim();
    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
    }
    const pageNoRaw = payload?.pageNo;
    const pageNo =
      pageNoRaw === undefined || pageNoRaw === null || String(pageNoRaw).trim() === ''
        ? null
        : Number(pageNoRaw);
    if (pageNo !== null && (!Number.isInteger(pageNo) || pageNo <= 0)) {
      throw new BadRequestException('Yamato 面单页码不正确');
    }

    const batch = await this.prisma.yamatoShipmentBatch.findUnique({
      where: { id: batchId },
      include: {
        pages: {
          orderBy: [{ pageNo: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!batch) {
      throw new NotFoundException(`Yamato 批次不存在: ${batchIdRaw}`);
    }
    if (batch.status !== YAMATO_BATCH_STATUS.PDF_READY || !batch.pdfFilePath) {
      throw new BadRequestException('当前批次尚未上传可打印的 Yamato PDF');
    }

    const matchedPageProductIds = new Set([productId]);
    const bodyMatchedPages = new Set<number>();
    let isBodyScan = false;
    if (batch.pickingBatchId) {
      const scannedProduct = await this.prisma.masterProduct.findUnique({
        where: { productId },
        select: { productType: true },
      });
      if (String(scannedProduct?.productType ?? '').trim() === '肩带本体') {
        isBodyScan = true;
        const pickingItems = await this.prisma.overseasPickingBatchItem.findMany({
          where: {
            batchId: batch.pickingBatchId,
            OR: [{ dispatchMode: '' }, { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }],
          },
          select: {
            productId: true,
            requestedQty: true,
            actualQty: true,
            orderId: true,
            pickingPlanSnapshot: true,
            bomSnapshot: true,
          },
        });
        pickingItems.forEach((item) => {
          const hasShipmentQty = Number(item.actualQty ?? item.requestedQty ?? 0) > 0;
          const usesScannedBody = (this.parseShoulderStrapBomSnapshot(item.bomSnapshot) ?? [])
            .some((component) => component.componentProductId.toUpperCase() === productId.toUpperCase());
          if (hasShipmentQty && usesScannedBody) {
            batch.pages.filter((page) => page.orderId === item.orderId && this.getBatchPageProductIds(page).includes(item.productId))
              .forEach((page) => bodyMatchedPages.add(page.pageNo));
          }
        });
      }
    }

    let printablePages = batch.pages.filter(
      (page) =>
        (!page.printedAt || options.allowPrinted) &&
        (pageNo === null || page.pageNo === pageNo) &&
        (isBodyScan ? (bodyMatchedPages.has(page.pageNo) || this.getBatchPageProductIds(page).some((id) => id.toUpperCase() === productId.toUpperCase())) : this.getBatchPageProductIds(page).some(
          (candidate) => Array.from(matchedPageProductIds).some(
            (matchedProductId) => candidate.localeCompare(matchedProductId, undefined, {
              sensitivity: 'accent',
            }) === 0,
          ),
        )),
    );
    if (options.excludeActivePrintJobs && printablePages.length) {
      const activeJobs = await this.prisma.printJob.findMany({
        where: {
          batchPageId: {
            in: printablePages.map((page) => page.id),
          },
          status: {
            in: [PrintJobStatus.pending, PrintJobStatus.claimed],
          },
        },
        select: {
          batchPageId: true,
          confirmationSnapshot: true,
        },
      });
      const activePageIds = new Set(activeJobs.filter((job) => { const owner = job.confirmationSnapshot as { operatorUsername?: string; stationId?: string } | null; return !owner || owner.operatorUsername !== payload.operatorUsername || owner.stationId !== payload.stationId; }).map((job) => job.batchPageId?.toString()).filter(Boolean));
      printablePages = printablePages.filter((page) => !activePageIds.has(page.id.toString()));
    }
    if (!printablePages.length) {
      throw new BadRequestException(`当前批次中产品ID ${productId} 对应面单已全部打印或正在打印中`);
    }

    if (isBodyScan && pageNo === null && !options.allowAmbiguous && printablePages.length > 1) {
      throw new BadRequestException('该肩带本体对应多个待打印订单，请先选择成品及配件组合');
    }
    return {
      batch,
      targetPage: printablePages[0],
      productId,
      printablePages,
      isBodyScan,
    };
  }

  private async loadPdfJsModule(): Promise<{
    getDocument: (source: { data: Uint8Array; disableWorker?: boolean }) => { promise: Promise<unknown>;
    };
  }> {
    if (!pdfJsModulePromise) {
      pdfJsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<{
        getDocument: (source: { data: Uint8Array; disableWorker?: boolean }) => { promise: Promise<unknown> };
      }>;
    }
    return pdfJsModulePromise;
  }

  private async extractPdfPagesText(fileBuffer: Buffer): Promise<ParsedPdfPageText[]> {
    const pdfJs = await this.loadPdfJsModule();
    const loadingTask = pdfJs.getDocument({
      data: new Uint8Array(fileBuffer),
      disableWorker: true,
    });
    const document = (await loadingTask.promise) as {
      numPages: number;
      getPage: (pageNo: number) => Promise<{
        getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }>;
        }>;
      }>;
    };

    if (document.numPages > 2000) throw new BadRequestException('单个 PDF 不能超过 2000 页，请拆分批次');
    const pages: ParsedPdfPageText[] = [];
    for (let pageNo = 1; pageNo <= document.numPages; pageNo += 1) {
      const page = await document.getPage(pageNo);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => `${String(item?.str ?? '')}${item?.hasEOL ? '\n' : ''}`)
        .join('')
        .trim();
      pages.push({
        pageNo,
        text,
      });
    }
    return pages;
  }

  private async extractUploadedYamatoPdfPages(files: YamatoShipmentPdfUploadFile[]): Promise<UploadedYamatoPdfPage[]> {
    const result: UploadedYamatoPdfPage[] = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      const pages = await this.extractPdfPagesText(file.buffer);
      if (result.length + pages.length > 2000) throw new BadRequestException('PDF 总页数不能超过 2000 页，请拆分批次');
      pages.forEach((page) => {
        result.push({
          fileIndex,
          fileBuffer: file.buffer,
          fileName: file.originalName ? String(file.originalName) : null,
          sourcePageNo: page.pageNo,
          text: page.text,
        });
      });
    }
    return result;
  }

  private matchUploadedPdfPagesToBatchPages(
    uploadedPages: UploadedYamatoPdfPage[],
    batchPages: Array<Pick<YamatoShipmentBatchPage, 'pageNo' | 'productIds' | 'orderId' | 'recipientName'>>,
  ): UploadedYamatoPdfPage[] {
    const matches = batchPages.map((page) => {
      const orderMatches = page.orderId ? uploadedPages.filter((uploaded) => this.pdfTextContainsProductId(uploaded.text, page.orderId!)) : [];
      const productIds = this.getBatchPageProductIds(page);
      const recipientName = this.normalizePdfComparableText(page.recipientName ?? '');
      const candidates = (orderMatches.length ? orderMatches : uploadedPages).filter((uploaded) =>
        productIds.length > 0 && productIds.every((id) => this.pdfTextContainsProductId(uploaded.text, id)) &&
        (recipientName ? this.normalizePdfComparableText(uploaded.text).includes(recipientName) : orderMatches.length > 0));
      if (candidates.length !== 1) throw new BadRequestException(`PDF 面单匹配${candidates.length ? '不唯一' : '失败'}：${this.describeYamatoBatchPageExpectation(page)}，请核对 PDF 中的商品和收件人；同商品、同姓名有多张面单时，请使用包含完整订单号的模板`);
      return candidates[0];
    });
    if (new Set(matches).size !== matches.length) throw new BadRequestException('同一 PDF 页匹配到多个订单，请核对面单后重新上传');
    return matches;
  }

  private async extractPdfSinglePage(fileBuffer: Buffer, pageNo: number): Promise<Buffer> {
    const source = await PDFDocument.load(fileBuffer);
    const pageIndex = pageNo - 1;
    if (pageIndex < 0 || pageIndex >= source.getPageCount()) {
      throw new BadRequestException(`PDF 中不存在第 ${pageNo} 页`);
    }
    const target = await PDFDocument.create();
    const [page] = await target.copyPages(source, [pageIndex]);
    target.addPage(page);
    const bytes = await target.save();
    return Buffer.from(bytes);
  }

  private async mergeUploadedPdfPagesInBatchOrder(pages: UploadedYamatoPdfPage[]): Promise<Buffer> {
    const target = await PDFDocument.create();
    const sourcesByFileIndex = new Map<number, PDFDocument>();
    for (const page of pages) {
      let source = sourcesByFileIndex.get(page.fileIndex);
      if (!source) {
        source = await PDFDocument.load(page.fileBuffer);
        sourcesByFileIndex.set(page.fileIndex, source);
      }
      const pageIndex = page.sourcePageNo - 1;
      if (pageIndex < 0 || pageIndex >= source.getPageCount()) {
        const fileLabel = page.fileName ? `「${page.fileName}」` : `第 ${page.fileIndex + 1} 个 PDF`;
        throw new BadRequestException(`${fileLabel} 中不存在第 ${page.sourcePageNo} 页`);
      }
      const [copiedPage] = await target.copyPages(source, [pageIndex]);
      target.addPage(copiedPage);
    }
    const bytes = await target.save();
    return Buffer.from(bytes);
  }

  private buildYamatoBatchDir(batchId: string): string {
    return resolve(process.cwd(), 'data', 'yamato-shipment-batches', batchId);
  }

  private buildYamatoBatchPdfPath(batchId: string, fileName: string): string {
    return join(this.buildYamatoBatchDir(batchId), fileName);
  }

  private async ensureYamatoBatchDir(batchId: string): Promise<void> {
    await mkdir(this.buildYamatoBatchDir(batchId), { recursive: true });
  }

  private sanitizeYamatoFileName(value: string | null | undefined): string {
    return String(value ?? '')
      .trim()
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .slice(0, 200);
  }

  private getYamatoPrintMode(): 'browser' | 'direct' | 'agent' {
    const configuredMode = String(process.env.YAMATO_PRINT_MODE ?? '')
      .trim()
      .toLowerCase();
    if (configuredMode === 'agent') {
      return 'agent';
    }
    if (configuredMode === 'direct') {
      return 'direct';
    }
    if (configuredMode === 'browser') {
      return 'browser';
    }
    return this.isYamatoDirectPrintEnabled() ? 'direct' : 'browser';
  }

  private isYamatoDirectPrintEnabled(): boolean {
    return (
      this.isTruthyEnvFlag(process.env.YAMATO_DIRECT_PRINT_ENABLED) ||
      Boolean(this.getConfiguredYamatoPrinterName())
    );
  }

  private getConfiguredYamatoPrinterName(): string {
    return String(process.env.YAMATO_PRINTER_NAME ?? '').trim();
  }

  private async resolveYamatoPrinterNameForProductId(productId: string): Promise<string | null> {
    const product = await this.prisma.masterProduct.findUnique({
      where: { productId },
      select: {
        yamatoPrinterName: true,
      },
    });
    return this.resolveYamatoWindowsPrinterName(product?.yamatoPrinterName);
  }

  private async resolveYamatoPrinterNameForProductIds(productIdsRaw: string[]): Promise<string | null> {
    const productIds = Array.from(
      new Set(productIdsRaw.map((productId) => String(productId ?? '').trim()).filter((productId) => productId)),
    );
    if (productIds.length <= 1) {
      return productIds.length ? this.resolveYamatoPrinterNameForProductId(productIds[0]) : YAMATO_DEFAULT_WINDOWS_PRINTER_NAME;
    }

    const products = await this.prisma.masterProduct.findMany({
      where: { productId: { in: productIds } },
      select: {
        productId: true,
        yamatoPrinterName: true,
      },
    });
    const printerValueByProductId = new Map(
      products.map((product) => [product.productId, String(product.yamatoPrinterName ?? '').trim() || '0'] as const),
    );
    const mergedPrinterValue = this.resolveMergedYamatoPrinterValue(
      productIds.map((productId) => printerValueByProductId.get(productId) ?? '0'),
      productIds.length,
    );
    return this.resolveYamatoWindowsPrinterName(mergedPrinterValue);
  }

  private resolveYamatoWindowsPrinterName(rawPrinterValue: string | null | undefined): string {
    const printerValue = String(rawPrinterValue ?? '').trim();
    if (!printerValue) {
      return YAMATO_DEFAULT_WINDOWS_PRINTER_NAME;
    }
    return (
      YAMATO_PRODUCT_PRINTER_ALIASES[printerValue] ??
      YAMATO_PRODUCT_PRINTER_ALIASES[printerValue.toUpperCase()] ??
      YAMATO_PRODUCT_PRINTER_ALIASES[printerValue.toLowerCase()] ??
      printerValue
    );
  }

  private isTruthyEnvFlag(value: string | null | undefined): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }

  private buildPrintJobDir(jobId: string): string {
    return resolve(process.cwd(), 'data', 'print-jobs', jobId);
  }

  private buildPrintJobPdfPath(jobId: string, fileName: string): string {
    return join(this.buildPrintJobDir(jobId), this.sanitizeYamatoFileName(fileName) || 'yamato-label.pdf');
  }

  private async ensurePrintJobDir(jobId: string): Promise<void> {
    await mkdir(this.buildPrintJobDir(jobId), { recursive: true });
  }

  private async sendPdfBufferToPrinter(
    pdfBuffer: Buffer,
    fileName: string,
    routedPrinterName?: string | null,
  ): Promise<{ printerName: string | null; printJobId: string | null }> {
    const printerName = routedPrinterName || this.getConfiguredYamatoPrinterName() || null;
    const tempDir = join(resolve(process.cwd(), 'data', 'yamato-print-jobs'), randomUUID());
    const tempFilePath = join(tempDir, this.sanitizeYamatoFileName(fileName) || 'yamato-label.pdf');
    await mkdir(tempDir, { recursive: true });
    await writeFile(tempFilePath, pdfBuffer);

    const args = ['-t', fileName];
    if (printerName) {
      args.push('-d', printerName);
    }
    args.push(tempFilePath);

    try {
      const { stdout, stderr } = await execFileAsync('lp', args, { timeout: 60000 });
      const output = String(stdout || stderr || '').trim();
      const printJobIdMatch = output.match(/\b([^\s()]+-\d+)\b/);
      return {
        printerName,
        printJobId: printJobIdMatch?.[1] || output || null,
      };
    } catch (error) {
      const stderr = String((error as { stderr?: string })?.stderr || '').trim();
      const stdout = String((error as { stdout?: string })?.stdout || '').trim();
      const message = stderr || stdout || (error instanceof Error ? error.message : '打印失败');
      if (/not found|ENOENT/i.test(message)) {
        throw new BadRequestException('当前服务器未安装 lp 打印命令，无法执行 Yamato 直打');
      }
      if (/default destination|No default destination|デフォルト|送信先/i.test(message)) {
        throw new BadRequestException('当前系统没有默认打印机，请先设置默认打印机或配置 YAMATO_PRINTER_NAME');
      }
      throw new BadRequestException(`Yamato 直打失败：${message}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private getBatchPageProductIds(page: Pick<YamatoShipmentBatchPage, 'productIds'>): string[] {
    const value = page.productIds;
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => String(item ?? '').trim())
      .filter((item) => item.length > 0);
  }

  private async buildYamatoShipmentPageProductDetails(
    page: Pick<YamatoShipmentBatchPage, 'productIds' | 'itemSummary'> & { orderId?: string | null },
    pickingBatchId?: bigint | null,
  ): Promise<YamatoShipmentPageProductDetail[]> {
    const parsedItems = this.parseYamatoItemSummaryProductQuantities(page.itemSummary, this.getBatchPageProductIds(page),
    );
    const productIds = Array.from(new Set(parsedItems.map((item) => item.productId).filter(Boolean)));
    const productRows = productIds.length
      ? await this.prisma.masterProduct.findMany({
          where: { productId: { in: productIds } },
          select: {
            productId: true,
            productName: true,
          },
        })
      : [];
    const productNameById = new Map(productRows.map((row) => [row.productId, row.productName] as const));
    const pickingItems = pickingBatchId && page.orderId ? await this.prisma.overseasPickingBatchItem.findMany({
      where: { batchId: pickingBatchId, orderId: page.orderId, productId: { in: productIds },
        OR: [{ dispatchMode: '' }, { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }] },
      select: { productId: true, actualQty: true, requestedQty: true, pickingPlanSnapshot: true, bomSnapshot: true },
    }) : [];
    const componentIds = Array.from(new Set(pickingItems.flatMap((item) =>
      (this.parseShoulderStrapBomSnapshot(item.bomSnapshot) ?? []).map((component) => component.componentProductId))));
    const componentProducts = componentIds.length ? await this.prisma.masterProduct.findMany({
      where: { productId: { in: componentIds } }, select: { productId: true, productType: true },
    }) : [];
    const bodyIds = new Set(componentProducts.filter((component) => component.productType === '肩带本体').map((component) => component.productId));
    const bodiesByProductId = new Map<string, Set<string>>();
    pickingItems.forEach((item) => {
      const ids = bodiesByProductId.get(item.productId) ?? new Set<string>();
      (this.parseShoulderStrapBomSnapshot(item.bomSnapshot) ?? []).forEach((component) => {
        if (bodyIds.has(component.componentProductId)) ids.add(component.componentProductId);
      });
      bodiesByProductId.set(item.productId, ids);
    });
    const assemblyByProductId = new Map<string, number>();
    pickingItems.forEach((item) => {
      if (!(this.parseShoulderStrapBomSnapshot(item.bomSnapshot) ?? []).length) return;
      const finished = this.parseOverseasPickingPlanSnapshot(item.pickingPlanSnapshot).reduce((sum, plan) => sum + Number(plan.pickQty ?? 0), 0);
      const assembly = Math.max(0, Number(item.actualQty ?? item.requestedQty ?? 0) - finished);
      assemblyByProductId.set(item.productId, (assemblyByProductId.get(item.productId) ?? 0) + assembly);
    });
    return parsedItems.map((item) => ({
      finishedQuantity: Math.max(0, item.quantity - (assemblyByProductId.get(item.productId) ?? 0)),
      assemblyQuantity: assemblyByProductId.get(item.productId) ?? 0,
      bodyProductIds: Array.from(bodiesByProductId.get(item.productId) ?? []),
      productId: item.productId,
      productName: productNameById.get(item.productId) ?? null,
      quantity: item.quantity,
    }));
  }

  private async buildYamatoShipmentPageAssemblyPartDetails(
    pickingBatchId: bigint | null,
    page: Pick<YamatoShipmentBatchPage, 'orderId' | 'productIds'>,
  ): Promise<YamatoShipmentPageAssemblyPartDetail[]> {
    const orderId = String(page.orderId ?? '').trim();
    const productIds = this.getBatchPageProductIds(page);
    if (!pickingBatchId || !orderId || !productIds.length) return [];

    const items = await this.prisma.overseasPickingBatchItem.findMany({
      where: {
        batchId: pickingBatchId,
        orderId,
        productId: { in: productIds },
        OR: [{ dispatchMode: '' }, { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }],
      },
      select: {
        productId: true,
        requestedQty: true,
        actualQty: true,
        pickingPlanSnapshot: true,
        bomSnapshot: true,
        pickingRequirementSnapshot: true,
      },
    });
    const requiredByComponentProductId = new Map<
      string,
      {
        componentProductId: string;
        componentProductName: string;
        componentProductType: string;
        requiredQty: number;
        pickingConfirmedQty: number | null;
        parentProductIds: Set<string>;
      }
    >();
    items.forEach((item) => {
      const requestedQty = Math.max(0, Number(item.actualQty ?? item.requestedQty ?? 0));
      const finishedQty = this.parseOverseasPickingPlanSnapshot(item.pickingPlanSnapshot)
        .reduce((sum, plan) => sum + Number(plan.pickQty ?? 0), 0);
      const assemblyQty = Math.max(requestedQty - finishedQty, 0);
      if (assemblyQty <= 0) return;
      const bomItems = this.parseShoulderStrapBomSnapshot(item.bomSnapshot) ?? [];
      bomItems.forEach((component) => {
        const requiredQty = Number(component.quantity) * assemblyQty;
        const pickingRequirement = this.parseOverseasPickingRequirementSnapshot(item.pickingRequirementSnapshot)
          .find((requirement) => requirement.productId === component.componentProductId);
        const pickingConfirmedQty = pickingRequirement?.pickedQty ?? null;
        const existing = requiredByComponentProductId.get(component.componentProductId);
        if (existing) {
          existing.requiredQty += requiredQty;
          existing.pickingConfirmedQty = existing.pickingConfirmedQty === null || pickingConfirmedQty === null
            ? null : existing.pickingConfirmedQty + pickingConfirmedQty;
          existing.parentProductIds.add(item.productId);
        } else {
          requiredByComponentProductId.set(component.componentProductId, {
            componentProductId: component.componentProductId,
            componentProductName: component.componentProductName,
            componentProductType: '',
            requiredQty,
            pickingConfirmedQty,
            parentProductIds: new Set([item.productId]),
          });
        }
      });
    });
    const componentProductIds = Array.from(requiredByComponentProductId.keys());
    const liveComponents = componentProductIds.length
      ? await this.prisma.masterProduct.findMany({
          where: { productId: { in: componentProductIds } },
          select: {
            productId: true,
            productName: true,
            productType: true,
            stockQty: true,
            boxInventories: { select: { qty: true } },
          },
        })
      : [];
    const liveComponentById = new Map(
      liveComponents.map((component) => [component.productId, component] as const),
    );
    return Array.from(requiredByComponentProductId.values()).map((component) => {
      const liveComponent = liveComponentById.get(component.componentProductId);
      return {
        componentProductId: component.componentProductId,
        componentProductName: liveComponent?.productName ?? component.componentProductName,
        componentProductType: String(liveComponent?.productType ?? component.componentProductType),
        requiredQty: component.requiredQty,
        pickingConfirmedQty: component.pickingConfirmedQty,
        stockQty: (liveComponent?.boxInventories ?? [{ qty: liveComponent?.stockQty ?? 0 }])
          .reduce((sum, row) => sum + Number(row.qty ?? 0), 0) ?? 0,
        parentProductIds: Array.from(component.parentProductIds),
      };
    });
  }

  private assertYamatoAssemblyPartsConfirmed(
    payload: YamatoShipmentPrintByProductPayload,
    assemblyParts: YamatoShipmentPageAssemblyPartDetail[],
  ): void {
    if (!assemblyParts.length) return;
    if (assemblyParts.some((part) => part.pickingConfirmedQty != null && part.pickingConfirmedQty < part.requiredQty)) {
      throw new BadRequestException('该面单的组装材料拣货数量未完成，请先核对拣货记录');
    }
    const confirmed = this.parseYamatoConfirmationQuantities(payload.confirmedAssemblyParts);
    const missingComponents = assemblyParts.filter((part) =>
      part.componentProductType !== '肩带本体' && confirmed.get(part.componentProductId) !== part.requiredQty,
    );
    if (missingComponents.length) {
      throw new BadRequestException(`请清点确认全部配件数量：${missingComponents.map((part) => part.componentProductId).join('、')}`);
    }
  }

  private parseYamatoConfirmationQuantities(value: unknown): Map<string, number> {
    if (value == null) return new Map();
    if (!Array.isArray(value)) throw new BadRequestException('扫码和确认数量格式不正确');
    const quantities = new Map<string, number>();
    for (const item of value) {
      const id = String(item?.productId ?? '').trim();
      if (!id || !Number.isInteger(item?.quantity) || item.quantity < 0 || quantities.has(id)) {
        throw new BadRequestException('扫码和确认数量须为非负整数，产品ID不能重复');
      }
      quantities.set(id, item.quantity);
    }
    return quantities;
  }

  private assertYamatoScannedProducts(payload: YamatoShipmentPrintByProductPayload, products: YamatoShipmentPageProductDetail[]): void {
    if (!Array.isArray(payload.scanRecords)) throw new BadRequestException('请扫码核对该面单的全部产品数量');
    const totals = new Map<string, number>();
    const seen = new Set<string>();
    for (const record of payload.scanRecords) {
      const product = products.find((item) => item.productId === record?.productId);
      const code = String(record?.scannedCode ?? '').trim().toUpperCase();
      const key = `${record?.productId}:${code}`;
      if (!product || ![product.productId, ...(product.bodyProductIds ?? [])].some((id) => id.toUpperCase() === code)
        || !Number.isInteger(record.quantity) || record.quantity <= 0 || seen.has(key)) {
        throw new BadRequestException('扫码记录的产品、本体或数量不正确');
      }
      seen.add(key);
      totals.set(product.productId, (totals.get(product.productId) ?? 0) + record.quantity);
    }
    if (products.some((product) => totals.get(product.productId) !== product.quantity)) {
      throw new BadRequestException('请扫齐该面单的产品数量，肩带成品码或本体码任选其一，每件只扫一次');
    }
  }

  private parseYamatoItemSummaryProductQuantities(
    itemSummary: string | null | undefined,
    fallbackProductIds: string[],
  ): Array<{ productId: string; quantity: number }> {
    const summary = String(itemSummary ?? '').trim().replace(/^DGAZ\s*/i, '');
    return Array.from(new Set(fallbackProductIds)).map((productId) => {
      const escaped = productId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|\\s*/\\s*)${escaped}\\*(\\d+)個`, 'g');
      const quantity = Array.from(summary.matchAll(pattern)).reduce((sum, match) => sum + Number(match[1]), 0);
      return { productId, quantity: quantity > 0 ? quantity : 1 };
    });
  }

  private describeYamatoBatchPageExpectation(
    page: Pick<YamatoShipmentBatchPage, 'productIds' | 'orderId' | 'recipientName'>,
  ): string {
    const expectedProductIds = this.getBatchPageProductIds(page);
    const orderId = String(page.orderId ?? '').trim();
    const recipientName = String(page.recipientName ?? '').trim();
    const expectedParts = [
      expectedProductIds.length ? `产品ID ${expectedProductIds.join('、')}` : null,
      orderId ? `订单号 ${orderId}` : null,
      recipientName ? `收件人 ${recipientName}` : null,
    ].filter((item): item is string => Boolean(item));

    return expectedParts.join(' / ') || '缺少可用于校验的产品ID、订单号或收件人';
  }

  private pdfTextContainsProductId(text: string, productId: string): boolean {
    const normalizedId = this.normalizePdfComparableText(productId);
    if (!normalizedId) return false;
    const escaped = normalizedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^A-Z0-9_-])${escaped}($|[^A-Z0-9_-])`, 'i');
    return pattern.test(String(text ?? '').toUpperCase());
  }

  private normalizePdfComparableText(value: string): string {
    return String(value ?? '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
  }

  private extractTrackingNoFromPdfText(text: string, excludedCodes: string[] = []): string | null {
    const format = (value: string) => { const digits = value.replace(/\D/g, ''); return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`; };
    const labelled = [...text.matchAll(/(?:お問い合わせ番号|お問合せ番号|送り状番号|伝票番号|追跡番号|tracking\s*(?:no\.?|number))[^\d]{0,30}(\d{4}[\s-]?\d{4}[\s-]?\d{4})(?!\d)/gi)].map((match) => format(match[1]));
    const barcodeNumbers = [...text.matchAll(/(?<![A-Za-z0-9])a(\d{12})a(?![A-Za-z0-9])/gi)].map((match) => format(match[1]));
    const formattedNumbers = [...text.matchAll(/(?<![A-Za-z0-9])\d{4}\s*-\s*\d{4}\s*-\s*\d{4}(?![A-Za-z0-9])/g)].map((match) => format(match[0]));
    const plainNumbers = [...text.matchAll(/(?<![A-Za-z0-9])\d{4}[\s-]*\d{4}[\s-]*\d{4}(?![A-Za-z0-9])/g)].map((match) => format(match[0]));
    const structuredNumbers = [...barcodeNumbers, ...formattedNumbers];
    const candidates = new Set(labelled.length ? labelled : (structuredNumbers.length ? structuredNumbers : plainNumbers).filter((value) => !excludedCodes.some((code) => code.replace(/\D/g, '') === value.replace(/\D/g, ''))));
    return candidates.size === 1 ? [...candidates][0] : null;
  }

  private isPdfFileBuffer(fileBuffer: Buffer): boolean {
    if (!fileBuffer || fileBuffer.length < 5) {
      return false;
    }
    return fileBuffer.subarray(0, 5).toString('ascii') === '%PDF-';
  }

  private async loadYamatoTemplateBuffer(): Promise<Buffer> {
    const cwd = process.cwd();
    const candidates = [
      join(cwd, 'docs', YAMATO_IMPORT_TEMPLATE_FILE),
      join(cwd, 'apps', 'api', 'docs', YAMATO_IMPORT_TEMPLATE_FILE),
      join(cwd, '..', '..', 'docs', YAMATO_IMPORT_TEMPLATE_FILE),
    ];

    for (const templatePath of candidates) {
      try {
        return await readFile(templatePath);
      } catch {
        // continue
      }
    }

    throw new NotFoundException(`模板文件不存在：${YAMATO_IMPORT_TEMPLATE_FILE}`);
  }

  private async buildYamatoWorkbookBuffer(
    rows: YamatoMergedExportRow[],
    currentDate: string): Promise<Buffer> {
    const templateBuffer = await this.loadYamatoTemplateBuffer();
    const zip = await JSZip.loadAsync(templateBuffer);
    const sheetPath = 'xl/worksheets/sheet1.xml';
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) {
      throw new NotFoundException(`模板缺少工作表文件：${sheetPath}`);
    }

    const originalSheetXml = await sheetFile.async('string');
    const originalRows = this.extractYamatoSheetRows(originalSheetXml);
    const headerRowXml = originalRows.get(1);
    if (!headerRowXml) {
      throw new NotFoundException('模板缺少第 1 行表头');
    }

    const dimensionMatch = originalSheetXml.match(/<dimension[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*\/>/);
    const lastTemplateRow = dimensionMatch ? Number.parseInt(dimensionMatch[4], 10) : 80;
    const finalColumn = dimensionMatch?.[3] ?? 'CQ';
    const baseTemplateRowNumber = originalRows.has(2) ? 2 : 1;
    const maxRow = Math.max(lastTemplateRow, rows.length + 1);
    const builtRows: string[] = [headerRowXml];

    for (let rowNumber = 2; rowNumber <= maxRow; rowNumber += 1) {
      const sourceRowNumber = originalRows.has(rowNumber) ? rowNumber : baseTemplateRowNumber;
      const templateRowXml = originalRows.get(sourceRowNumber);
      if (!templateRowXml) {
        throw new NotFoundException(`模板缺少第 ${sourceRowNumber} 行`);
      }

      const exportRow = rows[rowNumber - 2];
      if (!exportRow && originalRows.has(rowNumber)) {
        builtRows.push(originalRows.get(rowNumber) as string);
        continue;
      }

      builtRows.push(
        this.buildYamatoSheetRowXml(
          rowNumber,
          this.parseYamatoTemplateRow(templateRowXml, sourceRowNumber),
          exportRow ?? null,
          currentDate,
        ),
      );
    }

    const nextSheetXml = originalSheetXml
      .replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${builtRows.join('')}</sheetData>`)
      .replace(
        /<dimension[^>]*ref="[A-Z]+\d+:[A-Z]+\d+"\s*\/>/,
        `<dimension ref="A1:${finalColumn}${maxRow}"/>`);

    zip.file(sheetPath, nextSheetXml);
    return zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });
  }

  private extractYamatoSheetRows(sheetXml: string): Map<number, string> {
    const rows = new Map<number, string>();
    const matches = sheetXml.match(/<row\b[^>]*r="\d+"[^>]*>[\s\S]*?<\/row>/g) ?? [];
    matches.forEach((rowXml) => {
      const rowNumberMatch = rowXml.match(/<row\b[^>]*r="(\d+)"/);
      const rowNumber = Number.parseInt(rowNumberMatch?.[1] ?? '', 10);
      if (Number.isInteger(rowNumber) && rowNumber > 0) {
        rows.set(rowNumber, rowXml);
      }
    });
    return rows;
  }

  private parseYamatoTemplateRow(rowXml: string, sourceRowNumber: number): YamatoTemplateRow {
    const rowMatch = rowXml.match(/^<row\b([^>]*)>([\s\S]*?)<\/row>$/);
    if (!rowMatch) {
      throw new NotFoundException(`模板第 ${sourceRowNumber} 行格式无效`);
    }

    const rowAttributes = rowMatch[1].replace(/\s+r="\d+"/, '');
    const cells: YamatoTemplateRowCell[] = [];
    const cellMatches = rowMatch[2].match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) ?? [];
    cellMatches.forEach((cellXml) => {
      const refMatch = cellXml.match(/\br="([A-Z]+)\d+"/);
      if (!refMatch?.[1]) {
        return;
      }
      const styleMatch = cellXml.match(/\bs="([^"]+)"/);
      cells.push({
        column: refMatch[1],
        styleId: styleMatch?.[1] ?? null,
      });
    });

    return {
      rowAttributes,
      cells,
    };
  }

  private buildYamatoSheetRowXml(
    rowNumber: number,
    template: YamatoTemplateRow,
    row: YamatoMergedExportRow | null,
    currentDate: string,
  ): string {
    const values = row ? this.buildYamatoRowValueMap(row, currentDate) : new Map<string, string>();
    const cellsXml = template.cells
      .map((cell) => this.buildYamatoCellXml(cell, rowNumber, values.get(cell.column) ?? ''))
      .join('');
    return `<row r="${rowNumber}"${template.rowAttributes}>${cellsXml}</row>`;
  }

  private buildYamatoRowValueMap(row: YamatoMergedExportRow, currentDate: string): Map<string, string> {
    const values = new Map<string, string>();
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.orderId), row.orderId);
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.printerValue), row.printerValue || '0');
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.shipDate), currentDate);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.deliveryDate),
      this.normalizeYamatoOptionalCellValue(row.deliveryDate),
    );
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.deliveryTimeSlot),
      this.normalizeYamatoOptionalCellValue(row.deliveryTimeSlot),
    );
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.phone), row.phone);
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.postalCode), row.postalCode);
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.address1), row.address1);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.address2),
      this.normalizeYamatoOptionalCellValue(row.address2));
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.recipientName), row.recipientName);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.recipientSuffix),
      YAMATO_EXPORT_FIXED_VALUES.recipientSuffix);
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.senderPhone), YAMATO_EXPORT_FIXED_VALUES.senderPhone);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.senderPostalCode),
      YAMATO_EXPORT_FIXED_VALUES.senderPostalCode);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.senderAddress),
      YAMATO_EXPORT_FIXED_VALUES.senderAddress);
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.senderName), YAMATO_EXPORT_FIXED_VALUES.senderName);
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.itemSummary), row.itemSummary);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.invoiceCustomerCode),
      YAMATO_EXPORT_FIXED_VALUES.invoiceCustomerCode,
    );
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.coolType), YAMATO_EXPORT_FIXED_VALUES.coolType);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.deliveryType),
      YAMATO_EXPORT_FIXED_VALUES.deliveryType);
    return values;
  }

  private buildYamatoCellXml(cell: YamatoTemplateRowCell, rowNumber: number, value: string): string {
    const attrs = [`r="${cell.column}${rowNumber}"`];
    if (cell.styleId) {
      attrs.push(`s="${cell.styleId}"`);
    }
    const normalizedValue = String(value ?? '');
    if (!normalizedValue) {
      return `<c ${attrs.join(' ')}/>`;
    }
    const preserveSpace = /^\s|\s$|\n/.test(normalizedValue);
    const escaped = this.escapeXmlText(normalizedValue);
    return `<c ${attrs.join(' ')} t="inlineStr"><is><t${
      preserveSpace ? ' xml:space="preserve"' : ''
    }>${escaped}</t></is></c>`;
  }

  private escapeXmlText(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private getJsonField(payload: Prisma.JsonValue | null | undefined, key: string): string | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const value = (payload as Record<string, Prisma.JsonValue | null | undefined>)[key];
    if (value === null || value === undefined) {
      return null;
    }
    const text = String(value).trim();
    return text || null;
  }

  private concatAddress(parts: Array<string | null | undefined>): string {
    const text = parts
      .map((part) => String(part ?? '').trim())
      .filter((part) => part.length > 0)
      .join('');
    return text || '-';
  }

  private buildRakutenFullShippingAddress(
    prefecture: string | null | undefined,
    city: string | null | undefined,
    address: string | null | undefined,
  ): string {
    return this.concatAddress([prefecture, city, address]);
  }

  private normalizeYamatoPhone(value: string | null | undefined): string {
    const normalized = String(value ?? '')
      .normalize('NFKC')
      .replace(/[^\d]/g, '');
    return normalized.trim();
  }

  private normalizeYamatoOptionalCellValue(value: string | null | undefined): string {
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized === '-') {
      return '';
    }
    return normalized;
  }

  private formatCurrentYamatoDate(date: Date = new Date()): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}/${parts.month}/${parts.day}`;
  }

  private formatYamatoDeliveryDate(value: string | null | undefined): string {
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized === '-') {
      return '-';
    }
    const match = normalized.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (!match) {
      return normalized;
    }
    return `${match[1]}/${match[2].padStart(2, '0')}/${match[3].padStart(2, '0')}`;
  }

  private formatAmazonShipmentConfirmationDate(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  private formatYamatoFileNameStamp(date: Date = new Date()): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
  }

  private formatOrderProcessingExportDate(value: Date | string | null | undefined): string {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  private normalizeAmazonTrackingNumber(value: string | null | undefined): string {
    const raw = String(value ?? '').trim();
    const digits = raw.replace(/\D/g, '');
    return digits.length === 12 ? digits : raw;
  }

  private escapeTsvCell(value: string | number | null | undefined): string {
    return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  }

  private normalizeShipmentConfirmationScope(daysRaw: string | number | null | undefined, noun: string,
  ): {
    days: 1 | 2 | 3 | 5 | 15 | 30 | 'all';
    label: string;
    fileLabel: string;
  } {
    const normalized = String(daysRaw ?? '1').trim().toLowerCase();
    if (normalized === 'all') {
      return { days: 'all', label: `全部${noun}`, fileLabel: '全部' };
    }
    const days = Number(normalized);
    if (days === 1) return { days: 1, label: `当日${noun}`, fileLabel: '当日' };
    if (days === 2) return { days: 2, label: `最近2天${noun}`, fileLabel: '最近2天' };
    if (days === 3) return { days: 3, label: `最近3天${noun}`, fileLabel: '最近3天' };
    if (days === 5) return { days: 5, label: `最近5天${noun}`, fileLabel: '最近5天' };
    if (days === 15) return { days: 15, label: `最近15天${noun}`, fileLabel: '最近15天' };
    if (days === 30) return { days: 30, label: `最近30天${noun}`, fileLabel: '最近30天' };
    throw new BadRequestException('回传单号下载范围只支持当日、最近2天、最近3天、最近5天、最近15天、最近30天或全部');
  }

  private getImportDateRangeStart(days: 1 | 2 | 3 | 5 | 15 | 30): Date {
    const parts = getZonedDateParts(new Date(), APP_TIMEZONE);
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    // APP_TIMEZONE is Asia/Shanghai. Convert local midnight to UTC for DB DateTime comparison.
    return new Date(Date.UTC(year, month - 1, day - (days - 1), -8, 0, 0));
  }

  private buildOverseasPickingBatchNo(date: Date = new Date()): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `PK-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  }

  async importAmazonTxt(
    fileBuffer: Buffer,
    originalName?: string): Promise<AmazonOrderImportResult> {
    const sourceFileName = String(originalName ?? '').trim() || 'amazon-orders.txt';
    return this.importAmazonTxtBuffer(fileBuffer, sourceFileName, `uploaded:${sourceFileName}`);
  }

  async exportForThirdParty(): Promise<{
    exportedAt: string;
    total: number;
    rows: Record<string, unknown>[];
  }> {
    const [rakutenRows, amazonRows, manualRows] = await Promise.all([
      this.prisma.rakutenOrderRecord.findMany({
        where: { deletedAt: null,
          sendStatus: OrderSendStatus.unsent,
          OR: [{ shipmentNo: null }, { shipmentNo: '' }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.amazonOrderRecord.findMany({
        where: {
          ...PROCESSABLE_AMAZON_ORDER_WHERE,
          OR: [{ shipmentNo: null }, { shipmentNo: '' }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      (this.prisma as any).manualOrderRecord.findMany({
        where: {
          OR: [{ shipmentNo: null }, { shipmentNo: '' }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const [enrichedRakutenRows, enrichedAmazonRows, enrichedManualRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
      this.enrichManualOrderRows(manualRows),
    ]);

    const activePickedRefs = await this.loadActiveOverseasPickingBatchRefs([
      ...enrichedRakutenRows.map((row) => ({
        source: 'rakuten' as const,
        sourceRecordId: row.id,
      })),
      ...enrichedAmazonRows.map((row) => ({
        source: 'amazon' as const,
        sourceRecordId: row.id,
      })),
      ...enrichedManualRows.map((row) => ({
        source: 'manual' as const,
        sourceRecordId: row.id,
      })),
    ]);

    const targetRows = [
      ...enrichedRakutenRows
        .filter((row) => !rakutenOrderRemarkNeedsConfirmation(row) && this.shouldExportOrderToThirdParty('rakuten', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs,
          ),
        )
        .map((row) => ({
          createdAt: row.createdAt,
          row: this.toThirdPartyRow(row),
        })),
      ...enrichedAmazonRows
        .filter((row) => this.shouldExportOrderToThirdParty('amazon', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs),
        )
        .map((row) => ({
          createdAt: row.createdAt,
          row: this.toAmazonThirdPartyRow(row),
        })),
      ...enrichedManualRows
        .filter((row) => this.shouldExportOrderToThirdParty('manual', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs),
        )
        .map((row) => ({
          createdAt: row.createdAt,
          row: this.toManualThirdPartyRow(row),
        })),
    ].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

    return {
      exportedAt: new Date().toISOString(),
      total: targetRows.length,
      rows: targetRows.map((item) => item.row),
    };
  }

  async ackThirdPartyExport(payload: {
    items?: ThirdPartyExportAckItem[] }): Promise<{
    acknowledgedAt: string;
    requestedCount: number;
    rakutenCount: number;
    amazonCount: number;
    manualCount: number;
  }> {
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    if (!rawItems.length) {
      throw new BadRequestException('请至少提供一条回执记录');
    }

    const groupedIds = new Map<ThirdPartyExportSource, bigint[]>();
    for (const source of ['rakuten', 'amazon', 'manual'] as const) {
      groupedIds.set(source, []);
    }

    rawItems.forEach((item, index) => {
      const source = String(item?.source ?? '').trim();
      if (source !== 'rakuten' && source !== 'amazon' && source !== 'manual') {
        throw new BadRequestException(`items[${index}].source 只支持 rakuten、amazon 或 manual`);
      }
      const rawId = String(item?.id ?? '').trim();
      groupedIds.get(source)?.push(parseId(rawId, `items[${index}].id`));
    });

    const rakutenIds = Array.from(new Set(groupedIds.get('rakuten') ?? []));
    const amazonIds = Array.from(new Set(groupedIds.get('amazon') ?? []));
    const manualIds = Array.from(new Set(groupedIds.get('manual') ?? []));
    const acknowledgedAt = new Date();

    const [rakutenRows, amazonRows, manualRows] = await Promise.all([
      rakutenIds.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: { deletedAt: null,
              id: { in: rakutenIds },
              sendStatus: OrderSendStatus.unsent,
              xiyaExportedAt: null,
            },
          })
        : Promise.resolve([]),
      amazonIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: {
              ...PROCESSABLE_AMAZON_ORDER_WHERE,
              id: { in: amazonIds },
              AND: [
                { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                { xiyaExportedAt: null }],
            },
          })
        : Promise.resolve([]),
      manualIds.length
        ? (this.prisma as any).manualOrderRecord.findMany({
            where: {
              id: { in: manualIds },
              AND: [
                { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                { xiyaExportedAt: null }],
            },
          })
        : Promise.resolve([] as ManualOrderRecordLike[]),
    ]);

    const [enrichedRakutenRows, enrichedAmazonRows, enrichedManualRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
      this.enrichManualOrderRows(manualRows),
    ]);

    const activePickedRefs = await this.loadActiveOverseasPickingBatchRefs([
      ...enrichedRakutenRows.map((row) => ({
        source: 'rakuten' as const,
        sourceRecordId: row.id,
      })),
      ...enrichedAmazonRows.map((row) => ({
        source: 'amazon' as const,
        sourceRecordId: row.id,
      })),
      ...enrichedManualRows.map((row) => ({
        source: 'manual' as const,
        sourceRecordId: row.id,
      })),
    ]);

    const eligibleRakutenIds = enrichedRakutenRows
      .filter((row) =>
        !rakutenOrderRemarkNeedsConfirmation(row) && this.shouldExportOrderToThirdParty('rakuten', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs),
      )
      .map((row) => row.id);
    const eligibleAmazonIds = enrichedAmazonRows
      .filter((row) =>
        this.shouldExportOrderToThirdParty('amazon', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs),
      )
      .map((row) => row.id);
    const eligibleManualIds = enrichedManualRows
      .filter((row) =>
        this.shouldExportOrderToThirdParty('manual', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs),
      )
      .map((row) => row.id);

    const [rakutenResult, amazonResult, manualResult] = await this.prisma.$transaction(async (tx) => {
      const rakutenResult = eligibleRakutenIds.length
        ? await tx.rakutenOrderRecord.updateMany({
            where: { deletedAt: null,
              id: { in: eligibleRakutenIds },
              xiyaExportedAt: null,
            },
            data: {
              xiyaExportedAt: acknowledgedAt,
            },
          })
        : { count: 0 };
      const amazonResult = eligibleAmazonIds.length
        ? await tx.amazonOrderRecord.updateMany({
            where: {
              id: { in: eligibleAmazonIds },
              xiyaExportedAt: null,
            },
            data: {
              xiyaExportedAt: acknowledgedAt,
            },
          })
        : { count: 0 };
      const manualResult = eligibleManualIds.length
        ? await (tx as any).manualOrderRecord.updateMany({
            where: {
              id: { in: eligibleManualIds },
              xiyaExportedAt: null,
            },
            data: {
              xiyaExportedAt: acknowledgedAt,
            },
          })
        : { count: 0 };
      return [rakutenResult, amazonResult, manualResult] as const;
    });

    return {
      acknowledgedAt: acknowledgedAt.toISOString(),
      requestedCount: rawItems.length,
      rakutenCount: Number(rakutenResult.count ?? 0),
      amazonCount: Number(amazonResult.count ?? 0),
      manualCount: Number(manualResult.count ?? 0),
    };
  }

  async syncXiyaTrackingNumbers(): Promise<{
    syncedAt: string;
    days: number;
    fetchedCount: number;
    validCount: number;
    deduplicatedCount: number;
    rakutenUpdatedCount: number;
    amazonUpdatedCount: number;
    skippedUnmatchedCount: number;
    manualUpdatedCount: number;
  }> {
    if (this.xiyaTrackingSyncRunning) {
      throw new ConflictException('当前已有 Xiya 运单号同步任务正在执行，请稍后再试');
    }

    this.xiyaTrackingSyncRunning = true;
    try {
      // Read once per run so the request and response use the same current shop snapshot.
      const storeSources = await this.loadXiyaLogisticsStoreSources();
      const fetchedRows = await this.fetchXiyaLogisticsRows(storeSources);
      const candidates = this.normalizeXiyaTrackingCandidates(fetchedRows, storeSources);
      const deduplicatedCandidates = this.deduplicateXiyaTrackingCandidates(candidates);
      const [rakutenResult, amazonResult, manualResult] = await Promise.all([
        this.applyXiyaTrackingCandidates(
          'rakuten',
          deduplicatedCandidates.filter((candidate) => candidate.source === 'rakuten'),
        ),
        this.applyXiyaTrackingCandidates(
          'amazon',
          deduplicatedCandidates.filter((candidate) => candidate.source === 'amazon'),
        ),
        this.applyXiyaTrackingCandidates(
          'manual',
          deduplicatedCandidates),
      ]);

      return {
        syncedAt: new Date().toISOString(),
        days: XIYA_LOGISTICS_SYNC_DAYS,
        fetchedCount: fetchedRows.length,
        validCount: candidates.length,
        deduplicatedCount: deduplicatedCandidates.length,
        rakutenUpdatedCount: rakutenResult.updatedCount,
        amazonUpdatedCount: amazonResult.updatedCount,
        manualUpdatedCount: manualResult.updatedCount,
        skippedUnmatchedCount:
          rakutenResult.skippedUnmatchedCount + amazonResult.skippedUnmatchedCount + manualResult.skippedUnmatchedCount,
      };
    } finally {
      this.xiyaTrackingSyncRunning = false;
    }
  }

  @Cron(XIYA_TRACKING_SYNC_CRON, {
    name: 'daily-xiya-tracking-sync',
    timeZone: APP_TIMEZONE,
  })
  async runScheduledXiyaTrackingSync(): Promise<void> {
    try {
      const result = await this.syncXiyaTrackingNumbers();
      this.logger.log(
        `daily Xiya tracking sync completed: rakuten=${result.rakutenUpdatedCount}, amazon=${result.amazonUpdatedCount}, manual=${result.manualUpdatedCount}, unmatched=${result.skippedUnmatchedCount}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`daily Xiya tracking sync failed: ${message}`);
    }
  }

  async syncRakutenTrackingStatuses(): Promise<{
    syncedAt: string;
    candidateCount: number;
    trackingNoCount: number;
    maxPerRun: number;
    deliveredCount: number;
    customsClearanceCount: number;
    failedCount: number;
    latestCheckedAt: string | null;
    pendingTrackingNoCount: number;
  }> {
    const lockToken = randomUUID();
    if (!(await this.acquireRakutenTrackingSyncLock(lockToken))) {
      throw new ConflictException('当前已有乐天快递状态同步任务正在执行，请稍后再试');
    }
    const heartbeat = this.startRakutenTrackingSyncLockHeartbeat(lockToken);
    try {
      const ignored = await this.prisma.rakutenTrackingQueryIgnore.findMany({
        where: { isActive: true }, select: { trackingNo: true },
      });
      const rows = await this.prisma.rakutenOrderRecord.findMany({
        where: { deletedAt: null,
          shipmentNo: { not: null, notIn: ['', ...ignored.map((row) => row.trackingNo)] },
          OR: [
            { trackingIsDelivered: false },
            { trackingHasCustomsClearance: false },
            { trackingCustomsClearanceDate: null },
            { trackingError: { not: null } },
          ],
          ...this.buildRakutenChinaDispatchWhere(),
        },
        orderBy: [
          { trackingCheckedAt: 'asc' },
          { shipmentNoRegisteredAt: 'desc' },
          { id: 'desc' }],
        distinct: ['shipmentNo'],
        take: UOF_TRACKING_SYNC_MAX_PER_RUN,
      });
      const statusByNo = await this.refreshRakutenTrackingStatusesForRows(rows);
      const statuses = Array.from(statusByNo.values());
      const summary = await this.getRakutenTrackingStatusSummary();
      return {
        syncedAt: new Date().toISOString(),
        candidateCount: rows.length,
        trackingNoCount: statusByNo.size,
        maxPerRun: UOF_TRACKING_SYNC_MAX_PER_RUN,
        deliveredCount: statuses.filter((status) => this.isDeliveredRakutenTrackingStatus(status)).length,
        customsClearanceCount: statuses.filter((status) => status.hasCustomsClearance).length,
        failedCount: statuses.filter((status) => Boolean(status.error)).length,
        latestCheckedAt: summary.latestCheckedAt,
        pendingTrackingNoCount: summary.pendingTrackingNoCount,
      };
    } finally {
      clearInterval(heartbeat);
      await this.releaseRakutenTrackingSyncLock(lockToken);
    }
  }

  async getRakutenTrackingStatusSummary(): Promise<{
    latestCheckedAt: string | null;
    pendingTrackingNoCount: number;
    uncheckedTrackingNoCount: number;
  }> {
    const [latestRow, pendingCountRows, uncheckedCountRows] = await Promise.all([
      this.prisma.rakutenOrderRecord.findFirst({
        where: { deletedAt: null, trackingCheckedAt: { not: null } },
        orderBy: { trackingCheckedAt: 'desc' },
        select: { trackingCheckedAt: true },
      }),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT shipment_no) AS count
        FROM rakuten_order_records
        WHERE deleted_at IS NULL AND shipment_no IS NOT NULL AND shipment_no <> ''
          AND NOT EXISTS (SELECT 1 FROM rakuten_tracking_query_ignores i
            WHERE i.tracking_no = rakuten_order_records.shipment_no AND i.is_active = 1)
          AND (tracking_is_delivered = 0 OR tracking_has_customs_clearance = 0
            OR tracking_customs_clearance_date IS NULL OR tracking_error IS NOT NULL)
          AND dispatch_mode IN (${OVERSEAS_DISPATCH_MODE.CHINA_PENDING}, ${OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK})
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT shipment_no) AS count
        FROM rakuten_order_records
        WHERE deleted_at IS NULL AND shipment_no IS NOT NULL AND shipment_no <> ''
          AND NOT EXISTS (SELECT 1 FROM rakuten_tracking_query_ignores i
            WHERE i.tracking_no = rakuten_order_records.shipment_no AND i.is_active = 1)
          AND tracking_checked_at IS NULL
          AND dispatch_mode IN (${OVERSEAS_DISPATCH_MODE.CHINA_PENDING}, ${OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK})
      `),
    ]);
    return {
      latestCheckedAt: latestRow?.trackingCheckedAt?.toISOString() ?? null,
      pendingTrackingNoCount: Number(pendingCountRows[0]?.count ?? 0),
      uncheckedTrackingNoCount: Number(uncheckedCountRows[0]?.count ?? 0),
    };
  }

  async listRakutenTrackingQueryFailures(view = 'failed', query = '', pageRaw = '1') {
    if (!['failed', 'ignored'].includes(view)) throw new BadRequestException('不支持的物流查询列表');
    const page = Number(pageRaw);
    if (!Number.isSafeInteger(page) || page < 1) throw new BadRequestException('页码必须为正整数');
    const search = query.trim();
    if (search.length > 128) throw new BadRequestException('查询内容过长');
    const pageSize = 50;
    const activeIgnores = await this.prisma.rakutenTrackingQueryIgnore.findMany({
      where: { isActive: true }, orderBy: [{ ignoredAt: 'desc' }, { trackingNo: 'asc' }],
    });
    const ignoreByNo = new Map(activeIgnores.map((row) => [row.trackingNo, row]));
    // Search by an order selects its whole tracking-number group, including all item rows.
    const searchWhere = search ? Prisma.sql`AND (r.shipment_no LIKE ${`%${search}%`}
      OR EXISTS (SELECT 1 FROM rakuten_order_records o WHERE o.deleted_at IS NULL
        AND o.shipment_no = r.shipment_no AND (o.order_id LIKE ${`%${search}%`} OR o.mall_order_no LIKE ${`%${search}%`})))` : Prisma.empty;
    const failedWhere = Prisma.sql`r.deleted_at IS NULL AND r.shipment_no IS NOT NULL AND r.shipment_no <> ''
      AND r.dispatch_mode IN (${OVERSEAS_DISPATCH_MODE.CHINA_PENDING}, ${OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK})
      AND r.tracking_error IS NOT NULL AND r.tracking_error <> ''
      AND NOT EXISTS (SELECT 1 FROM rakuten_tracking_query_ignores i WHERE i.tracking_no = r.shipment_no AND i.is_active = 1)`;
    const counts = await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT r.shipment_no) AS count FROM rakuten_order_records r WHERE ${failedWhere}
    `);
    let total: number;
    let trackingNos: string[];
    if (view === 'ignored') {
      // Keep ignored numbers reviewable even if their orders are later deleted or corrected.
      const matches = search ? await this.prisma.rakutenOrderRecord.findMany({
        where: { deletedAt: null, OR: [{ orderId: { contains: search } }, { mallOrderNo: { contains: search } }] },
        select: { shipmentNo: true }, distinct: ['shipmentNo'],
      }) : [];
      const matchedNos = new Set(matches.map((row) => row.shipmentNo));
      const filtered = activeIgnores.filter((row) => !search || row.trackingNo.toLowerCase().includes(search.toLowerCase()) || matchedNos.has(row.trackingNo));
      total = filtered.length;
      trackingNos = filtered.slice((page - 1) * pageSize, page * pageSize).map((row) => row.trackingNo);
    } else {
      const filteredCounts = search ? await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT r.shipment_no) AS count FROM rakuten_order_records r WHERE ${failedWhere} ${searchWhere}
      `) : counts;
      total = Number(filteredCounts[0]?.count ?? 0);
      const groups = await this.prisma.$queryRaw<Array<{ trackingNo: string }>>(Prisma.sql`
        SELECT r.shipment_no AS trackingNo FROM rakuten_order_records r WHERE ${failedWhere} ${searchWhere}
        GROUP BY r.shipment_no ORDER BY MAX(r.tracking_checked_at) DESC, r.shipment_no ASC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
      `);
      trackingNos = groups.map((row) => row.trackingNo);
    }
    const rows = trackingNos.length ? await this.prisma.rakutenOrderRecord.findMany({
      where: { deletedAt: null, shipmentNo: { in: trackingNos }, ...this.buildRakutenChinaDispatchWhere() },
      select: { orderId: true, mallOrderNo: true, shipmentNo: true, shipmentCompany: true, shopName: true,
        trackingError: true, trackingCheckedAt: true,
        rmsConnection: { select: { shop: { select: { name: true } } } } },
      orderBy: [{ trackingCheckedAt: 'desc' }, { id: 'desc' }],
    }) : [];
    return { page, pageSize, total, failedCount: Number(counts[0]?.count ?? 0), ignoredCount: activeIgnores.length,
      items: trackingNos.map((trackingNo) => {
        const details = rows.filter((row) => row.shipmentNo === trackingNo);
        const ignored = ignoreByNo.get(trackingNo);
        const unique = (values: Array<string | null | undefined>) => [...new Set(values.filter((value): value is string => Boolean(value)))];
        return { trackingNo, recordCount: details.length,
          orderIds: unique(details.map((row) => row.orderId || row.mallOrderNo)),
          shopNames: unique(details.map((row) => row.shopName || row.rmsConnection?.shop.name)),
          shipmentCompanies: unique(details.map((row) => row.shipmentCompany)),
          error: details.find((row) => row.trackingError)?.trackingError ?? null,
          checkedAt: details[0]?.trackingCheckedAt?.toISOString() ?? null,
          ignoredAt: ignored?.ignoredAt.toISOString() ?? null, ignoredBy: ignored?.ignoredBy ?? null,
        };
      }),
    };
  }

  async updateRakutenTrackingQueryIgnores(payload: { trackingNos?: unknown; ignored?: unknown }, username: string) {
    if (!Array.isArray(payload?.trackingNos) || payload.trackingNos.length < 1 || payload.trackingNos.length > 100
      || payload.trackingNos.some((no: unknown) => typeof no !== 'string' || !no.trim() || no.trim().length > 128)
      || typeof payload.ignored !== 'boolean') throw new BadRequestException('请选择1至100个单号，并指定忽略或恢复查询');
    const trackingNos = [...new Set((payload.trackingNos as string[]).map((no) => no.trim()))];
    const ignored = payload.ignored;
    const lockToken = randomUUID();
    if (!(await this.acquireRakutenTrackingSyncLock(lockToken))) {
      throw new ConflictException('物流查询正在执行，请在本轮完成后再忽略或恢复');
    }
    try {
      const changedCount = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.rakutenTrackingQueryIgnore.findMany({ where: { trackingNo: { in: trackingNos } } });
        const activeNos = new Set(existing.filter((row) => row.isActive).map((row) => row.trackingNo));
        if (!ignored) {
          const result = await tx.rakutenTrackingQueryIgnore.updateMany({
            where: { trackingNo: { in: trackingNos }, isActive: true },
            data: { isActive: false, restoredAt: new Date(), restoredBy: username },
          });
          return result.count;
        }
        const failures = await tx.rakutenOrderRecord.findMany({
          where: { deletedAt: null, shipmentNo: { in: trackingNos }, trackingError: { not: null, notIn: [''] },
            ...this.buildRakutenChinaDispatchWhere() }, select: { shipmentNo: true }, distinct: ['shipmentNo'],
        });
        const eligible = new Set(failures.map((row) => row.shipmentNo));
        if (trackingNos.some((no) => !activeNos.has(no) && !eligible.has(no))) {
          throw new BadRequestException('部分单号已不在查询失败列表，请刷新后重新选择');
        }
        const changes = trackingNos.filter((no) => !activeNos.has(no));
        for (const trackingNo of changes) {
          const data = { isActive: true, ignoredAt: new Date(), ignoredBy: username, restoredAt: null, restoredBy: null };
          await tx.rakutenTrackingQueryIgnore.upsert({ where: { trackingNo }, create: { trackingNo, ...data }, update: data });
        }
        return changes.length;
      });
      return { changedCount, ignored };
    } finally { await this.releaseRakutenTrackingSyncLock(lockToken); }
  }

  private async syncManualOrderIdsToXyjgBestEffort(ids: Array<bigint | number | string>): Promise<void> {
    const normalizedIds = Array.from(
      new Set(
        ids
          .map((id) => {
            try {
              return BigInt(id);
            } catch {
              return null;
            }
          })
          .filter((id): id is bigint => id !== null),
      ),
    );
    if (!normalizedIds.length) {
      return;
    }

    const rows = (await (this.prisma as any).manualOrderRecord.findMany({
      where: {
        id: {
          in: normalizedIds,
        },
      },
    })) as ManualOrderRecordLike[];
    await this.syncManualOrdersToXyjgBestEffort(rows);
  }

  private async syncManualOrdersToXyjgBestEffort(rows: ManualOrderRecordLike[]): Promise<void> {
    const rowsByOrder = new Map<string, ManualOrderRecordLike[]>();
    for (const row of rows) {
      const bloggerCooperationId = this.resolveManualOrderBloggerCooperationId(row);
      if (!bloggerCooperationId) {
        continue;
      }
      const orderId = String(row.orderId ?? '').trim() || row.id.toString();
      const key = `${bloggerCooperationId}\u001f${orderId}`;
      rowsByOrder.set(key, [...(rowsByOrder.get(key) ?? []), row]);
    }

    for (const orderRows of rowsByOrder.values()) {
      await this.syncManualOrderGroupToXyjgBestEffort(orderRows);
    }
  }

  private async syncManualOrderGroupToXyjgBestEffort(rows: ManualOrderRecordLike[]): Promise<void> {
    const row = rows[0];
    if (!row) {
      return;
    }
    const bloggerCooperationId = this.resolveManualOrderBloggerCooperationId(row);
    if (!bloggerCooperationId) {
      return;
    }
    const orderId = String(row.orderId ?? '').trim();
    const orderRows = orderId
      ? ((await (this.prisma as any).manualOrderRecord.findMany({
          where: { orderId },
        })) as ManualOrderRecordLike[]).filter(
          (candidate) => this.resolveManualOrderBloggerCooperationId(candidate) === bloggerCooperationId)
      : rows;
    const targetRows = orderRows.length ? orderRows : rows;

    const trackingRow = targetRows.find((candidate) => String(candidate.shipmentNo ?? '').trim());
    const trackingNo = String(trackingRow?.shipmentNo ?? '').trim();
    const hasChinaDispatchRow = targetRows.some((candidate) => this.isChinaDispatchMode(candidate.dispatchMode));
    const pushMode =
      hasChinaDispatchRow
        ? XYJG_PUSH_MODE.CHINA_SHIP
        : trackingNo
          ? XYJG_PUSH_MODE.LOGISTICS_ORDER
          : null;
    if (!pushMode) {
      return;
    }

    const pushTrackingNo = pushMode === XYJG_PUSH_MODE.LOGISTICS_ORDER ? trackingNo : null;
    if (
      targetRows.every(
        (candidate) =>
          String(candidate.xyjgPushStatus ?? '') === XYJG_PUSH_STATUS.SYNCED &&
          String(candidate.xyjgPushMode ?? '') === pushMode &&
          String(candidate.xyjgPushTrackingNo ?? '') === String(pushTrackingNo ?? ''),
      )
    ) {
      return;
    }

    const payload = {
      company_name: XIYA_COMPANY_NAME,
      blogger_cooperation_id: bloggerCooperationId,
      switch_to_china_ship: pushMode === XYJG_PUSH_MODE.CHINA_SHIP,
      ...(pushTrackingNo ? { tracking_number: pushTrackingNo } : {}),
    };

    try {
      const response = await fetch(XYJG_BLOGGER_STATUS_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const responsePayload = await this.readExternalJsonResponse(response);
      const responseCode =
        responsePayload && typeof responsePayload === 'object'
          ? Number((responsePayload as Record<string, unknown>).code)
          : NaN;
      if (!response.ok || !XIYA_SUCCESS_CODES.has(responseCode)) {
        const message =
          responsePayload && typeof responsePayload === 'object'
            ? String((responsePayload as Record<string, unknown>).message ?? '')
            : '';
        throw new Error(message || `HTTP ${response.status}`);
      }

      await (this.prisma as any).manualOrderRecord.updateMany({
        where: { id: { in: targetRows.map((candidate) => candidate.id) } },
        data: {
          xyjgPushStatus: XYJG_PUSH_STATUS.SYNCED,
          xyjgPushMode: pushMode,
          xyjgPushTrackingNo: pushTrackingNo,
          xyjgPushedAt: new Date(),
          xyjgPushError: null,
          xyjgPushResponse: responsePayload as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `XYJG blogger status push failed for manual order ${String(row.orderId ?? row.id.toString())}: ${message}`,
      );
      await (this.prisma as any).manualOrderRecord.updateMany({
        where: { id: { in: targetRows.map((candidate) => candidate.id) } },
        data: {
          xyjgPushStatus: XYJG_PUSH_STATUS.FAILED,
          xyjgPushMode: pushMode,
          xyjgPushTrackingNo: pushTrackingNo,
          xyjgPushedAt: null,
          xyjgPushError: this.truncateText(message, 2000),
        },
      });
    }
  }

  private resolveManualOrderBloggerCooperationId(row: ManualOrderRecordLike): string | null {
    const direct = String(row.bloggerCooperationId ?? '').trim();
    if (direct) {
      return direct;
    }
    const fromRawPayload =
      this.getJsonObjectString(row.rawPayload, 'bloggerCooperationId') ||
      this.getJsonObjectString(row.rawPayload, 'blogger_cooperation_id') ||
      this.getJsonObjectString(row.rawPayload, '博主合作单ID');
    if (fromRawPayload) {
      return fromRawPayload;
    }
    return null;
  }

  private async readExternalJsonResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return {
        raw: this.truncateText(text, 2000),
      };
    }
  }

  private truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private async refreshRakutenTrackingStatusesForRows(
    rows: Array<
      Pick<
        RakutenOrderRecord,
        | 'shipmentNo'
        | 'trackingStatusLabel'
        | 'trackingHasCustomsClearance'
        | 'trackingIsDelivered'
        | 'trackingCustomsClearanceDate'
        | 'trackingStatusOccurredAt'
        | 'trackingCheckedAt'
        | 'trackingError'
      >
    >,
    options: { throwOnFetchError?: boolean } = {},
  ): Promise<Map<string, RakutenTrackingClearanceStatus>> {
    const statusByNo = new Map<string, RakutenTrackingClearanceStatus>();
    const rowsByTrackingNo = new Map<string, (typeof rows)[number]>();
    rows.forEach((row) => {
      const trackingNo = String(row.shipmentNo ?? '').trim();
      if (!trackingNo || rowsByTrackingNo.has(trackingNo)) return;
      rowsByTrackingNo.set(trackingNo, row);
      statusByNo.set(
        trackingNo,
        this.deliveredRakutenTrackingStatusCache.get(trackingNo) ??
          this.resolveRakutenTrackingClearanceStatusFromRow(row),
      );
    });

    const trackingNumbersToFetch = Array.from(rowsByTrackingNo.entries())
      .filter(([trackingNo, row]) => {
        if (row.trackingError || !row.trackingHasCustomsClearance || !row.trackingCustomsClearanceDate) return true;
        if (this.isDeliveredRakutenTrackingStatus(this.resolveRakutenTrackingClearanceStatusFromRow(row))) {
          return false;
        }
        return !this.deliveredRakutenTrackingStatusCache.has(trackingNo);
      })
      .map(([trackingNo]) => trackingNo);
    if (!trackingNumbersToFetch.length) {
      return statusByNo;
    }

    const results: Array<readonly [string, RakutenTrackingClearanceStatus]> = [];
    for (let index = 0; index < trackingNumbersToFetch.length; index += UOF_TRACKING_SYNC_BATCH_SIZE) {
      const batch = trackingNumbersToFetch.slice(index, index + UOF_TRACKING_SYNC_BATCH_SIZE);
      const batchResults = await this.mapWithConcurrency(batch, UOF_TRACKING_SYNC_CONCURRENCY, async (trackingNo) => {
        try {
          const status = await this.fetchUofTrackingClearanceStatus(trackingNo);
          await this.persistRakutenTrackingStatus(trackingNo, status);
          if (this.isDeliveredRakutenTrackingStatus(status)) {
            this.deliveredRakutenTrackingStatusCache.set(trackingNo, status);
          }
          return [trackingNo, status] as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : '未知错误';
          const sourceRow = rowsByTrackingNo.get(trackingNo);
          if (options.throwOnFetchError) {
            throw new BadRequestException(`快递单号 ${trackingNo} 状态取得失败：${message}`);
          }
          this.logger.warn(`UOF tracking lookup failed for ${trackingNo}: ${message}`);
          const failedStatus = {
            trackingNo,
            label: sourceRow?.trackingStatusLabel || '状态取得失败',
            hasCustomsClearance: sourceRow?.trackingHasCustomsClearance ?? false,
            isDelivered: sourceRow?.trackingIsDelivered ?? false,
            customsClearanceDate: sourceRow?.trackingCustomsClearanceDate?.toISOString().slice(0, 10) ?? null,
            occurredAt: sourceRow?.trackingStatusOccurredAt?.toISOString() ?? null,
            checkedAt: new Date().toISOString(),
            error: message,
          };
          await this.persistRakutenTrackingStatus(trackingNo, failedStatus);
          return [trackingNo, failedStatus] as const;
        }
      });
      results.push(...batchResults);
    }

    results.forEach(([trackingNo, status]) => {
      statusByNo.set(trackingNo, status);
    });
    return statusByNo;
  }

  private resolveRakutenTrackingClearanceStatusFromRow(
    row: Pick<
      RakutenOrderRecord,
      | 'shipmentNo'
        | 'trackingStatusLabel'
        | 'trackingHasCustomsClearance'
        | 'trackingIsDelivered'
        | 'trackingCustomsClearanceDate'
        | 'trackingStatusOccurredAt'
        | 'trackingCheckedAt'
        | 'trackingError'
    >,
  ): RakutenTrackingClearanceStatus {
    const trackingNo = String(row.shipmentNo ?? '').trim();
    if (!trackingNo) {
      return {
        trackingNo: null,
        label: '无发货单号',
        hasCustomsClearance: false,
        isDelivered: false,
        occurredAt: null,
        checkedAt: null,
        error: null,
      };
    }
    const label = String(row.trackingStatusLabel ?? '').trim();
    return {
      trackingNo,
      label: label || '未取得',
      hasCustomsClearance: Boolean(row.trackingHasCustomsClearance),
      isDelivered: Boolean(row.trackingIsDelivered),
      customsClearanceDate: row.trackingCustomsClearanceDate?.toISOString().slice(0, 10) ?? null,
      occurredAt: row.trackingStatusOccurredAt ? row.trackingStatusOccurredAt.toISOString() : null,
      checkedAt: row.trackingCheckedAt ? row.trackingCheckedAt.toISOString() : null,
      error: String(row.trackingError ?? '').trim() || null,
    };
  }

  private async persistRakutenTrackingStatus(
    trackingNo: string,
    status: RakutenTrackingClearanceStatus,
  ): Promise<void> {
    await this.prisma.rakutenOrderRecord.updateMany({
      where: { deletedAt: null,
        shipmentNo: trackingNo,
        ...this.buildRakutenChinaDispatchWhere(),
      },
      data: {
        trackingStatusLabel: status.label,
        trackingHasCustomsClearance: status.hasCustomsClearance,
        trackingIsDelivered: status.isDelivered,
        trackingStatusOccurredAt: this.parseUofTrackingOccurredAt(status.occurredAt),
        ...(status.customsClearanceDate ? {
          trackingCustomsClearanceDate: new Date(`${status.customsClearanceDate}T00:00:00.000Z`),
        } : {}),
        trackingCheckedAt: new Date(),
        trackingError: status.error ?? null,
      },
    });
  }

  private async acquireRakutenTrackingSyncLock(lockToken: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - RAKUTEN_TRACKING_SYNC_LOCK_STALE_MS);
    const result = await this.prisma.rakutenTrackingSyncLock.updateMany({
      where: {
        id: RAKUTEN_TRACKING_SYNC_LOCK_ID,
        OR: [{ lockToken: null }, { lockedAt: null }, { lockedAt: { lt: staleBefore } }],
      },
      data: { lockToken, lockedAt: new Date() },
    });
    return result.count === 1;
  }

  private startRakutenTrackingSyncLockHeartbeat(lockToken: string): ReturnType<typeof setInterval> {
    return setInterval(() => {
      void this.prisma.rakutenTrackingSyncLock.updateMany({
        where: { id: RAKUTEN_TRACKING_SYNC_LOCK_ID, lockToken },
        data: { lockedAt: new Date() },
      }).catch((error) => {
        this.logger.error(`Rakuten tracking sync lock heartbeat failed: ${String(error)}`);
      });
    }, RAKUTEN_TRACKING_SYNC_LOCK_HEARTBEAT_MS);
  }

  private async releaseRakutenTrackingSyncLock(lockToken: string): Promise<void> {
    await this.prisma.rakutenTrackingSyncLock.updateMany({
      where: { id: RAKUTEN_TRACKING_SYNC_LOCK_ID, lockToken },
      data: { lockToken: null, lockedAt: null },
    });
  }

  private isDeliveredRakutenTrackingStatus(status: RakutenTrackingClearanceStatus): boolean {
    return Boolean(status.isDelivered) || String(status.label ?? '').includes(UOF_TRACKING_DELIVERED_TEXT);
  }

  private parseUofTrackingOccurredAt(value: string | null): Date | null {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const normalized = text.includes('T') ? text : text.replace(' ', 'T');
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = [];
    for (let index = 0; index < items.length; index += concurrency) {
      const chunk = items.slice(index, index + concurrency);
      results.push(...(await Promise.all(chunk.map((item) => mapper(item)))));
    }
    return results;
  }

  private async fetchUofTrackingClearanceStatus(trackingNo: string): Promise<RakutenTrackingClearanceStatus> {
    const config = this.getUofTrackingConfig();
    const body = new URLSearchParams();
    body.set('appToken', config.appToken);
    body.set('appKey', config.appKey);
    body.set('serviceMethod', UOF_TRACKING_SERVICE_METHOD);
    body.set('paramsJson', JSON.stringify({ tracking_number: trackingNo }));

    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(UOF_TRACKING_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error('返回不是有效 JSON');
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('返回格式无效');
    }

    const root = payload as Record<string, unknown>;
    if (Number(root.success) !== 1) {
      throw new Error(String(root.cnmessage ?? root.enmessage ?? '接口返回失败'));
    }

    const shipmentRows = Array.isArray(root.data) ? root.data : [];
    const details = shipmentRows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const rowDetails = (row as Record<string, unknown>).details;
      return Array.isArray(rowDetails) ? rowDetails : [];
    });
    const latestDetail = details.find((detail) => detail && typeof detail === 'object') as
      Record<string, unknown>
      | undefined;
    const latestDescription = latestDetail
      ? String(latestDetail.track_description ?? latestDetail.track_description_en ?? '').trim()
      : '';
    const latestOccurredAt = latestDetail ? String(latestDetail.track_occur_date ?? '').trim() || null : null;
    const clearanceDetail = details.find((detail) => {
      if (!detail || typeof detail !== 'object') return false;
      const row = detail as Record<string, unknown>;
      return [row.track_description, row.track_description_en, row.track_status_cnname]
        .map((value) => String(value ?? ''))
        .some((value) => value.includes(UOF_TRACKING_CUSTOMS_CLEARANCE_TEXT));
    });
    if (clearanceDetail && typeof clearanceDetail === 'object') {
      const detail = clearanceDetail as Record<string, unknown>;
      const isDelivered = latestDescription.includes(UOF_TRACKING_DELIVERED_TEXT);
      return {
        trackingNo,
        label: latestDescription || UOF_TRACKING_CUSTOMS_CLEARANCE_TEXT,
        hasCustomsClearance: true,
        isDelivered,
        occurredAt: latestOccurredAt || String(detail.track_occur_date ?? '').trim() || null,
        customsClearanceDate: this.parseUofCustomsClearanceDate(detail.track_occur_date),
        checkedAt: new Date().toISOString(),
        error: null,
      };
    }

    const isDelivered = latestDescription.includes(UOF_TRACKING_DELIVERED_TEXT);
    return {
      trackingNo,
      label: latestDescription || '未通关许可',
      hasCustomsClearance: false,
      isDelivered,
      occurredAt: latestOccurredAt,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  }

  private parseUofCustomsClearanceDate(value: unknown): string | null {
    // Preserve the calendar date reported by the clearance node, regardless of server timezone.
    const date = String(value ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T]|$)/)?.[1];
    if (!date) return null;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
  }

  private getUofTrackingConfig(): { apiUrl: string; appToken: string; appKey: string;
  } {
    const apiUrl = String(process.env.UOF_TRACKING_API_URL ?? UOF_TRACKING_API_URL).trim();
    const appToken = String(process.env.UOF_TRACKING_APP_TOKEN ?? UOF_TRACKING_DEFAULT_APP_TOKEN).trim();
    const appKey = String(process.env.UOF_TRACKING_APP_KEY ?? UOF_TRACKING_DEFAULT_APP_KEY).trim();
    const missingFields = [
      apiUrl ? null : 'UOF_TRACKING_API_URL',
      appToken ? null : 'UOF_TRACKING_APP_TOKEN',
      appKey ? null : 'UOF_TRACKING_APP_KEY',
    ].filter((item): item is string => Boolean(item));
    if (missingFields.length) {
      throw new InternalServerErrorException(`UOF 快递状态接口配置缺失：${missingFields.join('、')}`);
    }
    return { apiUrl, appToken, appKey };
  }

  private async loadXiyaLogisticsStoreSources(): Promise<Map<string, ThirdPartyExportSource>> {
    const shops = await this.prisma.shop.findMany({
      select: { name: true, platform: true, status: true },
      orderBy: { id: 'asc' },
    });
    const storeSources = new Map<string, ThirdPartyExportSource>();
    for (const shop of shops) {
      const storeName = shop.name.trim();
      if (!storeName || shop.status !== 1) continue;
      const source: ThirdPartyExportSource =
        shop.platform === 'rakuten' ? 'rakuten' : shop.platform === 'amazon' ? 'amazon' : 'manual';
      storeSources.set(storeName, source);
    }

    const activeSources = new Set(storeSources.values());
    const configuredNames = new Set(shops.map((shop) => shop.name.trim()));
    for (const [storeName, source] of Object.entries(XIYA_LEGACY_LOGISTICS_STORE_SOURCE)) {
      if (activeSources.has(source) && !configuredNames.has(storeName)) {
        storeSources.set(storeName, source);
      }
    }
    return storeSources;
  }

  private async fetchXiyaLogisticsRows(
    storeSources: ReadonlyMap<string, ThirdPartyExportSource>,
  ): Promise<XiyaLogisticsRow[]> {
    // An omitted/empty storeName makes Xiya query its default shop, so skip when none are enabled.
    if (!storeSources.size) return [];
    const url = new URL(XIYA_LOGISTICS_EXPORT_URL);
    url.searchParams.set('company_name', XIYA_COMPANY_NAME);
    url.searchParams.set('storeName', Array.from(storeSources.keys()).join(','));
    url.searchParams.set('days', String(XIYA_LOGISTICS_SYNC_DAYS));

    let payload: unknown;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': XIYA_LOGISTICS_API_KEY,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new InternalServerErrorException(`Xiya 运单号接口请求失败：HTTP ${response.status}`);
      }
      payload = await response.json();
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `Xiya 运单号接口请求失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }

    if (!payload || typeof payload !== 'object') {
      throw new InternalServerErrorException('Xiya 运单号接口返回格式无效');
    }
    const root = payload as Record<string, unknown>;
    if (!XIYA_SUCCESS_CODES.has(Number(root.code))) {
      throw new InternalServerErrorException(`Xiya 运单号接口返回失败：${String(root.message ?? '未知错误')}`);
    }
    const data = root.data;
    if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).rows)) {
      throw new InternalServerErrorException('Xiya 运单号接口缺少 data.rows 字段');
    }
    return (data as Record<string, unknown>).rows as XiyaLogisticsRow[];
  }

  private normalizeXiyaTrackingCandidates(
    rows: XiyaLogisticsRow[],
    storeSources: ReadonlyMap<string, ThirdPartyExportSource>,
  ): XiyaTrackingCandidate[] {
    return rows
      .map((row) => {
        const storeName = String(row?.store_name ?? '').trim();
        const source = storeSources.get(storeName);
        const orderId = String(row?.sales_order_id ?? '').trim();
        const trackingNo = String(row?.logistics_order_id || row?.tracking_number || '').trim();
        if (!source || !orderId || !trackingNo) {
          return null;
        }
        const shipmentCompany = this.resolveXiyaShipmentCompany(row);
        const registeredAt = this.parseXiyaLogisticsDate(row?.created_at);
        return {
          source,
          orderId,
          trackingNo,
          storeName,
          shipmentCompany,
          registeredAt,
          rowCreatedAtMs: registeredAt.getTime(),
        };
      })
      .filter((item): item is XiyaTrackingCandidate => Boolean(item));
  }

  private deduplicateXiyaTrackingCandidates(candidates: XiyaTrackingCandidate[]): XiyaTrackingCandidate[] {
    const candidateByKey = new Map<string, XiyaTrackingCandidate>();
    candidates.forEach((candidate) => {
      const key = `${candidate.source}:${candidate.orderId}`;
      const current = candidateByKey.get(key);
      if (!current || candidate.rowCreatedAtMs >= current.rowCreatedAtMs) {
        candidateByKey.set(key, candidate);
      }
    });
    return Array.from(candidateByKey.values());
  }

  private parseXiyaLogisticsDate(value: unknown): Date {
    const text = String(value ?? '').trim();
    const parsed = text ? new Date(text) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  }

  private resolveXiyaShipmentCompany(row: XiyaLogisticsRow): string {
    const methodName = String(
      row?.['运输方式名称'] ??
        row?.shipping_method ??
        row?.shipping_method_name ??
        row?.delivery_method_name ??
        row?.logistics_method_name ??
        row?.transport_method_name ??
        '',
    )
      .trim()
      .toUpperCase();
    if (methodName === 'SAGAWA-01') {
      return 'Xiya-SAGAWA';
    }
    if (methodName === 'YAMATO-01') {
      return 'Xiya-YAMATO';
    }
    return 'Xiya';
  }

  private async applyXiyaTrackingCandidates(
    source: ThirdPartyExportSource,
    candidates: XiyaTrackingCandidate[],
  ): Promise<{ updatedCount: number; skippedUnmatchedCount: number }> {
    if (!candidates.length) {
      return { updatedCount: 0, skippedUnmatchedCount: 0 };
    }

    const candidateByOrderId = new Map(candidates.map((candidate) => [candidate.orderId, candidate]));
    const orderIds = Array.from(candidateByOrderId.keys());
    const rows =
      source === 'rakuten'
        ? await this.prisma.rakutenOrderRecord.findMany({
            where: { deletedAt: null,
              orderId: { in: orderIds },
              sendStatus: OrderSendStatus.unsent,
              OR: [{ shipmentNo: null }, { shipmentNo: '' }],
            },
          })
        : source === 'amazon'
          ? await this.prisma.amazonOrderRecord.findMany({
              where: {
                ...PROCESSABLE_AMAZON_ORDER_WHERE,
                orderId: { in: orderIds },
                OR: [{ shipmentNo: null }, { shipmentNo: '' }],
              },
            })
          : await (this.prisma as any).manualOrderRecord.findMany({
              where: {
                orderId: { in: orderIds },
                OR: [{ shipmentNo: null }, { shipmentNo: '' }],
              },
            });

    if (!rows.length) {
      return { updatedCount: 0, skippedUnmatchedCount: candidates.length };
    }

    const enrichedRows =
      source === 'rakuten'
        ? await this.enrichOrderRows(rows as RakutenOrderRecord[])
        : source === 'amazon'
          ? await this.enrichAmazonOrderRows(rows as AmazonOrderRecord[])
          : await this.enrichManualOrderRows(rows as ManualOrderRecordLike[]);

    const activePickedRefs = await this.loadActiveOverseasPickingBatchRefs(
      enrichedRows.map((row) => ({
        source,
        sourceRecordId: row.id,
      })),
    );

    const eligibleRows = enrichedRows
      .filter((row) =>
        this.shouldExportOrderToThirdParty(source, row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs),
      );
    const eligibleRowsByOrderId = new Map<string, typeof eligibleRows>();
    eligibleRows.forEach((row) => {
      const orderId = String(row.orderId ?? '').trim();
      if (!orderId) return;
      eligibleRowsByOrderId.set(orderId, [...(eligibleRowsByOrderId.get(orderId) ?? []), row]);
    });

    let updatedCount = 0;
    const updatedManualIds: bigint[] = [];
    for (const [orderId, candidate] of candidateByOrderId.entries()) {
      const targetRows = eligibleRowsByOrderId.get(orderId) ?? [];
      const scopedTargetRows = targetRows;
      if (!scopedTargetRows.length) {
        continue;
      }
      const ids = scopedTargetRows.map((row) => row.id);
      const updateResult =
        source === 'rakuten'
          ? await this.prisma.rakutenOrderRecord.updateMany({
              where: { deletedAt: null,
                id: { in: ids },
                sendStatus: OrderSendStatus.unsent,
                OR: [{ shipmentNo: null }, { shipmentNo: '' }],
              },
              data: {
                shipmentCompany: candidate.shipmentCompany,
                shipmentNo: candidate.trackingNo,
                shipmentNoRegisteredAt: candidate.registeredAt,
                sendStatus: OrderSendStatus.sent,
              },
            })
          : source === 'amazon'
            ? await this.prisma.amazonOrderRecord.updateMany({
                where: {
                  id: { in: ids },
                  OR: [{ shipmentNo: null }, { shipmentNo: '' }],
                },
                data: {
                  shipmentCompany: candidate.shipmentCompany,
                  shipmentNo: candidate.trackingNo,
                  shipmentNoRegisteredAt: candidate.registeredAt,
                },
              })
            : await (this.prisma as any).manualOrderRecord.updateMany({
                where: {
                  id: { in: ids },
                  OR: [{ shipmentNo: null }, { shipmentNo: '' }],
                },
                data: {
                  shipmentCompany: candidate.shipmentCompany,
                  shipmentNo: candidate.trackingNo,
                  shipmentNoRegisteredAt: candidate.registeredAt,
                },
              });
      updatedCount += Number(updateResult.count ?? 0);
      if (source === 'manual' && Number(updateResult.count ?? 0) > 0) {
        updatedManualIds.push(...ids);
      }
    }

    if (source === 'manual') {
      await this.syncManualOrderIdsToXyjgBestEffort(updatedManualIds);
    }
    const matchedOrderIds = new Set(eligibleRows.map((row) => String(row.orderId ?? '').trim()).filter(Boolean));
    return {
      updatedCount,
      skippedUnmatchedCount: candidates.filter((candidate) => !matchedOrderIds.has(candidate.orderId)).length,
    };
  }

  private async loadProductStockAvailability(productIdsRaw: string[]): Promise<
    Map<
      string,
      {
        productName: string | null;
        finishedStock: number;
        assemblableStock: number;
        assemblableStockApplicable: boolean;
        fulfillableStock: number;
      }
    >
  > {
    const productIds = Array.from(
      new Set(productIdsRaw.map((value) => String(value ?? '').trim()).filter(Boolean)),
    );
    if (!productIds.length) return new Map();

    const rows = await this.prisma.masterProduct.findMany({
      where: { productId: { in: productIds } },
      select: {
        productId: true,
        productName: true,
        productType: true,
        stockQty: true,
        boxInventories: { select: { qty: true } },
        bomComponents: {
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: {
            componentProductId: true,
            quantity: true,
            componentProduct: {
              select: {
                stockQty: true,
                status: true,
                productType: true,
                boxInventories: { select: { qty: true } },
              },
            },
          },
        },
      },
    });

    const stockIds = [...new Set(rows.flatMap((row) => [
      row.productId,
      ...(row.bomComponents ?? []).map((item) => item.componentProductId),
    ]))];
    const stockRows = await availableStock(this.prisma, stockIds);
    const stockByProductId = new Map<string, Array<{ qty: number }>>();
    stockRows.forEach((row) => {
      const locations = stockByProductId.get(row.productId) ?? [];
      locations.push({ qty: row.qty });
      stockByProductId.set(row.productId, locations);
    });

    return new Map(
      rows.map((row) => {
        const availability = calculateProductStockAvailability({
          ...row,
          boxInventories: stockByProductId.get(row.productId) ?? [],
          bomComponents: (row.bomComponents ?? []).map((item) => ({
            ...item,
            componentProduct: {
              ...item.componentProduct,
              boxInventories: stockByProductId.get(item.componentProductId) ?? [],
            },
          })),
        });
        return [
          String(row.productId ?? '').trim(),
          {
            productName: row.productName ?? null,
            finishedStock: availability.finishedStock,
            assemblableStock: availability.assemblableStock ?? 0,
            assemblableStockApplicable: String(row.productType ?? '').trim() === '肩带',
            fulfillableStock: availability.fulfillableStock,
          },
        ] as const;
      }),
    );
  }

  private async enrichOrderRows(rows: RakutenOrderRecord[]): Promise<OrderListItem[]> {
    if (!rows.length) {
      return [];
    }

    const lookupProductIds = Array.from(
      new Set(
        rows
          .flatMap((row) => [row.skuCode, row.setComponentSkuCode])
          .map((value) => String(value ?? '').trim())
          .filter((value) => value.length > 0),
      ),
    );

    if (!lookupProductIds.length) {
      return rows.map((row) => ({
        ...row,
        resolvedProductId: null,
        resolvedProductName: null,
        availableStock: 0,
        assemblableStock: 0,
        assemblableStockApplicable: false,
        fulfillmentMode: this.resolveFulfillmentModeFromDispatchMode(row.dispatchMode, 0),
      }));
    }

    const availabilityByProductId = await this.loadProductStockAvailability(lookupProductIds);

    return rows.map((row) => {
      const productId =
        String(row.skuCode ?? '').trim() ||
        String(row.setComponentSkuCode ?? '').trim() ||
        null;
      const availability = productId ? availabilityByProductId.get(productId) : null;
      const availableStock = availability?.finishedStock ?? 0;
      const assemblableStock = availability?.assemblableStock ?? 0;

      return {
        ...row,
        resolvedProductId: productId,
        resolvedProductName: availability?.productName ?? null,
        availableStock,
        assemblableStock,
        assemblableStockApplicable: availability?.assemblableStockApplicable ?? false,
        fulfillmentMode: this.resolveFulfillmentModeFromDispatchMode(
          row.dispatchMode,
          availableStock + assemblableStock,
        ),
      };
    });
  }

  private async enrichAmazonOrderRows(
    rows: AmazonOrderRecord[],
    options: { includeRelatedRows?: boolean } = {},
  ): Promise<AmazonEnrichedOrderListItem[]> {
    if (!rows.length) {
      return [];
    }

    const relatedRows = options.includeRelatedRows === false ? rows : await this.loadRelatedAmazonOrderRows(rows);
    const observationOrderIds = this.extractNonEmptyOrderIds(relatedRows);
    const observations = observationOrderIds.length
      ? await this.prisma.amazonOrderSyncObservation.findMany({
          where: { orderId: { in: observationOrderIds } },
          orderBy: { observedAt: 'desc' },
        })
      : [];
    const productIdOverrideByRowId = new Map(
      relatedRows.map((row) => [row.id.toString(), this.getJsonObjectString(row.rawPayload, '产品ID')] as const),
    );
    const lookupCodes = Array.from(
      new Set(
        relatedRows
          .map((row) => String(row.sku ?? '').trim())
          .filter((value) => value.length > 0)),
    );

    const skuRows = lookupCodes.length
      ? await this.prisma.sku.findMany({
          where: {
            status: 1,
            productId: { not: null },
            OR: [{ sku: { in: lookupCodes } }, { rbSku: { in: lookupCodes } }, { fbmSku: { in: lookupCodes } }],
          },
          select: {
            sku: true,
            rbSku: true,
            fbmSku: true,
            productId: true,
            shop: true,
          },
        })
      : [];

    const skuMetaByCode = new Map<string, { productId: string | null; shopName: string | null }>();
    const normalizedSkuMetaByCode = new Map<string, { productId: string | null; shopName: string | null }>();
    skuRows.forEach((row) => {
      const meta = {
        productId: String(row.productId ?? '').trim() || null,
        shopName: String(row.shop ?? '').trim() || null,
      };
      [row.rbSku, row.fbmSku, row.sku].forEach((candidate) => {
        const key = String(candidate ?? '').trim();
        if (key && !skuMetaByCode.has(key)) {
          skuMetaByCode.set(key, meta);
        }
        const normalizedKey = normalizeAmazonSkuLookupKey(candidate);
        if (!normalizedKey || normalizedSkuMetaByCode.has(normalizedKey)) return;
        normalizedSkuMetaByCode.set(normalizedKey, meta);
      });
    });

    const productIds = Array.from(
      new Set(
        [
          ...skuRows.map((row) => String(row.productId ?? '').trim()),
          ...Array.from(productIdOverrideByRowId.values()),
        ]
          .filter((value) => value.length > 0),
      ),
    );

    const availabilityByProductId = await this.loadProductStockAvailability(productIds);
    const resolveProductId = (row: AmazonOrderRecord): string | null => {
      const skuCode = String(row.sku ?? '').trim();
      const skuMeta =
        skuMetaByCode.get(skuCode) ??
        normalizedSkuMetaByCode.get(normalizeAmazonSkuLookupKey(skuCode)) ??
        null;
      return productIdOverrideByRowId.get(row.id.toString()) || skuMeta?.productId || null;
    };
    const chinaFulfillmentOrderIds = this.resolveChinaFulfillmentOrderIds(
      relatedRows.map((row) => {
        const productId = resolveProductId(row);
        return {
          orderId: row.orderId,
          dispatchMode: this.resolveEffectiveAmazonDispatchMode(row),
          availableStock: productId
            ? (availabilityByProductId.get(productId)?.fulfillableStock ?? 0)
            : 0,
          requestedQty: Number(row.quantityPurchased ?? 1),
        };
      }),
    );

    return rows.map((row) => {
      const skuCode = String(row.sku ?? '').trim();
      const skuMeta =
        skuMetaByCode.get(skuCode) ??
        normalizedSkuMetaByCode.get(normalizeAmazonSkuLookupKey(skuCode)) ??
        null;
      const productId = resolveProductId(row);
      const availability = productId ? availabilityByProductId.get(productId) : null;
      const availableStock = availability?.finishedStock ?? 0;
      const assemblableStock = availability?.assemblableStock ?? 0;
      const orderId = String(row.orderId ?? '').trim();
      const effectiveDispatchMode = this.resolveEffectiveAmazonDispatchMode(row);
      const isChinaFulfillment =
        this.isChinaDispatchMode(effectiveDispatchMode) ||
        (orderId
          ? chinaFulfillmentOrderIds.has(orderId)
          : availableStock + assemblableStock < Math.max(1, Number(row.quantityPurchased ?? 1)));
      const originalItemId = this.resolveOriginalAmazonOrderItemId(row.rawPayload, row.orderItemId);
      const observation = observations.find((item) =>
        item.orderId === orderId &&
        item.orderItemId === originalItemId &&
        (!row.spApiConnectionId || item.spApiConnectionId === row.spApiConnectionId),
      );
      const observedStatus = observation?.orderStatus ?? null;
      const amazonStateMismatch = Boolean(
        observation?.freezeReason &&
        ((observedStatus && observedStatus !== String(row.orderStatus ?? '').trim()) ||
          (observation.quantityToShip !== null && observation.quantityToShip !== row.quantityToShip)),
      );

      return {
        ...row,
        shippingOrigin: isChinaFulfillment ? '中国発' : this.resolveAmazonShippingOriginFromDispatchMode(OVERSEAS_DISPATCH_MODE.OVERSEAS),
        resolvedProductId: productId,
        resolvedProductName: availability?.productName ?? null,
        resolvedShopName: skuMeta?.shopName ?? null,
        availableStock,
        assemblableStock,
        assemblableStockApplicable: availability?.assemblableStockApplicable ?? false,
        fulfillmentMode: isChinaFulfillment ? 'xiya_api' : 'overseas_warehouse',
        amazonObservedOrderStatus: observedStatus,
        amazonObservedQuantityToShip: observation?.quantityToShip ?? null,
        amazonObservedAt: observation?.observedAt ?? null,
        amazonFreezeReason: observation?.freezeReason ?? null,
        amazonStateMismatch,
      };
    });
  }

  private async enrichManualOrderRows(rows: ManualOrderRecordLike[]): Promise<ManualEnrichedOrderListItem[]> {
    const enriched = await this.enrichAmazonOrderRows(rows as unknown as AmazonOrderRecord[], {
      includeRelatedRows: false,
    });
    return enriched as unknown as ManualEnrichedOrderListItem[];
  }

  private async loadRelatedAmazonOrderRows(rows: AmazonOrderRecord[]): Promise<AmazonOrderRecord[]> {
    const orderIds = this.extractNonEmptyOrderIds(rows);
    if (!orderIds.length) {
      return rows;
    }
    const relatedRows = await this.prisma.amazonOrderRecord.findMany({
      where: {
        ...PROCESSABLE_AMAZON_ORDER_WHERE,
        orderId: { in: orderIds },
      },
    });
    return this.mergeRowsById(rows, relatedRows);
  }

  private extractNonEmptyOrderIds(rows: Array<{ orderId: string | null }>): string[] {
    return Array.from(
      new Set(
        rows
          .map((row) => String(row.orderId ?? '').trim())
          .filter((orderId) => orderId.length > 0)),
    );
  }

  private mergeRowsById<Row extends { id: bigint }>(primaryRows: Row[], relatedRows: Row[]): Row[] {
    const rowsById = new Map<string, Row>();
    [...primaryRows, ...relatedRows].forEach((row) => {
      rowsById.set(row.id.toString(), row);
    });
    return Array.from(rowsById.values());
  }

  private resolveChinaFulfillmentOrderIds(
    rows: Array<{ orderId: string | null; dispatchMode?: string | null; availableStock: number; requestedQty?: number;
    }>,
  ): Set<string> {
    const orderIds = new Set<string>();
    rows.forEach((row) => {
      const orderId = String(row.orderId ?? '').trim();
      if (!orderId) {
        return;
      }
      const dispatchMode = String(row.dispatchMode ?? '').trim();
      if (this.isChinaDispatchMode(dispatchMode)) {
        orderIds.add(orderId);
        return;
      }
      if (dispatchMode === OVERSEAS_DISPATCH_MODE.OVERSEAS) {
        return;
      }
      const requestedQty = Math.max(1, Number(row.requestedQty ?? 1));
      if (Number(row.availableStock ?? 0) < requestedQty) {
        orderIds.add(orderId);
      }
    });
    return orderIds;
  }

  private async importAmazonTxtBuffer(
    fileBuffer: Buffer,
    sourceFileName: string,
    sourceFilePath: string,
  ): Promise<AmazonOrderImportResult> {
    const parsedRows = this.parseAmazonTxt(fileBuffer);
    const uniqueRowsMap = new Map<string, ParsedAmazonOrderRow>();
    for (const row of parsedRows) {
      if (!uniqueRowsMap.has(row.rowHash)) {
        uniqueRowsMap.set(row.rowHash, row);
      }
    }

    const uniqueRows = Array.from(uniqueRowsMap.values());
    const importOrderIds = Array.from(
      new Set(
        uniqueRows
          .map((row) => String(row.orderId ?? '').trim())
          .filter((orderId) => orderId.length > 0)),
    );
    const existingOrderIds = new Set<string>();
    if (importOrderIds.length) {
      const existingRows = await this.prisma.amazonOrderRecord.findMany({
        where: {
          ...PROCESSABLE_AMAZON_ORDER_WHERE,
          orderId: {
            in: importOrderIds,
          },
        },
        select: {
          orderId: true,
        },
      });
      for (const row of existingRows) {
        const orderId = String(row.orderId ?? '').trim();
        if (orderId) {
          existingOrderIds.add(orderId);
        }
      }
    }
    const rowsToCreate = uniqueRows.filter((row) => {
      const orderId = String(row.orderId ?? '').trim();
      return !orderId || !existingOrderIds.has(orderId);
    });
    const skuRows = await this.prisma.sku.findMany({
      where: {
        status: 1,
        productId: { not: null },
      },
      select: {
        sku: true,
        rbSku: true,
        fbmSku: true,
        productId: true,
        shop: true,
      },
    });

    const skuMetaByCode = new Map<string, { productId: string | null; shopName: string | null }>();
    const normalizedSkuMetaByCode = new Map<string, { productId: string | null; shopName: string | null }>();
    skuRows.forEach((row) => {
      const meta = {
        productId: String(row.productId ?? '').trim() || null,
        shopName: String(row.shop ?? '').trim() || null,
      };
      [row.rbSku, row.fbmSku, row.sku].forEach((candidate) => {
        const key = String(candidate ?? '').trim();
        if (key && !skuMetaByCode.has(key)) {
          skuMetaByCode.set(key, meta);
        }
        const normalizedKey = normalizeAmazonSkuLookupKey(candidate);
        if (!normalizedKey || normalizedSkuMetaByCode.has(normalizedKey)) return;
        normalizedSkuMetaByCode.set(normalizedKey, meta);
      });
    });

    const resolveSkuMeta = (skuCode: string | null) => {
      const rawCode = String(skuCode ?? '').trim();
      if (!rawCode) return null;
      return skuMetaByCode.get(rawCode) ??
        normalizedSkuMetaByCode.get(normalizeAmazonSkuLookupKey(rawCode)) ??
        null;
    };

    const productIds = Array.from(
      new Set(
        rowsToCreate
          .map((row) => resolveSkuMeta(row.sku)?.productId)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const availabilityByProductId = await this.loadProductStockAvailability(productIds);
    const chinaFulfillmentOrderIds = this.resolveChinaFulfillmentOrderIds(
      rowsToCreate.map((row) => {
        const productId = resolveSkuMeta(row.sku)?.productId;
        return {
          orderId: row.orderId,
          availableStock: productId
            ? (availabilityByProductId.get(productId)?.fulfillableStock ?? 0)
            : 0,
          requestedQty: Number(row.quantityPurchased ?? 1),
        };
      }),
    );
    const importedAt = new Date();
    const createManyInput: Prisma.AmazonOrderRecordCreateManyInput[] = rowsToCreate.map((row) => {
      const dispatchMode = (() => {
        const productId = resolveSkuMeta(row.sku)?.productId;
        const fulfillableStock = productId
          ? (availabilityByProductId.get(productId)?.fulfillableStock ?? 0)
          : 0;
        const orderId = String(row.orderId ?? '').trim();
        return (orderId
          ? chinaFulfillmentOrderIds.has(orderId)
          : fulfillableStock < Math.max(1, Number(row.quantityPurchased ?? 1)))
          ? OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK
          : OVERSEAS_DISPATCH_MODE.OVERSEAS;
      })();
      return {
        shippingOrigin: this.resolveAmazonShippingOriginFromDispatchMode(dispatchMode),
        rowHash: row.rowHash,
        orderId: row.orderId,
        orderItemId: row.orderItemId,
        purchaseDateRaw: row.purchaseDateRaw,
        paymentsDateRaw: row.paymentsDateRaw,
        reportingDateRaw: row.reportingDateRaw,
        promiseDateRaw: row.promiseDateRaw,
        daysPastPromise: row.daysPastPromise,
        buyerEmail: row.buyerEmail,
        buyerName: row.buyerName,
        buyerPhoneNumber: row.buyerPhoneNumber,
        sku: row.sku,
        productName: row.productName,
        quantityPurchased: row.quantityPurchased,
        quantityShipped: row.quantityShipped,
        quantityToShip: row.quantityToShip,
        shipServiceLevel: row.shipServiceLevel,
        recipientName: row.recipientName,
        shipAddress1: row.shipAddress1,
        shipAddress2: row.shipAddress2,
        shipAddress3: row.shipAddress3,
        shipCity: row.shipCity,
        shipState: row.shipState,
        shipPostalCode: row.shipPostalCode,
        shipCountry: row.shipCountry,
        customizedUrl: row.customizedUrl,
        customizedPage: row.customizedPage,
        isBusinessOrder: row.isBusinessOrder,
        purchaseOrderNumber: row.purchaseOrderNumber,
        priceDesignation: row.priceDesignation,
        vergeOfCancellation: row.vergeOfCancellation,
        vergeOfLateShipment: row.vergeOfLateShipment,
        mallName: row.mallName,
        shopName: row.shopName,
        shipmentCompany: row.shipmentCompany,
        shipmentNo: row.shipmentNo,
        shipmentNoRegisteredAt: row.shipmentNoRegisteredAt,
        dispatchMode,
        sourceFileName,
        sourceFilePath,
        rawPayload: row.rawPayload,
        csvImportedAt: importedAt,
      };
    });

    const result = createManyInput.length
      ? await this.prisma.amazonOrderRecord.createMany({
          data: createManyInput,
          skipDuplicates: true,
        })
      : { count: 0 };

    const duplicateInFileCount = parsedRows.length - uniqueRows.length;
    const existingOrderDuplicateCount = uniqueRows.length - rowsToCreate.length;
    const existingRowDuplicateCount = rowsToCreate.length - result.count;
    const existingDuplicateCount = existingOrderDuplicateCount + existingRowDuplicateCount;

    return {
      sourceFileName,
      sourceFilePath,
      csvImportedAt: importedAt.toISOString(),
      totalRows: parsedRows.length,
      uniqueRows: uniqueRows.length,
      createdCount: result.count,
      skippedCount: parsedRows.length - result.count,
      duplicateInFileCount,
      existingDuplicateCount,
    };
  }

  private parseAmazonTxt(fileBuffer: Buffer): ParsedAmazonOrderRow[] {
    const content = this.decodeAmazonTxtContent(fileBuffer);
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.replace(/\r/g, ''))
      .filter((line) => line.trim().length > 0);

    if (lines.length <= 1) {
      throw new BadRequestException('亚马逊订单TXT缺少数据行');
    }

    const headerRow = lines[0].split('\t').map((cell) => cell.trim());
    const headerIndexMap = new Map<string, number>();
    headerRow.forEach((header, index) => {
      if (header) {
        headerIndexMap.set(header, index);
      }
    });

    const missingHeaders = AMAZON_ORDER_TXT_COLUMNS.map((column) => column.header).filter(
      (header) => !OPTIONAL_AMAZON_ORDER_TXT_HEADERS.has(header) && !headerIndexMap.has(header),
    );
    if (missingHeaders.length) {
      throw new BadRequestException(`亚马逊订单TXT缺少列：${missingHeaders.join('、')}`);
    }

    const parsedRows: ParsedAmazonOrderRow[] = [];
    for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
      const sourceRow = lines[rowIndex].split('\t');
      const rawPayload = {} as Record<AmazonOrderTxtHeader, string | null>;
      for (const column of AMAZON_ORDER_TXT_COLUMNS) {
        const cellIndex = headerIndexMap.get(column.header);
        rawPayload[column.header] =
          cellIndex === undefined ? null : this.normalizeCellValue(sourceRow[cellIndex]);
      }

      const hasAnyValue = Object.values(rawPayload).some((value) => Boolean(value));
      if (!hasAnyValue) {
        continue;
      }

      const parsedRowWithoutHash = {
        orderId: rawPayload['order-id'],
        orderItemId: rawPayload['order-item-id'],
        purchaseDateRaw: rawPayload['purchase-date'],
        paymentsDateRaw: rawPayload['payments-date'],
        reportingDateRaw: rawPayload['reporting-date'],
        promiseDateRaw: rawPayload['promise-date'],
        daysPastPromise: this.parseQuantity(rawPayload['days-past-promise']),
        buyerEmail: rawPayload['buyer-email'],
        buyerName: rawPayload['buyer-name'],
        buyerPhoneNumber: rawPayload['buyer-phone-number'],
        sku: rawPayload['sku'],
        productName: rawPayload['product-name'],
        quantityPurchased: this.parseQuantity(rawPayload['quantity-purchased']),
        quantityShipped: this.parseQuantity(rawPayload['quantity-shipped']),
        quantityToShip: this.parseQuantity(rawPayload['quantity-to-ship']),
        shipServiceLevel: rawPayload['ship-service-level'],
        recipientName: rawPayload['recipient-name'],
        shipAddress1: rawPayload['ship-address-1'],
        shipAddress2: rawPayload['ship-address-2'],
        shipAddress3: rawPayload['ship-address-3'],
        shipCity: rawPayload['ship-city'],
        shipState: rawPayload['ship-state'],
        shipPostalCode: rawPayload['ship-postal-code'],
        shipCountry: rawPayload['ship-country'],
        customizedUrl: rawPayload['customized-url'],
        customizedPage: rawPayload['customized-page'],
        isBusinessOrder: this.parseBoolean(rawPayload['is-business-order']),
        purchaseOrderNumber: rawPayload['purchase-order-number'],
        priceDesignation: rawPayload['price-designation'],
        vergeOfCancellation: this.parseBoolean(rawPayload['verge-of-cancellation']),
        vergeOfLateShipment: this.parseBoolean(rawPayload['verge-of-lateShipment']),
        mallName: 'Amazon',
        shopName: null,
        shipmentCompany: null,
        shipmentNo: null,
        shipmentNoRegisteredAt: null,
        rawPayload,
      };

      parsedRows.push({
        ...parsedRowWithoutHash,
        rowHash: this.buildAmazonRowHash(parsedRowWithoutHash),
      });
    }

    if (!parsedRows.length) {
      throw new BadRequestException('亚马逊订单TXT缺少有效数据');
    }

    return parsedRows;
  }

  private decodeAmazonTxtContent(fileBuffer: Buffer): string {
    const evaluated = AMAZON_TXT_ENCODING_CANDIDATES.map((encoding, index) => {
      const content = this.decodeTextBuffer(fileBuffer, encoding).replace(/^\uFEFF/, '');
      return {
        encoding,
        content,
        score: this.scoreAmazonTxtDecodedContent(content) - index,
      };
    }).sort((left, right) => right.score - left.score);

    const best = evaluated[0];
    if (!best || best.score < 0) {
      throw new BadRequestException('亚马逊订单TXT编码无法识别，请保存为 UTF-8 或 Shift_JIS 后重试');
    }
    return best.content;
  }

  private decodeTextBuffer(fileBuffer: Buffer, encoding: AmazonTxtEncodingCandidate): string {
    if (encoding === 'utf8') {
      return fileBuffer.toString('utf8');
    }
    return iconv.decode(fileBuffer, encoding);
  }

  private scoreAmazonTxtDecodedContent(content: string): number {
    if (!content.trim()) return -1_000_000;

    const lines = content
      .split(/\r?\n/)
      .map((line) => line.replace(/\r/g, ''))
      .filter((line) => line.trim().length > 0);
    if (lines.length <= 1) return -100_000;

    const headerRow = lines[0].split('\t').map((cell) => cell.trim());
    const headerSet = new Set(headerRow);
    const missingHeaders = AMAZON_ORDER_TXT_COLUMNS.filter(
      (column) => !OPTIONAL_AMAZON_ORDER_TXT_HEADERS.has(column.header) && !headerSet.has(column.header),
    ).length;
    if (missingHeaders > 0) {
      return -50_000 - missingHeaders * 100;
    }

    const sample = lines.slice(1, 21).join('\n');
    const replacementCount = (sample.match(/\uFFFD/g) || []).length;
    const controlCount = (sample.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length;
    const cjkCount = (sample.match(/[\u3040-\u30FF\u3400-\u9FFF]/g) || []).length;
    const extendedLatinCount = (sample.match(/[\u00C0-\u024F]/g) || []).length;

    return 10_000 + cjkCount * 4 - replacementCount * 500 - controlCount * 100 - extendedLatinCount * 3;
  }

  private normalizeCellValue(value: string | number | boolean | null | undefined): string | null {
    const normalized = String(value ?? '')
      .replace(/\uFEFF/g, '')
      .replace(/\r?\n/g, ' ')
      .trim();
    return normalized ? normalized : null;
  }

  private parseQuantity(value: string | null): number | null {
    if (!value) {
      return null;
    }
    const normalized = value.replaceAll(',', '').trim();
    if (!normalized) {
      return null;
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return Math.trunc(parsed);
  }

  private parseBoolean(value: string | null): boolean | null {
    if (!value) {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    if (['true', '1', 'yes'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no'].includes(normalized)) {
      return false;
    }
    return null;
  }

  private normalizeEditableText(
    value: string | number | null | undefined,
    fieldName: string,
    maxLength: number,
  ): string | null {
    const text = String(value ?? '').trim();
    if (!text) {
      return null;
    }
    if (text.length > maxLength) {
      throw new BadRequestException(`${fieldName}不能超过 ${maxLength} 个字符`);
    }
    return text;
  }

  private normalizeEditablePositiveInt(
    value: string | number | null | undefined,
    fieldName: string): number | null {
    const text = String(value ?? '').trim();
    if (!text) {
      return null;
    }
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${fieldName}必须是大于 0 的整数`);
    }
    return parsed;
  }

  private requireEditableText(
    value: string | number | null | undefined,
    fieldName: string,
    maxLength: number): string {
    const text = this.normalizeEditableText(value, fieldName, maxLength);
    if (!text) {
      throw new BadRequestException(`${fieldName}不能为空`);
    }
    return text;
  }

  private requireEditablePositiveInt(value: string | number | null | undefined, fieldName: string): number {
    const parsed = this.normalizeEditablePositiveInt(value, fieldName);
    if (parsed === null) {
      throw new BadRequestException(`${fieldName}不能为空`);
    }
    return parsed;
  }

  private async resolveDispatchModeForProductId(
    productIdRaw: string | null,
    requestedQtyRaw: number = 1,
  ): Promise<string> {
    const productId = String(productIdRaw ?? '').trim();
    if (!productId) {
      return OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK;
    }
    const availability = (await this.loadProductStockAvailability([productId])).get(productId);
    const requestedQty = Math.max(1, Number(requestedQtyRaw ?? 1));
    return Number(availability?.fulfillableStock ?? 0) >= requestedQty
      ? OVERSEAS_DISPATCH_MODE.OVERSEAS
      : OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK;
  }

  private isChinaDispatchMode(dispatchModeRaw: string | null | undefined): boolean {
    const dispatchMode = String(dispatchModeRaw ?? '').trim();
    return (
      dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING ||
      dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK
    );
  }

  private resolveFulfillmentModeFromDispatchMode(
    dispatchModeRaw: string | null | undefined,
    availableStock: number,
  ): OrderFulfillmentMode {
    const dispatchMode = String(dispatchModeRaw ?? '').trim();
    if (dispatchMode === OVERSEAS_DISPATCH_MODE.OVERSEAS) {
      return 'overseas_warehouse';
    }
    if (this.isChinaDispatchMode(dispatchMode)) {
      return 'xiya_api';
    }
    return Number(availableStock ?? 0) > 0 ? 'overseas_warehouse' : 'xiya_api';
  }

  private async resolveAmazonProductIdForSku(sku: string | null): Promise<string | null> {
    const rawCode = String(sku ?? '').trim();
    if (!rawCode) {
      return null;
    }
    const skuRows = await this.prisma.sku.findMany({
      where: {
        status: 1,
        productId: { not: null },
        OR: [{ sku: rawCode }, { rbSku: rawCode }, { fbmSku: rawCode }],
      },
      select: {
        sku: true,
        rbSku: true,
        fbmSku: true,
        productId: true,
      },
    });
    const exactMatch =
      skuRows.find((row) => [row.sku, row.rbSku, row.fbmSku].some((value) => String(value ?? '').trim() === rawCode)) ??
      skuRows.find((row) =>
        [row.sku, row.rbSku, row.fbmSku].some(
          (value) => normalizeAmazonSkuLookupKey(value) === normalizeAmazonSkuLookupKey(rawCode),
        ),
      );
    return String(exactMatch?.productId ?? '').trim() || null;
  }

  private resolveAmazonShippingOriginFromDispatchMode(dispatchMode: string | null): string | null {
    if (dispatchMode === OVERSEAS_DISPATCH_MODE.OVERSEAS) {
      return '日本発';
    }
    if (this.isChinaDispatchMode(dispatchMode)) {
      return '中国発';
    }
    return null;
  }

  private resolveEffectiveAmazonDispatchMode(row: Pick<AmazonOrderRecord, 'dispatchMode' | 'shippingOrigin'>,
  ): string | null {
    const dispatchMode = String(row.dispatchMode ?? '').trim();
    if (dispatchMode === OVERSEAS_DISPATCH_MODE.OVERSEAS || this.isChinaDispatchMode(dispatchMode)) {
      return dispatchMode;
    }
    const shippingOrigin = String(row.shippingOrigin ?? '').trim();
    if (shippingOrigin === '中国発') {
      return OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK;
    }
    if (shippingOrigin === '日本発') {
      return OVERSEAS_DISPATCH_MODE.OVERSEAS;
    }
    return null;
  }

  private resolveAmazonShipmentConfirmationProfile(row: Pick<AmazonOrderRecord, 'dispatchMode' | 'shippingOrigin'>): {
    carrierCode: string;
    shipMethod: string;
  } {
    const dispatchMode = this.resolveEffectiveAmazonDispatchMode(row);
    if (this.isChinaDispatchMode(dispatchMode)) {
      return {
        carrierCode: 'SAGAWA EXPRESS',
        shipMethod: 'Hikyaku Express',
      };
    }
    return {
      carrierCode: 'YAMATO TRANSPORT',
      shipMethod: 'Yamato-bin',
    };
  }

  private async buildAmazonManualOrderCreateData(
    payload: CreateAmazonManualOrderPayload,
    fieldPrefix = '',
    origin: ManualOrderCreateOrigin = 'system_single',
  ): Promise<Prisma.ManualOrderRecordCreateInput> {
    const withField = (fieldName: string) => (fieldPrefix ? `${fieldPrefix}.${fieldName}` : fieldName);
    const isXiyaPush = origin === 'xiya_push';
    const orderId = this.requireEditableText(payload.orderId, withField('orderId'), 64);
    const sku = this.normalizeEditableText(payload.sku, withField('sku'), 128);
    const productId = this.requireEditableText(payload.productId, withField('productId'), 64);
    const quantityPurchased = this.requireEditablePositiveInt(payload.quantityPurchased, withField('quantityPurchased'),
    );
    const product = await this.prisma.masterProduct.findUnique({
      where: { productId },
      select: { productName: true },
    });
    const productName =
      this.normalizeEditableText(payload.productName, withField('productName'), 5000) ||
      String(product?.productName ?? '').trim() ||
      null;
    const orderItemId =
      this.normalizeEditableText(payload.orderItemId, withField('orderItemId'), 64) ||
      `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const mallName = this.normalizeEditableText(payload.mallName, withField('mallName'), 128);
    const shopName = this.normalizeEditableText(payload.shopName, withField('shopName'), 128);
    const bloggerCooperationId = isXiyaPush
      ? this.normalizeEditableText(
          payload.bloggerCooperationId ?? payload.blogger_cooperation_id,
          withField('bloggerCooperationId'),
          128,
        )
      : null;
    const recipientName = this.normalizeEditableText(payload.recipientName, withField('recipientName'), 255);
    const buyerPhoneNumber = this.normalizeEditableText(payload.buyerPhoneNumber, withField('buyerPhoneNumber'), 64);
    const shipPostalCode = this.normalizeEditableText(payload.shipPostalCode, withField('shipPostalCode'), 32);
    const shipState = this.normalizeEditableText(payload.shipState, withField('shipState'), 255);
    const shipAddress1 = this.normalizeEditableText(payload.shipAddress1, withField('shipAddress1'), 5000);
    const shipAddress2 = this.normalizeEditableText(payload.shipAddress2, withField('shipAddress2'), 5000);
    const shipAddress3 = this.normalizeEditableText(payload.shipAddress3, withField('shipAddress3'), 5000);
    const shipmentCompany = this.normalizeEditableText(payload.shipmentCompany, withField('shipmentCompany'), 128);
    const shipmentNo = this.normalizeEditableText(payload.shipmentNo, withField('shipmentNo'), 128);
    const dispatchMode = await this.resolveDispatchModeForProductId(productId, quantityPurchased);
    const now = new Date();
    const rawPayload = this.buildAmazonManualRawPayload({
      orderId,
      orderItemId,
      sku,
      productId,
      productName,
      quantityPurchased,
      recipientName,
      buyerPhoneNumber,
      shipPostalCode,
      shipState,
      shipAddress1,
      shipAddress2,
      shipAddress3,
    });

    const rawPayloadWithSource = isXiyaPush
      ? this.mergeRawPayload(rawPayload, {
          bloggerCooperationId,
          blogger_cooperation_id: bloggerCooperationId,
        })
      : rawPayload;

    return {
      rowHash: createHash('sha1')
        .update(['manual-amazon-order', randomUUID(), orderId, orderItemId, sku ?? '', productId].join('\u001f'))
        .digest('hex'),
      orderId,
      orderItemId,
      purchaseDateRaw: this.formatManualAmazonTimestamp(now),
      sku,
      productName,
      quantityPurchased,
      quantityToShip: quantityPurchased,
      recipientName,
      buyerPhoneNumber,
      shipPostalCode,
      shipState,
      shipAddress1,
      shipAddress2,
      shipAddress3,
      mallName,
      shopName,
      bloggerCooperationId,
      shippingOrigin: this.resolveAmazonShippingOriginFromDispatchMode(dispatchMode),
      dispatchMode,
      shipmentCompany,
      shipmentNo,
      shipmentNoRegisteredAt: this.resolveEditedShipmentRegisteredAt(null, null, shipmentNo),
      sourceFileName: isXiyaPush ? XIYA_MANUAL_ORDER_SOURCE_FILE_NAME : AMAZON_MANUAL_ORDER_SOURCE_FILE_NAME,
      sourceFilePath: isXiyaPush ? XIYA_MANUAL_ORDER_SOURCE_FILE_PATH : AMAZON_MANUAL_ORDER_SOURCE_FILE_PATH,
      rawPayload: rawPayloadWithSource,
      csvImportedAt: now,
    };
  }

  private parseManualOrderUploadFile(fileBuffer: Buffer, sourceFileName: string): CreateAmazonManualOrderPayload[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false, raw: false,
      });
    } catch {
      throw new BadRequestException('手动订单批量上传文件无法解析，请上传 xlsx 文件');
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new BadRequestException('手动订单批量上传文件没有可读取的工作表');
    }
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false,
    });
    const items = rawRows
      .map((row) => this.mapManualOrderUploadRow(row))
      .filter((item): item is CreateAmazonManualOrderPayload => Boolean(item));

    if (!items.length) {
      throw new BadRequestException(`手动订单批量上传文件没有有效数据：${sourceFileName}`);
    }
    return items;
  }

  private mapManualOrderUploadRow(row: Record<string, unknown>): CreateAmazonManualOrderPayload | null {
    const pick = (aliases: readonly string[]) => this.pickManualOrderUploadCell(row, aliases);
    const item: CreateAmazonManualOrderPayload = {
      orderId: pick(MANUAL_ORDER_UPLOAD_HEADERS.orderId),
      orderItemId: pick(MANUAL_ORDER_UPLOAD_HEADERS.orderItemId),
      sku: pick(MANUAL_ORDER_UPLOAD_HEADERS.sku),
      productId: pick(MANUAL_ORDER_UPLOAD_HEADERS.productId),
      quantityPurchased: pick(MANUAL_ORDER_UPLOAD_HEADERS.quantityPurchased),
      productName: pick(MANUAL_ORDER_UPLOAD_HEADERS.productName),
      mallName: pick(MANUAL_ORDER_UPLOAD_HEADERS.mallName),
      shopName: pick(MANUAL_ORDER_UPLOAD_HEADERS.shopName),
      bloggerCooperationId: pick(MANUAL_ORDER_UPLOAD_HEADERS.bloggerCooperationId),
      recipientName: pick(MANUAL_ORDER_UPLOAD_HEADERS.recipientName),
      buyerPhoneNumber: pick(MANUAL_ORDER_UPLOAD_HEADERS.buyerPhoneNumber),
      shipPostalCode: pick(MANUAL_ORDER_UPLOAD_HEADERS.shipPostalCode),
      shipState: pick(MANUAL_ORDER_UPLOAD_HEADERS.shipState),
      shipAddress1: pick(MANUAL_ORDER_UPLOAD_HEADERS.shipAddress1),
      shipAddress2: pick(MANUAL_ORDER_UPLOAD_HEADERS.shipAddress2),
      shipAddress3: pick(MANUAL_ORDER_UPLOAD_HEADERS.shipAddress3),
      shipmentCompany: pick(MANUAL_ORDER_UPLOAD_HEADERS.shipmentCompany),
      shipmentNo: pick(MANUAL_ORDER_UPLOAD_HEADERS.shipmentNo),
    };
    return Object.values(item).some((value) => String(value ?? '').trim()) ? item : null;
  }

  private pickManualOrderUploadCell(row: Record<string, unknown>, aliases: readonly string[]): string {
    const aliasSet = new Set(aliases.map((alias) => this.normalizeManualOrderUploadHeader(alias)));
    for (const [header, value] of Object.entries(row)) {
      if (!aliasSet.has(this.normalizeManualOrderUploadHeader(header))) continue;
      return this.stringifyManualOrderUploadValue(value);
    }
    return '';
  }

  private normalizeManualOrderUploadHeader(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s_\-－—–・·:：]/g, '');
  }

  private stringifyManualOrderUploadValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  }

  private buildAmazonManualRawPayload(payload: {
    orderId: string;
    orderItemId: string;
    sku: string | null;
    productId: string;
    productName: string | null;
    quantityPurchased: number;
    recipientName: string | null;
    buyerPhoneNumber: string | null;
    shipPostalCode: string | null;
    shipState: string | null;
    shipAddress1: string | null;
    shipAddress2: string | null;
    shipAddress3: string | null;
  }): Prisma.InputJsonObject {
    const rawPayload: Record<string, string | null> = {};
    AMAZON_ORDER_TXT_COLUMNS.forEach((column) => {
      rawPayload[column.header] = null;
    });
    rawPayload['order-id'] = payload.orderId;
    rawPayload['order-item-id'] = payload.orderItemId;
    rawPayload.sku = payload.sku;
    rawPayload['product-name'] = payload.productName;
    rawPayload['quantity-purchased'] = String(payload.quantityPurchased);
    rawPayload['quantity-to-ship'] = String(payload.quantityPurchased);
    rawPayload['recipient-name'] = payload.recipientName;
    rawPayload['buyer-phone-number'] = payload.buyerPhoneNumber;
    rawPayload['ship-postal-code'] = payload.shipPostalCode;
    rawPayload['ship-state'] = payload.shipState;
    rawPayload['ship-address-1'] = payload.shipAddress1;
    rawPayload['ship-address-2'] = payload.shipAddress2;
    rawPayload['ship-address-3'] = payload.shipAddress3;
    rawPayload['产品ID'] = payload.productId;
    return rawPayload as Prisma.InputJsonObject;
  }

  private formatManualAmazonTimestamp(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(
      parts.hour,
    ).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
  }

  private resolveEditedShipmentRegisteredAt(
    previousShipmentNo: string | null,
    previousRegisteredAt: Date | null,
    nextShipmentNo: string | null,
  ): Date | null {
    if (!nextShipmentNo) {
      return null;
    }
    if (String(previousShipmentNo ?? '').trim() === nextShipmentNo) {
      return previousRegisteredAt ?? new Date();
    }
    return new Date();
  }

  private hasRegisteredShipmentNo(row: { shipmentNo?: string | null }): boolean {
    return String(row.shipmentNo ?? '').trim().length > 0;
  }

  private mergeRawPayload(
    rawPayload: Prisma.JsonValue | Prisma.InputJsonObject | null,
    updates: Record<string, string | boolean | null>,
  ): Prisma.InputJsonObject {
    const base =
      rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
        ? { ...(rawPayload as Prisma.JsonObject) }
        : {};
    for (const [key, value] of Object.entries(updates)) {
      base[key] = value;
    }
    return base as Prisma.InputJsonObject;
  }

  private resolveOriginalAmazonOrderItemId(
    rawPayload: Prisma.JsonValue | null,
    fallback: string | null): string {
    if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
      const item = (rawPayload as Prisma.JsonObject).item;
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const original = String((item as Prisma.JsonObject).orderItemId ?? '').trim();
        if (original) return original;
      }
    }
    return String(fallback ?? '').trim();
  }

  private getJsonObjectString(rawPayload: Prisma.JsonValue | null, key: string): string {
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      return '';
    }
    const value = (rawPayload as Prisma.JsonObject)[key];
    return String(value ?? '').trim();
  }

  private resolveSendStatus(shipmentNo: string | null): OrderSendStatus {
    return shipmentNo && shipmentNo.trim() ? OrderSendStatus.sent : OrderSendStatus.unsent;
  }

  private buildAmazonRowHash(row: Omit<ParsedAmazonOrderRow, 'rowHash'>): string {
    const hashBase = AMAZON_ORDER_TXT_COLUMNS.map((column) => row.rawPayload[column.header] ?? '').join('\u001f');
    return createHash('sha1').update(hashBase).digest('hex');
  }

  private toThirdPartyRow(row: OrderListItem): Record<string, unknown> {
    return this.buildThirdPartyExportRow({
      source: 'rakuten',
      sourceLabel: '乐天',
      id: row.id.toString(),
      rowHash: row.rowHash,
      resolvedProductId: row.resolvedProductId,
      resolvedProductName: row.resolvedProductName,
      availableStock: row.availableStock,
      fulfillmentMode: row.fulfillmentMode,
      dispatchMode: row.dispatchMode,
      sourceFileName: row.sourceFileName,
      sourceFilePath: row.sourceFilePath,
      csvImportedAt: row.csvImportedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      orderId: row.orderId,
      itemDetailStatus: row.itemDetailStatus,
      skuCode: row.skuCode,
      setComponentSkuCode: row.setComponentSkuCode,
      orderQuantity: row.orderQuantity,
      productName: row.productName,
      mallName: row.mallName,
      shopName: row.shopName,
      mallOrderNo: row.mallOrderNo,
      orderStatusText: row.orderStatusText,
      orderImportedAtRaw: row.orderImportedAtRaw,
      orderRemark: row.orderRemark,
      shippingName: row.shippingName,
      shippingPostalCode: row.shippingPostalCode,
      shippingPrefecture: row.shippingPrefecture,
      shippingCity: row.shippingCity,
      shippingAddress: row.shippingAddress,
      shippingPhone: row.shippingPhone,
      shipmentCompany: row.shipmentCompany,
      shipmentNo: row.shipmentNo,
      shipmentNoRegisteredAt: row.shipmentNoRegisteredAt,
      deliveryMethod: row.deliveryMethod,
      deliveryDateRaw: row.deliveryDateRaw,
      deliveryTimeSlot: row.deliveryTimeSlot,
      shipmentRequestNo: row.shipmentRequestNo,
      productNameExtra: row.productNameExtra,
    });
  }

  private toAmazonThirdPartyRow(row: AmazonEnrichedOrderListItem): Record<string, unknown> {
    return this.buildThirdPartyExportRow({
      source: 'amazon',
      sourceLabel: '亚马逊',
      id: row.id.toString(),
      rowHash: row.rowHash,
      resolvedProductId: row.resolvedProductId,
      resolvedProductName: row.resolvedProductName,
      availableStock: row.availableStock,
      fulfillmentMode: row.fulfillmentMode,
      dispatchMode: row.dispatchMode,
      sourceFileName: row.sourceFileName,
      sourceFilePath: row.sourceFilePath,
      csvImportedAt: row.csvImportedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      orderId: row.orderId,
      itemDetailStatus: null,
      skuCode: row.sku,
      setComponentSkuCode: null,
      orderQuantity: row.quantityPurchased,
      productName: row.productName,
      mallName: row.mallName ?? 'Amazon',
      shopName: row.resolvedShopName ?? row.shopName,
      mallOrderNo: row.orderId,
      orderStatusText: null,
      orderImportedAtRaw: row.purchaseDateRaw,
      orderRemark: null,
      shippingName: row.recipientName,
      shippingPostalCode: row.shipPostalCode,
      shippingPrefecture: row.shipState,
      shippingCity: row.shipCity,
      shippingAddress: [row.shipAddress1, row.shipAddress2, row.shipAddress3]
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)
        .join(' '),
      shippingPhone: row.buyerPhoneNumber,
      shipmentCompany: row.shipmentCompany,
      shipmentNo: row.shipmentNo,
      shipmentNoRegisteredAt: row.shipmentNoRegisteredAt,
      deliveryMethod: row.shipServiceLevel,
      deliveryDateRaw: null,
      deliveryTimeSlot: null,
      shipmentRequestNo: row.orderItemId,
      productNameExtra: null,
    });
  }

  private toManualThirdPartyRow(row: ManualEnrichedOrderListItem): Record<string, unknown> {
    return this.buildThirdPartyExportRow({
      source: 'manual',
      sourceLabel: '手动订单',
      id: row.id.toString(),
      rowHash: row.rowHash,
      resolvedProductId: row.resolvedProductId,
      resolvedProductName: row.resolvedProductName,
      availableStock: row.availableStock,
      fulfillmentMode: row.fulfillmentMode,
      dispatchMode: row.dispatchMode,
      sourceFileName: row.sourceFileName,
      sourceFilePath: row.sourceFilePath,
      csvImportedAt: row.csvImportedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      orderId: row.orderId,
      itemDetailStatus: null,
      skuCode: row.sku,
      setComponentSkuCode: null,
      orderQuantity: row.quantityPurchased,
      productName: row.productName,
      mallName: row.mallName,
      shopName: row.resolvedShopName ?? row.shopName,
      mallOrderNo: row.orderId,
      orderStatusText: null,
      orderImportedAtRaw: row.purchaseDateRaw,
      orderRemark: null,
      shippingName: row.recipientName,
      shippingPostalCode: row.shipPostalCode,
      shippingPrefecture: row.shipState,
      shippingCity: row.shipCity,
      shippingAddress: [row.shipAddress1, row.shipAddress2, row.shipAddress3]
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)
        .join(' '),
      shippingPhone: row.buyerPhoneNumber,
      shipmentCompany: row.shipmentCompany,
      shipmentNo: row.shipmentNo,
      shipmentNoRegisteredAt: row.shipmentNoRegisteredAt,
      deliveryMethod: row.shipServiceLevel,
      deliveryDateRaw: null,
      deliveryTimeSlot: null,
      shipmentRequestNo: row.orderItemId,
      productNameExtra: null,
    });
  }

  private shouldExportOrderToThirdParty(
    source: ThirdPartyExportSource,
    sourceRecordId: bigint,
    dispatchModeRaw: string | null | undefined,
    fulfillmentMode: string,
    activePickedRefs: Set<string>,
  ): boolean {
    const dispatchMode = String(dispatchModeRaw ?? '').trim();
    if (this.isChinaDispatchMode(dispatchMode)) {
      return true;
    }
    if (fulfillmentMode !== 'xiya_api') {
      return false;
    }
    return !activePickedRefs.has(`${source}:${sourceRecordId.toString()}`);
  }

  private normalizeChinaOrderScope(scopeParam?: string): 'pending' | 'exported' | 'all' {
    const scope = String(scopeParam ?? '').trim().toLowerCase();
    if (scope === 'exported' || scope === 'completed' || scope === 'tracking_registered') return 'exported';
    if (scope === 'all') return 'all';
    return 'pending';
  }

  private buildChinaOrderShipmentNoFilter(
    scope: 'pending' | 'exported' | 'all'):
    | { OR: Array<{ shipmentNo: null } | { shipmentNo: string }> }
    | { AND: Array<{ shipmentNo: { not: null } } | { shipmentNo: { not: string } }>;
      }
    | Record<string, never> {
    if (scope === 'exported') {
      return { AND: [{ shipmentNo: { not: null } }, { shipmentNo: { not: '' } }],
      };
    }
    if (scope === 'all') {
      return {};
    }
    return { OR: [{ shipmentNo: null }, { shipmentNo: '' }] };
  }

  private buildRakutenChinaDispatchWhere(): { dispatchMode: { in: string[] } } {
    return {
      dispatchMode: {
        in: [OVERSEAS_DISPATCH_MODE.CHINA_PENDING, OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK],
      },
    };
  }

  private resolveChinaDispatchReason(dispatchModeRaw: string | null | undefined): string {
    return String(dispatchModeRaw ?? '').trim() === OVERSEAS_DISPATCH_MODE.CHINA_PENDING
      ? '拣货缺货切中国发'
      : '系统无库存';
  }

  private buildThirdPartyExportRow(row: ThirdPartyExportRowInput): Record<string, unknown> {
    return {
      source: row.source,
      sourceLabel: row.sourceLabel,
      id: row.id,
      rowHash: row.rowHash,
      resolvedProductId: row.resolvedProductId,
      resolvedProductName: row.resolvedProductName,
      availableStock: row.availableStock,
      fulfillmentMode: row.fulfillmentMode,
      dispatchMode: row.dispatchMode,
      chinaDispatchReason: this.resolveChinaDispatchReason(row.dispatchMode),
      sourceFileName: row.sourceFileName,
      sourceFilePath: row.sourceFilePath,
      CSV導入日時: row.csvImportedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      注文ID: row.orderId,
      商品明細ステータス: row.itemDetailStatus,
      SKU: row.skuCode,
      产品ID: row.resolvedProductId,
      产品名称: row.resolvedProductName,
      セット構成品SKUコード: row.setComponentSkuCode,
      注文個数: row.orderQuantity,
      商品名: row.productName,
      モール名: row.mallName,
      ショップ名: row.shopName,
      モール注文番号: row.mallOrderNo,
      注文ステータス: row.orderStatusText,
      注文取込日時: row.orderImportedAtRaw,
      注文備考: row.orderRemark,
      送付先氏名: row.shippingName,
      送付先郵便番号: row.shippingPostalCode,
      送付先都道府県: row.shippingPrefecture,
      送付先市区町村: row.shippingCity,
      送付先町名・番地以降: row.shippingAddress,
      送付先電話番号: row.shippingPhone,
      発送会社: row.shipmentCompany,
      発送番号: row.shipmentNo,
      発送番号登録日時: row.shipmentNoRegisteredAt?.toISOString() ?? null,
      配送方法: row.deliveryMethod,
      お届け指定日: row.deliveryDateRaw,
      お届け指定時間帯: row.deliveryTimeSlot,
      出荷依頼番号: row.shipmentRequestNo,
      商品名１: row.productNameExtra,
    };
  }
}
