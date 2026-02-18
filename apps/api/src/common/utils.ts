import { BadRequestException } from '@nestjs/common';

export function parseId(param: string, fieldName = 'id'): bigint {
  try {
    return BigInt(param);
  } catch {
    throw new BadRequestException(`${fieldName} must be a valid integer id`);
  }
}

export function toNullableJson<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function pad(num: number): string {
  return num.toString().padStart(2, '0');
}

export function generateOrderNo(prefix: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}
