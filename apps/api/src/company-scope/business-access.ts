/** Japan operates one Rakuten center; Chinese companies operate their Amazon
 * stores and their assigned China-fulfillment lines. */
export function isJapanManagementPath(path: string): boolean {
  return /^(rakuten-rms-api|rakuten-combo-products)(\/|$)/.test(path)
    || path === 'orders'
    || /^orders\/(rakuten\/(tracking-status-summary|tracking-query-failures|change-order-id-batch)|delete-batch)(\/|$)/.test(path);
}

export function isWarehouseWorkPath(path: string, method: string): boolean {
  if (path === 'inventory/fba-replenishments/pending-summary' && method === 'GET') return false;
  if (/^(batch-inbound|inbound|outbound|stocktake|stocktake-planner|return-records|print-jobs)(\/|$)/.test(path)
    || /^orders\/overseas-warehouse(\/|$)/.test(path)) return true;
  if (/^inventory\/(fba-replenishments|replace-box|dashboard\/(amazon-replenishment|production-recommendations))/.test(path)) return true;
  if (/^master-products\/[^/]+\/(box-inventories|fba-replenishments|print-settings)(\/|$)/.test(path)
    && !['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return /^(boxes|shelves)(\/|$)/.test(path) || path.startsWith('inventory/');
  }
  return false;
}

/** These are Japanese sales/configuration records, not physical stock owners.
 * Existing company_id values remain for historical compatibility. */
export function isJapanSalesModel(model: string): boolean {
  return model.startsWith('Rakuten');
}
