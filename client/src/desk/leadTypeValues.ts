/** Accept the new array response and the former single-value response during a rolling deploy. */
export function leadTypeValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}
