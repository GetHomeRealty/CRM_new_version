import type { InputHTMLAttributes } from 'react';

// Currency text input: shows the value with thousands separators (e.g. 750,000.00)
// while passing a plain, comma-free numeric string to onChange. Store the raw value
// as usual — parseNumber() already strips commas, so nothing else needs to change.
//
// Usage:  <MoneyInput value={form.price} onChange={(v) => set('price', v)} placeholder="0.00" />

export function groupMoney(v: string | number | null | undefined): string {
  if (v === '' || v === null || v === undefined) return '';
  const s = String(v).replace(/,/g, '');
  if (!/^-?\d*\.?\d*$/.test(s)) return String(v); // leave anything unexpected untouched
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const int = dot === -1 ? body : body.slice(0, dot);
  const dec = dot === -1 ? '' : body.slice(dot); // keeps '.' and typed decimals
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + dec;
}

type MoneyInputProps = {
  value: string | number | null | undefined;
  onChange: (v: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>;

export default function MoneyInput({ value, onChange, ...rest }: MoneyInputProps) {
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      value={groupMoney(value)}
      onChange={(e) => onChange(e.target.value.replace(/,/g, ''))}
    />
  );
}
