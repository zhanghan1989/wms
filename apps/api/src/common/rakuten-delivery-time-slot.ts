export function normalizeRakutenDeliveryTimeSlot(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').normalize('NFKC').trim();
  if (normalized === '午前中' || normalized === '1') {
    return '0812';
  }
  if (normalized === '2') {
    return '1416';
  }
  if (normalized === '9') {
    return null;
  }
  return normalized || null;
}
