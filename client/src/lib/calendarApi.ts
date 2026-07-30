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

export const updateEvent = (area: Area, id: number, body: Partial<CalendarEventInput>): Promise<CalendarEvent> =>
  api.put<CalendarEvent>(`/api/calendar/events/${id}`, body, { params: { area } }).then((r) => r.data);

export const deleteEvent = (area: Area, id: number): Promise<void> =>
  api.delete(`/api/calendar/events/${id}`, { params: { area } }).then(() => undefined);

/** Canadian holidays and festivals in a date range (computed, never stored). */
export const listHolidays = (from: string, to: string, province?: string): Promise<HolidayResponse> =>
  api.get<HolidayResponse>('/api/calendar/holidays', {
    params: { from, to, ...(province ? { province } : {}) },
  }).then((r) => r.data);
