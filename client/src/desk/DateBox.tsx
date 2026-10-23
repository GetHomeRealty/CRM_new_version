import { useRef } from 'react';
import Icon from '../ui/Icon';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10-21" → "21-October-2026" — the way the brokerage reads a deal date (2026-10-22). */
export function dayMonthYear(value: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return String(value ?? '');
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])}-${month}-${m[1]}` : String(value);
}

/**
 * A DATE BOX THAT READS "21-October-2026" (brokerage request, 2026-10-22).
 *
 * A browser's own date box shows dates in the PC's regional format (23-06-2026 here) and cannot be
 * told otherwise. This shows the date as text and keeps the browser's calendar for choosing it:
 * clicking the box, or pressing Enter / Space on it, opens the picker of a hidden date input that
 * holds the real YYYY-MM-DD value. The value, `onChange` and `disabled` behave exactly as the
 * plain date input they replace did.
 */
export default function DateBox({ value, onChange, disabled, testId }: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const open = () => {
    const el = picker.current;
    if (!el || disabled) return;
    try { el.showPicker(); } catch { el.focus(); el.click(); }
  };
  return (
    <div style={{ position: 'relative' }}>
      <input type="text" readOnly value={dayMonthYear(value)} placeholder="dd-Month-yyyy" disabled={disabled}
        data-testid={testId} aria-label={testId ? undefined : 'Date'}
        onClick={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
        style={{ cursor: disabled ? 'default' : 'pointer', paddingRight: 34 }} />
      <span aria-hidden style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none', display: 'inline-flex' }}>
        <Icon name="calendar" size={14} />
      </span>
      {/* The real value. Invisible and out of the tab order; it only supplies the calendar. */}
      <input ref={picker} type="date" value={value} disabled={disabled} tabIndex={-1} aria-hidden
        onChange={(e) => onChange(e.target.value)}
        style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: '100%', opacity: 0, pointerEvents: 'none' }} />
    </div>
  );
}
