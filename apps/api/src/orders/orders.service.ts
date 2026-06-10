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
  YamatoShipmentBatch,
  YamatoShipmentBatchPage,
} from '@prisma/client';
import * as iconv from 'iconv-lite';
import * as JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { join, resolve } from 'path';
import { promisify } from 'util';
import * as XLSX from 'xlsx';
import { APP_TIMEZONE, getZonedDateParts, parseId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

const execFileAsync = promisify(execFile);

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

const RAKUTEN_ORDER_HEADERS = {
  skuCode: 'SKU管理番号',
  productName: '商品名',
  skuInfo: 'SKU情報',
  unitPrice: '単価',
  orderQuantity: '個数',
  orderId: '注文番号',
  orderCreatedAt: '注文日時',
  orderConfirmedAt: '注文確定日時',
  deliveryMethod: '配送方法',
  deliveryClass: '配送区分',
  shippingPostalCode1: '送付先郵便番号1',
  shippingPostalCode2: '送付先郵便番号2',
  shippingPrefecture: '送付先住所都道府県',
  shippingCity: '送付先住所郡市区',
  shippingAddress: '送付先住所それ以降の住所',
  shippingLastName: '送付先姓',
  shippingFirstName: '送付先名',
  shippingPhone1: '送付先電話番号1',
  shippingPhone2: '送付先電話番号2',
  shippingPhone3: '送付先電話番号3',
  deliveryTimeSlot: 'お届け時間帯',
  deliveryDateRaw: 'お届け日指定',
  orderRemark: 'コメント',
} as const;

const RAKUTEN_ORDER_COLUMNS = [
  { header: RAKUTEN_ORDER_HEADERS.skuCode, key: 'skuCode' },
  { header: RAKUTEN_ORDER_HEADERS.productName, key: 'productName' },
  { header: RAKUTEN_ORDER_HEADERS.skuInfo, key: 'skuInfo' },
  { header: RAKUTEN_ORDER_HEADERS.unitPrice, key: 'unitPrice' },
  { header: RAKUTEN_ORDER_HEADERS.orderQuantity, key: 'orderQuantityRaw' },
  { header: RAKUTEN_ORDER_HEADERS.orderId, key: 'orderId' },
  { header: RAKUTEN_ORDER_HEADERS.orderCreatedAt, key: 'orderCreatedAtRaw' },
  { header: RAKUTEN_ORDER_HEADERS.orderConfirmedAt, key: 'orderConfirmedAtRaw' },
  { header: RAKUTEN_ORDER_HEADERS.deliveryMethod, key: 'deliveryMethod' },
  { header: RAKUTEN_ORDER_HEADERS.deliveryClass, key: 'deliveryClass' },
  { header: RAKUTEN_ORDER_HEADERS.shippingPostalCode1, key: 'shippingPostalCode1' },
  { header: RAKUTEN_ORDER_HEADERS.shippingPostalCode2, key: 'shippingPostalCode2' },
  { header: RAKUTEN_ORDER_HEADERS.shippingPrefecture, key: 'shippingPrefecture' },
  { header: RAKUTEN_ORDER_HEADERS.shippingCity, key: 'shippingCity' },
  { header: RAKUTEN_ORDER_HEADERS.shippingAddress, key: 'shippingAddress' },
  { header: RAKUTEN_ORDER_HEADERS.shippingLastName, key: 'shippingLastName' },
  { header: RAKUTEN_ORDER_HEADERS.shippingFirstName, key: 'shippingFirstName' },
  { header: RAKUTEN_ORDER_HEADERS.shippingPhone1, key: 'shippingPhone1' },
  { header: RAKUTEN_ORDER_HEADERS.shippingPhone2, key: 'shippingPhone2' },
  { header: RAKUTEN_ORDER_HEADERS.shippingPhone3, key: 'shippingPhone3' },
  { header: RAKUTEN_ORDER_HEADERS.deliveryTimeSlot, key: 'deliveryTimeSlot' },
  { header: RAKUTEN_ORDER_HEADERS.deliveryDateRaw, key: 'deliveryDateRaw' },
  { header: RAKUTEN_ORDER_HEADERS.orderRemark, key: 'orderRemark' },
] as const;

void ORDER_CSV_COLUMNS;

type OrderCsvColumn = (typeof RAKUTEN_ORDER_COLUMNS)[number];
type OrderCsvHeader = OrderCsvColumn['header'];

interface ParsedOrderCsvRow {
  rowHash: string;
  orderId: string | null;
  itemDetailStatus: string | null;
  skuCode: string | null;
  isComboOrder: boolean;
  comboOrderSku: string | null;
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
  sendStatus: OrderSendStatus;
  deliveryMethod: string | null;
  deliveryDateRaw: string | null;
  deliveryTimeSlot: string | null;
  shipmentRequestNo: string | null;
  productNameExtra: string | null;
  rawPayload: Record<OrderCsvHeader, string | null>;
}

interface OrderImportResult {
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

type OrderFulfillmentMode = 'overseas_warehouse' | 'xiya_api';

interface OrderListItem extends RakutenOrderRecord {
  resolvedProductId: string | null;
  resolvedProductName: string | null;
  availableStock: number;
  fulfillmentMode: OrderFulfillmentMode;
  trackingClearanceStatus?: RakutenTrackingClearanceStatus;
}

interface RakutenTrackingClearanceStatus {
  trackingNo: string | null;
  label: string;
  hasCustomsClearance: boolean;
  isDelivered: boolean;
  occurredAt: string | null;
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

interface RakutenShipmentConfirmationFileResult {
  fileName: string;
  content: Buffer;
  rowCount: number;
  skippedWithoutCustomsClearanceCount: number;
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
}
type ManualOrderRecordLike = AmazonOrderRecord & ManualOrderXyjgFields;
type ManualOrderListItem = AmazonOrderListItem & ManualOrderXyjgFields;

type AmazonFulfillmentMode = 'overseas_warehouse' | 'xiya_api';

interface AmazonEnrichedOrderListItem extends AmazonOrderListItem {
  availableStock: number;
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
  sales_order_id?: string | null;
  store_name?: string | null;
  created_at?: string | null;
  logistics_status?: string | null;
  shipping_method?: string | null;
  shipping_method_name?: string | null;
  delivery_method_name?: string | null;
  logistics_method_name?: string | null;
  transport_method_name?: string | null;
  '运输方式名称'?: string | null;
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
  orderCount: number;
  itemCount: number;
  totalQty: number;
  createdAt: string;
  confirmedAt: string | null;
  yamatoShipmentBatchId: string | null;
  yamatoShipmentBatchStatus: string | null;
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
}

type OverseasPickingPlanSnapshotItem = {
  shelfCode: string | null;
  boxCode: string | null;
  boxQty: number;
  pickQty: number;
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
  batchId: string;
  fileName: string;
  content: Buffer;
  pageNo: number;
  trackingNo: string | null;
  productId: string;
  remainingMatchCount: number;
}

interface YamatoShipmentDirectPrintResult {
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
  remainingMatchCount: number;
}

interface PreparedYamatoShipmentPrintResult {
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

interface YamatoShipmentPrintByProductPayload {
  productId?: string;
  pageNo?: string | number;
  acceptActivePrintJob?: boolean;
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
const AMAZON_MANUAL_ORDER_SOURCE_FILE_NAME = 'manual-amazon-order';
const AMAZON_MANUAL_ORDER_SOURCE_FILE_PATH = 'manual:amazon-order';
const XIYA_MANUAL_ORDER_SOURCE_FILE_NAME = 'xiya-manual-order';
const XIYA_MANUAL_ORDER_SOURCE_FILE_PATH = 'external:xiya-manual-order';
const MANUAL_ORDER_UPLOAD_TEMPLATE_FILE = '手动订单上传模板.xlsx';
const XIYA_LOGISTICS_EXPORT_URL = 'http://103.236.55.93/api/external/logistics/rakuten';
const XIYA_LOGISTICS_API_KEY = 'xiya-export-4HHGJWBDGg29yp8W8TK3QRQ3m1A';
const XIYA_LOGISTICS_SYNC_DAYS = 5;
const XIYA_TRACKING_SYNC_CRON = '0 0 17 * * *';
const UOF_TRACKING_API_URL =
  process.env.UOF_TRACKING_API_URL || 'http://oms.uofexp.com/webservice/PublicService.asmx/ServiceInterfaceUTF8';
const UOF_TRACKING_APP_TOKEN = process.env.UOF_TRACKING_APP_TOKEN;
const UOF_TRACKING_APP_KEY = process.env.UOF_TRACKING_APP_KEY;
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
const RAKUTEN_TRACKING_STATUS_SYNC_CRON = '0 0 5 * * *';
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
const XIYA_LOGISTICS_STORE_SOURCE: Record<string, ThirdPartyExportSource> = {
  DGAZ乐天日本: 'rakuten',
  DGAZ亚马逊日本站: 'amazon',
  ArcDiary亚马逊日本站: 'amazon',
};
const OVERSEAS_PICKING_BATCH_STATUS = {
  CREATED: 'created',
  PICKED: 'picked',
  YAMATO_EXPORTED: 'yamato_exported',
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
  'ヤマト': YAMATO_DEFAULT_WINDOWS_PRINTER_NAME,
  'ネコポス': 'nekoposu',
};
const YAMATO_PRINT_JOB_STALE_MS = 5 * 60 * 1000;
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
  getDocument: (source: { data: Uint8Array; disableWorker?: boolean }) => { promise: Promise<unknown> };
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
  private rakutenTrackingStatusSyncRunning = false;
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
    const [rows, yamatoBatches] = await Promise.all([
      this.prisma.overseasPickingBatch.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
      this.prisma.yamatoShipmentBatch.findMany({
        where: {
          pickingBatchId: { not: null },
        },
        select: {
          id: true,
          pickingBatchId: true,
          status: true,
        },
      }),
    ]);

    const yamatoBatchByPickingBatchId = new Map(
      yamatoBatches
        .filter((row) => row.pickingBatchId !== null)
        .map((row) => [row.pickingBatchId!.toString(), row] as const),
    );

    return rows.map((row) => {
      const yamatoBatch = yamatoBatchByPickingBatchId.get(row.id.toString()) ?? null;
      return {
        id: row.id.toString(),
        batchNo: row.batchNo,
        status: row.status,
        orderCount: Number(row.orderCount ?? 0),
        itemCount: Number(row.itemCount ?? 0),
        totalQty: Number(row.totalQty ?? 0),
        createdAt: row.createdAt.toISOString(),
        confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
        yamatoShipmentBatchId: yamatoBatch ? yamatoBatch.id.toString() : null,
        yamatoShipmentBatchStatus: yamatoBatch?.status ?? null,
      };
    });
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
          .map((item) => item.sourceRecordId),
      ),
    );
    const amazonSourceIds = Array.from(
      new Set(
        batch.items
          .filter((item) => item.source === 'amazon')
          .map((item) => item.sourceRecordId),
      ),
    );
    const manualSourceIds = Array.from(
      new Set(
        batch.items
          .filter((item) => item.source === 'manual')
          .map((item) => item.sourceRecordId),
      ),
    );
    const [rakutenSourceRows, amazonSourceRows, manualSourceRows] = await Promise.all([
      rakutenSourceIds.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: {
              id: {
                in: rakutenSourceIds,
              },
            },
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonSourceIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: {
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
    const locationMetaByProductId = await this.loadOverseasPickingBatchLocationMeta(
      batch.items.map((item) => item.productId),
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
      locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number }>,
      pickedQty: number,
      requestedQty: number,
    ): {
      current: { shelfCode: string | null; boxCode: string | null; qty: number } | null;
      next: { shelfCode: string | null; boxCode: string | null; qty: number } | null;
    } => {
      if (!locations.length) {
        return { current: null, next: null };
      }
      let consumedQty = Math.max(pickedQty, 0);
      for (let index = 0; index < locations.length; index += 1) {
        const location = locations[index];
        if (consumedQty < location.qty) {
          let remainingDemand = Math.max(requestedQty - consumedQty, 0);
          let nextLocation: { shelfCode: string | null; boxCode: string | null; qty: number } | null = null;
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
      locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number }>,
      requestedQty: number,
    ): Array<{ shelfCode: string | null; boxCode: string | null; boxQty: number; pickQty: number }> => {
      let remaining = Math.max(requestedQty, 0);
      const plans: Array<{ shelfCode: string | null; boxCode: string | null; boxQty: number; pickQty: number }> = [];
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
        locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number }>;
        pickPlans: OverseasPickingPlanSnapshotItem[];
      }
    >();

    sortedItems
      .filter(
        (item) =>
          !this.isChinaDispatchMode(item.dispatchMode),
      )
      .forEach((item) => {
        const requestedQty = Number(item.requestedQty ?? 0);
        const pickedQty = Number(item.actualQty ?? 0);
        const locationMeta = locationMetaByProductId.get(item.productId) ?? null;
        const sortKey = `${locationMeta?.shelfCode ?? 'ZZZ'}|${locationMeta?.boxCode ?? 'ZZZ'}|${item.productId}`;
        const aggregate =
          groupedItems.get(item.productId) ??
          {
            productId: item.productId,
            sortKey,
            productName: locationMeta?.productName ?? null,
            stockQty: Number(locationMeta?.stockQty ?? 0),
            requestedQty: 0,
            actualQty: 0,
            locations: locationMeta?.locations ?? [],
            pickPlans: [],
          };

        aggregate.requestedQty += requestedQty;
        aggregate.actualQty += pickedQty;
        aggregate.pickPlans.push(...this.parseOverseasPickingPlanSnapshot(item.pickingPlanSnapshot));
        groupedItems.set(item.productId, aggregate);
      });

    const groupedDetailItems = Array.from(groupedItems.values())
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey, 'zh-Hans-CN'))
      .map((item) => {
        const targetLocation = resolvePickingLocation(item.locations, item.actualQty, item.requestedQty);
        const pickPlans = item.pickPlans.length
          ? this.mergeOverseasPickingPlanSnapshots(item.pickPlans)
          : buildPickingPlans(item.locations, item.requestedQty);
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
      orderCount: Number(batch.orderCount ?? 0),
      itemCount: Number(batch.itemCount ?? 0),
      totalQty: Number(batch.totalQty ?? 0),
      createdAt: batch.createdAt.toISOString(),
      confirmedAt: batch.confirmedAt ? batch.confirmedAt.toISOString() : null,
      remark: batch.remark ?? null,
      yamatoShipmentBatchId: yamatoBatch ? yamatoBatch.id.toString() : null,
      yamatoShipmentBatchStatus: yamatoBatch?.status ?? null,
      items: groupedDetailItems,
      orders: detailOrders,
    };
  }

  async createOverseasPickingBatch(
    payload: { items?: SelectedOverseasWarehouseOrderRef[]; remark?: string },
    operatorId?: bigint,
  ): Promise<OverseasPickingBatchCreateResult> {
    const snapshots = await this.collectOverseasPickingBatchItemSnapshots(payload?.items);
    await this.attachOverseasPickingPlanSnapshots(snapshots);
    await this.assertOverseasPickingBatchDemandWithinStock(snapshots);
    const activeDuplicates = await this.findActiveOverseasPickingBatchDuplicates(snapshots);
    if (activeDuplicates.length) {
      throw new ConflictException(
        `以下订单已在进行中的拣货批次内：${activeDuplicates.join('、')}`,
      );
    }

    const batchNo = this.buildOverseasPickingBatchNo();
    const orderCount = new Set(snapshots.map((item) => item.orderId)).size;
    const itemCount = snapshots.length;
    const totalQty = snapshots.reduce((sum, item) => sum + item.requestedQty, 0);
    const remark = String(payload?.remark ?? '').trim() || null;

    const created = await this.prisma.overseasPickingBatch.create({
      data: {
        batchNo,
        status: OVERSEAS_PICKING_BATCH_STATUS.CREATED,
        orderCount,
        itemCount,
        totalQty,
        createdBy: operatorId ?? null,
        remark,
        items: {
          create: snapshots.map((item) => ({
            source: item.source,
            sourceRecordId: item.sourceRecordId,
            orderId: item.orderId,
            skuCode: item.skuCode,
            productId: item.productId,
            requestedQty: item.requestedQty,
            availableStockSnapshot: item.availableStockSnapshot,
            pickingPlanSnapshot: item.pickingPlanSnapshot ?? [],
            shopName: item.shopName,
            shippingName: item.shippingName,
          })),
        },
      },
    });

    return {
      id: created.id.toString(),
      batchNo: created.batchNo,
      status: created.status,
      itemCount,
    };
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

    const batch = await this.prisma.overseasPickingBatch.findUnique({
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

    const batchItems = await this.prisma.overseasPickingBatchItem.findMany({
      where: {
        batchId,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!batchItems.length) {
      throw new NotFoundException(`批次 ${batch.batchNo} 中暂无拣货明细`);
    }

    const locationMetaByProductId = await this.loadOverseasPickingBatchLocationMeta(
      batchItems.map((item) => item.productId),
    );
    const nextExpectedProduct = this.resolveNextOverseasPickingProduct(batchItems, locationMetaByProductId);
    if (nextExpectedProduct && nextExpectedProduct.productId !== productId) {
      const locationText = [nextExpectedProduct.shelfCode, nextExpectedProduct.boxCode]
        .filter((value) => String(value ?? '').trim().length > 0)
        .join(' / ');
      const locationHint = locationText ? `${locationText} / ` : '';
      throw new BadRequestException(
        `请按顺序拣货，当前应先拣 ${locationHint}${nextExpectedProduct.productId}${
          nextExpectedProduct.productName ? `（${nextExpectedProduct.productName}）` : ''
        }`,
      );
    }

    const allItems = batchItems.filter((item) => item.productId === productId);
    if (!allItems.length) {
      throw new NotFoundException(`批次 ${batch.batchNo} 中不存在产品 ${productId}`);
    }

    const activeItems = allItems.filter(
      (item) => String(item.dispatchMode ?? OVERSEAS_DISPATCH_MODE.OVERSEAS).trim() === OVERSEAS_DISPATCH_MODE.OVERSEAS,
    );
    if (!activeItems.length) {
      throw new NotFoundException(`批次 ${batch.batchNo} 中不存在产品 ${productId}`);
    }

    const target = activeItems.find((item) => Number(item.actualQty ?? 0) < Number(item.requestedQty ?? 0));
    if (!target) {
      throw new BadRequestException(`批次 ${batch.batchNo} 中产品 ${productId} 已全部完成拣货`);
    }

    const nextQty = Number(target.actualQty ?? 0) + 1;
    if (nextQty > Number(target.requestedQty ?? 0)) {
      throw new BadRequestException(`产品 ${productId} 已达到应拣数量`);
    }

    const totalRequestedQty = activeItems.reduce((sum, item) => sum + Number(item.requestedQty ?? 0), 0);
    const updated = await this.prisma.overseasPickingBatchItem.update({
      where: { id: target.id },
      data: {
        actualQty: nextQty,
        pickedAt: new Date(),
      },
      select: {
        id: true,
        productId: true,
        actualQty: true,
        requestedQty: true,
      },
    });

    return {
      id: updated.id.toString(),
      productId: updated.productId,
      pickedQty: activeItems.reduce((sum, item) => {
        const pickedQty = item.id === target.id ? nextQty : Number(item.actualQty ?? 0);
        return sum + pickedQty;
      }, 0),
      requestedQty: totalRequestedQty,
      remainingQty: Math.max(
        totalRequestedQty -
          activeItems.reduce((sum, item) => {
            const pickedQty = item.id === target.id ? nextQty : Number(item.actualQty ?? 0);
            return sum + pickedQty;
          }, 0),
        0,
      ),
    };
  }

  async switchOverseasPickingBatchProductToChina(
    batchIdRaw: string,
    productIdRaw: string,
  ): Promise<{ success: true; productId: string; dispatchMode: string; batchDeleted: boolean }> {
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
      },
    });
    if (!items.length) {
      throw new NotFoundException(`拣货批次中不存在产品 ${productId}`);
    }

    const activeItems = items.filter((item) => !this.isChinaDispatchMode(item.dispatchMode));
    if (!activeItems.length) {
      throw new NotFoundException(`拣货批次中不存在可切中国发的产品 ${productId}`);
    }
    if (activeItems.some((item) => Number(item.actualQty ?? 0) > 0)) {
      throw new BadRequestException(`产品 ${productId} 已开始扫码拣货，不能再切换到中国发`);
    }

    const itemIds = activeItems.map((item) => item.id);
    const rakutenIds = Array.from(
      new Set(
        activeItems
          .filter((item) => item.source === 'rakuten')
          .map((item) => item.sourceRecordId),
      ),
    );
    const amazonIds = Array.from(
      new Set(
        activeItems
          .filter((item) => item.source === 'amazon')
          .map((item) => item.sourceRecordId),
      ),
    );
    const manualIds = Array.from(
      new Set(
        activeItems
          .filter((item) => item.source === 'manual')
          .map((item) => item.sourceRecordId),
      ),
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
          where: {
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
        productId,
      },
      select: {
        id: true,
        actualQty: true,
        dispatchMode: true,
      },
    });
    if (!items.length) {
      throw new NotFoundException(`拣货批次中不存在产品 ${productId}`);
    }

    const targetItems = items.filter(
      (item) =>
        !this.isChinaDispatchMode(item.dispatchMode) && Number(item.actualQty ?? 0) > 0,
    );
    if (!targetItems.length) {
      return {
        success: true,
        productId,
        actualQty: 0,
      };
    }

    await this.prisma.overseasPickingBatchItem.updateMany({
      where: {
        id: {
          in: targetItems.map((item) => item.id),
        },
      },
      data: {
        actualQty: 0,
        pickedAt: null,
      },
    });

    return {
      success: true,
      productId,
      actualQty: 0,
    };
  }

  async switchOverseasPickingBatchItemToChina(
    batchIdRaw: string,
    itemIdRaw: string,
  ): Promise<{ success: true; itemId: string; dispatchMode: string; batchDeleted: boolean }> {
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
    if (Number(item.actualQty ?? 0) > 0) {
      throw new BadRequestException(`产品 ${item.productId} 已开始扫码拣货，不能再切换到中国发`);
    }

    const manualSwitchScope =
      item.source === 'manual'
        ? await this.resolveXyjgManualOrderSwitchScope(batchId, [item.sourceRecordId])
        : { manualIds: [] as bigint[], batchItemIds: [] as bigint[], pickedItems: [] as OverseasPickingScopePickedItem[] };
    const amazonSwitchScope =
      item.source === 'amazon'
        ? await this.resolveAmazonOrderSwitchScope(batchId, [item.sourceRecordId])
        : { amazonIds: [] as bigint[], batchItemIds: [] as bigint[], pickedItems: [] as OverseasPickingScopePickedItem[] };
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
          where: { id: item.sourceRecordId },
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
  ): Promise<{ amazonIds: bigint[]; batchItemIds: bigint[]; pickedItems: OverseasPickingScopePickedItem[] }> {
    const normalizedSeedIds = Array.from(new Set(seedAmazonIds.map((id) => id.toString()))).map((id) => BigInt(id));
    if (!normalizedSeedIds.length) {
      return { amazonIds: [], batchItemIds: [], pickedItems: [] };
    }

    const seedRows = await this.prisma.amazonOrderRecord.findMany({
      where: {
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
      return { amazonIds: normalizedSeedIds, batchItemIds: [], pickedItems: [] };
    }

    const scopedRows = await this.prisma.amazonOrderRecord.findMany({
      where: {
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
      return { amazonIds: normalizedSeedIds, batchItemIds: [], pickedItems: [] };
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
  ): Promise<{ manualIds: bigint[]; batchItemIds: bigint[]; pickedItems: OverseasPickingScopePickedItem[] }> {
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
      return { manualIds: normalizedSeedIds, batchItemIds: [], pickedItems: [] };
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
      return { manualIds: normalizedSeedIds, batchItemIds: [], pickedItems: [] };
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
  ): Promise<{ success: true; itemId: string; removedItemIds: string[]; batchDeleted: boolean }> {
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
        : { amazonIds: [] as bigint[], batchItemIds: [] as bigint[], pickedItems: [] as OverseasPickingScopePickedItem[] };
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
          where: { id: item.sourceRecordId },
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

    await this.prisma.$transaction(async (tx) => {
      const demandByProductId = new Map<string, number>();
      normalizedItems.forEach((item) => {
        if (item.dispatchMode !== OVERSEAS_DISPATCH_MODE.OVERSEAS) {
          return;
        }
        const key = item.productId;
        demandByProductId.set(key, (demandByProductId.get(key) ?? 0) + item.actualQty);
      });

      const productIds = Array.from(demandByProductId.keys());
      const inventoryRows = productIds.length
        ? await tx.masterProductBoxInventory.findMany({
            where: {
              productId: {
                in: productIds,
              },
            },
            orderBy: [{ qty: 'asc' }, { boxId: 'asc' }],
          })
        : [];
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

      for (const [productId, totalQty] of demandByProductId.entries()) {
        const rows = inventoryRowsByProductId.get(productId) ?? [];
        const available = rows.reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
        if (available < totalQty) {
          throw new ConflictException(`产品 ${productId} 库存不足，当前可用 ${available}，需要 ${totalQty}`);
        }
      }

      for (const item of normalizedItems) {
        const qty = item.actualQty;
        if (item.dispatchMode !== OVERSEAS_DISPATCH_MODE.OVERSEAS) continue;
        if (qty <= 0) continue;
        const allocations = this.allocateOverseasPickingQtyAcrossBoxes(
          inventoryRowsByProductId.get(item.productId) ?? [],
          qty,
          item.productId,
        );

        for (const allocation of allocations) {
          await tx.masterProductBoxInventory.update({
            where: {
              boxId_productId: {
                boxId: allocation.boxId,
                productId: item.productId,
              },
            },
            data: {
              qty: allocation.nextQty,
            },
          });
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

      for (const productId of productIds) {
        const totalQty = await tx.masterProductBoxInventory.aggregate({
          where: { productId },
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
    });

    const confirmed = await this.prisma.overseasPickingBatch.findUnique({
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
  }

  async listYamatoShipmentBatches(limitParam?: string): Promise<YamatoShipmentBatchSummary[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50) : 20;
    const rows = await this.prisma.yamatoShipmentBatch.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        pages: {
          select: {
            id: true,
            printedAt: true,
          },
        },
      },
    });

    return rows.map((row) => {
      const printedPageCount = row.pages.filter((page) => Boolean(page.printedAt)).length;
      const pageCount = Number(row.pageCount ?? row.pages.length ?? 0);
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

  async list(limitParam?: string, offsetParam?: string): Promise<OrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const parsedOffset = Number(offsetParam);
    const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    const rows = await this.prisma.rakutenOrderRecord.findMany({
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
      orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    });
    return this.enrichAmazonOrderRows(rows);
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
            where: { id: { in: rakutenExactIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonExactIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: { id: { in: amazonExactIds } },
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
        500,
      );
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
      const row = await this.prisma.rakutenOrderRecord.findUnique({ where: { id } });
      if (!row) {
        throw new NotFoundException(`乐天订单不存在: ${idRaw}`);
      }
      const [enriched] = await this.enrichOrderRows([row]);
      return enriched;
    }

    if (source === 'amazon') {
      const row = await this.prisma.amazonOrderRecord.findUnique({ where: { id } });
      if (!row) {
        throw new NotFoundException(`亚马逊订单不存在: ${idRaw}`);
      }
      const [enriched] = await this.enrichAmazonOrderRows([row]);
      return enriched;
    }

    if (source === 'manual') {
      const row = await (this.prisma as any).manualOrderRecord.findUnique({ where: { id } });
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
        const rows = await this.prisma.$queryRawUnsafe<Array<{ value: string | null }>>(
          `SELECT ${config.valueColumn} AS value
           FROM ${config.tableName}
           WHERE ${normalizedSql.replace('value_column_placeholder', config.valueColumn)} LIKE ?
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
    limit: number,
  ): Promise<UnifiedOrderSearchSuggestion[]> {
    const keyword = String(query ?? '').trim();
    if (!keyword) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
    const [rakutenRows, amazonRows, manualRows] = await Promise.all([
      this.prisma.rakutenOrderRecord.findMany({
        where: { shippingName: { contains: keyword } },
        select: { shippingName: true },
        orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
        take: normalizedLimit,
      }),
      this.prisma.amazonOrderRecord.findMany({
        where: { recipientName: { contains: keyword } },
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
      ...rakutenRows.map((row) => ({ sourceLabel: '乐天', value: row.shippingName })),
      ...amazonRows.map((row) => ({ sourceLabel: '亚马逊', value: row.recipientName })),
      ...manualRows.map((row) => ({ sourceLabel: '手动订单', value: row.recipientName })),
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
    limit: number,
  ): Promise<UnifiedOrderSearchRow[]> {
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
      manualPhoneIds,
    ] = await Promise.all([
      names.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: { OR: names.map((name) => ({ shippingName: { contains: name } })) },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
            take: limit,
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      names.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: { OR: names.map((name) => ({ recipientName: { contains: name } })) },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
            take: limit,
          })
        : Promise.resolve([] as AmazonOrderRecord[]),
      names.length
        ? ((this.prisma as any).manualOrderRecord.findMany({
            where: { OR: names.map((name) => ({ recipientName: { contains: name } })) },
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
            where: { id: { in: rakutenPhoneIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonPhoneIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: { id: { in: amazonPhoneIds } },
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
      rakuten: { tableName: 'rakuten_order_records', phoneColumn: 'shipping_phone' },
      amazon: { tableName: 'amazon_order_records', phoneColumn: 'buyer_phone_number' },
      manual: { tableName: 'manual_order_records', phoneColumn: 'buyer_phone_number' },
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
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: bigint | number | string }>>(
      `SELECT id FROM ${tableConfig.tableName} WHERE ${whereSql} ORDER BY csv_imported_at DESC, id DESC LIMIT ?`,
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
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: bigint | number | string }>>(
      `SELECT id FROM ${tableName}
       WHERE UPPER(REGEXP_REPLACE(COALESCE(order_id, ''), '[^0-9A-Za-z]', '')) = ?
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
    row: OrderListItem,
  ): UnifiedOrderSearchRow;
  private toUnifiedOrderSearchRow(
    source: 'amazon',
    row: AmazonEnrichedOrderListItem,
  ): UnifiedOrderSearchRow;
  private toUnifiedOrderSearchRow(
    source: 'manual',
    row: ManualEnrichedOrderListItem,
  ): UnifiedOrderSearchRow;
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

  async updateRakutenOrder(idRaw: string, payload: UpdateRakutenOrderPayload): Promise<OrderListItem> {
    const id = parseId(idRaw, 'id');
    const current = await this.prisma.rakutenOrderRecord.findUnique({ where: { id } });
    if (!current) {
      throw new NotFoundException(`乐天订单不存在: ${idRaw}`);
    }
    if (this.hasRegisteredShipmentNo(current)) {
      const shipmentCompany = this.normalizeEditableText(payload.shipmentCompany, '发货公司', 128);
      const shipmentNo = this.normalizeEditableText(payload.shipmentNo, '发货单号', 128);
      const updated = await this.prisma.rakutenOrderRecord.update({
        where: { id },
        data: {
          shipmentCompany,
          shipmentNo,
          shipmentNoRegisteredAt: shipmentNo ? new Date() : null,
          sendStatus: this.resolveSendStatus(shipmentNo),
        },
      });
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
    const dispatchMode = await this.resolveDispatchModeForProductId(productId);
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

    const updated = await this.prisma.rakutenOrderRecord.update({
      where: { id },
      data: {
        orderId,
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
        rawPayload: this.mergeRawPayload(current.rawPayload, {
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

    const [enriched] = await this.enrichOrderRows([updated]);
    return enriched;
  }

  async updateAmazonOrder(idRaw: string, payload: UpdateAmazonOrderPayload): Promise<AmazonEnrichedOrderListItem> {
    const id = parseId(idRaw, 'id');
    const current = await this.prisma.amazonOrderRecord.findUnique({ where: { id } });
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
    const dispatchMode = await this.resolveDispatchModeForProductId(productId);
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
    const current = await (this.prisma as any).manualOrderRecord.findUnique({ where: { id } });
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
    const dispatchMode = await this.resolveDispatchModeForProductId(productId);
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
    const data = await this.buildAmazonManualOrderCreateData(payload, '', 'system_single');
    const row = await this.prisma.$transaction(
      async (tx) => {
        await this.assertManualOrderIdsDoNotExist([data], tx as any);
        return ((tx as any).manualOrderRecord.create({
          data,
        })) as Promise<ManualOrderRecordLike>;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.syncManualOrdersToXyjgBestEffort([row as ManualOrderRecordLike]);
    const [enriched] = await this.enrichManualOrderRows([row as ManualOrderRecordLike]);
    return enriched;
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
      ['MANUAL-001', '', '', '8736', 1, '', '', '2号店-DGAZ store', '山田太郎', '090-0000-0000', '100-0001', '東京都', '千代田区', '千代田1-1', '', '', ''],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '手动订单');
    return {
      fileName: MANUAL_ORDER_UPLOAD_TEMPLATE_FILE,
      content: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    };
  }

  async importAmazonManualOrdersFile(
    fileBuffer: Buffer,
    originalName?: string,
  ): Promise<ManualOrderFileImportResult> {
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
          const created = (await (tx as any).manualOrderRecord.create({ data })) as ManualOrderRecordLike;
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
    payload: DeleteAmazonManualOrdersForXiyaPayload,
  ): Promise<{
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
      payload?.bloggerCooperationId ?? payload?.blogger_cooperation_id ?? '',
    ).trim();
    const rows = (await (this.prisma as any).manualOrderRecord.findMany({
      where: {
        orderId: { in: orderIds },
        OR: [
          { sourceFilePath: XIYA_MANUAL_ORDER_SOURCE_FILE_PATH },
          { bloggerCooperationId: { not: null } },
        ],
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
    })) as Array<{ id: bigint; orderId: string | null; shipmentNo: string | null }>;
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
      throw new ConflictException(`订单 ${String(rowWithShipment.orderId ?? '').trim()} 已经有运单号，请联系海外仓处理`);
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
    return Boolean(bloggerCooperationId) || String(data.sourceFilePath ?? '').trim() === XIYA_MANUAL_ORDER_SOURCE_FILE_PATH;
  }

  async listOverseasWarehouse(limitParam?: string): Promise<OverseasWarehouseOrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const batchSize = Math.min(Math.max(limit, 200), 500);
    const collected: OverseasWarehouseOrderListItem[] = [];
    let rakutenSkip = 0;
    let amazonSkip = 0;
    let manualSkip = 0;
    let rakutenExhausted = false;
    let amazonExhausted = false;
    let manualExhausted = false;

    while (collected.length < limit && (!rakutenExhausted || !amazonExhausted || !manualExhausted)) {
      const [rakutenRows, amazonRows, manualRows]: [RakutenOrderRecord[], AmazonOrderRecord[], ManualOrderRecordLike[]] = await Promise.all([
        rakutenExhausted
          ? Promise.resolve([] as RakutenOrderRecord[])
          : this.prisma.rakutenOrderRecord.findMany({
              where: {
                sendStatus: OrderSendStatus.unsent,
                OR: [{ dispatchMode: null }, { dispatchMode: '' }, { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS }],
              },
              orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
              skip: rakutenSkip,
              take: batchSize,
            }),
        amazonExhausted
          ? Promise.resolve([] as AmazonOrderRecord[])
          : this.prisma.amazonOrderRecord.findMany({
              where: {
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
              skip: amazonSkip,
              take: batchSize,
            }),
        manualExhausted
          ? Promise.resolve([] as ManualOrderRecordLike[])
          : (this.prisma as any).manualOrderRecord.findMany({
              where: {
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
          .filter(
            (row) =>
              row.fulfillmentMode === 'overseas_warehouse' &&
              row.availableStock > 0 &&
              !activePickedRefs.has(`rakuten:${row.id.toString()}`),
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
              row.availableStock > 0 &&
              !activePickedRefs.has(`amazon:${row.id.toString()}`),
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
              row.availableStock > 0 &&
              !activePickedRefs.has(`manual:${row.id.toString()}`),
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
        where: {
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
        enrichedRow.availableStock <= 0 ||
        activePickedRefs.has(`rakuten:${id.toString()}`)
      ) {
        throw new BadRequestException('当前订单已不在海外仓待处理范围内，无法切中国发');
      }
      await this.prisma.rakutenOrderRecord.update({
        where: { id },
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
              id,
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
                    { dispatchMode: OVERSEAS_DISPATCH_MODE.OVERSEAS },
                  ],
                },
              ],
            },
          });
    if (!row) {
      throw new NotFoundException(`${source === 'manual' ? '手动订单' : '亚马逊订单'}不存在或当前不可切中国发: ${idRaw}`);
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
      enrichedRow.availableStock <= 0 ||
      activePickedRefs.has(`${source}:${id.toString()}`)
    ) {
      throw new BadRequestException('当前订单已不在海外仓待处理范围内，无法切中国发');
    }
    if (source === 'amazon') {
      const orderId = String((row as AmazonOrderRecord).orderId ?? '').trim();
      const scopedRows = orderId
        ? await this.prisma.amazonOrderRecord.findMany({
            where: {
              orderId,
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
  ): Promise<OverseasWarehouseOrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
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
      const [rakutenRows, amazonRows, manualRows]: [RakutenOrderRecord[], AmazonOrderRecord[], ManualOrderRecordLike[]] = await Promise.all([
        rakutenExhausted
          ? Promise.resolve([] as RakutenOrderRecord[])
          : this.prisma.rakutenOrderRecord.findMany({
              where: {
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

  async deleteAmazonBatch(payload: {
    ids?: Array<string | number>;
  }): Promise<{ deletedCount: number }> {
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

    const result = await this.prisma.amazonOrderRecord.deleteMany({
      where: { id: { in: ids } },
    });

    return { deletedCount: result.count };
  }

  async deleteManualBatch(payload: {
    ids?: Array<string | number>;
  }): Promise<{ deletedCount: number }> {
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

  private buildAmazonShipmentConfirmationTxtContent(rows: Array<AmazonOrderRecord | AmazonEnrichedOrderListItem>): Buffer {
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
        },
      ),
    ];
    return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
  }

  async buildRakutenShipmentConfirmationCsv(payload: {
    days?: string | number;
  }): Promise<RakutenShipmentConfirmationFileResult> {
    const scope = this.normalizeShipmentConfirmationScope(payload?.days, '订单');
    const importedAtStart = scope.days === 'all' ? null : this.getImportDateRangeStart(scope.days);

    const rows = await this.prisma.rakutenOrderRecord.findMany({
      where: {
        shipmentNo: { not: null },
        shipmentNoRegisteredAt: { not: null },
        ...(importedAtStart ? { csvImportedAt: { gte: importedAtStart } } : {}),
      },
      orderBy: [{ csvImportedAt: 'desc' }, { shipmentNoRegisteredAt: 'asc' }, { id: 'asc' }],
    });
    if (!rows.length) {
      throw new BadRequestException(`${scope.label}没有可下载的已登记发货单号乐天订单`);
    }

    const clearedRows = rows.filter((row) => this.resolveRakutenTrackingClearanceStatusFromRow(row).hasCustomsClearance);
    if (!clearedRows.length) {
      throw new BadRequestException(
        `${scope.label}没有已取得「${UOF_TRACKING_CUSTOMS_CLEARANCE_TEXT}」快递状态的乐天订单`,
      );
    }

    const invalidRows = clearedRows
      .map((row) => {
        const missingFields = [
          String(row.orderId ?? '').trim() ? null : '注文番号',
          row.shipmentNoRegisteredAt ? null : '発送日',
          String(row.shipmentNo ?? '').trim() ? null : 'お荷物伝票番号',
        ].filter((item): item is string => Boolean(item));
        return missingFields.length ? `${row.orderId ?? row.id.toString()} 缺少 ${missingFields.join('、')}` : null;
      })
      .filter((item): item is string => Boolean(item));
    if (invalidRows.length) {
      throw new BadRequestException(`无法生成乐天回传单号CSV：${invalidRows.join('；')}`);
    }

    const chinaDispatchOrderRecordIdsByOrderId =
      await this.loadRakutenChinaDispatchOrderRecordIdsByOrderId(clearedRows);
    const headers = ['注文番号', '送付先ID', '発送明細ID', 'お荷物伝票番号', '配送会社', '発送日'];
    const lines = [
      headers.map((value) => this.escapeCsvCell(value)).join(','),
      ...clearedRows.map((row) =>
        [
          row.orderId,
          this.resolveRakutenShippingDestinationId(row),
          this.resolveRakutenShippingDetailId(row, chinaDispatchOrderRecordIdsByOrderId),
          this.normalizeAmazonTrackingNumber(row.shipmentNo),
          this.resolveRakutenShipmentCarrierCode(row),
          this.formatRakutenShipmentConfirmationDate(row.shipmentNoRegisteredAt as Date),
        ]
          .map((value) => this.escapeCsvCell(value))
          .join(','),
      ),
    ];

    return {
      fileName: `${this.formatYamatoFileNameStamp()}_${scope.fileLabel}_ShippingCompletion.csv`,
      content: iconv.encode(`${lines.join('\r\n')}\r\n`, 'cp932'),
      rowCount: clearedRows.length,
      skippedWithoutCustomsClearanceCount: rows.length - clearedRows.length,
    };
  }

  async deleteRakutenBatch(payload: {
    ids?: Array<string | number>;
  }): Promise<{ deletedCount: number }> {
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
      throw new BadRequestException('请至少选择一条乐天订单记录');
    }

    await this.assertOrderRecordsHaveNoShipmentNo('rakuten', ids);
    await this.assertOrderRecordsNotInOverseasPickingBatch('rakuten', ids);

    const result = await this.prisma.rakutenOrderRecord.deleteMany({
      where: { id: { in: ids } },
    });

    return { deletedCount: result.count };
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
            where: { id: { in: rakutenIds } },
            orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: { id: { in: amazonIds } },
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

    const [enrichedRakutenRows, enrichedAmazonRows, enrichedManualRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
      this.enrichManualOrderRows(manualRows),
    ]);

    const rakutenMap = new Map(
      enrichedRakutenRows
        .filter((row) => row.fulfillmentMode === 'overseas_warehouse' && row.availableStock > 0)
        .map((row) => [row.id.toString(), row] as const),
    );
    const amazonMap = new Map(
      enrichedAmazonRows
        .filter((row) => row.fulfillmentMode === 'overseas_warehouse' && row.availableStock > 0)
        .map((row) => [row.id.toString(), row] as const),
    );
    const manualMap = new Map(
      enrichedManualRows
        .filter((row) => row.fulfillmentMode === 'overseas_warehouse' && row.availableStock > 0)
        .map((row) => [row.id.toString(), row] as const),
    );

    const items: OverseasPickingBatchItemSnapshot[] = [];
    selectedItems.forEach((item, index) => {
      const source = item?.source;
      const id = String(item?.id ?? '').trim();
      if (!id || (source !== 'rakuten' && source !== 'amazon' && source !== 'manual')) {
        throw new BadRequestException(`items[${index}] 缺少有效的 source 或 id`);
      }

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
        throw new BadRequestException(`${source === 'manual' ? '手动订单' : '亚马逊订单'} ${id} 不存在、无库存或已不在海外仓处理范围内`);
      }
      const orderId = String(row.orderId ?? '').trim();
      const productId = String(row.resolvedProductId ?? '').trim();
      const skuCode = String(row.sku ?? (source === 'manual' ? productId : '')).trim();
      const requestedQty = Number(row.quantityPurchased ?? 0);
      if (!orderId || !productId || !skuCode || requestedQty <= 0) {
        const requiredFieldsText = source === 'manual' ? '订单号、产品ID 或数量' : '订单号、产品ID、SKU 或数量';
        throw new BadRequestException(`${source === 'manual' ? '手动订单' : '亚马逊订单'} ${id} 缺少有效的${requiredFieldsText}`);
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
  ): Promise<void> {
    const demandByProductId = new Map<string, number>();
    snapshots.forEach((item) => {
      const productId = String(item.productId ?? '').trim();
      if (!productId) return;
      demandByProductId.set(productId, (demandByProductId.get(productId) ?? 0) + Number(item.requestedQty ?? 0));
    });
    const productIds = Array.from(demandByProductId.keys());
    if (!productIds.length) {
      return;
    }
    const stockRows = await this.prisma.masterProduct.findMany({
      where: {
        productId: {
          in: productIds,
        },
      },
      select: {
        productId: true,
        stockQty: true,
      },
    });
    const stockByProductId = new Map(stockRows.map((row) => [String(row.productId ?? '').trim(), Number(row.stockQty ?? 0)]));
    const shortageTexts = productIds
      .map((productId) => {
        const requestedQty = demandByProductId.get(productId) ?? 0;
        const stockQty = stockByProductId.get(productId) ?? 0;
        const shortageQty = requestedQty - stockQty;
        if (shortageQty <= 0) return null;
        return `产品 ${productId} 待拣 ${requestedQty}，库存 ${stockQty}，需要踢出 ${shortageQty}`;
      })
      .filter((item): item is string => Boolean(item));
    if (shortageTexts.length) {
      throw new ConflictException(`批次待拣数量超过库存：${shortageTexts.join('；')}`);
    }
  }

  private async findActiveOverseasPickingBatchDuplicates(
    snapshots: OverseasPickingBatchItemSnapshot[],
  ): Promise<string[]> {
    if (!snapshots.length) {
      return [];
    }
    const duplicateRows = await this.prisma.overseasPickingBatchItem.findMany({
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
  ): Promise<void> {
    const locationMetaByProductId = await this.loadOverseasPickingBatchLocationMeta(
      snapshots.map((item) => item.productId),
    );
    const remainingLocationsByProductId = new Map<
      string,
      Array<{ shelfCode: string | null; boxCode: string | null; qty: number; originalQty: number }>
    >();

    snapshots.forEach((snapshot) => {
      const productId = String(snapshot.productId ?? '').trim();
      if (!productId || remainingLocationsByProductId.has(productId)) {
        return;
      }
      const locations = locationMetaByProductId.get(productId)?.locations ?? [];
      remainingLocationsByProductId.set(
        productId,
        locations.map((location) => ({
          shelfCode: location.shelfCode ?? null,
          boxCode: location.boxCode ?? null,
          qty: Number(location.qty ?? 0),
          originalQty: Number(location.qty ?? 0),
        })),
      );
    });

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

  private async loadActiveOverseasPickingBatchRefs(
    refs: Array<{ source: 'rakuten' | 'amazon' | 'manual'; sourceRecordId: bigint }>,
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
    payload: OverseasPickingBatchConfirmPayload,
  ): Map<string, number> {
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

  private resolveNextOverseasPickingProduct(
    items: Array<{
      productId: string;
      requestedQty: number | null;
      actualQty: number | null;
      dispatchMode: string | null;
    }>,
    locationMetaByProductId: Map<
      string,
      {
        shelfCode: string | null;
        boxCode: string | null;
        productName: string | null;
        stockQty: number;
        locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number }>;
      }
    >,
  ): { productId: string; productName: string | null; shelfCode: string | null; boxCode: string | null } | null {
    const groupedItems = new Map<
      string,
      {
        productId: string;
        productName: string | null;
        shelfCode: string | null;
        boxCode: string | null;
        sortKey: string;
        requestedQty: number;
        actualQty: number;
      }
    >();

    items
      .filter(
        (item) =>
          String(item.dispatchMode ?? OVERSEAS_DISPATCH_MODE.OVERSEAS).trim() === OVERSEAS_DISPATCH_MODE.OVERSEAS,
      )
      .forEach((item) => {
        const productId = String(item.productId ?? '').trim();
        if (!productId) return;
        const locationMeta = locationMetaByProductId.get(productId) ?? null;
        const aggregate =
          groupedItems.get(productId) ??
          {
            productId,
            productName: locationMeta?.productName ?? null,
            shelfCode: locationMeta?.shelfCode ?? null,
            boxCode: locationMeta?.boxCode ?? null,
            sortKey: `${locationMeta?.shelfCode ?? 'ZZZ'}|${locationMeta?.boxCode ?? 'ZZZ'}|${productId}`,
            requestedQty: 0,
            actualQty: 0,
          };
        aggregate.requestedQty += Number(item.requestedQty ?? 0);
        aggregate.actualQty += Number(item.actualQty ?? 0);
        groupedItems.set(productId, aggregate);
      });

    const nextItem =
      Array.from(groupedItems.values())
        .sort((left, right) => left.sortKey.localeCompare(right.sortKey, 'zh-Hans-CN'))
        .find((item) => item.actualQty < item.requestedQty) ?? null;
    if (!nextItem) {
      return null;
    }

    return {
      productId: nextItem.productId,
      productName: nextItem.productName,
      shelfCode: nextItem.shelfCode,
      boxCode: nextItem.boxCode,
    };
  }

  private allocateOverseasPickingQtyAcrossBoxes(
    rows: Array<{ boxId: bigint; qty: number | null; productId: string }>,
    requestedQty: number,
    productId: string,
  ): Array<{ boxId: bigint; qty: number; nextQty: number }> {
    let remaining = requestedQty;
    const allocations: Array<{ boxId: bigint; qty: number; nextQty: number }> = [];

    for (const row of rows) {
      const currentQty = Number(row.qty ?? 0);
      if (currentQty <= 0 || remaining <= 0) continue;
      const allocateQty = Math.min(currentQty, remaining);
      remaining -= allocateQty;
      row.qty = currentQty - allocateQty;
      allocations.push({
        boxId: row.boxId,
        qty: allocateQty,
        nextQty: Number(row.qty ?? 0),
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

  private mergeOverseasPickingPlanSnapshots(
    plans: OverseasPickingPlanSnapshotItem[],
  ): OverseasPickingPlanSnapshotItem[] {
    const mergedByLocation = new Map<string, OverseasPickingPlanSnapshotItem>();
    plans.forEach((plan) => {
      const key = `${plan.shelfCode ?? ''}\u001f${plan.boxCode ?? ''}`;
      const current = mergedByLocation.get(key);
      if (!current) {
        mergedByLocation.set(key, { ...plan });
        return;
      }
      current.boxQty = Math.max(Number(current.boxQty ?? 0), Number(plan.boxQty ?? 0));
      current.pickQty += Number(plan.pickQty ?? 0);
    });
    return Array.from(mergedByLocation.values());
  }

  private async buildYamatoExportItemsFromPickingBatchItems(
    items: Array<{
      source: string;
      sourceRecordId: bigint;
      productId: string;
      actualQty: number | null;
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
          .filter((value) => value.length > 0),
      ),
    );

    const [rakutenRows, amazonRows, manualRows, productRows]: [
      RakutenOrderRecord[],
      AmazonOrderRecord[],
      ManualOrderRecordLike[],
      Array<{ productId: string; yamatoPrinterName: string | null }>,
    ] = await Promise.all([
      rakutenIds.length
        ? this.prisma.rakutenOrderRecord.findMany({
            where: { id: { in: rakutenIds } },
          })
        : Promise.resolve([] as RakutenOrderRecord[]),
      amazonIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: { id: { in: amazonIds } },
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
        : Promise.resolve([] as Array<{ productId: string; yamatoPrinterName: string | null }>),
    ]);

    const rakutenMap = new Map(rakutenRows.map((row) => [row.id.toString(), row] as const));
    const amazonMap = new Map(amazonRows.map((row) => [row.id.toString(), row] as const));
    const manualMap = new Map(manualRows.map((row) => [row.id.toString(), row] as const));
    const printerValueByProductId = new Map(
      productRows.map((row) => [row.productId, String(row.yamatoPrinterName ?? '').trim() || '0'] as const),
    );

    return items.map((item) => {
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
          printerValue: printerValueByProductId.get(item.productId) ?? '0',
          quantity,
          deliveryDate: String(
            this.getJsonField(row.rawPayload, RAKUTEN_ORDER_HEADERS.deliveryDateRaw) ?? row.deliveryDateRaw ?? '',
          ).trim(),
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
  ): Promise<
    Map<
      string,
      {
        shelfCode: string | null;
        boxCode: string | null;
        productName: string | null;
        stockQty: number;
        locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number }>;
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
      this.prisma.masterProductBoxInventory.findMany({
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
      this.prisma.masterProduct.findMany({
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
        locations: Array<{ shelfCode: string | null; boxCode: string | null; qty: number }>;
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
      const itemPart = `${item.productId}*${item.quantity}個`;
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
    const mergedPdfBuffer = await this.mergeUploadedPdfPagesInBatchOrder(orderedUploadedPages);

    const trackingNumbers = parsedPages.map((page) =>
      this.extractTrackingNoFromPdfText(page?.text ?? ''),
    );
    trackingNumbers.forEach((trackingNo, index) => {
      if (!trackingNo) {
        throw new BadRequestException(`PDF 第 ${parsedPages[index]?.pageNo ?? index + 1} 页未识别到快递单号`);
      }
    });

    const sanitizedFileName = this.getYamatoUploadFileName(batch.id, validFiles);
    const pdfPath = this.buildYamatoBatchPdfPath(batch.id.toString(), sanitizedFileName);
    await this.ensureYamatoBatchDir(batch.id.toString());
    await writeFile(pdfPath, mergedPdfBuffer);

    const manualOrderIdsForXyjg = new Set<bigint>();
    await this.prisma.$transaction(async (tx) => {
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
          },
        );
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
          where: { id: { in: rakutenIds }, orderId },
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
    await this.markYamatoShipmentBatchPagePrinted(prepared.pageId, prepared.productId);

    return {
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
    const { batch, targetPage, productId, printablePages } = await this.findPrintableYamatoShipmentPageByProductId(
      batchIdRaw,
      payload,
    );
    const productIds = this.getBatchPageProductIds(targetPage);
    return {
      batchId: batch.id.toString(),
      pageNo: targetPage.pageNo,
      orderId: targetPage.orderId ?? null,
      trackingNo: targetPage.trackingNo ?? null,
      productId,
      productIds,
      itemSummary: targetPage.itemSummary ?? null,
      recipientName: targetPage.recipientName ?? null,
      products: await this.buildYamatoShipmentPageProductDetails(targetPage),
      remainingMatchCount: Math.max(printablePages.length - 1, 0),
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
    const printJob = await this.sendPdfBufferToPrinter(prepared.content, prepared.fileName);
    await this.markYamatoShipmentBatchPagePrinted(prepared.pageId, prepared.productId);

    return {
      batchId: prepared.batchId,
      fileName: prepared.fileName,
      pageNo: prepared.pageNo,
      trackingNo: prepared.trackingNo,
      productId: prepared.productId,
      remainingMatchCount: prepared.remainingMatchCount,
      printerName: printJob.printerName,
      printJobId: printJob.printJobId,
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

    let prepared: PreparedYamatoShipmentPrintResult;
    try {
      prepared = await this.prepareYamatoShipmentLabelByProductId(batchIdRaw, payload, {
        excludeActivePrintJobs: true,
      });
    } catch (error) {
      if (
        !(error instanceof BadRequestException) ||
        !String(error.message).includes('对应面单已全部打印或正在打印中')
      ) {
        throw error;
      }
      prepared = await this.prepareYamatoShipmentLabelByProductId(batchIdRaw, payload);
    }
    const printerName = await this.resolveYamatoPrinterNameForProductIds(prepared.productIds);
    const activeJob = await this.prisma.printJob.findFirst({
      where: {
        batchPageId: prepared.pageId,
        status: {
          in: [PrintJobStatus.pending, PrintJobStatus.claimed],
        },
      },
      orderBy: [{ id: 'desc' }],
    });
    if (activeJob) {
      const staleReason = this.getReusablePrintJobBlockReason(activeJob, printerName);
      if (!staleReason) {
        if (payload.acceptActivePrintJob === true) {
          await this.prisma.printJob.updateMany({
            where: {
              id: activeJob.id,
              status: {
                in: [PrintJobStatus.pending, PrintJobStatus.claimed],
              },
            },
            data: {
              status: PrintJobStatus.failed,
              failedAt: new Date(),
              errorMessage: 'requeued after merged label confirmation',
            },
          });
        } else {
          throw new BadRequestException('该面单已在打印队列中，请勿重复扫码');
        }
      } else {
        await this.prisma.printJob.updateMany({
          where: {
            id: activeJob.id,
            status: {
              in: [PrintJobStatus.pending, PrintJobStatus.claimed],
            },
          },
          data: {
            status: PrintJobStatus.failed,
            failedAt: new Date(),
            errorMessage: staleReason,
          },
        });
      }
    }

    return this.createYamatoShipmentPrintJob(prepared, printerName);
  }

  private async createYamatoShipmentPrintJob(
    prepared: PreparedYamatoShipmentPrintResult,
    printerName: string | null,
  ): Promise<YamatoShipmentQueuedPrintResult> {
    const created = await this.prisma.printJob.create({
      data: {
        jobType: 'yamato_label',
        status: PrintJobStatus.pending,
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
      await this.prisma.printJob.update({
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
      await this.prisma.printJob.update({
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

    const prepared = await this.prepareYamatoShipmentLabelByProductId(batchIdRaw, payload);
    const printerName = await this.resolveYamatoPrinterNameForProductIds(prepared.productIds);
    const cleared = await this.prisma.printJob.updateMany({
      where: {
        batchPageId: prepared.pageId,
        status: {
          in: [PrintJobStatus.pending, PrintJobStatus.claimed],
        },
      },
      data: {
        status: PrintJobStatus.failed,
        failedAt: new Date(),
        errorMessage: 'manual reprint requested',
      },
    });
    const queued = await this.createYamatoShipmentPrintJob(prepared, printerName);
    return {
      ...queued,
      clearedJobCount: cleared.count,
    };
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
      },
    });
    if (!job || job.jobType !== 'yamato_label') {
      throw new NotFoundException(`Yamato 打印任务不存在: ${jobIdRaw}`);
    }
    return job;
  }

  private async prepareYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: YamatoShipmentPrintByProductPayload,
    options: { excludeActivePrintJobs?: boolean } = {},
  ): Promise<PreparedYamatoShipmentPrintResult> {
    const { batch, targetPage, productId, printablePages } = await this.findPrintableYamatoShipmentPageByProductId(
      batchIdRaw,
      payload,
      options,
    );

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
    options: { excludeActivePrintJobs?: boolean } = {},
  ): Promise<{
    batch: YamatoShipmentBatch & { pages: YamatoShipmentBatchPage[] };
    targetPage: YamatoShipmentBatchPage;
    productId: string;
    printablePages: YamatoShipmentBatchPage[];
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

    let printablePages = batch.pages.filter(
      (page) =>
        !page.printedAt &&
        (pageNo === null || page.pageNo === pageNo) &&
        this.getBatchPageProductIds(page).some(
          (candidate) => candidate.localeCompare(productId, undefined, { sensitivity: 'accent' }) === 0,
        ),
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
        },
      });
      const activePageIds = new Set(activeJobs.map((job) => job.batchPageId?.toString()).filter(Boolean));
      printablePages = printablePages.filter((page) => !activePageIds.has(page.id.toString()));
    }
    if (!printablePages.length) {
      throw new BadRequestException(`当前批次中产品ID ${productId} 对应面单已全部打印或正在打印中`);
    }

    return {
      batch,
      targetPage: printablePages[0],
      productId,
      printablePages,
    };
  }

  private async markYamatoShipmentBatchPagePrinted(pageId: bigint, productId: string): Promise<void> {
    const result = await this.prisma.yamatoShipmentBatchPage.updateMany({
      where: {
        id: pageId,
        printedAt: null,
      },
      data: {
        printedAt: new Date(),
        printedProductId: productId,
      },
    });
    if (result.count !== 1) {
      throw new BadRequestException('该面单已被其他操作打印，请刷新批次后重试');
    }
  }

  private async loadPdfJsModule(): Promise<{
    getDocument: (source: { data: Uint8Array; disableWorker?: boolean }) => { promise: Promise<unknown> };
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
        getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
      }>;
    };

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
    const usedUploadedPageIndexes = new Set<number>();
    return batchPages.map((batchPage) => {
      const expectedText = this.describeYamatoBatchPageExpectation(batchPage);
      let bestUploadedPageIndex = -1;
      let bestScore = 0;

      uploadedPages.forEach((uploadedPage, uploadedPageIndex) => {
        if (usedUploadedPageIndexes.has(uploadedPageIndex)) {
          return;
        }
        const score = this.scorePdfTextForYamatoBatchPage(uploadedPage.text, batchPage);
        if (score <= 0) {
          return;
        }
        if (score > bestScore) {
          bestUploadedPageIndex = uploadedPageIndex;
          bestScore = score;
        }
      });

      if (bestUploadedPageIndex < 0) {
        throw new BadRequestException(`PDF 中未找到第 ${batchPage.pageNo} 张预期面单：${expectedText}`);
      }

      usedUploadedPageIndexes.add(bestUploadedPageIndex);
      return uploadedPages[bestUploadedPageIndex];
    });
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

  private getReusablePrintJobBlockReason(
    job: {
      status: PrintJobStatus;
      printerName: string | null;
      queuedAt: Date;
      claimedAt: Date | null;
    },
    currentPrinterName: string | null,
  ): string | null {
    const jobPrinterName = String(job.printerName ?? '').trim();
    const nextPrinterName = String(currentPrinterName ?? '').trim();
    if (jobPrinterName !== nextPrinterName) {
      return `printer route changed from ${jobPrinterName || '(default)'} to ${nextPrinterName || '(default)'}`;
    }

    const activeAt = job.status === PrintJobStatus.claimed ? (job.claimedAt ?? job.queuedAt) : job.queuedAt;
    if (activeAt.getTime() <= Date.now() - YAMATO_PRINT_JOB_STALE_MS) {
      return 'print job timed out before retry';
    }

    return null;
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
  ): Promise<{ printerName: string | null; printJobId: string | null }> {
    const printerName = this.getConfiguredYamatoPrinterName() || null;
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
      const { stdout, stderr } = await execFileAsync('lp', args);
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
    page: Pick<YamatoShipmentBatchPage, 'productIds' | 'itemSummary'>,
  ): Promise<YamatoShipmentPageProductDetail[]> {
    const parsedItems = this.parseYamatoItemSummaryProductQuantities(page.itemSummary, this.getBatchPageProductIds(page));
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
    return parsedItems.map((item) => ({
      productId: item.productId,
      productName: productNameById.get(item.productId) ?? null,
      quantity: item.quantity,
    }));
  }

  private parseYamatoItemSummaryProductQuantities(
    itemSummary: string | null | undefined,
    fallbackProductIds: string[],
  ): Array<{ productId: string; quantity: number }> {
    const quantityByProductId = new Map<string, number>();
    const summary = String(itemSummary ?? '').trim().replace(/^DGAZ\s*/i, '');
    summary
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const starIndex = part.lastIndexOf('*');
        if (starIndex <= 0) return;
        const productId = part.slice(0, starIndex).trim();
        const quantityText = part.slice(starIndex + 1).replace(/[^\d]/g, '');
        const quantity = Number.parseInt(quantityText, 10);
        if (!productId || !Number.isInteger(quantity) || quantity <= 0) return;
        quantityByProductId.set(productId, (quantityByProductId.get(productId) ?? 0) + quantity);
      });

    fallbackProductIds.forEach((productId) => {
      if (!quantityByProductId.has(productId)) {
        quantityByProductId.set(productId, 1);
      }
    });

    return Array.from(quantityByProductId.entries()).map(([productId, quantity]) => ({
      productId,
      quantity,
    }));
  }

  private scorePdfTextForYamatoBatchPage(
    text: string,
    page: Pick<YamatoShipmentBatchPage, 'productIds' | 'orderId' | 'recipientName'>,
  ): number {
    let score = 0;
    const expectedProductIds = this.getBatchPageProductIds(page);
    if (expectedProductIds.some((productId) => this.pdfTextContainsProductId(text, productId))) {
      score += 100;
    }

    const normalizedText = this.normalizePdfComparableText(text);
    const orderId = String(page.orderId ?? '').trim();
    if (orderId && normalizedText.includes(this.normalizePdfComparableText(orderId))) {
      score += 50;
    }

    const recipientName = String(page.recipientName ?? '').trim();
    if (recipientName && normalizedText.includes(this.normalizePdfComparableText(recipientName))) {
      score += 10;
    }

    return score;
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
    const normalizedText = this.normalizePdfComparableText(text);
    const normalizedProductId = this.normalizePdfComparableText(productId);
    if (!normalizedText || !normalizedProductId) {
      return false;
    }
    return normalizedText.includes(normalizedProductId);
  }

  private normalizePdfComparableText(value: string): string {
    return String(value ?? '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
  }

  private extractTrackingNoFromPdfText(text: string): string | null {
    const hyphenated = text.match(/\b\d{4}-\d{4}-\d{4}\b/);
    if (hyphenated?.[0]) {
      return hyphenated[0];
    }

    const plain = text.match(/\b\d{12}\b/);
    if (!plain?.[0]) {
      return null;
    }
    const digits = plain[0];
    return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`;
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
    currentDate: string,
  ): Promise<Buffer> {
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
        `<dimension ref="A1:${finalColumn}${maxRow}"/>`,
      );

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
      this.normalizeYamatoOptionalCellValue(row.address2),
    );
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.recipientName), row.recipientName);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.recipientSuffix),
      YAMATO_EXPORT_FIXED_VALUES.recipientSuffix,
    );
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.senderPhone), YAMATO_EXPORT_FIXED_VALUES.senderPhone);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.senderPostalCode),
      YAMATO_EXPORT_FIXED_VALUES.senderPostalCode,
    );
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.senderAddress),
      YAMATO_EXPORT_FIXED_VALUES.senderAddress,
    );
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.senderName), YAMATO_EXPORT_FIXED_VALUES.senderName);
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.itemSummary), row.itemSummary);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.invoiceCustomerCode),
      YAMATO_EXPORT_FIXED_VALUES.invoiceCustomerCode,
    );
    values.set(XLSX.utils.encode_col(YAMATO_COLUMNS.coolType), YAMATO_EXPORT_FIXED_VALUES.coolType);
    values.set(
      XLSX.utils.encode_col(YAMATO_COLUMNS.deliveryType),
      YAMATO_EXPORT_FIXED_VALUES.deliveryType,
    );
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

  private formatAmazonShipmentConfirmationDate(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  private formatRakutenShipmentConfirmationDate(date: Date): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}${parts.month}${parts.day}`;
  }

  private formatYamatoFileNameStamp(date: Date = new Date()): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
  }

  private normalizeAmazonTrackingNumber(value: string | null | undefined): string {
    const raw = String(value ?? '').trim();
    const digits = raw.replace(/\D/g, '');
    return digits.length === 12 ? digits : raw;
  }

  private escapeTsvCell(value: string | number | null | undefined): string {
    return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  }

  private escapeCsvCell(value: string | number | null | undefined): string {
    const normalized = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  private resolveRakutenShippingDestinationId(row: RakutenOrderRecord): string {
    return (
      this.getJsonField(row.rawPayload, '送付先ID') ??
      this.getJsonField(row.rawPayload, '送付先Id') ??
      this.getJsonField(row.rawPayload, '送付先id') ??
      row.shipmentRequestNo ??
      ''
    );
  }

  private resolveRakutenShippingDetailId(
    row: RakutenOrderRecord,
    chinaDispatchOrderRecordIdsByOrderId: Map<string, Set<string>>,
  ): string {
    const orderId = String(row.orderId ?? '').trim();
    if (!orderId) {
      return '';
    }
    const chinaRecordIds = chinaDispatchOrderRecordIdsByOrderId.get(orderId);
    if (!chinaRecordIds?.size) {
      return '';
    }
    if (chinaRecordIds.has(row.id.toString())) {
      return '中国発';
    }
    return '中国発あり';
  }

  private resolveRakutenShipmentCarrierCode(row: RakutenOrderRecord): string {
    return String(row.shipmentCompany ?? '').trim().toUpperCase() === 'XIYA-SAGAWA' ? '1002' : '1001';
  }

  private async loadRakutenChinaDispatchOrderRecordIdsByOrderId(
    rows: RakutenOrderRecord[],
  ): Promise<Map<string, Set<string>>> {
    const orderIds = Array.from(
      new Set(
        rows
          .map((row) => String(row.orderId ?? '').trim())
          .filter((orderId) => orderId.length > 0),
      ),
    );
    if (!orderIds.length) {
      return new Map();
    }

    const relatedRows = await this.prisma.rakutenOrderRecord.findMany({
      where: {
        orderId: { in: orderIds },
      },
      orderBy: [{ id: 'asc' }],
    });
    const enrichedRows = await this.enrichOrderRows(relatedRows);
    const activePickedRefs = await this.loadActiveOverseasPickingBatchRefs(
      enrichedRows.map((row) => ({
        source: 'rakuten' as const,
        sourceRecordId: row.id,
      })),
    );
    const result = new Map<string, Set<string>>();
    for (const row of enrichedRows) {
      if (!this.isRakutenChinaDispatchRow(row, activePickedRefs)) {
        continue;
      }
      const orderId = String(row.orderId ?? '').trim();
      if (!orderId) {
        continue;
      }
      const ids = result.get(orderId) ?? new Set<string>();
      ids.add(row.id.toString());
      result.set(orderId, ids);
    }
    return result;
  }

  private isRakutenChinaDispatchRow(row: OrderListItem, activePickedRefs: Set<string>): boolean {
    const dispatchMode = String(row.dispatchMode ?? '').trim();
    if (this.isChinaDispatchMode(dispatchMode)) {
      return true;
    }
    if (row.xiyaExportedAt) {
      return true;
    }
    const shipmentCompany = String(row.shipmentCompany ?? '').trim();
    if (shipmentCompany === 'Xiya' || shipmentCompany === 'SAGAWA' || shipmentCompany === 'YAMATO') {
      return true;
    }
    return row.fulfillmentMode === 'xiya_api' && !activePickedRefs.has(`rakuten:${row.id.toString()}`);
  }

  private normalizeShipmentConfirmationScope(daysRaw: string | number | null | undefined, noun: string): {
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
    return `PK-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
  }

  async importUploadedCsv(
    fileBuffer: Buffer,
    originalName?: string,
  ): Promise<OrderImportResult> {
    const sourceFileName = String(originalName ?? '').trim() || 'rakuten-orders.csv';
    return this.importCsvBuffer(fileBuffer, sourceFileName, `uploaded:${sourceFileName}`);
  }

  async importAmazonTxt(
    fileBuffer: Buffer,
    originalName?: string,
  ): Promise<AmazonOrderImportResult> {
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
        where: {
          sendStatus: OrderSendStatus.unsent,
          OR: [{ shipmentNo: null }, { shipmentNo: '' }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.amazonOrderRecord.findMany({
        where: {
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
        .filter((row) => this.shouldExportOrderToThirdParty('rakuten', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs))
        .map((row) => ({
          createdAt: row.createdAt,
          row: this.toThirdPartyRow(row),
        })),
      ...enrichedAmazonRows
        .filter((row) => this.shouldExportOrderToThirdParty('amazon', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs))
        .map((row) => ({
          createdAt: row.createdAt,
          row: this.toAmazonThirdPartyRow(row),
        })),
      ...enrichedManualRows
        .filter((row) => this.shouldExportOrderToThirdParty('manual', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs))
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
    items?: ThirdPartyExportAckItem[];
  }): Promise<{
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
            where: {
              id: { in: rakutenIds },
              sendStatus: OrderSendStatus.unsent,
              xiyaExportedAt: null,
            },
          })
        : Promise.resolve([]),
      amazonIds.length
        ? this.prisma.amazonOrderRecord.findMany({
            where: {
              id: { in: amazonIds },
              AND: [
                { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                { xiyaExportedAt: null },
              ],
            },
          })
        : Promise.resolve([]),
      manualIds.length
        ? (this.prisma as any).manualOrderRecord.findMany({
            where: {
              id: { in: manualIds },
              AND: [
                { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
                { xiyaExportedAt: null },
              ],
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
        this.shouldExportOrderToThirdParty('rakuten', row.id, row.dispatchMode, row.fulfillmentMode, activePickedRefs),
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
            where: {
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
      const fetchedRows = await this.fetchXiyaLogisticsRows();
      const candidates = this.normalizeXiyaTrackingCandidates(fetchedRows);
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
          deduplicatedCandidates,
        ),
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
    latestCheckedAt: string | null;
    pendingTrackingNoCount: number;
  }> {
    if (this.rakutenTrackingStatusSyncRunning) {
      throw new ConflictException('当前已有乐天快递状态同步任务正在执行，请稍后再试');
    }

    this.rakutenTrackingStatusSyncRunning = true;
    try {
      const rows = await this.prisma.rakutenOrderRecord.findMany({
        where: {
          shipmentNo: { not: null, notIn: [''] },
          trackingIsDelivered: false,
          ...this.buildRakutenChinaDispatchWhere(),
        },
        orderBy: [
          { trackingCheckedAt: 'asc' },
          { shipmentNoRegisteredAt: 'desc' },
          { id: 'desc' },
        ],
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
        latestCheckedAt: summary.latestCheckedAt,
        pendingTrackingNoCount: summary.pendingTrackingNoCount,
      };
    } finally {
      this.rakutenTrackingStatusSyncRunning = false;
    }
  }

  async getRakutenTrackingStatusSummary(): Promise<{
    latestCheckedAt: string | null;
    pendingTrackingNoCount: number;
    uncheckedTrackingNoCount: number;
  }> {
    const [latestRow, pendingRows, uncheckedRows] = await Promise.all([
      this.prisma.rakutenOrderRecord.findFirst({
        where: { trackingCheckedAt: { not: null } },
        orderBy: { trackingCheckedAt: 'desc' },
        select: { trackingCheckedAt: true },
      }),
      this.prisma.rakutenOrderRecord.findMany({
        where: {
          shipmentNo: { not: null, notIn: [''] },
          trackingIsDelivered: false,
          ...this.buildRakutenChinaDispatchWhere(),
        },
        distinct: ['shipmentNo'],
        select: { shipmentNo: true },
      }),
      this.prisma.rakutenOrderRecord.findMany({
        where: {
          shipmentNo: { not: null, notIn: [''] },
          trackingCheckedAt: null,
          ...this.buildRakutenChinaDispatchWhere(),
        },
        distinct: ['shipmentNo'],
        select: { shipmentNo: true },
      }),
    ]);
    return {
      latestCheckedAt: latestRow?.trackingCheckedAt?.toISOString() ?? null,
      pendingTrackingNoCount: pendingRows.length,
      uncheckedTrackingNoCount: uncheckedRows.length,
    };
  }

  @Cron(RAKUTEN_TRACKING_STATUS_SYNC_CRON, {
    name: 'daily-rakuten-tracking-status-sync',
    timeZone: APP_TIMEZONE,
  })
  async runScheduledRakutenTrackingStatusSync(): Promise<void> {
    try {
      const result = await this.syncRakutenTrackingStatuses();
      this.logger.log(
        `daily Rakuten tracking status sync completed: candidates=${result.candidateCount}, trackingNos=${result.trackingNoCount}, delivered=${result.deliveredCount}, customsClearance=${result.customsClearanceCount}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`daily Rakuten tracking status sync failed: ${message}`);
    }
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
      ? (((await (this.prisma as any).manualOrderRecord.findMany({
          where: { orderId },
        })) as ManualOrderRecordLike[]).filter(
          (candidate) => this.resolveManualOrderBloggerCooperationId(candidate) === bloggerCooperationId,
        ))
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
      if (!response.ok || responseCode !== 200) {
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
          if (options.throwOnFetchError) {
            throw new BadRequestException(`快递单号 ${trackingNo} 状态取得失败：${message}`);
          }
          this.logger.warn(`UOF tracking lookup failed for ${trackingNo}: ${message}`);
          const failedStatus = {
            trackingNo,
            label: '状态取得失败',
            hasCustomsClearance: false,
            isDelivered: false,
            occurredAt: null,
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
      where: { shipmentNo: trackingNo },
      data: {
        trackingStatusLabel: status.label,
        trackingHasCustomsClearance: status.hasCustomsClearance,
        trackingIsDelivered: status.isDelivered,
        trackingStatusOccurredAt: this.parseUofTrackingOccurredAt(status.occurredAt),
        trackingCheckedAt: new Date(),
        trackingError: status.error ?? null,
      },
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
      | Record<string, unknown>
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

  private getUofTrackingConfig(): { apiUrl: string; appToken: string; appKey: string } {
    const apiUrl = String(UOF_TRACKING_API_URL ?? '').trim();
    const appToken = String(UOF_TRACKING_APP_TOKEN ?? '').trim();
    const appKey = String(UOF_TRACKING_APP_KEY ?? '').trim();
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

  private async fetchXiyaLogisticsRows(): Promise<XiyaLogisticsRow[]> {
    const url = new URL(XIYA_LOGISTICS_EXPORT_URL);
    url.searchParams.set('storeName', Object.keys(XIYA_LOGISTICS_STORE_SOURCE).join(','));
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
    if (Number(root.code) !== 200) {
      throw new InternalServerErrorException(`Xiya 运单号接口返回失败：${String(root.message ?? '未知错误')}`);
    }
    const data = root.data;
    if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).rows)) {
      throw new InternalServerErrorException('Xiya 运单号接口缺少 data.rows 字段');
    }
    return (data as Record<string, unknown>).rows as XiyaLogisticsRow[];
  }

  private normalizeXiyaTrackingCandidates(rows: XiyaLogisticsRow[]): XiyaTrackingCandidate[] {
    return rows
      .map((row) => {
        const storeName = String(row?.store_name ?? '').trim();
        const source = XIYA_LOGISTICS_STORE_SOURCE[storeName];
        const orderId = String(row?.sales_order_id ?? '').trim();
        const trackingNo = String(row?.logistics_order_id ?? '').trim();
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
            where: {
              orderId: { in: orderIds },
              sendStatus: OrderSendStatus.unsent,
              OR: [{ shipmentNo: null }, { shipmentNo: '' }],
            },
          })
        : source === 'amazon'
          ? await this.prisma.amazonOrderRecord.findMany({
              where: {
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
              where: {
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
        fulfillmentMode: this.resolveFulfillmentModeFromDispatchMode(row.dispatchMode, 0),
      }));
    }

    const productRows = await this.prisma.masterProduct.findMany({
      where: {
        productId: { in: lookupProductIds },
      },
      select: {
        productId: true,
        productName: true,
        stockQty: true,
      },
    });

    const stockQtyByProductId = new Map(
      productRows.map((row) => [String(row.productId ?? '').trim(), Number(row.stockQty ?? 0)]),
    );
    const productNameByProductId = new Map(
      productRows.map((row) => [String(row.productId ?? '').trim(), row.productName ?? null]),
    );

    return rows.map((row) => {
      const productId =
        String(row.skuCode ?? '').trim() ||
        String(row.setComponentSkuCode ?? '').trim() ||
        null;
      const availableStock = productId ? stockQtyByProductId.get(productId) ?? 0 : 0;

      return {
        ...row,
        resolvedProductId: productId,
        resolvedProductName: productId ? productNameByProductId.get(productId) ?? null : null,
        availableStock,
        fulfillmentMode: this.resolveFulfillmentModeFromDispatchMode(row.dispatchMode, availableStock),
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
    const productIdOverrideByRowId = new Map(
      relatedRows.map((row) => [row.id.toString(), this.getJsonObjectString(row.rawPayload, '产品ID')] as const),
    );
    const lookupCodes = Array.from(
      new Set(
        relatedRows
          .map((row) => String(row.sku ?? '').trim())
          .filter((value) => value.length > 0),
      ),
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

    const productRows = productIds.length
      ? await this.prisma.masterProduct.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, productName: true, stockQty: true },
        })
      : [];

    const stockQtyByProductId = new Map(
      productRows.map((row) => [String(row.productId ?? '').trim(), Number(row.stockQty ?? 0)]),
    );
    const productNameByProductId = new Map(
      productRows.map((row) => [String(row.productId ?? '').trim(), row.productName ?? null]),
    );
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
          availableStock: productId ? stockQtyByProductId.get(productId) ?? 0 : 0,
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
      const availableStock = productId ? stockQtyByProductId.get(productId) ?? 0 : 0;
      const orderId = String(row.orderId ?? '').trim();
      const effectiveDispatchMode = this.resolveEffectiveAmazonDispatchMode(row);
      const isChinaFulfillment =
        this.isChinaDispatchMode(effectiveDispatchMode) ||
        (orderId ? chinaFulfillmentOrderIds.has(orderId) : availableStock <= 0);

      return {
        ...row,
        shippingOrigin: isChinaFulfillment ? '中国発' : this.resolveAmazonShippingOriginFromDispatchMode(OVERSEAS_DISPATCH_MODE.OVERSEAS),
        resolvedProductId: productId,
        resolvedProductName: productId ? productNameByProductId.get(productId) ?? null : null,
        resolvedShopName: skuMeta?.shopName ?? null,
        availableStock,
        fulfillmentMode: isChinaFulfillment ? 'xiya_api' : 'overseas_warehouse',
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
          .filter((orderId) => orderId.length > 0),
      ),
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
    rows: Array<{ orderId: string | null; dispatchMode?: string | null; availableStock: number }>,
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
      if (Number(row.availableStock ?? 0) <= 0) {
        orderIds.add(orderId);
      }
    });
    return orderIds;
  }

  private async importCsvBuffer(
    fileBuffer: Buffer,
    sourceFileName: string,
    sourceFilePath: string,
  ): Promise<OrderImportResult> {
    const parsedRows = await this.expandRakutenComboRows(this.parseCsv(fileBuffer));
    const uniqueRowsMap = new Map<string, ParsedOrderCsvRow>();
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
          .filter((orderId) => orderId.length > 0),
      ),
    );
    const existingOrderIds = new Set<string>();
    if (importOrderIds.length) {
      const existingRows = await this.prisma.rakutenOrderRecord.findMany({
        where: {
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
    const productIds = Array.from(
      new Set(
        rowsToCreate
          .map((row) => String(row.skuCode ?? row.setComponentSkuCode ?? '').trim())
          .filter((productId) => productId.length > 0),
      ),
    );
    const productRows = productIds.length
      ? await this.prisma.masterProduct.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, stockQty: true },
        })
      : [];
    const stockQtyByProductId = new Map(
      productRows.map((row) => [String(row.productId ?? '').trim(), Number(row.stockQty ?? 0)]),
    );
    const importedAt = new Date();
    const createManyInput: Prisma.RakutenOrderRecordCreateManyInput[] = rowsToCreate.map((row) => ({
      rowHash: row.rowHash,
      orderId: row.orderId,
      itemDetailStatus: row.itemDetailStatus,
      skuCode: row.skuCode,
      isComboOrder: Boolean(row.isComboOrder),
      comboOrderSku: row.comboOrderSku,
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
      dispatchMode: (() => {
        const productId = String(row.skuCode ?? row.setComponentSkuCode ?? '').trim();
        const stockQty = productId ? stockQtyByProductId.get(productId) ?? 0 : 0;
        return stockQty > 0 ? OVERSEAS_DISPATCH_MODE.OVERSEAS : OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK;
      })(),
      sendStatus: row.sendStatus,
      deliveryMethod: row.deliveryMethod,
      deliveryDateRaw: row.deliveryDateRaw,
      deliveryTimeSlot: row.deliveryTimeSlot,
      shipmentRequestNo: row.shipmentRequestNo,
      productNameExtra: row.productNameExtra,
      sourceFileName,
      sourceFilePath,
      rawPayload: row.rawPayload,
      csvImportedAt: importedAt,
    }));

    const result = createManyInput.length
      ? await this.prisma.rakutenOrderRecord.createMany({
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

  private async expandRakutenComboRows(rows: ParsedOrderCsvRow[]): Promise<ParsedOrderCsvRow[]> {
    if (!rows.length) {
      return rows;
    }

    const comboSkuCodes = Array.from(
      new Set(
        rows
          .map((row) => String(row.skuCode ?? '').trim())
          .filter((skuCode) => /^zh-/i.test(skuCode)),
      ),
    );
    if (!comboSkuCodes.length) {
      return rows;
    }

    const comboProducts = await this.prisma.rakutenComboProduct.findMany({
      where: {
        comboName: {
          in: comboSkuCodes,
        },
      },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: {
            product: {
              select: {
                productId: true,
                productName: true,
              },
            },
          },
        },
      },
    });
    const comboBySku = new Map(
      comboProducts.map((combo) => [String(combo.comboName ?? '').trim(), combo] as const),
    );

    const missingComboSkuCodes = comboSkuCodes.filter((skuCode) => !comboBySku.has(skuCode));
    if (missingComboSkuCodes.length) {
      throw new BadRequestException(
        `以下乐天组合SKU未配置组合产品：${missingComboSkuCodes.join('、')}`,
      );
    }

    const expandedRows: ParsedOrderCsvRow[] = [];
    rows.forEach((row) => {
      const skuCode = String(row.skuCode ?? '').trim();
      if (!/^zh-/i.test(skuCode)) {
        expandedRows.push(row);
        return;
      }

      const combo = comboBySku.get(skuCode);
      if (!combo || !Array.isArray(combo.items) || combo.items.length <= 0) {
        throw new BadRequestException(`乐天组合SKU ${skuCode} 未配置组合明细`);
      }

      combo.items.forEach((item) => {
        const componentProductId = String(item.productId ?? '').trim();
        if (!componentProductId) {
          throw new BadRequestException(`乐天组合SKU ${skuCode} 存在空产品ID明细`);
        }
        const componentProductName =
          String(item.product?.productName ?? '').trim() ||
          String(row.productName ?? '').trim() ||
          null;
        const expandedRowWithoutHash: Omit<ParsedOrderCsvRow, 'rowHash'> = {
          ...row,
          isComboOrder: true,
          comboOrderSku: skuCode,
          skuCode: componentProductId,
          setComponentSkuCode: skuCode,
          productName: componentProductName,
          rawPayload: this.buildExpandedRakutenComboRawPayload(row.rawPayload, {
            componentProductId,
            componentProductName,
          }),
        };
        expandedRows.push({
          ...expandedRowWithoutHash,
          rowHash: this.buildRowHash(expandedRowWithoutHash),
        });
      });
    });

    return expandedRows;
  }

  private parseCsv(fileBuffer: Buffer): ParsedOrderCsvRow[] {
    const workbook = XLSX.read(fileBuffer, {
      type: 'buffer',
      codepage: 932,
      dense: true,
      raw: true,
      cellText: true,
    });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new BadRequestException('订单CSV没有可读取的工作表');
    }

    const firstSheet = workbook.Sheets[firstSheetName];
    const rows = this.extractSheetRows(firstSheet);
    if (rows.length <= 1) {
      throw new BadRequestException('订单CSV没有可导入的数据');
    }

    const headerRow = rows[0].map((cell) => String(cell ?? '').trim());
    const headerIndexMap = new Map<string, number>();
    headerRow.forEach((header, index) => {
      if (header) {
        headerIndexMap.set(header, index);
      }
    });

    const missingHeaders = RAKUTEN_ORDER_COLUMNS.map((column) => column.header).filter(
      (header) => !headerIndexMap.has(header),
    );
    if (missingHeaders.length) {
      throw new BadRequestException(`订单CSV缺少列：${missingHeaders.join('、')}`);
    }

    const parsedRows: ParsedOrderCsvRow[] = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const sourceRow = rows[rowIndex] ?? [];
      const rawPayload = {} as Record<OrderCsvHeader, string | null>;
      for (const column of RAKUTEN_ORDER_COLUMNS) {
        const cellIndex = headerIndexMap.get(column.header);
        rawPayload[column.header] =
          cellIndex === undefined ? null : this.normalizeCellValue(sourceRow[cellIndex]);
      }
      rawPayload[RAKUTEN_ORDER_HEADERS.deliveryTimeSlot] = this.normalizeRakutenDeliveryTimeSlot(
        rawPayload[RAKUTEN_ORDER_HEADERS.deliveryTimeSlot],
      );

      const hasAnyValue = Object.values(rawPayload).some((value) => Boolean(value));
      if (!hasAnyValue) {
        continue;
      }

      const shippingName = this.combineNonEmptyParts([
        rawPayload[RAKUTEN_ORDER_HEADERS.shippingLastName],
        rawPayload[RAKUTEN_ORDER_HEADERS.shippingFirstName],
      ]);
      const shippingPostalCode = this.combineNonEmptyParts(
        [
          rawPayload[RAKUTEN_ORDER_HEADERS.shippingPostalCode1],
          rawPayload[RAKUTEN_ORDER_HEADERS.shippingPostalCode2],
        ],
        '-',
      );
      const shippingPhone = this.combineNonEmptyParts(
        [
          rawPayload[RAKUTEN_ORDER_HEADERS.shippingPhone1],
          rawPayload[RAKUTEN_ORDER_HEADERS.shippingPhone2],
          rawPayload[RAKUTEN_ORDER_HEADERS.shippingPhone3],
        ],
        '-',
      );

      const parsedRowWithoutHash = {
        orderId: rawPayload[RAKUTEN_ORDER_HEADERS.orderId],
        itemDetailStatus: rawPayload[RAKUTEN_ORDER_HEADERS.deliveryClass],
        skuCode: rawPayload[RAKUTEN_ORDER_HEADERS.skuCode],
        isComboOrder: false,
        comboOrderSku: null,
        setComponentSkuCode: null,
        orderQuantity: this.parseQuantity(rawPayload[RAKUTEN_ORDER_HEADERS.orderQuantity]),
        productName: rawPayload[RAKUTEN_ORDER_HEADERS.productName],
        mallName: 'Rakuten',
        shopName: null,
        mallOrderNo: rawPayload[RAKUTEN_ORDER_HEADERS.orderId],
        orderStatusText: rawPayload[RAKUTEN_ORDER_HEADERS.orderConfirmedAt],
        orderImportedAtRaw: rawPayload[RAKUTEN_ORDER_HEADERS.orderCreatedAt],
        orderRemark: rawPayload[RAKUTEN_ORDER_HEADERS.orderRemark],
        shippingName,
        shippingPostalCode,
        shippingPrefecture: rawPayload[RAKUTEN_ORDER_HEADERS.shippingPrefecture],
        shippingCity: rawPayload[RAKUTEN_ORDER_HEADERS.shippingCity],
        shippingAddress: rawPayload[RAKUTEN_ORDER_HEADERS.shippingAddress],
        shippingPhone,
        shipmentCompany: null,
        shipmentNo: null,
        shipmentNoRegisteredAt: null,
        sendStatus: this.resolveSendStatus(null),
        deliveryMethod: rawPayload[RAKUTEN_ORDER_HEADERS.deliveryMethod],
        deliveryDateRaw: rawPayload[RAKUTEN_ORDER_HEADERS.deliveryDateRaw],
        deliveryTimeSlot: rawPayload[RAKUTEN_ORDER_HEADERS.deliveryTimeSlot],
        shipmentRequestNo: null,
        productNameExtra: rawPayload[RAKUTEN_ORDER_HEADERS.skuInfo],
        rawPayload,
      };

      parsedRows.push({
        ...parsedRowWithoutHash,
        rowHash: this.buildRowHash(parsedRowWithoutHash),
      });
    }

    if (!parsedRows.length) {
      throw new BadRequestException('订单CSV没有可导入的数据');
    }

    return parsedRows;
  }

  private extractSheetRows(sheet: XLSX.WorkSheet): Array<Array<string | number | boolean | null>> {
    const sheetRange = sheet['!ref'];
    if (!sheetRange) {
      return [];
    }

    const range = XLSX.utils.decode_range(sheetRange);
    const rows: Array<Array<string | number | boolean | null>> = [];
    const denseSheet = sheet as unknown as Array<Array<XLSX.CellObject | undefined>>;

    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
      const row: Array<string | number | boolean | null> = [];
      for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
        const cell = Array.isArray(denseSheet)
          ? denseSheet[rowIndex]?.[columnIndex]
          : (sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })] as XLSX.CellObject | undefined);
        row.push(this.extractSheetCellValue(cell));
      }
      rows.push(row);
    }

    return rows;
  }

  private extractSheetCellValue(cell: XLSX.CellObject | undefined): string | number | boolean | null {
    if (!cell) {
      return null;
    }

    const formattedValue = typeof cell.w === 'string' ? cell.w.replace(/\uFEFF/g, '').replace(/\r?\n/g, ' ').trim() : '';
    if (formattedValue) {
      return formattedValue;
    }

    const rawValue = cell.v;
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      return null;
    }

    if (rawValue instanceof Date) {
      const year = rawValue.getFullYear();
      const month = String(rawValue.getMonth() + 1).padStart(2, '0');
      const day = String(rawValue.getDate()).padStart(2, '0');
      const hours = String(rawValue.getHours()).padStart(2, '0');
      const minutes = String(rawValue.getMinutes()).padStart(2, '0');
      const seconds = String(rawValue.getSeconds()).padStart(2, '0');
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    return rawValue;
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
          .filter((orderId) => orderId.length > 0),
      ),
    );
    const existingOrderIds = new Set<string>();
    if (importOrderIds.length) {
      const existingRows = await this.prisma.amazonOrderRecord.findMany({
        where: {
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
      return (
        skuMetaByCode.get(rawCode) ??
        normalizedSkuMetaByCode.get(normalizeAmazonSkuLookupKey(rawCode)) ??
        null
      );
    };

    const productIds = Array.from(
      new Set(
        rowsToCreate
          .map((row) => resolveSkuMeta(row.sku)?.productId)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const productRows = productIds.length
      ? await this.prisma.masterProduct.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, stockQty: true },
        })
      : [];

    const stockQtyByProductId = new Map(
      productRows.map((row) => [String(row.productId ?? '').trim(), Number(row.stockQty ?? 0)]),
    );
    const chinaFulfillmentOrderIds = this.resolveChinaFulfillmentOrderIds(
      rowsToCreate.map((row) => {
        const productId = resolveSkuMeta(row.sku)?.productId;
        return {
          orderId: row.orderId,
          availableStock: productId ? stockQtyByProductId.get(productId) ?? 0 : 0,
        };
      }),
    );
    const importedAt = new Date();
    const createManyInput: Prisma.AmazonOrderRecordCreateManyInput[] = rowsToCreate.map((row) => {
      const dispatchMode = (() => {
        const productId = resolveSkuMeta(row.sku)?.productId;
        const stockQty = productId ? stockQtyByProductId.get(productId) ?? 0 : 0;
        const orderId = String(row.orderId ?? '').trim();
        return (orderId ? chinaFulfillmentOrderIds.has(orderId) : stockQty <= 0)
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

  private normalizeRakutenDeliveryTimeSlot(value: string | null): string | null {
    const normalized = String(value ?? '').normalize('NFKC').trim();
    if (normalized === '午前中' || normalized === '1') {
      return '0812';
    }
    return normalized || null;
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

  private combineNonEmptyParts(parts: Array<string | null>, separator = ''): string | null {
    const normalized = parts
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0);
    return normalized.length ? normalized.join(separator) : null;
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
    fieldName: string,
  ): number | null {
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
    maxLength: number,
  ): string {
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

  private async resolveDispatchModeForProductId(productIdRaw: string | null): Promise<string> {
    const productId = String(productIdRaw ?? '').trim();
    if (!productId) {
      return OVERSEAS_DISPATCH_MODE.CHINA_NO_STOCK;
    }
    const product = await this.prisma.masterProduct.findUnique({
      where: { productId },
      select: { stockQty: true },
    });
    return Number(product?.stockQty ?? 0) > 0
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

  private resolveEffectiveAmazonDispatchMode(row: Pick<AmazonOrderRecord, 'dispatchMode' | 'shippingOrigin'>): string | null {
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
    const quantityPurchased = this.requireEditablePositiveInt(payload.quantityPurchased, withField('quantityPurchased'));
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
    const dispatchMode = await this.resolveDispatchModeForProductId(productId);
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
      workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false, raw: false });
    } catch {
      throw new BadRequestException('手动订单批量上传文件无法解析，请上传 xlsx 文件');
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new BadRequestException('手动订单批量上传文件没有可读取的工作表');
    }
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
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
    updates: Record<string, string | null>,
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

  private buildExpandedRakutenComboRawPayload(
    rawPayload: Record<OrderCsvHeader, string | null>,
    payload: { componentProductId: string; componentProductName: string | null },
  ): Record<OrderCsvHeader, string | null> {
    return {
      ...rawPayload,
      [RAKUTEN_ORDER_HEADERS.skuCode]: payload.componentProductId,
      [RAKUTEN_ORDER_HEADERS.productName]: payload.componentProductName,
    };
  }

  private buildRowHash(row: Omit<ParsedOrderCsvRow, 'rowHash'>): string {
    const hashBase = RAKUTEN_ORDER_COLUMNS.map((column) => row.rawPayload[column.header] ?? '').join('\u001f');
    return createHash('sha1').update(hashBase).digest('hex');
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
    scope: 'pending' | 'exported' | 'all',
  ):
    | { OR: Array<{ shipmentNo: null } | { shipmentNo: string }> }
    | { AND: Array<{ shipmentNo: { not: null } } | { shipmentNo: { not: string } }> }
    | Record<string, never> {
    if (scope === 'exported') {
      return { AND: [{ shipmentNo: { not: null } }, { shipmentNo: { not: '' } }] };
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
