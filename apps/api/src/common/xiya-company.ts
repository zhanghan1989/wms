import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { companyContext } from '../company-scope/company-context';

export interface XiyaCompany {
  companyId: bigint;
  name: string;
  companyCode?: string;
  companyName?: string;
  productDays: number;
  logisticsDays: number;
  allStores: boolean;
  syncBloggerStatus: boolean;
  storeAliases: Record<string, string>;
}

export async function resolveXiyaCompany(prisma: PrismaClient): Promise<XiyaCompany> {
  const context = companyContext.getStore();
  const selectedId = context?.companyId;
  if (selectedId === undefined && !context?.warehouse) throw new BadRequestException('请先选择同步所属公司');
  // Warehouse logistics actions retain their legacy XYJG scope. Product actions
  // enumerate all configured companies before resolving an individual profile.
  const company = await prisma.company.findUnique({ where: selectedId !== undefined
    ? { id: selectedId } : { name: process.env.XIYA_WMS_COMPANY_NAME || 'XYJG' } });
  if (!company || company.status !== 1) throw new BadRequestException('公司不存在或已停用');
  const companyId = company.id;
  if (company.name === (process.env.XIYA_QILIN_WMS_COMPANY_NAME || 'QLSZ')) {
    let storeAliases: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(process.env.XIYA_QILIN_STORE_ALIASES || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.entries(parsed).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())) {
        throw new Error();
      }
      storeAliases = parsed as Record<string, string>;
    } catch {
      throw new BadRequestException('XIYA_QILIN_STORE_ALIASES 必须是上游店铺名到 WMS 店铺名的 JSON 对象');
    }
    return { companyId, name: company.name, companyCode: 'CO260716362', productDays: 30,
      logisticsDays: 30, allStores: true, syncBloggerStatus: false, storeAliases };
  }
  if (company.name === (process.env.XIYA_WMS_COMPANY_NAME || 'XYJG')) {
    return { companyId, name: company.name, companyName: process.env.XIYA_COMPANY_NAME || 'XYJG',
      productDays: 10, logisticsDays: 5, allStores: false, syncBloggerStatus: true, storeAliases: {} };
  }
  throw new BadRequestException(`公司 ${company.name} 尚未配置 Xiya 同步`);
}

export function setXiyaCompanyParams(url: URL, company: XiyaCompany): void {
  url.searchParams.delete('company_name');
  url.searchParams.delete('company_code');
  url.searchParams.delete('apiKey');
  if (company.companyCode) url.searchParams.set('company_code', company.companyCode);
  else url.searchParams.set('company_name', company.companyName!);
}

export function xiyaSyncDays(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new BadRequestException('同步天数必须是 1 到 365 的整数');
  }
  return days;
}
