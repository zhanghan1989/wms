/** Japan operates one Rakuten center; Chinese companies operate their Amazon
 * stores and their assigned China-fulfillment lines. */
export function isJapanManagementPath(path: string): boolean {
  if (isCompanySalesDashboardPath(path)) return false;
  return /^(rakuten-rms-api|rakuten-combo-products)(\/|$)/.test(path)
    || /^orders\/(rakuten\/(tracking-status-summary|tracking-query-failures|change-order-id-batch)|delete-batch)(\/|$)/.test(path);
}

export function isCompanySalesDashboardPath(path: string): boolean {
  return path === 'rakuten-rms-api/store-dashboard' || path === 'rakuten-rms-api/store-dashboard/export-excel';
}

export function isWarehouseWorkPath(path: string, method: string): boolean {
  // Chinese companies may query returns; only warehouse/system accounts may write.
  if (/^return-records(\/|$)/.test(path) && !['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  // FBA workflows use the requesting company's data scope.
  if (/^inventory\/fba-replenishments(\/|$)/.test(path)
    || /^master-products\/[^/]+\/fba-replenishments$/.test(path)) return false;
  if (/^(batch-inbound|inbound|outbound|stocktake|stocktake-planner|print-jobs)(\/|$)/.test(path)
    || /^orders\/overseas-warehouse(\/|$)/.test(path)) return true;
  if (/^inventory\/(replace-box|dashboard\/(amazon-replenishment|production-recommendations))/.test(path)) return true;
  if (/^master-products\/[^/]+\/(box-inventories|print-settings)(\/|$)/.test(path)
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
