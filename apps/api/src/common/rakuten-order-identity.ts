import { Prisma, RakutenOrderRecord } from '@prisma/client';

// orderId is the warehouse parcel reference; rmsOrderId is the customer order.
// Never infer parentage by stripping suffixes from a legitimate RMS number.
export function originalRakutenOrderId(row: Pick<RakutenOrderRecord, 'orderId'> & Partial<Pick<RakutenOrderRecord, 'rmsOrderId' | 'rawPayload'>>): string {
  const raw = row.rawPayload as Record<string, any> | null;
  return String(row.rmsOrderId || raw?._wmsOriginalOrderId || raw?.rmsOrder?.orderNumber || raw?.rmsOrder?.OrderNumber || row.orderId || '').trim();
}

export function rakutenOrderIdentityWhere(orderId: string): Prisma.RakutenOrderRecordWhereInput {
  return { OR: [{ rmsOrderId: orderId }, { rmsOrderId: null, orderId }] };
}
