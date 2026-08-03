import type { Area } from '../desk/area';
import api from './axios';
import type { CalendarEvent, CalendarEventInput, CalendarOptions , HolidayResponse } from '../types';

/** Calendar events API. */

export const calendarOptions = (): Promise<CalendarOptions> =>
  api.get<CalendarOptions>('/api/calendar/options').then((r) => r.data);

/** List events, optionally limited to a date window (yyyy-mm-dd). */
/**
 * Every call names its area. The CRM Calendar shows the calendar connected under CRM Settings and
 * the Transaction Desk Calendar shows its own — the server decides from the event's `domain`, so a
 * request that omitted the area would silently read the Transaction Desk's.
 *
 * It is on the write calls too: creating an event in the CRM must stamp it CRM, which is also what
 * decides which Google calendar it is mirrored to.
 */
export const listEvents = (area: Area, params: { from?: string; to?: string } = {}): Promise<CalendarEvent[]> =>
  api.get<CalendarEvent[]>('/api/calendar/events', { params: { ...params, area } }).then((r) => r.data);

export const createEvent = (area: Area, body: CalendarEventInput): Promise<CalendarEvent> =>
  api.post<CalendarEvent>('/api/calendar/events', body, { params: { area } }).then((r) => r.data);

/** `scope: 'series'` applies the change to this occurrence and the later ones. */
export const updateEvent = (area: Area, id: number, body: Partial<CalendarEventInput>, scope: 'this' | 'series' = 'this'): Promise<CalendarEvent> =>
  api.put<CalendarEvent>(`/api/calendar/events/${id}`, body, { params: { area, scope } }).then((r) => r.data);

/** `scope: 'series'` also removes the later occurrences of a repeating appointment. */
export const deleteEvent = (area: Area, id: number, scope: 'this' | 'series' = 'this'): Promise<void> =>
  api.delete(`/api/calendar/events/${id}`, { params: { area, scope } }).then(() => undefined);

/** Canadian holidays and festivals in a date range (computed, never stored). */
export const listHolidays = (from: string, to: string, province?: string): Promise<HolidayResponse> =>
  api.get<HolidayResponse>('/api/calendar/holidays', {
    params: { from, to, ...(province ? { province } : {}) },
  }).then((r) => r.data);

/** What actually happened in the caller's diary over a range. Counts only — computed server-side. */
export interface CalendarAnalytics {
  range: { from: string; to: string };
  totals: { total: number; scheduled: number; completed: number; cancelled: number; no_show: number; rescheduled: number };
  rates: { completion: number | null; no_show: number | null; cancellation: number | null; settled: number };
  by_type: { type: string; label: string; total: number; completed: number; no_show: number }[];
  by_weekday: { day: string; total: number }[];
  /** How many appointments START in each hour. Empty hours between the first and last are included. */
  by_hour: { hour: string; total: number }[];
  /** How many MINUTES each hour is occupied for — workload, not headcount. */
  by_hour_busy: { hour: string; minutes: number }[];
  busiest: {
    weekday: string | null;
    hour: string | null;
    busy_hour: string | null;
    busy_minutes: number;
    date: string | null;
    date_count: number;
  };
}

export const calendarAnalytics = (area: Area, from?: string, to?: string): Promise<CalendarAnalytics> =>
  api.get<CalendarAnalytics>('/api/calendar/analytics', { params: { area, from, to } }).then((r) => r.data);

export interface FollowUpSuggestion { action: string; why: string; urgency: string; when: string | null }
export interface SuggestionResult {
  event: { id: number; title: string; date: string; type: string; status: string };
  suggestions: FollowUpSuggestion[];
  provider: string;
  model: string;
}

/** POST, not GET: it costs money per call and must never be fired by a prefetch or a refresh. */
export const suggestFollowUps = (area: Area, id: number): Promise<SuggestionResult> =>
  api.post<SuggestionResult>(`/api/calendar/events/${id}/suggestions`, {}, { params: { area } }).then((r) => r.data);

/* ------------------------------------------------------------------ push ---- */

export interface PushKey { public_key: string | null; configured: boolean }
export interface PushSubscriptionRow {
  id: number; user_agent: string | null; scope: string | null;
  last_used_at: string | null; created_at: string | null;
}
export interface PushSendResult { sent: number; failed: number; removed: number }

export const pushKey = (): Promise<PushKey> =>
  api.get<PushKey>('/api/calendar/push/key').then((r) => r.data);

export const pushSubscriptions = (): Promise<PushSubscriptionRow[]> =>
  api.get<PushSubscriptionRow[]>('/api/calendar/push/subscriptions').then((r) => r.data);

/**
 * The browser's own subscription object, handed to the server verbatim. `toJSON()` is what produces
 * the `{ endpoint, keys: { p256dh, auth } }` shape — the object itself has getters, not fields, so
 * sending it directly would post `{}`.
 */
export const pushSubscribe = (sub: PushSubscriptionJSON, scope: Area): Promise<{ id: number }> =>
  api.post<{ id: number }>('/api/calendar/push/subscribe', { ...sub, scope }).then((r) => r.data);

export const pushUnsubscribe = (endpoint: string): Promise<{ removed: number }> =>
  api.post<{ removed: number }>('/api/calendar/push/unsubscribe', { endpoint }).then((r) => r.data);

export const pushTest = (area: Area): Promise<PushSendResult> =>
  api.post<PushSendResult>('/api/calendar/push/test', {}, { params: { area } }).then((r) => r.data);

interface PushSubscriptionJSON { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
