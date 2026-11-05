import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { companyContext } from './company-context';

/** Cron entry points run once per active company; manual calls keep their request scope. */
export function CompanyJob(): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    descriptor.value = async function (this: { prisma?: PrismaClient; companyPrisma?: PrismaClient }, ...args: unknown[]) {
      if (companyContext.getStore()) return original.apply(this, args);
      const prisma = this.companyPrisma ?? this.prisma;
      if (!prisma) throw new Error('公司定时任务缺少数据库连接');
      const companies = await prisma.company.findMany({ where: { status: 1 }, select: { id: true } });
      for (const company of companies) {
        try {
          await companyContext.run({ companyId: company.id, systemAdmin: true, warehouse: false, userId: 0n }, () => original.apply(this, args));
        } catch (error) {
          new Logger('CompanyJob').error(`公司 ${company.id} 的任务执行失败`, error instanceof Error ? error.stack : String(error));
        }
      }
    };
  };
}
export function companyScheduleWhere(key: string): { companyId_key: { companyId: bigint; key: string } } {
  // Retain the original center's settings; selecting a Chinese company must not
  // create another automation center or another set of switches.
  return { companyId_key: { companyId: 1n, key } };
}

/** One Japan-operated job, with access to each product's existing inventory. */
export function JapanJob(): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    descriptor.value = function (...args: unknown[]) {
      const current = companyContext.getStore();
      if (current && !current.systemAdmin && !current.warehouse) {
        throw new Error('仅日本海外仓或系统管理员可以执行乐天任务');
      }
      return companyContext.run({ systemAdmin: current?.systemAdmin ?? false, warehouse: true,
        japanOperations: true, userId: current?.userId ?? 0n }, () => original.apply(this, args));
    };
  };
}
