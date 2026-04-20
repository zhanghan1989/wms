import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
  availableStock: number;
  fulfillmentMode: OrderFulfillmentMode;
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

interface AmazonOrderListItem extends AmazonOrderRecord {
  resolvedProductId: string | null;
  resolvedShopName: string | null;
}

type AmazonFulfillmentMode = 'overseas_warehouse' | 'xiya_api';

interface AmazonEnrichedOrderListItem extends AmazonOrderListItem {
  availableStock: number;
  fulfillmentMode: AmazonFulfillmentMode;
}

type ThirdPartyExportSource = 'rakuten' | 'amazon';

interface ThirdPartyExportRowInput {
  source: ThirdPartyExportSource;
  sourceLabel: string;
  id: string;
  rowHash: string;
  resolvedProductId: string | null;
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
  source: 'rakuten' | 'amazon';
  id?: string;
  sourceLabel: string;
  csvImportedAt: Date;
  createdAt: Date;
  orderId: string | null;
  skuCode: string | null;
  resolvedProductId: string | null;
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
  xiyaStatus?: 'pending_export' | 'acknowledged';
}

interface SelectedOverseasWarehouseOrderRef {
  source?: 'rakuten' | 'amazon';
  id?: string | number;
}

interface ThirdPartyExportAckItem {
  source?: 'rakuten' | 'amazon';
  id?: string | number;
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
  source: 'rakuten' | 'amazon';
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
  source: 'rakuten' | 'amazon';
  sourceRecordId: bigint;
  orderId: string;
  skuCode: string;
  productId: string;
  requestedQty: number;
  availableStockSnapshot: number;
  shopName: string | null;
  shippingName: string | null;
}

interface YamatoImportFileResult {
  fileName: string;
  content: Buffer;
  batchId: string;
}

