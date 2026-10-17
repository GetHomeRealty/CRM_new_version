import { useMemo, useState } from 'react';
import { currencySign, formatCurrency } from './format';

/**
 * Commission by Closing Month, as a compact chart.
 *
 * It replaced a list of one horizontal bar per month that grew with the brokerage's history and drew
 * only the months that had deals — so the axis jumped (2099-12 → 2028-05 → 2028-03 …) and a year
 * with nothing in it simply was not there. Now the chart shows ONE PERIOD at a time, every month of
 * it in order whether or not anything closed, at a fixed height:
 *
 *   · Last 12 months   this month and the eleven before it (the default)
 *   · Next 12 months   deals expected to close, when there are any
 *   · a calendar year  any year a deal closes in, January to December
 *   · Selected range   when the page's From/To filter is set, that range
 *
 * Deals with no closing date belong to no month; their total is stated under the chart.
 */

type MonthTotal = { month: string; total: number };
type ChartType = 'columns' | 'line';

const MAX_COLUMNS = 120;
/** A closing date further ahead than this is almost certainly a typing mistake (2099, not 2029). */
const FAR_FUTURE_YEARS = 5;

const ym = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  return ym(new Date(y, m - 1 + n, 1));
}
/** Every `YYYY-MM` from `start` to `end`, inclusive. */
function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let m = start; m <= end && out.length < MAX_COLUMNS; m = addMonths(m, 1)) out.push(m);
  return out;
}
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (m: string): string => MONTH_SHORT[Number(m.slice(5, 7)) - 1];
const longLabel = (m: string): string => `${monthName(m)} ${m.slice(0, 4)}`;

