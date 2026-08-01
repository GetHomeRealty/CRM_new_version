import { useCallback, useEffect, useState } from 'react';
import { useArea } from './AreaContext';
import { calendarAnalytics, type CalendarAnalytics } from '../lib/calendarApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

/**
 * What actually happened in this diary.
 *
 * Bars rather than a chart library: one measure, nine rows at most, and a length is read at a
 * glance. Reaching for a plotting dependency to draw nine horizontal rectangles would cost more to
 * maintain than it buys anybody.
 *
 * Collapsed by default. It answers a question people ask occasionally — "how did last quarter go" —
 * and putting it permanently above the month grid would push the actual calendar down the page for
 * the majority of visits, which are somebody checking tomorrow.
 */

const RANGES: { label: string; days: number }[] = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '12 months', days: 365 },
];

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** One row of the bar list. `of` is the largest value, so bars are relative to the busiest. */
function Bar({ label, n, of, tone }: { label: string; n: number; of: number; tone?: string }) {
  const pct = of > 0 ? Math.round((n / of) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
      <span style={{ fontSize: 12, width: 92, flex: 'none', color: 'var(--muted)' }}>{label}</span>
      <span style={{ flex: 1, height: 8, background: 'var(--line)', borderRadius: 4, overflow: 'hidden' }}>
        <span style={{ display: 'block', width: `${pct}%`, height: '100%', borderRadius: 4, background: tone ?? 'var(--pri, #4f46e5)' }} />
      </span>
      <strong style={{ fontSize: 12, width: 28, textAlign: 'right' }}>{n}</strong>
    </div>
  );
}

export default function CalendarAnalyticsPanel() {
  const { area } = useArea();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(90);
  const [data, setData] = useState<CalendarAnalytics | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    calendarAnalytics(area, iso(from), iso(to))
      .then(setData)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load calendar analytics'), 'bad'))
      .finally(() => setLoading(false));
  }, [area, days, toast]);

  // Nothing is fetched until somebody opens it — see the note above about the common visit.
  useEffect(() => { if (open) load(); }, [open, load]);

  const t = data?.totals;
  const r = data?.rates;
  const maxDay = Math.max(1, ...(data?.by_weekday ?? []).map((d) => d.total));
  const maxHour = Math.max(1, ...(data?.by_hour ?? []).map((h) => h.total));
  const maxType = Math.max(1, ...(data?.by_type ?? []).map((x) => x.total));

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong>Calendar analytics</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>How your appointments actually went.</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {open && RANGES.map((x) => (
            <button key={x.days} type="button" className={`btn ghost sm${days === x.days ? ' active' : ''}`}
              onClick={() => setDays(x.days)}>{x.label}</button>
          ))}
          <button className="btn ghost sm" type="button" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {open && loading && <p className="help" style={{ marginTop: 10 }}>Working it out…</p>}

      {open && !loading && data && t && r && (
        t.total === 0 ? (
          <p className="help" style={{ marginTop: 10 }}>
            No appointments in the last {days} days, so there is nothing to measure yet.
          </p>
        ) : (
          <>
            <div className="tiles" style={{ marginTop: 12 }}>
              <div className="stat-card">
                <div className="lbl">Appointments</div>
                <div className="val">{t.total}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  <span className="tile-breakdown"><span className="tile-part info">{t.scheduled} still to come</span></span>
                </div>
              </div>
              <div className="stat-card">
                <div className="lbl">Kept</div>
                <div className="val" style={{ color: 'var(--ok-ink)' }}>{r.completion === null ? '—' : `${r.completion}%`}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  <span className="tile-breakdown"><span className="tile-part ok">{t.completed} completed</span></span>
                </div>
              </div>
              <div className="stat-card">
                <div className="lbl">No-shows</div>
                <div className="val" style={{ color: t.no_show ? 'var(--bad-ink)' : undefined }}>{r.no_show === null ? '—' : `${r.no_show}%`}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  <span className="tile-breakdown"><span className="tile-part bad">{t.no_show} nobody came</span></span>
                </div>
              </div>
              <div className="stat-card">
                <div className="lbl">Cancelled</div>
                <div className="val">{r.cancellation === null ? '—' : `${r.cancellation}%`}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  <span className="tile-breakdown"><span className="tile-part bad">{t.cancelled} called off</span></span>
                </div>
              </div>
            </div>

            {/* Said out loud, because a percentage over a handful of appointments is not a trend and
                somebody will otherwise read one as if it were. */}
            <p className="help" style={{ marginTop: 4 }}>
              Rates are of the {r.settled} appointment{r.settled === 1 ? '' : 's'} that reached an outcome —
              still-scheduled ones are not counted{r.settled > 0 && r.settled < 10 ? '. That is a small number; treat the percentages loosely.' : '.'}
            </p>

            <div className="g2" style={{ marginTop: 12 }}>
              <div>
                <div className="modal-sub">Busiest days</div>
                {data.by_weekday.map((d) => <Bar key={d.day} label={d.day} n={d.total} of={maxDay} />)}
                {data.busiest.weekday && (
                  <p className="help">
                    Busiest overall: <strong>{data.busiest.weekday}</strong>
                    {data.busiest.hour && <> · most common start <strong>{data.busiest.hour}</strong></>}
                    {data.busiest.date && <> · fullest day <strong>{data.busiest.date}</strong> ({data.busiest.date_count})</>}
                  </p>
                )}
              </div>

              <div>
                <div className="modal-sub">By appointment type</div>
                {data.by_type.length === 0
                  ? <p className="help">Nothing recorded.</p>
                  : data.by_type.map((x) => (
                    <div key={x.type}>
                      <Bar label={x.label} n={x.total} of={maxType} />
                      {(x.completed > 0 || x.no_show > 0) && (
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 100, marginTop: -2, marginBottom: 4 }}>
                          {x.completed} kept{x.no_show > 0 && <> · <span style={{ color: 'var(--bad-ink)' }}>{x.no_show} no-show</span></>}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>

            {data.by_hour.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="modal-sub">Time of day</div>
                {data.by_hour.map((h) => <Bar key={h.hour} label={h.hour} n={h.total} of={maxHour} />)}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
