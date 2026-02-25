import { BadRequestException } from '@nestjs/common';

export const APP_TIMEZONE = 'Asia/Shanghai';

export function parseId(param: string, fieldName = 'id'): bigint {
  try {
    return BigInt(param);
  } catch {
    throw new BadRequestException(`${fieldName}必须为有效数字ID`);
  }
}

export function toNullableJson<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export function getZonedDateParts(
  date: Date = new Date(),
  timeZone: string = APP_TIMEZONE,
): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const mapped = Object.fromEntries(
    parts.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]),
  ) as Record<string, string>;

  return {
    year: mapped.year || '0000',
    month: mapped.month || '00',
    day: mapped.day || '00',
    hour: mapped.hour || '00',
    minute: mapped.minute || '00',
    second: mapped.second || '00',
  };
}

export function generateOrderNo(prefix: string): string {
  const parts = getZonedDateParts(new Date(), APP_TIMEZONE);
  const stamp = [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].join(
    '',
  );
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}
