export function normalizeBoxCode(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim();
  return /^\d{1,6}$/.test(value) ? value.replace(/^0+(?=\d)/, '') : '';
}

export function buildEquivalentBoxCodes(raw: string | null | undefined): string[] {
  const normalized = normalizeBoxCode(raw);
  if (!normalized) return [];

  // Existing records may still carry leading zeros.
  return Array.from({ length: 7 - normalized.length }, (_, index) =>
    normalized.padStart(normalized.length + index, '0'),
  );
}
