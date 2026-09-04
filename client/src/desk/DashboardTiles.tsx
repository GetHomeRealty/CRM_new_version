import type { CSSProperties, ReactNode } from 'react';

/**
 * The tile vocabulary both dashboards are built from.
 *
 * Extracted unchanged when the single dashboard became two — the CRM's and the Transaction Desk's
 * cards look and behave identically, and duplicating these would let the two drift apart visually
 * for no reason. What differs between the dashboards is which data they read, not how a number is
 * presented.
 */

/**
 * The status split under a card's headline number, e.g. "3 pending · 1 completed".
 * A zero is kept rather than hidden — "0 cancelled" is information, a missing line is not.
 */
export function Breakdown({ parts }: { parts: { n: number; label: string; tone?: 'ok' | 'info' | 'bad' }[] }) {
  return (
    <span className="tile-breakdown">
      {parts.map((p) => (
        <span key={p.label} className={`tile-part ${p.tone ?? ''}`}>
          <strong>{p.n}</strong> {p.label}
        </span>
      ))}
    </span>
  );
}

/**
 * How many THINGS a tally covers — the sum of its counts, not how many groups it has.
 *
 * The headline of a card whose sub-line is a `TallyBreakdown` has to come from here rather than
 * from `Object.keys(by).length`. That expression counts the DISTINCT STATUSES in use, which reads
 * as a quantity of deals in the same typography as every neighbouring tile and is not one: a
 * brokerage whose deals are all Pending scored 1, and validating some of them would have made the
 * number go UP, to 2, by adding a second group. It is exported beside `TallyBreakdown` on purpose,
 * so a headline and the breakdown under it are derived from the same map.
 */
export function tallyTotal(by: Record<string, number>): number {
  return Object.values(by).reduce((sum, n) => sum + n, 0);
}

/**
 * A label→count map rendered as a breakdown, for the groupBy tallies the dashboards return.
 *
 * Sorted by count so the largest group reads first, and every key is shown: a status with a zero
 * cannot appear here at all (the database only returns groups that exist), so anything listed is
 * real.
 */
export function TallyBreakdown({ by, tone = 'info' }: { by: Record<string, number>; tone?: 'ok' | 'info' | 'bad' }) {
  const parts = Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => ({ n, label: label.toLowerCase(), tone }));
  if (!parts.length) return <span className="muted">nothing yet</span>;
  return <Breakdown parts={parts} />;
}

export interface TileProps { label: ReactNode; value: ReactNode; sub: ReactNode; color?: string; }

export function Tile({ label, value, sub, color }: TileProps) {
  const valStyle: CSSProperties | undefined = color ? { color } : undefined;
  return (
    <div className="stat-card">
      <div className="lbl">{label}</div>
      <div className="val" style={valStyle}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}
