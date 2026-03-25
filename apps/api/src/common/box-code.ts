export function normalizeBoxCode(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!value) return '';

  if (/^\d{1,6}$/.test(value)) {
    return value.padStart(Math.max(3, value.length), '0');
  }
  return '';
}

export function buildEquivalentBoxCodes(raw: string | null | undefined): string[] {
  const normalized = normalizeBoxCode(raw);
  if (!normalized) return [];

  const codes = new Set<string>([normalized]);
  if (/^\d+$/.test(normalized)) {
    codes.add(String(Number(normalized)));
  }

  return Array.from(codes);
}
