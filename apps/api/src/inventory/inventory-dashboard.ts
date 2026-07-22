const DAY_IN_MS = 24 * 60 * 60 * 1000;

export type NoSalesInventoryStatus = 'unknown' | 'observing' | 'obsolete';

export function classifyNoSalesInventoryAge(
  firstStockedAt: Date | null | undefined,
  now: Date,
  observationDays = 90,
): { status: NoSalesInventoryStatus; observedDays: number | null; remainingDays: number | null } {
  if (!firstStockedAt || Number.isNaN(firstStockedAt.getTime())) {
    return { status: 'unknown', observedDays: null, remainingDays: null };
  }
  const elapsedMs = Math.max(0, now.getTime() - firstStockedAt.getTime());
  const observedDays = Math.floor(elapsedMs / DAY_IN_MS);
  if (observedDays < observationDays) {
    return {
      status: 'observing',
      observedDays,
      remainingDays: observationDays - observedDays,
    };
  }
  return { status: 'obsolete', observedDays, remainingDays: 0 };
}
