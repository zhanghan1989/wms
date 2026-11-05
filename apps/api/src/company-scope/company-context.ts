import { AsyncLocalStorage } from 'node:async_hooks';

export interface CompanyScope {
  companyId?: bigint;
  systemAdmin: boolean;
  warehouse: boolean;
  userId: bigint;
  bypass?: boolean;
  japanOperations?: boolean;
  japanShopNames?: Promise<string[]>;
  amazonSkuOnly?: boolean;
  dashboardCompanyScope?: boolean;
}
export const companyContext = new AsyncLocalStorage<CompanyScope | undefined>();
