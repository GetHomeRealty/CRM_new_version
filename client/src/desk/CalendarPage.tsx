import { useArea } from './AreaContext';
import { deskPath } from './area';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { listEvents, deleteEvent, updateEvent, calendarOptions, listHolidays } from '../lib/calendarApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import EventEditorModal from './EventEditorModal';
import ConfirmDialog from './ConfirmDialog';
import CalendarAnalyticsPanel from './CalendarAnalyticsPanel';
import PushRemindersToggle from './PushRemindersToggle';
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
    // Its own colour. A showing and a viewing are different appointments to a brokerage, and
    // sharing one swatch made a day of both unreadable at a glance.
    case 'showing': return 'ev-showing';
    case 'meeting': return 'ev-meeting';
    case 'open-house': return 'ev-openhouse';
    case 'follow-up': return 'ev-followup';
    case 'call': return 'ev-call';
    case 'inspection': return 'ev-inspection';
    case 'closing': return 'ev-closing';
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
  s === 'completed' ? 'ok'
  // A no-show reads as bad, like a cancellation — it cost the agent a journey.
  : s === 'cancelled' || s === 'no-show' ? 'bad'
  : s === 'rescheduled' ? 'warn' : 'info';

/** Every day shown in the month grid, padded to whole weeks. */
/**
 * `YYYY-MM` from the URL, or the current month.
 *
 * Deliberately forgiving — a hand-edited or truncated value falls back to today rather than
 * rendering an Invalid Date grid.
 */