interface YamatoExportItem {
  source: 'rakuten' | 'amazon';
  id: string;
  orderId: string;
  productId: string;
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

interface PreparedYamatoShipmentPrintResult {
  batchId: string;
  fileName: string;
  content: Buffer;
  pageId: bigint;
  pageNo: number;
  trackingNo: string | null;
  productId: string;
  remainingMatchCount: number;
}

interface ParsedPdfPageText {
  pageNo: number;
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
} as const;
const OVERSEAS_PICKING_BATCH_STATUS = {
  CREATED: 'created',
  PICKED: 'picked',
  YAMATO_EXPORTED: 'yamato_exported',
} as const;
const YAMATO_BATCH_STATUS = {
  EXCEL_EXPORTED: 'excel_exported',
  PDF_READY: 'pdf_ready',
} as const;
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
    const [rakutenSourceRows, amazonSourceRows] = await Promise.all([
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
    ]);
    const rakutenSourceMap = new Map(rakutenSourceRows.map((row) => [row.id.toString(), row] as const));
    const amazonSourceMap = new Map(amazonSourceRows.map((row) => [row.id.toString(), row] as const));
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
      }
    >();

    sortedItems
      .filter(
        (item) =>
          String(item.dispatchMode ?? OVERSEAS_DISPATCH_MODE.OVERSEAS).trim() !== OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
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
          };

        aggregate.requestedQty += requestedQty;
        aggregate.actualQty += pickedQty;
        groupedItems.set(item.productId, aggregate);
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
      const source = item.source === 'amazon' ? ('amazon' as const) : ('rakuten' as const);
      const rakutenRow = item.source === 'rakuten' ? (rakutenSourceMap.get(sourceRecordId) ?? null) : null;
      const amazonRow = item.source === 'amazon' ? (amazonSourceMap.get(sourceRecordId) ?? null) : null;
      const shipmentTrackingNo = String(item.shipmentTrackingNo ?? page?.trackingNo ?? '').trim() || null;
      const yamatoPrintedAt = toIsoString(page?.printedAt);
      const dispatchMode =
        String(item.dispatchMode ?? OVERSEAS_DISPATCH_MODE.OVERSEAS).trim() || OVERSEAS_DISPATCH_MODE.OVERSEAS;
      let orderStatusText = '待拣货';
      if (dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING) {
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
        sourceLabel: source === 'amazon' ? '亚马逊' : '乐天',
        sourceRecordId,
        csvImportedAt: toIsoString(rakutenRow?.csvImportedAt) ?? toIsoString(amazonRow?.csvImportedAt),
        createdAt: toIsoString(rakutenRow?.createdAt) ?? toIsoString(amazonRow?.createdAt),
        orderId: item.orderId ?? rakutenRow?.orderId ?? amazonRow?.orderId ?? null,
        skuCode: item.skuCode ?? rakutenRow?.skuCode ?? amazonRow?.sku ?? null,
        productId: item.productId,
        orderQuantity: Number(item.requestedQty ?? 0),
        actualQty: Number(item.actualQty ?? 0),
        shopName: item.shopName ?? rakutenRow?.shopName ?? amazonRow?.shopName ?? null,
        shippingName: item.shippingName ?? rakutenRow?.shippingName ?? amazonRow?.recipientName ?? null,
        shipmentCompany:
          rakutenRow?.shipmentCompany ?? amazonRow?.shipmentCompany ?? (shipmentTrackingNo ? 'Yamato' : null),
        shipmentTrackingNo,
        shipmentNoRegisteredAt:
          toIsoString(rakutenRow?.shipmentNoRegisteredAt) ?? toIsoString(amazonRow?.shipmentNoRegisteredAt),
        dispatchMode,
        chinaDispatchReason:
          dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING ? '拣货缺货切中国发' : null,
        yamatoPageNo: page?.pageNo ?? null,
        yamatoPrintedAt,
        orderStatusText,
        orderImportedAtRaw: rakutenRow?.orderImportedAtRaw ?? null,
        purchaseDateRaw: amazonRow?.purchaseDateRaw ?? null,
        productName: rakutenRow?.productName ?? amazonRow?.productName ?? null,
        productNameExtra: rakutenRow?.productNameExtra ?? null,
        shippingPhone: rakutenRow?.shippingPhone ?? null,
        shippingPostalCode: rakutenRow?.shippingPostalCode ?? null,
        shippingPrefecture: rakutenRow?.shippingPrefecture ?? null,
        shippingCity: rakutenRow?.shippingCity ?? null,
        shippingAddress: rakutenRow?.shippingAddress ?? null,
        deliveryDateRaw: rakutenRow?.deliveryDateRaw ?? null,
        deliveryTimeSlot: rakutenRow?.deliveryTimeSlot ?? null,
        buyerPhoneNumber: amazonRow?.buyerPhoneNumber ?? null,
        shipPostalCode: amazonRow?.shipPostalCode ?? null,
        shipState: amazonRow?.shipState ?? null,
        shipAddress1: amazonRow?.shipAddress1 ?? null,
        shipAddress2: amazonRow?.shipAddress2 ?? null,
        shipAddress3: amazonRow?.shipAddress3 ?? null,
        rawPayload: rakutenRow?.rawPayload ?? amazonRow?.rawPayload ?? null,
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

    const activeItems = items.filter(
      (item) => String(item.dispatchMode ?? OVERSEAS_DISPATCH_MODE.OVERSEAS).trim() !== OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
    );
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
      if (amazonIds.length) {
        await tx.amazonOrderRecord.updateMany({
          where: {
            id: {
              in: amazonIds,
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
            in: itemIds,
          },
        },
      });

      return this.recalculateOverseasPickingBatchAfterItemRemoval(tx, batchId);
    });

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
        String(item.dispatchMode ?? OVERSEAS_DISPATCH_MODE.OVERSEAS).trim() !== OVERSEAS_DISPATCH_MODE.CHINA_PENDING &&
        Number(item.actualQty ?? 0) > 0,
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
    if (String(item.dispatchMode ?? '') === OVERSEAS_DISPATCH_MODE.CHINA_PENDING) {
      throw new NotFoundException(`拣货批次明细不存在可切中国发的订单: ${itemIdRaw}`);
    }
    if (Number(item.actualQty ?? 0) > 0) {
      throw new BadRequestException(`产品 ${item.productId} 已开始扫码拣货，不能再切换到中国发`);
    }

    const batchDeleted = await this.prisma.$transaction(async (tx) => {
      if (item.source === 'rakuten') {
        await tx.rakutenOrderRecord.update({
          where: { id: item.sourceRecordId },
          data: {
            dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
          },
        });
      } else {
        await tx.amazonOrderRecord.update({
          where: { id: item.sourceRecordId },
          data: {
            dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
          },
        });
      }
      await tx.overseasPickingBatchItem.delete({
        where: { id: item.id },
      });

      return this.recalculateOverseasPickingBatchAfterItemRemoval(tx, batchId);
    });

    return {
      success: true,
      itemId: item.id.toString(),
      dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
      batchDeleted,
    };
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
    if (String(item.dispatchMode ?? '') === OVERSEAS_DISPATCH_MODE.CHINA_PENDING) {
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
  ): Promise<{ success: true; itemId: string; batchDeleted: boolean }> {
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

    const batchDeleted = await this.prisma.$transaction(async (tx) => {
      await tx.overseasPickingBatchItem.delete({
        where: { id: item.id },
      });

      const resetDispatchMode =
        String(item.dispatchMode ?? '').trim() === OVERSEAS_DISPATCH_MODE.CHINA_PENDING
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

      return this.recalculateOverseasPickingBatchAfterItemRemoval(tx, batchId);
    });

    return {
      success: true,
      itemId: item.id.toString(),
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
      if (dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING) {
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
        if (item.dispatchMode !== OVERSEAS_DISPATCH_MODE.OVERSEAS) {
          await tx.overseasPickingBatchItem.update({
            where: { id: item.id },
            data: {
              actualQty: 0,
              pickedAt: null,
            },
          });
          continue;
        }
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

        await tx.overseasPickingBatchItem.update({
          where: { id: item.id },
          data: {
            actualQty: qty,
            pickedAt: item.pickedAt ?? new Date(),
          },
        });
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

  async list(limitParam?: string): Promise<OrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const rows = await this.prisma.rakutenOrderRecord.findMany({
      orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return this.enrichOrderRows(rows);
  }

  async listAmazon(limitParam?: string): Promise<AmazonOrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const rows = await this.prisma.amazonOrderRecord.findMany({
      orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return this.enrichAmazonOrderRows(rows);
  }

  async listOverseasWarehouse(limitParam?: string): Promise<OverseasWarehouseOrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const batchSize = Math.min(Math.max(limit, 200), 500);
    const collected: OverseasWarehouseOrderListItem[] = [];
    let rakutenSkip = 0;
    let amazonSkip = 0;
    let rakutenExhausted = false;
    let amazonExhausted = false;

    while (collected.length < limit && (!rakutenExhausted || !amazonExhausted)) {
      const [rakutenRows, amazonRows]: [RakutenOrderRecord[], AmazonOrderRecord[]] = await Promise.all([
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
      ]);

      rakutenSkip += rakutenRows.length;
      amazonSkip += amazonRows.length;
      rakutenExhausted = rakutenRows.length < batchSize;
      amazonExhausted = amazonRows.length < batchSize;

      const [enrichedRakutenRows, enrichedAmazonRows] = await Promise.all([
        this.enrichOrderRows(rakutenRows),
        this.enrichAmazonOrderRows(amazonRows),
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
  ): Promise<{ success: true; source: 'rakuten' | 'amazon'; id: string; dispatchMode: string }> {
    const source = String(sourceRaw ?? '').trim();
    if (source !== 'rakuten' && source !== 'amazon') {
      throw new BadRequestException('source 只支持 rakuten 或 amazon');
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

    const row = await this.prisma.amazonOrderRecord.findFirst({
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
      throw new NotFoundException(`亚马逊订单不存在或当前不可切中国发: ${idRaw}`);
    }
    const [enrichedRows, activePickedRefs] = await Promise.all([
      this.enrichAmazonOrderRows([row]),
      this.loadActiveOverseasPickingBatchRefs([{ source: 'amazon', sourceRecordId: id }]),
    ]);
    const enrichedRow = enrichedRows[0];
    if (
      !enrichedRow ||
      enrichedRow.fulfillmentMode !== 'overseas_warehouse' ||
      enrichedRow.availableStock <= 0 ||
      activePickedRefs.has(`amazon:${id.toString()}`)
    ) {
      throw new BadRequestException('当前订单已不在海外仓待处理范围内，无法切中国发');
    }
    await this.prisma.amazonOrderRecord.update({
      where: { id },
      data: {
        dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
      },
    });
    return {
      success: true,
      source: 'amazon',
      id: id.toString(),
      dispatchMode: OVERSEAS_DISPATCH_MODE.CHINA_PENDING,
    };
  }

  async listChinaOrderProcessing(limitParam?: string, scopeParam?: string): Promise<OverseasWarehouseOrderListItem[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    const scope = this.normalizeChinaOrderScope(scopeParam);
    const batchSize = Math.min(Math.max(limit, 200), 500);
    const collected: OverseasWarehouseOrderListItem[] = [];
    let rakutenSkip = 0;
    let amazonSkip = 0;
    let rakutenExhausted = false;
    let amazonExhausted = false;

    while (collected.length < limit && (!rakutenExhausted || !amazonExhausted)) {
      const [rakutenRows, amazonRows]: [RakutenOrderRecord[], AmazonOrderRecord[]] = await Promise.all([
        rakutenExhausted
          ? Promise.resolve([] as RakutenOrderRecord[])
          : this.prisma.rakutenOrderRecord.findMany({
              where: {
                sendStatus: OrderSendStatus.unsent,
                ...this.buildChinaOrderExportedAtFilter(scope),
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
                  this.buildChinaOrderExportedAtFilter(scope),
                ],
              },
              orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
              skip: amazonSkip,
              take: batchSize,
            }),
      ]);

      rakutenSkip += rakutenRows.length;
      amazonSkip += amazonRows.length;
      rakutenExhausted = rakutenRows.length < batchSize;
      amazonExhausted = amazonRows.length < batchSize;

      const [enrichedRakutenRows, enrichedAmazonRows] = await Promise.all([
        this.enrichOrderRows(rakutenRows),
        this.enrichAmazonOrderRows(amazonRows),
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
      ]);

      collected.push(
        ...enrichedRakutenRows
          .filter((row) => {
            const dispatchMode = String(row.dispatchMode ?? '').trim();
            if (dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING) {
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
              chinaDispatchReason:
                dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING ? '拣货缺货切中国发' : '系统无库存',
              xiyaExportedAt: row.xiyaExportedAt?.toISOString() ?? null,
              xiyaStatus: row.xiyaExportedAt ? ('acknowledged' as const) : ('pending_export' as const),
            };
          }),
        ...enrichedAmazonRows
          .filter((row) => {
            const dispatchMode = String(row.dispatchMode ?? '').trim();
            if (dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING) {
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
              chinaDispatchReason:
                dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING ? '拣货缺货切中国发' : '系统无库存',
              xiyaExportedAt: row.xiyaExportedAt?.toISOString() ?? null,
              xiyaStatus: row.xiyaExportedAt ? ('acknowledged' as const) : ('pending_export' as const),
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
      .slice(0, limit);
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

    const result = await this.prisma.amazonOrderRecord.deleteMany({
      where: { id: { in: ids } },
    });

    return { deletedCount: result.count };
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

  async buildOverseasWarehouseYamatoImport(payload: {
    items?: SelectedOverseasWarehouseOrderRef[];
  }): Promise<YamatoImportFileResult> {
    const selectedItems = Array.isArray(payload?.items) ? payload.items : [];
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

    const [rakutenRows, amazonRows] = await Promise.all([
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
    ]);

    const [enrichedRakutenRows, enrichedAmazonRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
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

    const exportItems: YamatoExportItem[] = [];
    selectedItems.forEach((item, index) => {
      const source = item?.source;
      const id = String(item?.id ?? '').trim();
      if (!id || (source !== 'rakuten' && source !== 'amazon')) {
        throw new BadRequestException(`items[${index}] 缺少有效的 source 或 id`);
      }

      if (source === 'rakuten') {
        const row = rakutenMap.get(id);
        if (!row) {
          throw new BadRequestException(`乐天订单 ${id} 不存在、无库存或已不在海外仓处理范围内`);
        }
        exportItems.push(this.mapRakutenOrderToYamatoItem(row));
        return;
      }

      const row = amazonMap.get(id);
      if (!row) {
        throw new BadRequestException(`亚马逊订单 ${id} 不存在、无库存或已不在海外仓处理范围内`);
      }
      exportItems.push(this.mapAmazonOrderToYamatoItem(row));
    });

    const mergedRows = this.mergeYamatoExportItems(exportItems);
    if (!mergedRows.length) {
      throw new BadRequestException('没有可生成打单导入文件的订单');
    }

    const currentDate = this.formatCurrentYamatoDate();
    const timestamp = this.formatYamatoFileNameStamp();
    const fileName = `ヤマト-インポート_${timestamp}.xlsx`;
    const content = await this.buildYamatoWorkbookBuffer(mergedRows, currentDate);
    const batch = await this.createYamatoShipmentBatch(fileName, mergedRows);
    return {
      fileName,
      content,
      batchId: batch.id.toString(),
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

    const [rakutenRows, amazonRows] = await Promise.all([
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
    ]);

    const [enrichedRakutenRows, enrichedAmazonRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
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

    const items: OverseasPickingBatchItemSnapshot[] = [];
    selectedItems.forEach((item, index) => {
      const source = item?.source;
      const id = String(item?.id ?? '').trim();
      if (!id || (source !== 'rakuten' && source !== 'amazon')) {
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

      const row = amazonMap.get(id);
      if (!row) {
        throw new BadRequestException(`亚马逊订单 ${id} 不存在、无库存或已不在海外仓处理范围内`);
      }
      const orderId = String(row.orderId ?? '').trim();
      const productId = String(row.resolvedProductId ?? '').trim();
      const skuCode = String(row.sku ?? '').trim();
      const requestedQty = Number(row.quantityPurchased ?? 0);
      if (!orderId || !productId || !skuCode || requestedQty <= 0) {
        throw new BadRequestException(`亚马逊订单 ${id} 缺少有效的订单号、产品ID、SKU 或数量`);
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
        `${row.source === 'amazon' ? '亚马逊' : '乐天'}:${row.orderId || row.sourceRecordId.toString()}(${row.batch.batchNo})`,
    );
  }

  private async loadActiveOverseasPickingBatchRefs(
    refs: Array<{ source: 'rakuten' | 'amazon'; sourceRecordId: bigint }>,
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

    const [rakutenRows, amazonRows] = await Promise.all([
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
    ]);

    const rakutenMap = new Map(rakutenRows.map((row) => [row.id.toString(), row] as const));
    const amazonMap = new Map(amazonRows.map((row) => [row.id.toString(), row] as const));

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
          quantity,
          deliveryDate: String(
            this.getJsonField(row.rawPayload, RAKUTEN_ORDER_HEADERS.deliveryDateRaw) ?? row.deliveryDateRaw ?? '',
          ).trim(),
          deliveryTimeSlot: String(
            this.getJsonField(row.rawPayload, RAKUTEN_ORDER_HEADERS.deliveryTimeSlot) ?? row.deliveryTimeSlot ?? '',
          ).trim(),
          phone: normalizedPhone || '-',
          postalCode: String(row.shippingPostalCode ?? '').trim() || '-',
          address1: this.concatAddress([row.shippingPrefecture, row.shippingCity]),
          address2: String(row.shippingAddress ?? '').trim() || '-',
          recipientName: String(row.shippingName ?? '').trim() || '-',
        };
      }

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

  private mapRakutenOrderToYamatoItem(row: OrderListItem): YamatoExportItem {
    const normalizedPhone = this.normalizeYamatoPhone(String(row.shippingPhone ?? '').trim());
    return {
      source: 'rakuten',
      id: row.id.toString(),
      orderId: String(row.orderId ?? '').trim(),
      productId: String(row.resolvedProductId ?? '').trim() || '-',
      quantity: Number(row.orderQuantity ?? 0) || 0,
      deliveryDate: String(
        this.getJsonField(row.rawPayload, RAKUTEN_ORDER_HEADERS.deliveryDateRaw) ?? row.deliveryDateRaw ?? '',
      ).trim(),
      deliveryTimeSlot: String(
        this.getJsonField(row.rawPayload, RAKUTEN_ORDER_HEADERS.deliveryTimeSlot) ?? row.deliveryTimeSlot ?? '',
      ).trim(),
      phone: normalizedPhone || '-',
      postalCode: String(row.shippingPostalCode ?? '').trim() || '-',
      address1: this.concatAddress([row.shippingPrefecture, row.shippingCity]),
      address2: String(row.shippingAddress ?? '').trim() || '-',
      recipientName: String(row.shippingName ?? '').trim() || '-',
    };
  }

  private mapAmazonOrderToYamatoItem(row: AmazonEnrichedOrderListItem): YamatoExportItem {
    const normalizedPhone = this.normalizeYamatoPhone(String(row.buyerPhoneNumber ?? '').trim());
    return {
      source: 'amazon',
      id: row.id.toString(),
      orderId: String(row.orderId ?? '').trim(),
      productId: String(row.resolvedProductId ?? '').trim() || '-',
      quantity: Number(row.quantityPurchased ?? 0) || 0,
      deliveryDate: '-',
      deliveryTimeSlot: '-',
      phone: normalizedPhone || '-',
      postalCode: String(row.shipPostalCode ?? '').trim() || '-',
      address1: this.concatAddress([row.shipState, row.shipAddress1]),
      address2: this.concatAddress([row.shipAddress2, row.shipAddress3]),
      recipientName: String(row.recipientName ?? '').trim() || '-',
    };
  }

  private mergeYamatoExportItems(items: YamatoExportItem[]): YamatoMergedExportRow[] {
    const mergedByOrderId = new Map<
      string,
      Omit<YamatoExportItem, 'source' | 'id' | 'productId' | 'quantity'> & {
        itemParts: string[];
        productIds: string[];
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
          deliveryDate: item.deliveryDate || '-',
          deliveryTimeSlot: item.deliveryTimeSlot || '-',
          phone: item.phone || '-',
          postalCode: item.postalCode || '-',
          address1: item.address1 || '-',
          address2: item.address2 || '-',
          recipientName: item.recipientName || '-',
          itemParts: [itemPart],
          productIds: [item.productId],
          lineCount: 1,
        });
        return;
      }

      existing.itemParts.push(itemPart);
      existing.productIds.push(item.productId);
      existing.lineCount += 1;
    });

    return Array.from(mergedByOrderId.values()).map((row) => ({
      orderId: row.orderId,
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
    }));
  }

  async uploadYamatoShipmentBatchPdf(
    batchIdRaw: string,
    fileBuffer: Buffer,
    originalName?: string,
  ): Promise<YamatoShipmentBatchUploadResult> {
    const batchId = parseId(batchIdRaw, 'batchId');
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
    if (!this.isPdfFileBuffer(fileBuffer)) {
      throw new BadRequestException('上传文件不是有效的 PDF，请确认选择的是 Yamato 批量 PDF');
    }

    const parsedPages = await this.extractPdfPagesText(fileBuffer);
    if (parsedPages.length !== batch.pages.length) {
      throw new BadRequestException(
        `PDF 页数与批次数量不一致：PDF ${parsedPages.length} 页，批次 ${batch.pages.length} 页`,
      );
    }

    batch.pages.forEach((page, index) => {
      const parsed = parsedPages[index];
      const expectedProductIds = this.getBatchPageProductIds(page);
      if (!expectedProductIds.length) {
        return;
      }
      const matched = expectedProductIds.some((productId) => this.pdfTextContainsProductId(parsed.text, productId));
      if (!matched) {
        throw new BadRequestException(
          `PDF 第 ${parsed.pageNo} 页未匹配到预期产品ID：${expectedProductIds.join('、')}`,
        );
      }
    });

    const trackingNumbers = parsedPages.map((page) =>
      this.extractTrackingNoFromPdfText(page?.text ?? ''),
    );
    trackingNumbers.forEach((trackingNo, index) => {
      if (!trackingNo) {
        throw new BadRequestException(`PDF 第 ${parsedPages[index]?.pageNo ?? index + 1} 页未识别到快递单号`);
      }
    });

    const sanitizedFileName =
      this.sanitizeYamatoFileName(originalName) || `yamato-batch-${batch.id.toString()}.pdf`;
    const pdfPath = this.buildYamatoBatchPdfPath(batch.id.toString(), sanitizedFileName);
    await this.ensureYamatoBatchDir(batch.id.toString());
    await writeFile(pdfPath, fileBuffer);

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

        await this.writeYamatoTrackingNoBackToOrders(
          tx,
          page.orderId,
          trackingNo,
        );

        if (batch.pickingBatchId && String(page.orderId ?? '').trim()) {
          await tx.overseasPickingBatchItem.updateMany({
            where: {
              batchId: batch.pickingBatchId,
              orderId: String(page.orderId ?? '').trim(),
            },
            data: {
              shipmentTrackingNo: trackingNo,
            },
          });
        }
      }
    });

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
  ): Promise<void> {
    const orderId = String(orderIdRaw ?? '').trim();
    const trackingNo = String(trackingNoRaw ?? '').trim();
    if (!orderId || !trackingNo) {
      throw new BadRequestException('Yamato 面单缺少可回写的订单号或快递单号');
    }

    const registeredAt = new Date();
    const rakutenResult = await tx.rakutenOrderRecord.updateMany({
      where: { orderId },
      data: {
        shipmentCompany: 'Yamato',
        shipmentNo: trackingNo,
        shipmentNoRegisteredAt: registeredAt,
        sendStatus: this.resolveSendStatus(trackingNo),
      },
    });
    const amazonResult = await tx.amazonOrderRecord.updateMany({
      where: { orderId },
      data: {
        shipmentCompany: 'Yamato',
        shipmentNo: trackingNo,
        shipmentNoRegisteredAt: registeredAt,
      },
    });

    if (rakutenResult.count + amazonResult.count <= 0) {
      throw new NotFoundException(`未找到可回写快递单号的订单：${orderId}`);
    }
  }

  async printYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: { productId?: string },
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

  async directPrintYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: { productId?: string },
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
    payload: { productId?: string },
  ): Promise<YamatoShipmentQueuedPrintResult> {
    if (this.getYamatoPrintMode() !== 'agent') {
      throw new BadRequestException('Yamato 打印代理未启用');
    }

    const prepared = await this.prepareYamatoShipmentLabelByProductId(batchIdRaw, payload);
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
      throw new BadRequestException('该面单已在打印队列中，请勿重复扫码');
    }

    const printerName = await this.resolveYamatoPrinterNameForProductId(prepared.productId);
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

  private async prepareYamatoShipmentLabelByProductId(
    batchIdRaw: string,
    payload: { productId?: string },
  ): Promise<PreparedYamatoShipmentPrintResult> {
    const batchId = parseId(batchIdRaw, 'batchId');
    const productId = String(payload?.productId ?? '').trim();
    if (!productId) {
      throw new BadRequestException('产品ID不能为空');
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

    const printablePages = batch.pages.filter(
      (page) =>
        !page.printedAt &&
        this.getBatchPageProductIds(page).some(
          (candidate) => candidate.localeCompare(productId, undefined, { sensitivity: 'accent' }) === 0,
        ),
    );
    if (!printablePages.length) {
      throw new BadRequestException(`当前批次中未找到产品ID ${productId} 对应的未打印面单`);
    }

    try {
      await stat(batch.pdfFilePath);
    } catch {
      throw new BadRequestException('当前批次的 Yamato PDF 文件不存在，请重新上传');
    }

    const targetPage = printablePages[0];
    const pdfBuffer = await readFile(batch.pdfFilePath);
    const singlePagePdf = await this.extractPdfSinglePage(pdfBuffer, targetPage.pageNo);

    return {
      batchId: batch.id.toString(),
      fileName: `Yamato-${productId}-p${targetPage.pageNo}.pdf`,
      content: singlePagePdf,
      pageId: targetPage.id,
      pageNo: targetPage.pageNo,
      trackingNo: targetPage.trackingNo ?? null,
      productId,
      remainingMatchCount: Math.max(printablePages.length - 1, 0),
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

  private async createYamatoShipmentBatch(
    exportedFileName: string,
    rows: YamatoMergedExportRow[],
  ): Promise<YamatoShipmentBatch> {
    return this.prisma.yamatoShipmentBatch.create({
      data: {
        exportedFileName,
        pageCount: rows.length,
        status: YAMATO_BATCH_STATUS.EXCEL_EXPORTED,
        pages: {
          create: rows.map((row, index) => ({
            pageNo: index + 1,
            orderId: row.orderId,
            productIds: row.productIds,
            itemSummary: row.itemSummary,
            recipientName: row.recipientName,
          })),
        },
      },
    });
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
    const printerName = String(product?.yamatoPrinterName ?? '').trim();
    return printerName || null;
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

  private pdfTextContainsProductId(text: string, productId: string): boolean {
    const normalizedText = String(text ?? '')
      .toUpperCase()
      .replace(/\s+/g, '');
    const normalizedProductId = String(productId ?? '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
    if (!normalizedText || !normalizedProductId) {
      return false;
    }
    return normalizedText.includes(normalizedProductId);
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

  private formatYamatoFileNameStamp(date: Date = new Date()): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
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
    const [rakutenRows, amazonRows] = await Promise.all([
      this.prisma.rakutenOrderRecord.findMany({
        where: {
          sendStatus: OrderSendStatus.unsent,
          xiyaExportedAt: null,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.amazonOrderRecord.findMany({
        where: {
          AND: [
            { OR: [{ shipmentNo: null }, { shipmentNo: '' }] },
            { xiyaExportedAt: null },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const [enrichedRakutenRows, enrichedAmazonRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
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
  }> {
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    if (!rawItems.length) {
      throw new BadRequestException('请至少提供一条回执记录');
    }

    const groupedIds = new Map<ThirdPartyExportSource, bigint[]>();
    for (const source of ['rakuten', 'amazon'] as const) {
      groupedIds.set(source, []);
    }

    rawItems.forEach((item, index) => {
      const source = String(item?.source ?? '').trim();
      if (source !== 'rakuten' && source !== 'amazon') {
        throw new BadRequestException(`items[${index}].source 只支持 rakuten 或 amazon`);
      }
      const rawId = String(item?.id ?? '').trim();
      groupedIds.get(source)?.push(parseId(rawId, `items[${index}].id`));
    });

    const rakutenIds = Array.from(new Set(groupedIds.get('rakuten') ?? []));
    const amazonIds = Array.from(new Set(groupedIds.get('amazon') ?? []));
    const acknowledgedAt = new Date();

    const [rakutenRows, amazonRows] = await Promise.all([
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
    ]);

    const [enrichedRakutenRows, enrichedAmazonRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
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

    const [rakutenResult, amazonResult] = await this.prisma.$transaction(async (tx) => {
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
      return [rakutenResult, amazonResult] as const;
    });

    return {
      acknowledgedAt: acknowledgedAt.toISOString(),
      requestedCount: rawItems.length,
      rakutenCount: Number(rakutenResult.count ?? 0),
      amazonCount: Number(amazonResult.count ?? 0),
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
        availableStock: 0,
        fulfillmentMode: 'xiya_api',
      }));
    }

    const productRows = await this.prisma.masterProduct.findMany({
      where: {
        productId: { in: lookupProductIds },
      },
      select: {
        productId: true,
        stockQty: true,
      },
    });

    const stockQtyByProductId = new Map(
      productRows.map((row) => [String(row.productId ?? '').trim(), Number(row.stockQty ?? 0)]),
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
        availableStock,
        fulfillmentMode: availableStock > 0 ? 'overseas_warehouse' : 'xiya_api',
      };
    });
  }

  private async enrichAmazonOrderRows(rows: AmazonOrderRecord[]): Promise<AmazonEnrichedOrderListItem[]> {
    if (!rows.length) {
      return [];
    }

    const lookupCodes = Array.from(
      new Set(
        rows
          .map((row) => String(row.sku ?? '').trim())
          .filter((value) => value.length > 0),
      ),
    );

    if (!lookupCodes.length) {
      return rows.map((row) => ({
        ...row,
        resolvedProductId: null,
        resolvedShopName: null,
        availableStock: 0,
        fulfillmentMode: 'xiya_api',
      }));
    }

    const skuRows = await this.prisma.sku.findMany({
      where: {
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

    const productIds = Array.from(
      new Set(
        skuRows
          .map((row) => String(row.productId ?? '').trim())
          .filter((value) => value.length > 0),
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

    return rows.map((row) => {
      const skuCode = String(row.sku ?? '').trim();
      const skuMeta =
        skuMetaByCode.get(skuCode) ??
        normalizedSkuMetaByCode.get(normalizeAmazonSkuLookupKey(skuCode)) ??
        null;
      const productId = skuMeta?.productId ?? null;
      const availableStock = productId ? stockQtyByProductId.get(productId) ?? 0 : 0;

      return {
        ...row,
        resolvedProductId: productId,
        resolvedShopName: skuMeta?.shopName ?? null,
        availableStock,
        fulfillmentMode: availableStock > 0 ? 'overseas_warehouse' : 'xiya_api',
      };
    });
  }

  private async importCsvBuffer(
    fileBuffer: Buffer,
    sourceFileName: string,
    sourceFilePath: string,
  ): Promise<OrderImportResult> {
    const parsedRows = this.parseCsv(fileBuffer);
    const uniqueRowsMap = new Map<string, ParsedOrderCsvRow>();
    for (const row of parsedRows) {
      if (!uniqueRowsMap.has(row.rowHash)) {
        uniqueRowsMap.set(row.rowHash, row);
      }
    }

    const uniqueRows = Array.from(uniqueRowsMap.values());
    const importedAt = new Date();
    const createManyInput: Prisma.RakutenOrderRecordCreateManyInput[] = uniqueRows.map((row) => ({
      rowHash: row.rowHash,
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

    const result = await this.prisma.rakutenOrderRecord.createMany({
      data: createManyInput,
      skipDuplicates: true,
    });

    const duplicateInFileCount = parsedRows.length - uniqueRows.length;
    const existingDuplicateCount = uniqueRows.length - result.count;

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
    const skuRows = await this.prisma.sku.findMany({
      where: {
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
        uniqueRows
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
    const importedAt = new Date();
    const createManyInput: Prisma.AmazonOrderRecordCreateManyInput[] = uniqueRows.map((row) => ({
      shippingOrigin: (() => {
        const productId = resolveSkuMeta(row.sku)?.productId;
        const stockQty = productId ? stockQtyByProductId.get(productId) ?? 0 : 0;
        return stockQty > 0 ? '日本発' : '中国発';
      })(),
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
      sourceFileName,
      sourceFilePath,
      rawPayload: row.rawPayload,
      csvImportedAt: importedAt,
    }));

    const result = await this.prisma.amazonOrderRecord.createMany({
      data: createManyInput,
      skipDuplicates: true,
    });

    const duplicateInFileCount = parsedRows.length - uniqueRows.length;
    const existingDuplicateCount = uniqueRows.length - result.count;

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
      (header) => !headerIndexMap.has(header),
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
    const missingHeaders = AMAZON_ORDER_TXT_COLUMNS.filter((column) => !headerSet.has(column.header)).length;
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

  private combineNonEmptyParts(parts: Array<string | null>, separator = ''): string | null {
    const normalized = parts
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0);
    return normalized.length ? normalized.join(separator) : null;
  }

  private resolveSendStatus(shipmentNo: string | null): OrderSendStatus {
    return shipmentNo && shipmentNo.trim() ? OrderSendStatus.sent : OrderSendStatus.unsent;
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

  private shouldExportOrderToThirdParty(
    source: ThirdPartyExportSource,
    sourceRecordId: bigint,
    dispatchModeRaw: string | null | undefined,
    fulfillmentMode: string,
    activePickedRefs: Set<string>,
  ): boolean {
    const dispatchMode = String(dispatchModeRaw ?? '').trim();
    if (dispatchMode === OVERSEAS_DISPATCH_MODE.CHINA_PENDING) {
      return true;
    }
    if (fulfillmentMode !== 'xiya_api') {
      return false;
    }
    return !activePickedRefs.has(`${source}:${sourceRecordId.toString()}`);
  }

  private normalizeChinaOrderScope(scopeParam?: string): 'pending' | 'exported' | 'all' {
    const scope = String(scopeParam ?? '').trim().toLowerCase();
    if (scope === 'exported') return 'exported';
    if (scope === 'all') return 'all';
    return 'pending';
  }

  private buildChinaOrderExportedAtFilter(
    scope: 'pending' | 'exported' | 'all',
  ): { xiyaExportedAt?: null | { not: null } } {
    if (scope === 'exported') {
      return { xiyaExportedAt: { not: null } };
    }
    if (scope === 'all') {
      return {};
    }
    return { xiyaExportedAt: null };
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
      SKUコード: row.skuCode,
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