/** $1.2M / $708K / $950 — for axis and column labels, where a full amount will not fit. */
function compact(n: number): string {
  const a = Math.abs(n);
  const s = currencySign();
  if (a >= 1_000_000) return `${s}${(n / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${s}${Math.round(n / 1_000)}K`;
  return `${s}${Math.round(n)}`;
}
/** A round axis maximum at or above `v`: 1, 2, 2.5 or 5 × a power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((s) => s * p >= v) ?? 10) * p;
}

export default function MonthCommissionChart({ months, from, to }: {
  months: MonthTotal[];
  /** The page's applied From/To filter (`YYYY-MM-DD`), when one is set. */
  from?: string;
  to?: string;
}) {
  const now = ym(new Date());
  const ranged = !!from || !!to;
  const dated = useMemo(() => months.filter((m) => m.month !== 'none'), [months]);
  const byMonth = useMemo(() => new Map(dated.map((m) => [m.month, m.total])), [dated]);
  const undated = months.find((m) => m.month === 'none');

  const years = useMemo(() => [...new Set(dated.map((m) => m.month.slice(0, 4)))].sort().reverse(), [dated]);
  const hasUpcoming = dated.some((m) => m.month > now);

  const options: { key: string; label: string }[] = [
    ...(ranged ? [{ key: 'range', label: 'Selected range' }] : []),
    { key: 'last12', label: 'Last 12 months' },
    ...(hasUpcoming ? [{ key: 'next12', label: 'Next 12 months' }] : []),
    ...years.map((y) => ({ key: `year:${y}`, label: y })),
  ];
  const [period, setPeriod] = useState(ranged ? 'range' : 'last12');
  const [type, setType] = useState<ChartType>('columns');
  // A period that is no longer offered (the filter changed) falls back to the first one that is.
  const active = options.some((o) => o.key === period) ? period : options[0].key;

  let start: string;
  let end: string;
  if (active === 'next12') { start = addMonths(now, 1); end = addMonths(now, 12); }
  else if (active.startsWith('year:')) { start = `${active.slice(5)}-01`; end = `${active.slice(5)}-12`; }
  else if (active === 'range') {
    const first = dated[0]?.month ?? now;
    const last = dated[dated.length - 1]?.month ?? now;
    start = from ? from.slice(0, 7) : first;
    end = to ? to.slice(0, 7) : last;
    // Never more columns than fit: keep the most recent end of a very long range.
    if (monthsBetween(start, end).length >= MAX_COLUMNS) start = addMonths(end, -(MAX_COLUMNS - 1));
  } else { start = addMonths(now, -11); end = now; }

  const cols = monthsBetween(start, end).map((m) => ({ month: m, total: byMonth.get(m) ?? 0 }));
  const periodTotal = cols.reduce((s, c) => s + c.total, 0);
  const top = niceMax(Math.max(0, ...cols.map((c) => c.total)));
  const pct = (v: number) => Math.max(0, Math.min(100, (v / top) * 100));
  const showValues = cols.length <= 18;
  const farFuture = dated.filter((m) => Number(m.month.slice(0, 4)) > new Date().getFullYear() + FAR_FUTURE_YEARS);

  const PLOT_H = 200;
  const colMin = 30;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={active} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" style={{ width: 'auto', minWidth: 170 }}>
          {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <div className="toolbar-row" style={{ gap: 4 }} role="group" aria-label="Chart type">
          {(['columns', 'line'] as const).map((t) => (
            <button key={t} type="button" className={`btn sm ${type === t ? 'primary' : 'ghost'}`} onClick={() => setType(t)}>
              {t === 'columns' ? 'Columns' : 'Line'}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <span className="help">
          {longLabel(start)} – {longLabel(end)} · <strong style={{ color: 'var(--text)' }}>{formatCurrency(periodTotal)}</strong>
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        {/* The top padding leaves room for the highest axis label and the tallest column's value. */}
        <div style={{ display: 'flex', minWidth: 48 + cols.length * colMin, paddingTop: 16 }}>
          {/* Y axis */}
          <div style={{ width: 48, flex: 'none', position: 'relative', height: PLOT_H, fontSize: 10.5, color: 'var(--muted)' }}>
            {[1, 0.75, 0.5, 0.25, 0].map((f) => (
              <span key={f} style={{ position: 'absolute', right: 6, top: `${(1 - f) * 100}%`, transform: 'translateY(-50%)' }}>{compact(top * f)}</span>
            ))}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Plot */}
            <div style={{ position: 'relative', height: PLOT_H, borderBottom: '1px solid var(--border, #e5e7eb)' }}>
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <div key={f} style={{ position: 'absolute', left: 0, right: 0, top: `${(1 - f) * 100}%`, borderTop: '1px dashed var(--border, #e5e7eb)' }} />
              ))}

              {type === 'line' && cols.length > 0 && (
                <svg viewBox={`0 0 ${cols.length} 100`} preserveAspectRatio="none" aria-hidden="true"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
                  <polygon fill="rgba(200,16,46,.10)"
                    points={`0.5,100 ${cols.map((c, i) => `${i + 0.5},${100 - pct(c.total)}`).join(' ')} ${cols.length - 0.5},100`} />
                  <polyline fill="none" stroke="#c8102e" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round"
                    points={cols.map((c, i) => `${i + 0.5},${100 - pct(c.total)}`).join(' ')} />
                </svg>
              )}

              <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
                {cols.map((c) => (
                  <div key={c.month} title={`${longLabel(c.month)}: ${formatCurrency(c.total)}`}
                    style={{ flex: 1, minWidth: colMin, position: 'relative', display: 'flex', justifyContent: 'center' }}>
                    {type === 'columns' ? (
                      <div style={{
                        position: 'absolute', bottom: 0, width: '62%', maxWidth: 46, height: `${pct(c.total)}%`,
                        minHeight: c.total > 0 ? 2 : 0, borderRadius: '4px 4px 0 0',
                        background: 'linear-gradient(180deg,#c8102e,#9c0c24)',
                      }} />
                    ) : (
                      <div style={{
                        position: 'absolute', bottom: `calc(${pct(c.total)}% - 4px)`, width: 8, height: 8, borderRadius: '50%',
                        background: '#fff', border: '2px solid #c8102e', boxSizing: 'border-box',
                      }} />
                    )}
                    {showValues && c.total > 0 && (
                      <span style={{ position: 'absolute', bottom: `calc(${pct(c.total)}% + 6px)`, fontSize: 10, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                        {compact(c.total)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* X axis: the month, and the year under January and the first column */}
            <div style={{ display: 'flex' }}>
              {cols.map((c, i) => (
                <div key={c.month} style={{ flex: 1, minWidth: colMin, textAlign: 'center', fontSize: 10.5, color: 'var(--muted)', paddingTop: 4, lineHeight: 1.3 }}>
                  <div style={{ color: c.month === now ? 'var(--text)' : undefined, fontWeight: c.month === now ? 700 : undefined }}>{monthName(c.month)}</div>
                  <div style={{ visibility: i === 0 || c.month.endsWith('-01') ? 'visible' : 'hidden' }}>{c.month.slice(0, 4)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {(undated && undated.total !== 0) || farFuture.length > 0 ? (
        <div className="help" style={{ marginTop: 8, display: 'grid', gap: 2 }}>
          {undated && undated.total !== 0 && (
            <span>Not charted: <strong>{formatCurrency(undated.total)}</strong> on deals with no closing date.</span>
          )}
          {farFuture.length > 0 && (
            <span style={{ color: 'var(--warn-ink)' }}>
              Closing date{farFuture.length > 1 ? 's' : ''} in {farFuture.map((m) => longLabel(m.month)).join(', ')} — probably a typing
              mistake; check the closing date on {farFuture.length > 1 ? 'those deals' : 'that deal'}.
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
