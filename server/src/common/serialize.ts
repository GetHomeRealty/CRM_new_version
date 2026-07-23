/**
 * Serialization helpers that reproduce Laravel/PHP value formatting so JSON
 * responses stay byte-identical.
 */

/** Laravel `optional($date)->toDateString()` — a @db.Date column as "YYYY-MM-DD". */
export function toDateString(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/** Laravel Carbon `toDateTimeString()` — "YYYY-MM-DD HH:mm:ss" (UTC). */
export function toDateTimeString(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Laravel Carbon `toIso8601String()` — "YYYY-MM-DDTHH:mm:ss+00:00" (UTC). */
export function toIso8601String(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 19) + '+00:00';
}

/**
 * Laravel's DEFAULT model date serialization (Eloquent serializeDate) —
 * "YYYY-MM-DDTHH:mm:ss.000000Z" (ISO-8601, microseconds, UTC). Used when a raw
 * model (not a Resource) is returned as JSON.
 */
export function laravelJsonDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, '.000000Z');
}

/** Laravel `decimal:n` cast — a fixed-decimals STRING (e.g. 13 → "13.00"). */
export function decimalCast(v: number | string | { toString(): string } | null | undefined, places: number): string | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(places) : null;
}

/** PHP blank(): null / undefined / empty-or-whitespace string / empty array. */
export function phpBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * PHP round(): round half away from zero, with the same floating-point
 * pre-correction PHP applies (e.g. round(2.005, 2) === 2.01, not 2.00). We strip
 * fp noise by re-parsing at 14 significant digits before the half-up round.
 */
export function phpRound(value: number, precision = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = Math.pow(10, precision);
  const scaled = parseFloat((Math.abs(value) * factor).toPrecision(14));
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(scaled)) / factor;
}

/** PHP round($n, 2). */
export function round2(n: number): number {
  return phpRound(n, 2);
}

/** PHP `(float) str_replace(',', '', (string) $v)` — strip thousands separators. */
export function toFloat(v: unknown): number {
  const n = parseFloat(String(v ?? 0).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** PHP `(float) $v` cast: parseFloat semantics (stops at first non-numeric), non-numeric → 0. */
export function phpFloat(v: unknown): number {
  const n = parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/**
 * PHP `empty($v)` truthiness: true for null/undefined, false, 0, 0.0, '', '0', [].
 * Used where the Laravel code guards with `empty()` / `!empty()`.
 */
export function phpEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '' || v === '0') return true;
  if (v === 0) return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Parse a JSON blob column (Eloquent array cast); invalid/empty → null. */
export function parseJson<T = unknown>(text: string | null | undefined): T | null {
  if (text === null || text === undefined || text === '') return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Parse a JSON blob column that Laravel would treat as an array/object, defaulting to {}. */
export function parseJsonObject(text: string | null | undefined): Record<string, unknown> {
  const v = parseJson<Record<string, unknown>>(text);
  return v && typeof v === 'object' ? v : {};
}

/**
 * Reproduce Laravel's `array` cast round-trip (json_decode($x, true) then
 * json_encode): every EMPTY object `{}` becomes `[]` (recursively), because PHP
 * decodes objects to associative arrays and re-encodes an empty array as `[]`.
 * Non-empty objects and arrays are preserved (recursing into their values).
 */
export function phpJsonNormalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(phpJsonNormalize);
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 0) return [];
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = phpJsonNormalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Parse a JSON blob column for RESPONSE output, matching Laravel's array-cast encoding. */
export function jsonField(text: string | null | undefined): unknown {
  const v = parseJson(text);
  return v === null ? null : phpJsonNormalize(v);
}
