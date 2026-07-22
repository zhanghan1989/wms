import * as XLSX from 'xlsx';

export type FbaSalesChannel = 'fba' | 'fbm' | 'unmatched' | 'ambiguous';

export interface FbaSalesReportRow {
  sellerSku: string;
  asin: string;
  productName: string;
  orderedQty: number;
  orderItemQty: number;
  salesAmount: number;
}

export interface FbaSalesClassifiedRow extends FbaSalesReportRow {
  channel: FbaSalesChannel;
  productId: string | null;
  matchedBy: 'sku' | 'fbmSku' | 'rbSku' | null;
}

export interface FbaSalesSystemSku {
  sku: string;
  fbmSku: string | null;
  rbSku: string | null;
  productId: string | null;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/[\s_\-()（）]/g, '')
    .toLowerCase();
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function parseNumber(value: unknown): number {
  const normalized = normalizeText(value)
    .replace(/[,\s]/g, '')
    .replace(/[￥¥$%]/g, '')
    .replace(/^JP/i, '');
  if (!normalized || normalized === '-' || normalized === '--') return 0;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function pickValue(record: Record<string, unknown>, candidates: string[]): unknown {
  const headerMap = new Map(Object.keys(record).map((key) => [normalizeHeader(key), key]));
  for (const candidate of candidates) {
    const matched = headerMap.get(normalizeHeader(candidate));
    if (matched) return record[matched];
  }
  return '';
}

export function parseFbaSalesBusinessReport(buffer: Buffer): FbaSalesReportRow[] {
  let workbook: XLSX.WorkBook;
  try {
    const source = buffer.toString('utf8').replace(/^\uFEFF/, '');
    workbook = XLSX.read(source, { type: 'string', raw: false });
  } catch {
    throw new Error('无法读取CSV文件，请确认文件格式和编码');
  }
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error('CSV文件没有可读取的工作表');
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheetName], {
    defval: '',
    raw: false,
  });
  if (!records.length) throw new Error('CSV文件没有数据行');

  const firstRecord = records[0];
  const availableHeaders = new Set(Object.keys(firstRecord).map(normalizeHeader));
  const requiredHeaders = ['SKU', '已订购商品数量'];
  const missingHeaders = requiredHeaders.filter((header) => !availableHeaders.has(normalizeHeader(header)));
  if (missingHeaders.length) {
    throw new Error(
      `请选择包含SKU列的90天销售报告；当前CSV缺少必要字段：${missingHeaders.join('、')}`,
    );
  }

  const rows = records
    .map((record) => ({
      sellerSku: normalizeText(pickValue(record, ['SKU', 'sku'])),
      asin: normalizeText(pickValue(record, ['（子）ASIN', '(子)ASIN', '子ASIN', 'Child ASIN'])),
      productName: normalizeText(pickValue(record, ['标题', '商品名称', 'Title'])),
      orderedQty: Math.max(0, Math.round(parseNumber(pickValue(record, ['已订购商品数量', 'Units Ordered'])))),
      orderItemQty: Math.max(0, Math.round(parseNumber(pickValue(record, ['订单商品总数', 'Total Order Items'])))),
      salesAmount: Math.max(0, parseNumber(pickValue(record, ['已订购商品销售额', 'Ordered Product Sales']))),
    }))
    .filter((row) => row.sellerSku);
  if (!rows.length) throw new Error('CSV未识别到有效SKU');

  const grouped = new Map<string, FbaSalesReportRow>();
  rows.forEach((row) => {
    const current = grouped.get(row.sellerSku);
    if (!current) {
      grouped.set(row.sellerSku, { ...row });
      return;
    }
    current.orderedQty += row.orderedQty;
    current.orderItemQty += row.orderItemQty;
    current.salesAmount += row.salesAmount;
    if (!current.asin && row.asin) current.asin = row.asin;
    if (!current.productName && row.productName) current.productName = row.productName;
  });
  return [...grouped.values()];
}

function addIndex(map: Map<string, Set<string>>, keyValue: unknown, productIdValue: unknown): void {
  const key = normalizeText(keyValue);
  const productId = normalizeText(productIdValue);
  if (!key || !productId) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(productId);
}

function resolveUniqueProductIds(productIds: Set<string> | undefined): string | null | 'ambiguous' {
  if (!productIds?.size) return null;
  if (productIds.size > 1) return 'ambiguous';
  return [...productIds][0];
}

export function classifyFbaSalesRows(
  reportRows: FbaSalesReportRow[],
  systemSkus: FbaSalesSystemSku[],
): FbaSalesClassifiedRow[] {
  const skuIndex = new Map<string, Set<string>>();
  const fbmSkuIndex = new Map<string, Set<string>>();
  const rbSkuIndex = new Map<string, Set<string>>();
  systemSkus.forEach((row) => {
    addIndex(skuIndex, row.sku, row.productId);
    addIndex(fbmSkuIndex, row.fbmSku, row.productId);
    addIndex(rbSkuIndex, row.rbSku, row.productId);
  });

  return reportRows.map((row) => {
    const fbaProductId = resolveUniqueProductIds(skuIndex.get(row.sellerSku));
    if (fbaProductId === 'ambiguous') {
      return { ...row, channel: 'ambiguous', productId: null, matchedBy: 'sku' };
    }
    if (fbaProductId) {
      return { ...row, channel: 'fba', productId: fbaProductId, matchedBy: 'sku' };
    }

    const fbmProductIds = new Set<string>([
      ...(fbmSkuIndex.get(row.sellerSku) ?? []),
      ...(rbSkuIndex.get(row.sellerSku) ?? []),
    ]);
    const fbmProductId = resolveUniqueProductIds(fbmProductIds);
    if (fbmProductId === 'ambiguous') {
      return { ...row, channel: 'ambiguous', productId: null, matchedBy: null };
    }
    if (fbmProductId) {
      const matchedBy = fbmSkuIndex.has(row.sellerSku) ? 'fbmSku' : 'rbSku';
      return { ...row, channel: 'fbm', productId: fbmProductId, matchedBy };
    }
    return { ...row, channel: 'unmatched', productId: null, matchedBy: null };
  });
}
