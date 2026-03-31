import { createHash } from 'crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderRecord, OrderSendStatus, Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
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

type OrderCsvColumn = (typeof ORDER_CSV_COLUMNS)[number];
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

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(limitParam?: string): Promise<OrderRecord[]> {
    const parsedLimit = Number(limitParam);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 200;
    return this.prisma.orderRecord.findMany({
      orderBy: [{ csvImportedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  async importUploadedCsv(
    fileBuffer: Buffer,
    originalName?: string,
  ): Promise<OrderImportResult> {
    const sourceFileName = String(originalName ?? '').trim() || 'uploaded-orders.csv';
    return this.importCsvBuffer(fileBuffer, sourceFileName, `uploaded:${sourceFileName}`);
  }

  async exportForThirdParty(): Promise<{
    exportedAt: string;
    total: number;
    rows: Record<string, unknown>[];
  }> {
    const rows = await this.prisma.orderRecord.findMany({
      where: {
        sendStatus: OrderSendStatus.unsent,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return {
      exportedAt: new Date().toISOString(),
      total: rows.length,
      rows: rows.map((row) => this.toThirdPartyRow(row)),
    };
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
    const createManyInput: Prisma.OrderRecordCreateManyInput[] = uniqueRows.map((row) => ({
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

    const result = await this.prisma.orderRecord.createMany({
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
      raw: false,
    });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new BadRequestException('订单CSV没有可读取的工作表');
    }

    const firstSheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(firstSheet, {
      header: 1,
      raw: false,
      defval: '',
    });
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

    const missingHeaders = ORDER_CSV_COLUMNS.map((column) => column.header).filter(
      (header) => !headerIndexMap.has(header),
    );
    if (missingHeaders.length) {
      throw new BadRequestException(`订单CSV缺少列：${missingHeaders.join('、')}`);
    }

    const parsedRows: ParsedOrderCsvRow[] = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const sourceRow = rows[rowIndex] ?? [];
      const rawPayload = {} as Record<OrderCsvHeader, string | null>;
      for (const column of ORDER_CSV_COLUMNS) {
        const cellIndex = headerIndexMap.get(column.header);
        rawPayload[column.header] =
          cellIndex === undefined ? null : this.normalizeCellValue(sourceRow[cellIndex]);
      }

      const hasAnyValue = Object.values(rawPayload).some((value) => Boolean(value));
      if (!hasAnyValue) {
        continue;
      }

      const parsedRowWithoutHash = {
        orderId: rawPayload['注文ID'],
        itemDetailStatus: rawPayload['商品明細ステータス'],
        skuCode: rawPayload['SKUコード'],
        setComponentSkuCode: rawPayload['セット構成品SKUコード'],
        orderQuantity: this.parseQuantity(rawPayload['注文個数']),
        productName: rawPayload['商品名'],
        mallName: rawPayload['モール名'],
        shopName: rawPayload['ショップ名'],
        mallOrderNo: rawPayload['モール注文番号'],
        orderStatusText: rawPayload['注文ステータス'],
        orderImportedAtRaw: rawPayload['注文取込日時'],
        orderRemark: rawPayload['注文備考'],
        shippingName: rawPayload['送付先氏名'],
        shippingPostalCode: rawPayload['送付先郵便番号'],
        shippingPrefecture: rawPayload['送付先都道府県'],
        shippingCity: rawPayload['送付先市区町村'],
        shippingAddress: rawPayload['送付先町名・番地以降'],
        shippingPhone: rawPayload['送付先電話番号'],
        shipmentCompany: null,
        shipmentNo: null,
        shipmentNoRegisteredAt: null,
        sendStatus: this.resolveSendStatus(null),
        deliveryMethod: rawPayload['配送方法'],
        deliveryDateRaw: rawPayload['お届け指定日'],
        deliveryTimeSlot: rawPayload['お届け指定時間帯'],
        shipmentRequestNo: rawPayload['出荷依頼番号'],
        productNameExtra: rawPayload['商品名１'],
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

  private resolveSendStatus(shipmentNo: string | null): OrderSendStatus {
    return shipmentNo && shipmentNo.trim() ? OrderSendStatus.sent : OrderSendStatus.unsent;
  }

  private buildRowHash(row: Omit<ParsedOrderCsvRow, 'rowHash'>): string {
    const hashBase = ORDER_CSV_COLUMNS.map((column) => row.rawPayload[column.header] ?? '').join('\u001f');
    return createHash('sha1').update(hashBase).digest('hex');
  }

  private toThirdPartyRow(row: OrderRecord): Record<string, unknown> {
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
