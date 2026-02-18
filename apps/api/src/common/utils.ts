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
