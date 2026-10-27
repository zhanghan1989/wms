import { Prisma } from '@prisma/client';

const MINUTE_MS = 60_000;

export function nextTrackingCheck(status: { error?: string | null; isDelivered: boolean }, failures: number, now: Date): Date {
  // Keep moving parcels timely. Revisit incomplete delivered parcels daily;
  // repeated provider errors back off from 20 minutes to at most one day.
  const minutes = status.error ? Math.min(1440, 20 * 2 ** Math.min(7, Math.max(0, failures - 1)))
    : status.isDelivered ? 1440 : 20;
  return new Date(now.getTime() + minutes * MINUTE_MS);
}

// Prisma's NOT/equality predicates follow SQL NULL semantics. Include NULL
// explicitly when a nullable fact changes to a value, and vice versa.
export function trackingFactDifferences(data: Record<string, string | boolean | Date | null>): Prisma.RakutenOrderRecordWhereInput[] {
  const nonNullable = new Set(['trackingHasCustomsClearance', 'trackingIsDelivered']);
  const differences: Prisma.RakutenOrderRecordWhereInput[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null) differences.push({ [key]: { not: null } });
    else {
      if (!nonNullable.has(key)) differences.push({ [key]: null });
      differences.push({ [key]: { not: value } });
    }
  }
  return differences;
}
