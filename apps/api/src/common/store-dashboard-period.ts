import { BadRequestException } from '@nestjs/common';

export function storeDashboardPeriod(now: Date, daysRaw?: string, month?: string) {
  const days = [7, 30, 90].includes(Number(daysRaw)) ? Number(daysRaw) : 30;
  if (!month) return { days, start: new Date(now.getTime() - days * 86400000), end: now,
    previousStart: new Date(now.getTime() - days * 2 * 86400000), month: null };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 2000) {
    throw new BadRequestException('月份格式须为 YYYY-MM');
  }
  const start = new Date(`${month}-01T00:00:00+09:00`);
  if (start > now) throw new BadRequestException('不能查询未来月份');
  const [year, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(year, m, 1) - 9 * 3600000);
  const previousStart = new Date(Date.UTC(year, m - 2, 1) - 9 * 3600000);
  return { days: Math.round((end.getTime() - start.getTime()) / 86400000), start, end, previousStart, month };
}
export type StoreDashboardPeriod = ReturnType<typeof storeDashboardPeriod>;
