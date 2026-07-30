import { useArea } from './AreaContext';
import { useEffect, useState } from 'react';
import { createEvent, updateEvent } from '../lib/calendarApi';
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
  { value: 'task', label: 'Task' },
];
const FALLBACK_STATUSES: { value: EventStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'rescheduled', label: 'Rescheduled' },
];

interface Form {
  title: string;
  date: string;
  time: string;
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

  useEffect(() => { listTransactions().then(setDeals).catch(() => { /* linking is optional */ }); }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => (e[k as string] ? { ...e, [k as string]: [] } : e));
  };
  const err = (k: string) => (errors[k]?.length ? <div className="field-err">{errors[k][0]}</div> : null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    const body: CalendarEventInput = {
      title: form.title.trim(),
      date: form.date,
      time: form.time,
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
    };
    try {
      if (event) await updateEvent(area, event.id, body);
      else await createEvent(area, body);
      toast(event ? 'Event updated' : 'Event created', 'ok');
      onSaved();
    } catch (ex) {
      const res = (ex as { response?: { data?: { errors?: Record<string, string[]> } } }).response?.data;
      if (res?.errors) setErrors(res.errors);
      toast(apiErrorMessage(ex, 'Could not save the event'), 'bad');
      setSaving(false);
    }
  };

  const types = options?.types ?? FALLBACK_TYPES;
  const statuses = options?.statuses ?? FALLBACK_STATUSES;

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <button className="close" onClick={onClose} type="button">✕</button>
        <div className="modal-h">{event ? 'Edit Event' : 'Add New Event'}</div>

        <form onSubmit={save}>
          <div className="grid2">
            <div className="field">
              <label>Event Title *</label>
              <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Property viewing at 123 Main St" autoFocus />
              {err('title')}
            </div>
            <div className="field">
              <label>Event Type *</label>
              <select value={form.type} onChange={(e) => set('type', e.target.value as EventType)}>
                {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {err('type')}
            </div>

            <div className="field">
              <label>Date *</label>
              <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
              {err('date')}
            </div>
            <div className="field">
              <label>Time *</label>
              <input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} />
              {err('time')}
            </div>

            <div className="field">
              <label>Status</label>
              <select value={form.status} onChange={(e) => set('status', e.target.value as EventStatus)}>
                {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {err('status')}
            </div>
            <div className="field">
              <label>Location</label>
              <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Address or meeting place" />
              {err('location')}
            </div>

            <div className="field">
              <label>Attendees</label>
              <input value={form.attendees} onChange={(e) => set('attendees', e.target.value)} placeholder="Names, comma separated" />
              {err('attendees')}
            </div>
            <div className="field">
              <label>Related Deal</label>
              <select value={form.transaction_id} onChange={(e) => set('transaction_id', e.target.value)}>
                <option value="">Not linked</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>#{d.trade_no} — {d.property || 'No address'}</option>
                ))}
              </select>
              {err('transaction_id')}
            </div>

            <div className="field">
              <label>Contact Phone</label>
              <input type="tel" value={form.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} />
              {err('contact_phone')}
            </div>
            <div className="field">
              <label>Contact Email</label>
              <input type="email" value={form.contact_email} onChange={(e) => set('contact_email', e.target.value)} />
              {err('contact_email')}
            </div>
          </div>

          <div className="field">
            <label>Description</label>
            <textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
            {err('description')}
          </div>

          <div className="grid2">
            <div className="field">
              <label>Property Details</label>
              <textarea rows={2} value={form.property_details} onChange={(e) => set('property_details', e.target.value)} />
              {err('property_details')}
            </div>
            <div className="field">
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
              {err('notes')}
            </div>
          </div>

          <label className="cal-reminder">
            <input type="checkbox" checked={form.enable_reminder} onChange={(e) => set('enable_reminder', e.target.checked)} />
            <span>
              Flag this event for a reminder
              <em> — recorded on the event; no reminder is dispatched yet.</em>
            </span>
          </label>

          <div className="actions">
            <button className="btn ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : event ? 'Update Event' : 'Save Event'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
