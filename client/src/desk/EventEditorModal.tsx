import { useArea } from './AreaContext';
import { useEffect, useState } from 'react';
import { createEvent, updateEvent, suggestFollowUps, type FollowUpSuggestion } from '../lib/calendarApi';
import { listTransactions } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';
import type { CalendarEvent, CalendarEventInput, CalendarOptions, EventStatus, EventType, Transaction } from '../types';

/** Fallbacks if /calendar/options hasn't loaded — keeps the form usable either way. */
const FALLBACK_TYPES: { value: EventType; label: string }[] = [
  { value: 'viewing', label: 'Property Viewing' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'open-house', label: 'Open House' },
  { value: 'follow-up', label: 'Follow-up' },
  { value: 'call', label: 'Call' },
  { value: 'showing', label: 'Showing' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'closing', label: 'Closing' },
  { value: 'task', label: 'Task' },
];
const FALLBACK_STATUSES: { value: EventStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no-show', label: 'No-show' },
  { value: 'rescheduled', label: 'Rescheduled' },
];

interface Form {
  title: string;
  date: string;
  time: string;
  end_time: string;
  // Repeat, on a NEW appointment only. Changing the rule of an existing series would mean
  // regenerating occurrences people may already have moved or cancelled — a different feature,
  // and a destructive one, so the controls simply do not appear when editing.
  recur_freq: 'none' | 'daily' | 'weekly' | 'monthly';
  recur_interval: string;
  recur_end: 'never' | 'on' | 'after';
  recur_until: string;
  recur_count: string;
  type: EventType;
  status: EventStatus;
  location: string;
  attendees: string;
  contact_phone: string;
  contact_email: string;
  description: string;
  property_details: string;
  notes: string;
  enable_reminder: boolean;
  transaction_id: string;
}

