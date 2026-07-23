import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listEvents, deleteEvent, calendarOptions, listHolidays } from '../lib/calendarApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import EventEditorModal from './EventEditorModal';
import ConfirmDialog from './ConfirmDialog';
import type { CalendarEvent, CalendarOptions, Holiday } from '../types';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** yyyy-mm-dd for a Date, using its local calendar day (never UTC-shifted). */
const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "July 22, 2026" */
const longDate = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : ymd;
};

/** 24-hour "14:30" → "2:30 PM" */
const clock = (t: string): string => {
  const m = /^(\d{2}):(\d{2})$/.exec(t ?? '');
  if (!m) return t ?? '';
  const h = Number(m[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${suffix}`;
};

/** Colour class per event type — mirrors the source calendar's colour coding. */
const typePill = (t: string): string => {
  switch (t) {
    case 'viewing': return 'ev-viewing';
    case 'showing': return 'ev-viewing';
    case 'meeting': return 'ev-meeting';
    case 'open-house': return 'ev-openhouse';
    case 'follow-up': return 'ev-followup';
    case 'call': return 'ev-call';
    default: return 'ev-task';
  }
};

/** Tooltip text for a holiday chip: what kind it is, and whether the date can move. */
const holidayTitle = (h: Holiday): string => {
  const kind = h.national ? 'National statutory holiday'
    : h.kind === 'statutory' ? `Statutory holiday (${h.provinces.join(', ')})`
    : h.kind === 'festival' ? 'Festival / observance' : 'Observance';
  return h.approximate
    ? `${h.name} — ${kind}. Follows a lunar calendar, so confirm the exact date locally.`
    : `${h.name} — ${kind}.`;
};
const statusPill = (s: string): string =>
  s === 'completed' ? 'ok' : s === 'cancelled' ? 'bad' : s === 'rescheduled' ? 'warn' : 'info';

/** Every day shown in the month grid, padded to whole weeks. */
function monthGrid(anchor: Date): { date: Date; inMonth: boolean }[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const cells: { date: Date; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({ date: d, inMonth: d.getMonth() === anchor.getMonth() });
    // stop after the week that completes the month
    if (i >= 34 && d.getMonth() !== anchor.getMonth() && d.getDay() === 6) break;
  }
  return cells;
}

export default function CalendarPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canEdit = can('calendar', 'edit');

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [options, setOptions] = useState<CalendarOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [anchor, setAnchor] = useState(new Date());
  const [selected, setSelected] = useState(iso(new Date()));
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<CalendarEvent | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);

  /**
   * Only the first fetch shows a loading screen. Refreshes after saving or deleting an event
   * update the grid in place — replacing the whole month with "Loading calendar…" for a moment
   * read as the page reloading itself.
   */
  const loadedOnce = useRef(false);

  const load = useCallback(() => {
    if (!loadedOnce.current) setLoading(true);
    listEvents()
      .then(setEvents)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load the calendar'), 'bad'))
      .finally(() => { loadedOnce.current = true; setLoading(false); });
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { calendarOptions().then(setOptions).catch(() => { /* form falls back to defaults */ }); }, []);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.time.localeCompare(b.time));
    return map;
  }, [events]);

  const cells = monthGrid(anchor);

  // Fetch holidays for exactly the span the grid shows — which includes the trailing days of the
  // neighbouring months, so a December view still picks up New Year's Day.
  const gridFrom = cells.length ? iso(cells[0].date) : '';
  const gridTo = cells.length ? iso(cells[cells.length - 1].date) : '';
  useEffect(() => {
    if (!gridFrom || !gridTo) return;
    let cancelled = false;
    listHolidays(gridFrom, gridTo)
      .then((r) => { if (!cancelled) setHolidays(r.data); })
      .catch(() => { /* the calendar still works without holidays */ });
    return () => { cancelled = true; };
  }, [gridFrom, gridTo]);

  const holidaysByDate = useMemo(() => {
    const map = new Map<string, Holiday[]>();
    for (const h of holidays) {
      const list = map.get(h.date) ?? [];
      list.push(h);
      map.set(h.date, list);
    }
    return map;
  }, [holidays]);

  const today = iso(new Date());
  const todayEvents = byDate.get(today) ?? [];
  const upcoming = useMemo(
    () => events.filter((e) => e.date > today).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)).slice(0, 8),
    [events, today],
  );

  // ConfirmDialog closes itself after onConfirm, so this only does the work.
  const remove = async () => {
    if (!toDelete) return;
    try {
      await deleteEvent(toDelete.id);
      toast('Event deleted', 'ok');
      load();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not delete the event'), 'bad');
    }
  };

  const shiftMonth = (by: number) => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + by, 1));

  if (loading) return <div className="centered">Loading calendar…</div>;

  return (
    <>
      {/* header */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Calendar</h2>
            <div className="muted" style={{ fontSize: 13 }}>Manage your appointments, showings and follow-ups.</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={() => load()}>↻ Refresh</button>
            {canEdit && <button className="btn primary" onClick={() => setEditing('new')}>+ Add Event</button>}
          </div>
        </div>
      </div>

      <div className="cal-layout">
        {/* month grid — "Pick a date": days with events are highlighted; the events themselves
            are read in the cards on the right, so the grid stays clean. */}
        <div className="card cal-grid-card">
          <div className="modal-h" style={{ fontSize: 14 }}>📅 Pick a date</div>
          <div className="cal-monthbar">
            <button className="btn ghost sm" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
            <strong>{MONTHS[anchor.getMonth()]} {anchor.getFullYear()}</strong>
            <button className="btn ghost sm" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
          </div>

          <div className="cal-grid pick">
            {WEEKDAYS.map((d) => <div key={d} className="cal-dow">{d}</div>)}
            {cells.map(({ date, inMonth }) => {
              const key = iso(date);
              const dayList = byDate.get(key) ?? [];
              const hols = holidaysByDate.get(key) ?? [];
              const hint = [dayList.length ? `${dayList.length} event(s)` : 'No events', ...hols.map(holidayTitle)].join(' · ');
              return (
                <button
                  type="button"
                  key={key}
                  className={`cal-cell${inMonth ? '' : ' out'}${key === selected ? ' sel' : ''}${key === today ? ' today' : ''}${dayList.length ? ' has-events' : ''}`}
                  onClick={() => setSelected(key)}
                  onDoubleClick={() => canEdit && setEditing('new')}
                  title={hint}
                >
                  <span className="cal-daynum">{date.getDate()}</span>
                  {/* A small dot marks a statutory holiday or festival; its name is shown in the
                      day card on the right. Keeps the grid clean, per the "Pick a date" style. */}
                  {hols.length > 0 && <span className={`cal-hol-dot${hols.some((h) => h.kind === 'festival') ? ' festival' : ''}`} />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Two cards: Today's Events and Upcoming Events. Each event row carries its own Edit /
            Delete, so there is no separate selected-day card. */}
        <div className="cal-side">
          <div className="card">
            <div className="modal-h" style={{ fontSize: 14 }}>Today&apos;s Events<span className="sec-count">{todayEvents.length}</span></div>
            {todayEvents.length === 0
              ? <div className="help">No events today.</div>
              : todayEvents.map((e) => <EventRow key={e.id} e={e} canEdit={canEdit} onEdit={() => setEditing(e)} onDelete={() => setToDelete(e)} onDeal={() => navigate(`/app/transactions/${e.transaction_id}?mode=view`)} />)}
          </div>

          <div className="card">
            <div className="modal-h" style={{ fontSize: 14 }}>Upcoming Events<span className="sec-count">{upcoming.length}</span></div>
            {upcoming.length === 0
              ? <div className="help">Nothing upcoming.</div>
              : upcoming.map((e) => <EventRow key={e.id} e={e} showDate canEdit={canEdit} onEdit={() => setEditing(e)} onDelete={() => setToDelete(e)} onDeal={() => navigate(`/app/transactions/${e.transaction_id}?mode=view`)} />)}
          </div>
        </div>
      </div>

      {editing && (
        <EventEditorModal
          event={editing === 'new' ? null : editing}
          defaultDate={selected}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      <ConfirmDialog
        confirm={toDelete ? {
          title: 'Delete this event?',
          message: `"${toDelete.title}" on ${longDate(toDelete.date)} will be removed from the calendar.`,
          onConfirm: remove,
        } : null}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}

/**
 * One event in the Today's / Upcoming cards — title, status, time (and date in the Upcoming card),
 * with Edit and Delete inline. These two cards are the only place events are listed now, so each
 * row carries its own actions rather than a separate day panel.
 */
function EventRow({ e, showDate, canEdit, onEdit, onDelete, onDeal }: {
  e: CalendarEvent; showDate?: boolean; canEdit: boolean;
  onEdit: () => void; onDelete: () => void; onDeal: () => void;
}) {
  return (
    <div className="cal-item">
      <span className={`cal-bar ${typePill(e.type)}`} />
      <div className="cal-item-body">
        <div className="cal-item-top">
          <strong>{e.title}</strong>
          <span className={`pill ${statusPill(e.status)}`}>{e.status}</span>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {showDate ? `${longDate(e.date)} · ` : ''}{clock(e.time)}{e.location ? ` · ${e.location}` : ''}
        </div>
        {e.trade_no && (
          <a className="prop-link" style={{ fontSize: 12 }} onClick={onDeal}>
            Deal #{e.trade_no}{e.transaction_property ? ` — ${e.transaction_property}` : ''}
          </a>
        )}
        {e.description && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{e.description}</div>}
        {canEdit && (
          <div className="cal-item-actions">
            <button className="btn ghost sm" onClick={onEdit}>Edit</button>
            <button className="btn ghost sm" onClick={onDelete}>Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}
