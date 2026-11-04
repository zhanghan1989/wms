import { AsyncLocalStorage } from 'node:async_hooks';

export interface CompanyScope {
  companyId?: bigint;
  systemAdmin: boolean;
  warehouse: boolean;
  userId: bigint;
  bypass?: boolean;
}
export const companyContext = new AsyncLocalStorage<CompanyScope | undefined>();