/** The next half-hour, as HH:MM — the default time for a new event. */
function nextHalfHour(): string {
  const d = new Date();
  const mins = d.getMinutes() >= 30 ? 30 : 0;
  return `${String(d.getHours()).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

const toForm = (e: CalendarEvent | null, defaultDate: string): Form => ({
  title: e?.title ?? '',
  date: e?.date ?? defaultDate,
  time: e?.time ?? nextHalfHour(),
  end_time: e?.end_time ?? '',
  recur_freq: 'none',
  recur_interval: '1',
  recur_end: 'after',
  recur_until: '',
  recur_count: '10',
  type: e?.type ?? 'meeting',
  status: e?.status ?? 'scheduled',
  location: e?.location ?? '',
  attendees: e?.attendees ?? '',
  contact_phone: e?.contact_phone ?? '',
  contact_email: e?.contact_email ?? '',
  description: e?.description ?? '',
  property_details: e?.property_details ?? '',
  notes: e?.notes ?? '',
  enable_reminder: e?.enable_reminder ?? false,
  transaction_id: e?.transaction_id ? String(e.transaction_id) : '',
});

/**
 * Create or edit a calendar event. Field-level errors returned by the API are shown against
 * the field that caused them rather than as one opaque message.
 */
export default function EventEditorModal({ event, defaultDate, options, onClose, onSaved }: {
  event: CalendarEvent | null;
  defaultDate: string;
  options: CalendarOptions | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // The event is created in, and saved to, the area whose calendar is on screen — which also
  // decides which connected Google calendar it is mirrored to.
  const { area } = useArea();
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => toForm(event, defaultDate));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [deals, setDeals] = useState<Transaction[]>([]);
  // Set when the server refuses a save because the slot is taken. Back-to-back showings at one
  // address are legitimate, so the answer is a warning with a way through, not a wall.
  const [clash, setClash] = useState<string | null>(null);
  // Set when the server refuses because somebody else saved first.
  const [stale, setStale] = useState<string | null>(null);
  // Which occurrences an edit applies to. Only offered when the event belongs to a series.
  const [scope, setScope] = useState<'this' | 'series'>('this');
  // Suggested follow-ups. Never fetched on open — see the note by the button.
  const [ideas, setIdeas] = useState<FollowUpSuggestion[] | null>(null);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [ideasFrom, setIdeasFrom] = useState('');

  const askForIdeas = async () => {
    if (!event) return;
    setIdeasBusy(true);
    try {
      const r = await suggestFollowUps(area, event.id);
      setIdeas(r.suggestions);
      setIdeasFrom(`${r.provider} · ${r.model}`);
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not get suggestions'), 'bad');
    } finally {
      setIdeasBusy(false);
    }
  };

  useEffect(() => { listTransactions().then(setDeals).catch(() => { /* linking is optional */ }); }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => (e[k as string] ? { ...e, [k as string]: [] } : e));
  };
  const err = (k: string) => (errors[k]?.length ? <div className="field-err">{errors[k][0]}</div> : null);

  const save = async (e: React.FormEvent, allowOverlap = false) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    if (!allowOverlap) setClash(null);
    setStale(null);
    const body: CalendarEventInput = {
      title: form.title.trim(),
      date: form.date,
      time: form.time,
      end_time: form.end_time || null,
      type: form.type,
      status: form.status,
      location: form.location.trim(),
      attendees: form.attendees.trim(),
      contact_phone: form.contact_phone.trim(),
      contact_email: form.contact_email.trim(),
      description: form.description.trim(),
      property_details: form.property_details.trim(),
      notes: form.notes.trim(),
      enable_reminder: form.enable_reminder,
      transaction_id: form.transaction_id ? Number(form.transaction_id) : null,
      ...(allowOverlap ? { allow_overlap: true } : {}),
      // The version this editor was opened on. The server refuses the save if the event has moved
      // on since, rather than letting this write erase whatever the other person just saved.
      ...(event ? { version: event.version } : {}),
      // Only ever sent when creating.
      ...(!event && form.recur_freq !== 'none' ? {
        recur_freq: form.recur_freq,
        recur_interval: Number(form.recur_interval) || 1,
        ...(form.recur_end === 'on' ? { recur_until: form.recur_until } : {}),
        ...(form.recur_end === 'after' ? { recur_count: Number(form.recur_count) || 1 } : {}),
      } : {}),
    };
    try {
      if (event) await updateEvent(area, event.id, body, event.recurrence_id ? scope : 'this');
      else await createEvent(area, body);
      toast(event ? 'Event updated' : 'Event created', 'ok');
      onSaved();
    } catch (ex) {
      const res = (ex as { response?: { data?: { errors?: Record<string, string[]>; conflict?: { title: string } ; message?: string } } }).response?.data;
      // An overlap is a warning, not a rejection: the same address can have back-to-back showings,
      // and a genuine double-booking is sometimes deliberate. Say what it collides with and offer
      // a way through rather than making the user guess which field is wrong.
      // 409 is the concurrency lock, not an overlap: someone else saved this event first. Offering
      // "Book anyway" here would be exactly wrong — it would overwrite them — so it is not shown.
      const status = (ex as { response?: { status?: number } }).response?.status;
      if (status === 409) setStale(res?.message ?? 'Somebody else changed this event while you were editing it.');
      else if (res?.conflict) setClash(res.message ?? 'This overlaps another appointment.');
      else if (res?.errors) setErrors(res.errors);
      if (!res?.conflict && status !== 409) toast(apiErrorMessage(ex, 'Could not save the event'), 'bad');
      setSaving(false);
    }
  };

  const types = options?.types ?? FALLBACK_TYPES;
  const statuses = options?.statuses ?? FALLBACK_STATUSES;

  return (
    // Escape closes it, like every other dismissable layer. Without this the only way out was the
    // Cancel button, and the overlay swallows clicks on everything behind it.
    <div className="overlay open"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      role="dialog" aria-modal="true" aria-labelledby="event-editor-heading">
      <div className="modal" style={{ maxWidth: 720 }}>
        <button className="close" onClick={onClose} type="button" aria-label="Close">✕</button>
        <div className="modal-h" id="event-editor-heading">{event ? 'Edit Event' : 'Add New Event'}</div>

        <form onSubmit={save}>
          <div className="grid2">
            <div className="field">
              <label htmlFor="event-title">Event Title *</label>
              <input id="event-title" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Property viewing at 123 Main St" autoFocus />
              {err('title')}
            </div>
            <div className="field">
              <label htmlFor="event-type">Event Type *</label>
              <select id="event-type" value={form.type} onChange={(e) => set('type', e.target.value as EventType)}>
                {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {err('type')}
            </div>

            <div className="field">
              <label htmlFor="event-date">Date *</label>
              <input id="event-date" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
              {err('date')}
            </div>
            <div className="field">
              <label htmlFor="event-time">Time *</label>
              <input id="event-time" type="time" value={form.time} onChange={(e) => set('time', e.target.value)} />
              {err('time')}
            </div>

            {/* Optional, because every event already in the calendar was created without one. Left
                blank, the event counts as a one-hour block for conflict checking — the same hour
                the Google mirror has always assumed. */}
            <div className="field">
              <label htmlFor="event-end-time">End Time</label>
              <input id="event-end-time" type="time" value={form.end_time} onChange={(e) => set('end_time', e.target.value)} />
              <div className="help" style={{ fontSize: 11 }}>Leave blank for a one-hour slot.</div>
              {err('end_time')}
            </div>

            {/* New appointments only — see the note on the form type. */}
            {!event && (
              <div className="field">
                <label htmlFor="event-repeat">Repeat</label>
                <select id="event-repeat" value={form.recur_freq}
                  onChange={(e) => set('recur_freq', e.target.value as Form['recur_freq'])}>
                  <option value="none">Does not repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
                {err('recur_freq')}
              </div>
            )}
            {!event && form.recur_freq !== 'none' && (
              <div className="field">
                <label htmlFor="event-repeat-every">Every</label>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input id="event-repeat-every" type="number" min={1} max={52} style={{ width: 70 }}
                    value={form.recur_interval} onChange={(e) => set('recur_interval', e.target.value)} />
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {form.recur_freq === 'daily' ? 'day(s)' : form.recur_freq === 'weekly' ? 'week(s)' : 'month(s)'}
                  </span>
                </div>
                {err('recur_interval')}
              </div>
            )}

            <div className="field">
              <label htmlFor="event-status">Status</label>
              <select id="event-status" value={form.status} onChange={(e) => set('status', e.target.value as EventStatus)}>
                {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {err('status')}
            </div>
            <div className="field">
              <label htmlFor="event-location">Location</label>
              <input id="event-location" value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Address or meeting place" />
              {err('location')}
            </div>

            <div className="field">
              <label htmlFor="event-attendees">Attendees</label>
              <input id="event-attendees" value={form.attendees} onChange={(e) => set('attendees', e.target.value)} placeholder="Names, comma separated" />
              {err('attendees')}
            </div>
            <div className="field">
              <label htmlFor="event-deal">Related Deal</label>
              <select id="event-deal" value={form.transaction_id} onChange={(e) => set('transaction_id', e.target.value)}>
                <option value="">Not linked</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>#{d.trade_no} — {d.property || 'No address'}</option>
                ))}
              </select>
              {err('transaction_id')}
            </div>

            <div className="field">
              <label htmlFor="event-phone">Contact Phone</label>
              <input id="event-phone" type="tel" value={form.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} />
              {err('contact_phone')}
            </div>
            <div className="field">
              <label htmlFor="event-email">Contact Email</label>
              <input id="event-email" type="email" value={form.contact_email} onChange={(e) => set('contact_email', e.target.value)} />
              {err('contact_email')}
            </div>
          </div>

          {!event && form.recur_freq !== 'none' && (
            <div className="field">
              <label>Ends</label>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontWeight: 400 }}>
                  <input type="radio" name="recur-end" checked={form.recur_end === 'after'} onChange={() => set('recur_end', 'after')} />
                  after
                  <input type="number" min={1} style={{ width: 70 }} disabled={form.recur_end !== 'after'}
                    value={form.recur_count} onChange={(e) => set('recur_count', e.target.value)} />
                  appointments
                </label>
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontWeight: 400 }}>
                  <input type="radio" name="recur-end" checked={form.recur_end === 'on'} onChange={() => set('recur_end', 'on')} />
                  on
                  <input type="date" disabled={form.recur_end !== 'on'}
                    value={form.recur_until} onChange={(e) => set('recur_until', e.target.value)} />
                </label>
                <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontWeight: 400 }}>
                  <input type="radio" name="recur-end" checked={form.recur_end === 'never'} onChange={() => set('recur_end', 'never')} />
                  no end date
                </label>
              </div>
              <div className="help" style={{ fontSize: 11 }}>
                With no end date the repeat stops after two years, or 200 appointments — whichever comes first.
              </div>
              {err('recur_until')}{err('recur_count')}
            </div>
          )}

          <div className="field">
            <label htmlFor="event-description">Description</label>
            <textarea id="event-description" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
            {err('description')}
          </div>

          <div className="grid2">
            <div className="field">
              <label htmlFor="event-property">Property Details</label>
              <textarea id="event-property" rows={2} value={form.property_details} onChange={(e) => set('property_details', e.target.value)} />
              {err('property_details')}
            </div>
            <div className="field">
              <label htmlFor="event-notes">Notes</label>
              <textarea id="event-notes" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
              {err('notes')}
            </div>
          </div>

          <label className="cal-reminder">
            <input type="checkbox" checked={form.enable_reminder} onChange={(e) => set('enable_reminder', e.target.checked)} />
            <span>
              Remind me about this event
              <em> — by email a day before and an hour before.</em>
            </span>
          </label>

          {/* Spelled out before the save, not after: "update" on a standing arrangement is
              ambiguous, and the wrong guess rewrites months of somebody's diary. */}
          {event?.recurrence_id && (
            <div className="field" style={{ marginTop: 10 }}>
              <label>This appointment repeats — apply the change to</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                  <input type="radio" name="edit-scope" checked={scope === 'this'} onChange={() => setScope('this')} />
                  Just this one
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400 }}>
                  <input type="radio" name="edit-scope" checked={scope === 'series'} onChange={() => setScope('series')} />
                  This one and everything after it
                </label>
              </div>
              <div className="help" style={{ fontSize: 11 }}>
                Appointments before this date are never changed. The date stays per-appointment either way.
              </div>
            </div>
          )}

          {/* Existing appointments only, and only on request.
              It costs money per press and sends this appointment's details to whichever AI provider
              is configured, so it is never fired automatically — not on open, not on save. The
              button says what it does before it does it. */}
          {event && (
            <div className="field" style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn ghost sm" type="button" disabled={ideasBusy} onClick={() => void askForIdeas()}>
                  {ideasBusy ? 'Thinking…' : '✨ Suggest follow-ups'}
                </button>
                <span className="help" style={{ margin: 0, fontSize: 11 }}>
                  Sends this appointment&apos;s details to your AI provider. Suggestions only — nothing is sent or saved.
                </span>
              </div>

              {ideas && ideas.length > 0 && (
                <ul className="acct-list" style={{ marginTop: 8 }}>
                  {ideas.map((s, i) => (
                    <li key={`${s.action}-${i}`} style={{ display: 'block' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 13 }}>{s.action}</strong>
                        <span className={`pill ${s.urgency === 'high' ? 'bad' : s.urgency === 'low' ? '' : 'warn'}`} style={{ fontSize: 10 }}>
                          {s.urgency}
                        </span>
                        {s.when && <span className="muted" style={{ fontSize: 11.5 }}>by {s.when}</span>}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>{s.why}</div>
                    </li>
                  ))}
                </ul>
              )}
              {ideas && ideasFrom && (
                <div className="help" style={{ fontSize: 10.5, marginTop: 4 }}>
                  Suggested by {ideasFrom}. Written from this appointment&apos;s record only — it was not a summary of the meeting.
                </div>
              )}
            </div>
          )}

          {stale && (
            <div className="field-err" role="alert" style={{ margin: '10px 0', padding: '8px 10px', borderRadius: 6 }}>
              {stale}
              <div style={{ marginTop: 6 }}>
                <button className="btn ghost sm" type="button" onClick={() => window.location.reload()}>↻ Reload the calendar</button>
              </div>
            </div>
          )}

          {clash && (
            <div className="field-err" role="alert" style={{ margin: '10px 0', padding: '8px 10px', borderRadius: 6 }}>
              {clash}
            </div>
          )}

          <div className="actions">
            <button className="btn ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            {clash && (
              <button className="btn ghost" type="button" disabled={saving} onClick={(e) => void save(e as unknown as React.FormEvent, true)}>
                Book anyway
              </button>
            )}
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : event ? 'Update Event' : 'Save Event'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
