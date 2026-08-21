const TOKYO_TIME_ZONE = 'Asia/Tokyo';

function validUtcDate(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date;
}

function matchedDate(match: RegExpMatchArray | null): Date | null {
  if (!match) return null;
  return validUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function tokyoDateFromInstant(source: string): Date | null {
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TOKYO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return validUtcDate(Number(record.year), Number(record.month), Number(record.day));
}

export function parseRakutenOrderDate(value: unknown): Date | null {
  const source = String(value ?? '').trim();
  if (!source) return null;

  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(source)) {
    return tokyoDateFromInstant(source);
  }

  const yearFirst = matchedDate(source.match(/^(\d{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})(?:\D|$)/));
  if (yearFirst) return yearFirst;

  const japanese = matchedDate(source.match(/^(\d{4})年([0-9]{1,2})月([0-9]{1,2})日/));
  if (japanese) return japanese;

  const compact = matchedDate(source.match(/^(\d{4})(\d{2})(\d{2})(?:\D|$)/));
  if (compact) return compact;

  const monthFirst = source.match(/^([0-9]{1,2})[-/]([0-9]{1,2})[-/](\d{4})(?:\D|$)/);
  if (monthFirst) {
    return validUtcDate(Number(monthFirst[3]), Number(monthFirst[1]), Number(monthFirst[2]));
  }

  return tokyoDateFromInstant(source);
}
