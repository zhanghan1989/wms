import * as XLSX from 'xlsx';

export type AmazonReplenishmentCsvRow = Record<string, string>;

type ColumnRequirement = {
  label: string;
  candidates: string[];
};

const BUSINESS_REQUIREMENTS: ColumnRequirement[] = [
  { label: '（子）ASIN', candidates: ['（子）ASIN', '(子)ASIN', '子ASIN', 'Child ASIN'] },
  { label: '会话数 - 总计', candidates: ['会话数 - 总计', '会话数-总计', 'Sessions - Total'] },
  {
    label: '页面浏览量 - 总计',
    candidates: ['页面浏览量 - 总计 ', '页面浏览量 - 总计', '页面浏览量-总计', 'Page Views - Total'],
  },
  { label: '已订购商品数量', candidates: ['已订购商品数量', 'Units Ordered'] },
];

const INVENTORY_REQUIREMENTS: ColumnRequirement[] = [
  { label: 'SKU', candidates: ['sku', 'SKU'] },
  { label: 'FNSKU', candidates: ['FNSKU', 'fnsku'] },
  { label: 'ASIN', candidates: ['asin', 'ASIN'] },
  { label: '可售库存', candidates: ['available', '可售库存', '可售'] },
  {
    label: '过去90天配送数量',
    candidates: ['配送商品数量（过去 90 天）', '过去 90 天内配送的售出商品'],
  },
];

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
}

function findMissingColumns(rows: AmazonReplenishmentCsvRow[], requirements: ColumnRequirement[]): string[] {
  const headers = new Set(Object.keys(rows[0] ?? {}).map(normalizeHeader));
  return requirements
    .filter((requirement) => !requirement.candidates.some((candidate) => headers.has(normalizeHeader(candidate))))
    .map((requirement) => requirement.label);
}

function pickValue(row: AmazonReplenishmentCsvRow | undefined, candidates: string[]): string {
  if (!row) return '';
  const headerMap = new Map(Object.keys(row).map((key) => [normalizeHeader(key), key]));
  for (const candidate of candidates) {
    const key = headerMap.get(normalizeHeader(candidate));
    if (key) return String(row[key] ?? '').trim();
  }
  return '';
}

export function parseAmazonReplenishmentCsv(buffer: Buffer): AmazonReplenishmentCsvRow[] {
  let workbook: XLSX.WorkBook;
  try {
    const source = buffer.toString('utf8').replace(/^\uFEFF/, '');
    workbook = XLSX.read(source, { type: 'string', raw: false, dateNF: 'yyyy-mm-dd' });
  } catch {
    throw new Error('无法读取CSV文件，请确认文件格式和编码');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('CSV文件没有可读取的工作表');
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: '',
    raw: false,
  });
  const rows = records
    .map((record) =>
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key.replace(/^\uFEFF/, ''), String(value ?? '').trim()]),
      ),
    )
    .filter((row) => Object.values(row).some(Boolean));
  if (!rows.length) throw new Error('CSV文件没有数据行');
  return rows;
}

export function validateAmazonReplenishmentReports(
  businessRows: AmazonReplenishmentCsvRow[],
  inventoryRows: AmazonReplenishmentCsvRow[],
): void {
  const businessMissing = findMissingColumns(businessRows, BUSINESS_REQUIREMENTS);
  if (businessMissing.length) {
    throw new Error(`第一份文件不是“销售和流量报告（按子 ASIN）”，缺少字段：${businessMissing.join('、')}`);
  }
  const inventoryMissing = findMissingColumns(inventoryRows, INVENTORY_REQUIREMENTS);
  if (inventoryMissing.length) {
    throw new Error(`第二份文件不是FBA库存报告，缺少字段：${inventoryMissing.join('、')}`);
  }
}

export function getAmazonInventorySnapshotMetadata(rows: AmazonReplenishmentCsvRow[]): {
  store: string | null;
  snapshotDate: string | null;
} {
  const stores = new Set(rows.map((row) => pickValue(row, ['store', '店铺'])).filter(Boolean));
  const snapshotDates = new Set(rows.map((row) => pickValue(row, ['快照日期', '库龄快照日期'])).filter(Boolean));
  return {
    store: stores.size === 1 ? [...stores][0].slice(0, 128) : null,
    snapshotDate: snapshotDates.size === 1 ? [...snapshotDates][0].slice(0, 32) : null,
  };
}
