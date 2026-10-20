export interface InboundArrivalDates {
  expectedArrivalDate?: string | null;
  registeredAt?: Date | string | null;
}

// Keep the estimate anchored to the batch registration, never the dashboard date.
export function resolveInboundExpectedArrivalDate(input: InboundArrivalDates): string | null {
  if (input.expectedArrivalDate) return input.expectedArrivalDate;
  if (!input.registeredAt) return null;
  const registered = new Date(input.registeredAt);
  if (Number.isNaN(registered.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(registered);
  const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const start = Date.parse(`${date.year}-${date.month}-${date.day}T00:00:00.000Z`);
  return new Date(start + 45 * 86400000).toISOString().slice(0, 10);
}
