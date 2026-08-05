import * as XLSX from 'xlsx';

export interface FbaInventoryReportRow {
  sellerSku: string;
  asin: string;
  productName: string;
  snapshotDate: string;
  availableQty: number;
  inboundQty: number;
  reservedQty: number;
  unfulfillableQty: number;
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

function parseQty(value: unknown): number {
  const numeric = Number(normalizeText(value).replace(/[,\s]/g, ''));
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

function pickValue(record: Record<string, unknown>, candidates: string[]): unknown {
  const headerMap = new Map(Object.keys(record).map((key) => [normalizeHeader(key), key]));
  for (const candidate of candidates) {
    const matched = headerMap.get(normalizeHeader(candidate));
    if (matched) return record[matched];
  }
  return '';
}

export function parseFbaInventoryReport(buffer: Buffer): {
  rows: FbaInventoryReportRow[];
  snapshotDate: string | null;
} {
  let workbook: XLSX.WorkBook;
  try {
    const source = buffer.toString('utf8').replace(/^\uFEFF/, '');
    workbook = XLSX.read(source, { type: 'string', raw: false, dateNF: 'yyyy-mm-dd' });
  } catch {
    throw new Error('无法读取FBA库存CSV，请确认文件格式和编码');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('FBA库存CSV没有可读取的工作表');
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: '',
    raw: false,
  });
  if (!records.length) throw new Error('FBA库存CSV没有数据行');

  const availableHeaders = new Set(Object.keys(records[0]).map(normalizeHeader));
  const requiredHeaders = ['SKU', 'available', '入库数量', '预留总数量', '不可售数量'];
  const missingHeaders = requiredHeaders.filter((header) => !availableHeaders.has(normalizeHeader(header)));
  if (missingHeaders.length) {
    throw new Error(`请选择FBA库存报告；当前CSV缺少必要字段：${missingHeaders.join('、')}`);
  }

  const grouped = new Map<string, FbaInventoryReportRow>();
  records.forEach((record) => {
    const sellerSku = normalizeText(pickValue(record, ['sku', 'SKU']));
    if (!sellerSku) return;
    const row: FbaInventoryReportRow = {
      sellerSku,
      asin: normalizeText(pickValue(record, ['asin', 'ASIN'])),
      productName: normalizeText(pickValue(record, ['商品名称', '标题', 'Title'])),
      snapshotDate: normalizeText(pickValue(record, ['快照日期', '库龄快照日期'])),
      availableQty: parseQty(pickValue(record, ['available', '可售库存', '可售'])),
      inboundQty: parseQty(pickValue(record, ['入库数量'])),
      reservedQty: parseQty(pickValue(record, ['预留总数量'])),
      unfulfillableQty: parseQty(pickValue(record, ['不可售数量'])),
    };
    const current = grouped.get(sellerSku);
    if (!current) {
      grouped.set(sellerSku, row);
      return;
    }
    current.availableQty += row.availableQty;
    current.inboundQty += row.inboundQty;
    current.reservedQty += row.reservedQty;
    current.unfulfillableQty += row.unfulfillableQty;
    if (!current.asin && row.asin) current.asin = row.asin;
    if (!current.productName && row.productName) current.productName = row.productName;
    if (!current.snapshotDate && row.snapshotDate) current.snapshotDate = row.snapshotDate;
  });
  const rows = [...grouped.values()];
  if (!rows.length) throw new Error('FBA库存CSV未识别到有效SKU');
  const snapshotDates = new Set(rows.map((row) => row.snapshotDate).filter(Boolean));
  return {
    rows,
    snapshotDate: snapshotDates.size === 1 ? [...snapshotDates][0] : null,
  };
}
