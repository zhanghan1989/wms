export type InventoryKey = { manageNumber: string; variantId: string };
export type InventoryRecord = InventoryKey & {
  quantity: number;
  operationLeadTime?: { normalDeliveryTimeId?: number; backOrderDeliveryTimeId?: number };
  shipFromIds?: number[];
};
export type InventoryWrite = InventoryRecord & { mode: 'ABSOLUTE' };
export type InventoryPlanRow = InventoryRecord & {
  mappingId: string; productId: string; currentQuantity: number; safetyStock: number;
  stock?: InventoryStockBreakdown;
};
export const inventoryKey = (row: InventoryKey) => `${row.manageNumber.toLowerCase()}\u001f${row.variantId}`;

export type RakutenCatalogVariant = {
  manageNumber: string; variantId: string; merchantDefinedSkuId: string | null;
  title: string; hidden: boolean; unlimitedStock: boolean;
  salesStart: string | null; salesEnd: string | null;
};
export type RakutenCatalogPage = {
  numFound: number; nextCursorMark: string; variants: RakutenCatalogVariant[]; itemCount: number;
};

// Full product payloads can be large even without inventory data.
export const RAKUTEN_CATALOG_PAGE_SIZE = 25;

export const RAKUTEN_INVENTORY_JOB_NAME = 'rakuten-inventory-sync';
export type InventoryPlanContext = {
  mode: 'full' | 'incremental'; scopeCount: number; skippedCount: number; issues?: InventorySkuIssue[];
};
export function inventoryFullCheckDue(last: Date | null | undefined, now = new Date()): boolean {
  const day = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  return !last || day(last) !== day(now);
}

export type InventoryStockBreakdown = {
  finishedStock: number; assemblableStock: number | null; beforePending: number;
  pendingReserved: number; availableQuantity: number;
};
export type InventorySkuIssue = InventoryKey & { mappingId: string; productId: string; reason: string };
