import { createHash } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { AmazonOrderRecord, OrderSendStatus, Prisma, RakutenOrderRecord } from '@prisma/client';
import * as iconv from 'iconv-lite';
import { join } from 'path';
import * as XLSX from 'xlsx';
import { APP_TIMEZONE, getZonedDateParts, parseId } from '../common/utils';
import { PrismaService } from '../prisma/prisma.service';

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

type OrderFulfillmentMode = 'rakuten_warehouse' | 'xiya_api';

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
}

interface SelectedOverseasWarehouseOrderRef {
  source?: 'rakuten' | 'amazon';
  id?: string | number;
}

interface YamatoImportFileResult {
  fileName: string;
  content: Buffer;
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

const YAMATO_IMPORT_TEMPLATE_FILE = 'ヤマト-インポート.xlsx';
const YAMATO_DUPLICATE_ROW_FILL = 'FFF59D';
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

function normalizeAmazonSkuLookupKey(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

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

    const [rakutenRows, amazonRows] = await Promise.all([
      this.prisma.rakutenOrderRecord.findMany({
        where: {
          sendStatus: OrderSendStatus.unsent,
        },
        orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
      this.prisma.amazonOrderRecord.findMany({
        where: {
          OR: [{ shipmentNo: null }, { shipmentNo: '' }],
        },
        orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    ]);

    const [enrichedRakutenRows, enrichedAmazonRows] = await Promise.all([
      this.enrichOrderRows(rakutenRows),
      this.enrichAmazonOrderRows(amazonRows),
    ]);

    return [
      ...enrichedRakutenRows
        .filter((row) => row.fulfillmentMode === 'rakuten_warehouse' && row.availableStock > 0)
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
        .filter((row) => row.fulfillmentMode === 'overseas_warehouse' && row.availableStock > 0)
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
    ]
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
        .filter((row) => row.fulfillmentMode === 'rakuten_warehouse' && row.availableStock > 0)
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

    const workbook = await this.loadYamatoTemplateWorkbook();
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new NotFoundException(`模板文件缺少工作表：${YAMATO_IMPORT_TEMPLATE_FILE}`);
    }
    const sheet = workbook.Sheets[sheetName];
    const templateRowIndex = 1;
    const startRowIndex = 1;
    const maxColumnIndex = YAMATO_COLUMNS.deliveryType;
    const currentDate = this.formatCurrentYamatoDate();

    mergedRows.forEach((row, rowOffset) => {
      const targetRowIndex = startRowIndex + rowOffset;
      this.writeYamatoRowCell(sheet, targetRowIndex, YAMATO_COLUMNS.orderId, row.orderId, templateRowIndex);
      this.writeYamatoRowCell(sheet, targetRowIndex, YAMATO_COLUMNS.shipDate, currentDate, templateRowIndex);
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.deliveryDate,
        row.deliveryDate || '-',
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.deliveryTimeSlot,
        row.deliveryTimeSlot || '-',
        templateRowIndex,
      );
      this.writeYamatoRowCell(sheet, targetRowIndex, YAMATO_COLUMNS.phone, row.phone, templateRowIndex);
      this.writeYamatoRowCell(sheet, targetRowIndex, YAMATO_COLUMNS.postalCode, row.postalCode, templateRowIndex);
      this.writeYamatoRowCell(sheet, targetRowIndex, YAMATO_COLUMNS.address1, row.address1, templateRowIndex);
      this.writeYamatoRowCell(sheet, targetRowIndex, YAMATO_COLUMNS.address2, row.address2, templateRowIndex);
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.recipientName,
        row.recipientName,
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.recipientSuffix,
        YAMATO_EXPORT_FIXED_VALUES.recipientSuffix,
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.senderPhone,
        YAMATO_EXPORT_FIXED_VALUES.senderPhone,
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.senderPostalCode,
        YAMATO_EXPORT_FIXED_VALUES.senderPostalCode,
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.senderAddress,
        YAMATO_EXPORT_FIXED_VALUES.senderAddress,
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.senderName,
        YAMATO_EXPORT_FIXED_VALUES.senderName,
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.itemSummary,
        row.itemSummary,
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.invoiceCustomerCode,
        YAMATO_EXPORT_FIXED_VALUES.invoiceCustomerCode,
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.coolType,
        YAMATO_EXPORT_FIXED_VALUES.coolType,
        templateRowIndex,
      );
      this.writeYamatoRowCell(
        sheet,
        targetRowIndex,
        YAMATO_COLUMNS.deliveryType,
        YAMATO_EXPORT_FIXED_VALUES.deliveryType,
        templateRowIndex,
      );

      if (row.isMergedDuplicate) {
        this.highlightYamatoRow(sheet, targetRowIndex, maxColumnIndex, templateRowIndex);
      }
    });

    this.extendSheetRange(sheet, startRowIndex + mergedRows.length - 1, maxColumnIndex);

    const content = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
      cellStyles: true,
    }) as Buffer;
    const timestamp = this.formatYamatoFileNameStamp();
    return {
      fileName: `ヤマト-インポート_${timestamp}.xlsx`,
      content,
    };
  }

  private parseSelectedOverseasOrderId(value: string | number | undefined, fieldName: string): bigint {
    const text = String(value ?? '').trim();
    if (!text) {
      throw new BadRequestException(`${fieldName} 不能为空`);
    }
    return parseId(text, fieldName);
  }

  private mapRakutenOrderToYamatoItem(row: OrderListItem): YamatoExportItem {
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
      phone: String(row.shippingPhone ?? '').trim() || '-',
      postalCode: String(row.shippingPostalCode ?? '').trim() || '-',
      address1: this.concatAddress([row.shippingPrefecture, row.shippingCity]),
      address2: String(row.shippingAddress ?? '').trim() || '-',
      recipientName: String(row.shippingName ?? '').trim() || '-',
    };
  }

  private mapAmazonOrderToYamatoItem(row: AmazonEnrichedOrderListItem): YamatoExportItem {
    return {
      source: 'amazon',
      id: row.id.toString(),
      orderId: String(row.orderId ?? '').trim(),
      productId: String(row.resolvedProductId ?? '').trim() || '-',
      quantity: Number(row.quantityPurchased ?? 0) || 0,
      deliveryDate: '-',
      deliveryTimeSlot: '-',
      phone: String(row.buyerPhoneNumber ?? '').trim() || '-',
      postalCode: String(row.shipPostalCode ?? '').trim() || '-',
      address1: this.concatAddress([row.shipState, row.shipAddress1]),
      address2: this.concatAddress([row.shipAddress2, row.shipAddress3]),
      recipientName: String(row.recipientName ?? '').trim() || '-',
    };
  }

  private mergeYamatoExportItems(items: YamatoExportItem[]): Array<
    Omit<YamatoExportItem, 'source' | 'id' | 'productId' | 'quantity'> & {
      itemSummary: string;
      isMergedDuplicate: boolean;
    }
  > {
    const mergedByOrderId = new Map<
      string,
      Omit<YamatoExportItem, 'source' | 'id' | 'productId' | 'quantity'> & {
        itemParts: string[];
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
          lineCount: 1,
        });
        return;
      }

      existing.itemParts.push(itemPart);
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
    }));
  }

  private async loadYamatoTemplateWorkbook(): Promise<XLSX.WorkBook> {
    const cwd = process.cwd();
    const candidates = [
      join(cwd, 'docs', YAMATO_IMPORT_TEMPLATE_FILE),
      join(cwd, 'apps', 'api', 'docs', YAMATO_IMPORT_TEMPLATE_FILE),
      join(cwd, '..', '..', 'docs', YAMATO_IMPORT_TEMPLATE_FILE),
    ];

    for (const templatePath of candidates) {
      try {
        const content = await readFile(templatePath);
        return XLSX.read(content, { type: 'buffer', cellStyles: true });
      } catch {
        // continue
      }
    }

    throw new NotFoundException(`模板文件不存在：${YAMATO_IMPORT_TEMPLATE_FILE}`);
  }

  private writeYamatoRowCell(
    sheet: XLSX.WorkSheet,
    rowIndex: number,
    columnIndex: number,
    value: string,
    templateRowIndex: number,
  ): void {
    const ref = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
    const templateRef = XLSX.utils.encode_cell({ r: templateRowIndex, c: columnIndex });
    const templateCell = sheet[templateRef] as XLSX.CellObject | undefined;
    const existingCell = sheet[ref] as XLSX.CellObject | undefined;
    const cell: XLSX.CellObject = {
      ...(existingCell ?? {}),
      t: 's',
      v: value,
      w: value,
    };

    if (templateCell?.s) {
      cell.s = this.cloneXlsxStyle(templateCell.s);
    }

    sheet[ref] = cell;
  }

  private highlightYamatoRow(
    sheet: XLSX.WorkSheet,
    rowIndex: number,
    maxColumnIndex: number,
    templateRowIndex: number,
  ): void {
    for (let columnIndex = 0; columnIndex <= maxColumnIndex; columnIndex += 1) {
      const ref = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const templateRef = XLSX.utils.encode_cell({ r: templateRowIndex, c: columnIndex });
      const templateCell = sheet[templateRef] as XLSX.CellObject | undefined;
      const existingCell = sheet[ref] as XLSX.CellObject | undefined;
      const cell: XLSX.CellObject = existingCell ?? {
        t: 's',
        v: '',
        w: '',
      };
      cell.s = {
        ...(templateCell?.s ? this.cloneXlsxStyle(templateCell.s) : {}),
        fill: {
          patternType: 'solid',
          fgColor: { rgb: YAMATO_DUPLICATE_ROW_FILL },
          bgColor: { rgb: YAMATO_DUPLICATE_ROW_FILL },
        },
      };
      sheet[ref] = cell;
    }
  }

  private extendSheetRange(sheet: XLSX.WorkSheet, maxRowIndex: number, maxColumnIndex: number): void {
    const currentRange = sheet['!ref']
      ? XLSX.utils.decode_range(sheet['!ref'])
      : XLSX.utils.decode_range(`A1:${XLSX.utils.encode_cell({ r: maxRowIndex, c: maxColumnIndex })}`);
    if (maxRowIndex > currentRange.e.r) {
      currentRange.e.r = maxRowIndex;
    }
    if (maxColumnIndex > currentRange.e.c) {
      currentRange.e.c = maxColumnIndex;
    }
    sheet['!ref'] = XLSX.utils.encode_range(currentRange);
  }

  private cloneXlsxStyle(style: unknown): Record<string, unknown> | undefined {
    if (!style || typeof style !== 'object') {
      return undefined;
    }
    return JSON.parse(JSON.stringify(style)) as Record<string, unknown>;
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

  private formatCurrentYamatoDate(date: Date = new Date()): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}/${parts.month}/${parts.day}`;
  }

  private formatYamatoFileNameStamp(date: Date = new Date()): string {
    const parts = getZonedDateParts(date, APP_TIMEZONE);
    return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
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
    const rows = await this.prisma.rakutenOrderRecord.findMany({
      where: {
        sendStatus: OrderSendStatus.unsent,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const enrichedRows = await this.enrichOrderRows(rows);
    const targetRows = enrichedRows.filter((row) => row.fulfillmentMode === 'xiya_api');

    return {
      exportedAt: new Date().toISOString(),
      total: targetRows.length,
      rows: targetRows.map((row) => this.toThirdPartyRow(row)),
    };
  }

  private async enrichOrderRows(rows: RakutenOrderRecord[]): Promise<OrderListItem[]> {
    if (!rows.length) {
      return [];
    }

    const lookupCodes = Array.from(
      new Set(
        rows
          .flatMap((row) => [row.skuCode, row.setComponentSkuCode])
          .map((value) => String(value ?? '').trim())
          .filter((value) => value.length > 0),
      ),
    );

    if (!lookupCodes.length) {
      return rows.map((row) => ({
        ...row,
        resolvedProductId: null,
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
      },
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
          where: {
            productId: { in: productIds },
          },
          select: {
            productId: true,
            stockQty: true,
          },
        })
      : [];

    const stockQtyByProductId = new Map(
      productRows.map((row) => [String(row.productId ?? '').trim(), Number(row.stockQty ?? 0)]),
    );

    const productIdBySkuCode = new Map<string, string>();
    const normalizedProductIdBySkuCode = new Map<string, string>();
    skuRows.forEach((row) => {
      const productId = String(row.productId ?? '').trim();
      if (!productId) return;

      [row.sku, row.rbSku, row.fbmSku].forEach((candidate) => {
        const rawKey = String(candidate ?? '').trim();
        if (rawKey && !productIdBySkuCode.has(rawKey)) {
          productIdBySkuCode.set(rawKey, productId);
        }

        const normalizedKey = normalizeAmazonSkuLookupKey(candidate);
        if (normalizedKey && !normalizedProductIdBySkuCode.has(normalizedKey)) {
          normalizedProductIdBySkuCode.set(normalizedKey, productId);
        }
      });
    });

    const resolveProductId = (value: string | null): string | null => {
      const rawKey = String(value ?? '').trim();
      if (!rawKey) return null;
      return (
        productIdBySkuCode.get(rawKey) ??
        normalizedProductIdBySkuCode.get(normalizeAmazonSkuLookupKey(rawKey)) ??
        null
      );
    };

    return rows.map((row) => {
      const productId = resolveProductId(row.skuCode) ?? resolveProductId(row.setComponentSkuCode);
      const availableStock = productId ? stockQtyByProductId.get(productId) ?? 0 : 0;

      return {
        ...row,
        resolvedProductId: productId,
        availableStock,
        fulfillmentMode: availableStock > 0 ? 'rakuten_warehouse' : 'xiya_api',
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

  private toThirdPartyRow(row: RakutenOrderRecord): Record<string, unknown> {
    return {
      id: row.id.toString(),
      rowHash: row.rowHash,
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