function monthFromParam(v: string | null): Date {
  const m = /^(\d{4})-(\d{2})$/.exec(v ?? '');
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12) return new Date(year, month - 1, 1);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

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
  const { area } = useArea();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canEdit = can('calendar', 'edit');

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [options, setOptions] = useState<CalendarOptions | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * The month on screen, kept in the URL as `?month=YYYY-MM`.
   *
   * It was component state, so a refresh, a bookmark or a link pasted to a colleague all landed
   * back on today — you could not send somebody "next month's showings". Held here it survives a
   * reload, and Back/Forward step through the months you visited.
   */
  const [params, setParams] = useSearchParams();
  const anchor = monthFromParam(params.get('month'));
  const setAnchor = (next: Date | ((prev: Date) => Date)) => {
    const d = typeof next === 'function' ? (next as (p: Date) => Date)(anchor) : next;
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('month', value);
      return p;
    }, { replace: false });
  };
  const [selected, setSelected] = useState(iso(new Date()));
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<CalendarEvent | null>(null);
  /** The day whose full list is open, or null. Set only by the cell's "+N more" button. */
  const [dayView, setDayView] = useState<string | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);

  /**
   * Only the first fetch shows a loading screen. Refreshes after saving or deleting an event
   * update the grid in place — replacing the whole month with "Loading calendar…" for a moment
   * read as the page reloading itself.
   */
  const loadedOnce = useRef(false);
  /** Drives the Refresh button's own label; separate from `loading`, which owns the first paint. */
  const [refreshing, setRefreshing] = useState(false);

  // The span the grid is showing, including the trailing days of the neighbouring months. Computed
  // before `load` because the fetch is scoped to it.
  const cells = monthGrid(anchor);
  const gridFrom = cells.length ? iso(cells[0].date) : '';
  const gridTo = cells.length ? iso(cells[cells.length - 1].date) : '';

  /**
   * Fetch only the month on screen.
   *
   * This used to ask for every event the user had ever had and narrow it in the browser, and
   * changing month fired no request at all — so the first visit paid for the whole history and the
   * cost grew for ever. The busiest calendar here was already 223 KB across five months of Google
   * sync. The holidays panel beside it was doing the right thing all along; this now matches it.
   *
   * A month either side is included so an event on the trailing days of the grid is still shown.
   */
  const load = useCallback(() => {
    if (!gridFrom || !gridTo) return Promise.resolve();
    if (!loadedOnce.current) setLoading(true);
    // Returned, not fired and forgotten: the Refresh button awaits this so it can show that
    // something is happening. Every other caller ignores the promise exactly as before.
    return listEvents(area, { from: gridFrom, to: gridTo })
      .then(setEvents)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load the calendar'), 'bad'))
      .finally(() => { loadedOnce.current = true; setLoading(false); });
    // `area` is a dependency: switching from the CRM's calendar to the Transaction Desk's has to
    // refetch, or the new area would keep showing the previous one's events. So is the visible
    // span — moving to another month is now a fetch rather than a filter.
  }, [toast, area, gridFrom, gridTo]);

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

  // Holidays are fetched for exactly the span the grid shows — which includes the trailing days of
  // the neighbouring months, so a December view still picks up New Year's Day. `gridFrom`/`gridTo`
  // are declared above, next to `load`, because the events fetch now uses the same span.
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
  // Holidays + festivals in the month currently shown, listed under Upcoming Events.
  const monthHolidays = useMemo(
    () => [...holidays].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)),
    [holidays],
  );

  // ConfirmDialog closes itself after onConfirm, so this only does the work.
  // Which occurrences a delete applies to. Only asked when the event is part of a series.
  const [deleteScope, setDeleteScope] = useState<'this' | 'series'>('this');

  /**
   * Dragging an appointment to another day.
   *
   * `dragging` is the event under the cursor and `dragOver` the cell it is above, so the grid can
   * show where it would land. Both are cleared on drop and on dragend — a drag abandoned outside
   * the window otherwise leaves a cell highlighted for ever.
   */
  const [dragging, setDragging] = useState<CalendarEvent | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const moveTo = async (e: CalendarEvent, day: string) => {
    if (e.date === day) return;
    try {
      // The version goes with it, so a drag is refused rather than applied if somebody else moved
      // the same appointment while this browser was holding an older copy. A dragged occurrence of
      // a repeat moves on its own — 'this', never the series: dragging one box cannot reasonably
      // mean "move every Tuesday for the next six months".
      await updateEvent(area, e.id, { date: day, version: e.version }, 'this');
      toast(`"${e.title}" moved to ${longDate(day)}`, 'ok');
      load();
    } catch (ex) {
      const status = (ex as { response?: { status?: number } }).response?.status;
      // 409 is somebody else's save; 400 is an overlap. Both are worth the exact words, because a
      // drag that silently springs back looks like the calendar is broken.
      if (status === 409) toast('Somebody else changed that appointment. Refreshing.', 'bad');
      else toast(apiErrorMessage(ex, 'Could not move the appointment'), 'bad');
      load();
    }
  };

  const remove = async () => {
    if (!toDelete) return;
    try {
      await deleteEvent(area, toDelete.id, toDelete.recurrence_id ? deleteScope : 'this');
      toast('Event deleted', 'ok');
      load();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not delete the event'), 'bad');
    }
  };

  const shiftMonth = (by: number) => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + by, 1));
  const goToday = () => { const now = new Date(); setAnchor(new Date(now.getFullYear(), now.getMonth(), 1)); setSelected(iso(now)); };

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
            {/*
              THE BUTTON ALWAYS WORKED — it has always called `load()`, which refetches the month.
              What it did not do is SAY so. After the first fetch `loadedOnce` suppresses the
              loading screen (deliberately: replacing the grid with "Loading calendar…" on every
              save read as the page reloading itself), so a refresh that returned the same events
              changed not one pixel. Clicking it and seeing nothing happen is indistinguishable from
              a dead button, which is how it was reported.
            */}
            <button
              className="btn ghost"
              disabled={refreshing}
              onClick={() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }}
            >
              {refreshing ? '↻ Refreshing…' : '↻ Refresh'}
            </button>
            {canEdit && <button className="btn primary" onClick={() => setEditing('new')}>+ Add Event</button>}
          </div>
        </div>
      </div>

      <div className="cal-layout">
        {/* The calendar column: the month grid with its two lists tucked directly underneath, so
            they read as part of the calendar rather than as a separate band across the page. */}
        <div className="cal-main">
        {/* Large month grid — the main view. Each day shows its holidays/festivals by name and its
            events as chips; the sidebar on the right lists today's events in full. */}
        <div className="card cal-grid-card">
          <div className="cal-monthbar">
            <button className="btn ghost sm" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
            <strong className="cal-monthname">{MONTHS[anchor.getMonth()]} {anchor.getFullYear()}</strong>
            <button className="btn ghost sm" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
            <button className="btn ghost sm" onClick={goToday} style={{ marginLeft: 8 }}>Today</button>
          </div>

          <div className="cal-grid big">
            {WEEKDAYS.map((d) => <div key={d} className="cal-dow">{d}</div>)}
            {cells.map(({ date, inMonth }) => {
              const key = iso(date);
              const dayList = byDate.get(key) ?? [];
              const hols = holidaysByDate.get(key) ?? [];
              return (
                <div
                  key={key}
                  className={`cal-cell${inMonth ? '' : ' out'}${key === selected ? ' sel' : ''}${key === today ? ' today' : ''}${dragOver === key ? ' drop-target' : ''}`}
                  onClick={() => setSelected(key)}
                  onDoubleClick={() => canEdit && setEditing('new')}
                  // preventDefault is what makes a cell a valid drop target at all; without it the
                  // browser refuses the drop and the drag just snaps back.
                  onDragOver={(ev) => { if (dragging) { ev.preventDefault(); setDragOver(key); } }}
                  onDragLeave={() => setDragOver((d) => (d === key ? null : d))}
                  onDrop={(ev) => {
                    ev.preventDefault();
                    const moving = dragging;
                    setDragOver(null);
                    setDragging(null);
                    if (moving) void moveTo(moving, key);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="cal-cell-head">
                    <span className="cal-daynum">{date.getDate()}</span>
                  </div>
                  {hols.map((h) => (
                    <span key={h.name} className={`cal-holiday${h.kind === 'festival' ? ' festival' : ''}`} title={holidayTitle(h)}>
                      {h.approximate ? '◐ ' : ''}{h.name}
                    </span>
                  ))}
                  {dayList.slice(0, 3).map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className={`cal-chip ${typePill(e.type)}${dragging?.id === e.id ? ' dragging' : ''}`}
                      title={canEdit ? `${clock(e.time)} · ${e.title} — drag to another day to reschedule` : `${clock(e.time)} · ${e.title}`}
                      // Only when the user may edit: offering a drag that the server will refuse
                      // teaches people the calendar is unreliable.
                      draggable={canEdit}
                      onDragStart={(ev) => {
                        setDragging(e);
                        ev.dataTransfer.effectAllowed = 'move';
                        // Firefox will not start a drag unless something is on the transfer.
                        ev.dataTransfer.setData('text/plain', String(e.id));
                      }}
                      onDragEnd={() => { setDragging(null); setDragOver(null); }}
                      onClick={(ev) => { ev.stopPropagation(); canEdit ? setEditing(e) : setSelected(key); }}
                    >
                      {clock(e.time)} {e.title}
                    </button>
                  ))}
                  {/*
                    A cell shows three chips; the rest were counted and then unreachable — the
                    label was a plain <span> with no handler, so a day with six appointments hid
                    three of them with no way to see them at all.

                    stopPropagation because the cell itself selects the day on click, and the
                    button must not also do that behind the popup.
                  */}
                  {dayList.length > 3 && (
                    <button
                      type="button"
                      className="cal-more"
                      title={`Show all ${dayList.length} appointments on ${longDate(key)}`}
                      onClick={(ev) => { ev.stopPropagation(); setDayView(key); }}
                    >
                      +{dayList.length - 3} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="cal-legend">
            <span><i className="cal-lg-dot stat" /> Holiday</span>
            <span><i className="cal-lg-dot fest" /> Festival</span>
            <span className="muted">◐ date may vary (lunar)</span>
          </div>
        </div>

          {/*
            Upcoming Events and Holidays & Festivals, immediately under the grid and side by side.

            Kept inside the calendar column so they are the width of the calendar rather than of the
            page, and so nothing sits between them and the month they describe. Stacked in the 320px
            sidebar they made the page as tall as the two lists combined; here they take half that
            height, and each scrolls inside its own card, so the page is a fixed length however busy
            the month is.
          */}
          <div className="cal-below">
            <div className="card">
              <div className="modal-h" style={{ fontSize: 14 }}>Upcoming Events<span className="sec-count">{upcoming.length}</span></div>
              {upcoming.length === 0
                ? <div className="help">Nothing upcoming.</div>
                : (
                  <div className="cal-scroll">
                    {upcoming.map((e) => <EventRow key={e.id} e={e} showDate canEdit={canEdit} onEdit={() => setEditing(e)} onDelete={() => setToDelete(e)} onDeal={() => navigate(`${deskPath(`transactions/${e.transaction_id}`)}?mode=view`)} />)}
                  </div>
                )}
            </div>

            {/* Holidays & festivals for the month being viewed. */}
            <div className="card">
              <div className="modal-h" style={{ fontSize: 14 }}>Holidays &amp; Festivals<span className="sec-count">{monthHolidays.length}</span></div>
              {monthHolidays.length === 0
                ? <div className="help">None this month.</div>
                : (
                  <div className="cal-scroll">
                    {monthHolidays.map((h) => (
                      <div key={`${h.date}-${h.name}`} className="cal-hol-row" title={holidayTitle(h)}>
                        <span className={`cal-hol-swatch${h.kind === 'festival' ? ' festival' : ''}`} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{h.name}{h.approximate ? ' ◐' : ''}</div>
                          <div className="muted" style={{ fontSize: 12 }}>{longDate(h.date)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          </div>
        </div>

        {/* Only today's events sit beside the grid: it is the shortest of the three lists and the
            one being read against the day that is already highlighted. Each event row carries its
            own Edit / Delete, so there is no separate selected-day card. */}
        <div className="cal-side">
          <div className="card">
            <div className="modal-h" style={{ fontSize: 14 }}>Today&apos;s Events<span className="sec-count">{todayEvents.length}</span></div>
            {todayEvents.length === 0
              ? <div className="help">No events today.</div>
              : todayEvents.map((e) => <EventRow key={e.id} e={e} canEdit={canEdit} onEdit={() => setEditing(e)} onDelete={() => setToDelete(e)} onDeal={() => navigate(`${deskPath(`transactions/${e.transaction_id}`)}?mode=view`)} />)}
          </div>
        </div>
      </div>

      {/* Below the calendar, collapsed. It answers an occasional question and must not push the
          month grid down the page for the common visit, which is somebody checking tomorrow. */}
      <PushRemindersToggle />

      {/*
        * Transaction Desk only, by request.
        *
        * Removed from the CRM's calendar rather than deleted: the panel, its endpoint and the Desk's
        * use of it are untouched, and `/api/calendar/analytics` is still asked the same question
        * with `area=desk`. Scoped on `area` for the same reason every other cross-area difference on
        * this page is — the two calendars are one component and one route, told apart by this value.
        */}
      {area === 'desk' && <CalendarAnalyticsPanel />}

      {/*
        Every appointment on one day, opened from "+N more".

        Rows are the same `EventRow` the Today's card uses, given the same `canEdit`, so Edit and
        Delete behave identically and nothing here can do anything the rest of the screen cannot.
        Editing or deleting from the list closes it and hands off to the existing modals, rather
        than stacking a second dialog on top.
      */}
      {dayView && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) setDayView(null); }}>
          {/*
            * `min(520px, 100%)`, not `520`.
            *
            * A bare `maxWidth: 520` REPLACES the stylesheet's `max-width: 100%` rather than adding
            * to it, and `.modal` also carries `width: 780px` — so the used width was
            * `min(780, 520) = 520px` at every viewport. Measured at 390px on 2026-08-05: the dialog
            * rendered **518px wide inside a 390px overlay**, which put the right-hand side of every
            * appointment, including its Edit and Delete buttons, off the screen.
            *
            * That is this feature's own bug in a new place: "+N more" exists because a day's later
            * appointments were unreachable from the grid, and on a phone the thing that revealed them
            * was itself unreachable. Nobody would have found it on a desktop, which is where the
            * cap was chosen.
            */}
          <div className="modal" style={{ maxWidth: 'min(520px, 100%)', maxHeight: '80vh', overflowY: 'auto' }}>
            <button className="close" onClick={() => setDayView(null)}>✕</button>
            <div className="modal-h" style={{ fontSize: 14 }}>
              {longDate(dayView)}
              <span className="sec-count">{(byDate.get(dayView) ?? []).length}</span>
            </div>
            {(byDate.get(dayView) ?? []).length === 0
              ? <div className="help">Nothing on this day any more.</div>
              : (byDate.get(dayView) ?? []).map((e) => (
                <EventRow
                  key={e.id}
                  e={e}
                  canEdit={canEdit}
                  onEdit={() => { setDayView(null); setEditing(e); }}
                  onDelete={() => { setDayView(null); setToDelete(e); }}
                  onDeal={() => navigate(`${deskPath(`transactions/${e.transaction_id}`)}?mode=view`)}
                />
              ))}
          </div>
        </div>
      )}

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
          title: toDelete.recurrence_id ? 'Delete a repeating appointment' : 'Delete this event?',
          // A repeat needs the choice spelled out before it is made: "delete" on a standing
          // arrangement is ambiguous, and guessing wrong removes months of somebody's diary.
          message: toDelete.recurrence_id
            ? `"${toDelete.title}" on ${longDate(toDelete.date)} repeats. Choose what to remove — appointments before this date are never touched.`
            : `"${toDelete.title}" on ${longDate(toDelete.date)} will be removed from the calendar.`,
          body: toDelete.recurrence_id ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                <input type="radio" name="del-scope" checked={deleteScope === 'this'} onChange={() => setDeleteScope('this')} />
                Just this one — {longDate(toDelete.date)}
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                <input type="radio" name="del-scope" checked={deleteScope === 'series'} onChange={() => setDeleteScope('series')} />
                This one and everything after it
              </label>
            </div>
          ) : null,
          onConfirm: remove,
        } : null}
        onClose={() => { setToDelete(null); setDeleteScope('this'); }}
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
