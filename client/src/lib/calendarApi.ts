import api from './axios';
import type { CalendarEvent, CalendarEventInput, CalendarOptions , HolidayResponse } from '../types';

/** Calendar events API. */

export const calendarOptions = (): Promise<CalendarOptions> =>
  api.get<CalendarOptions>('/api/calendar/options').then((r) => r.data);

/** List events, optionally limited to a date window (yyyy-mm-dd). */
export const listEvents = (params: { from?: string; to?: string } = {}): Promise<CalendarEvent[]> =>
  api.get<CalendarEvent[]>('/api/calendar/events', { params }).then((r) => r.data);

export const createEvent = (body: CalendarEventInput): Promise<CalendarEvent> =>
  api.post<CalendarEvent>('/api/calendar/events', body).then((r) => r.data);

export const updateEvent = (id: number, body: Partial<CalendarEventInput>): Promise<CalendarEvent> =>
  api.put<CalendarEvent>(`/api/calendar/events/${id}`, body).then((r) => r.data);

export const deleteEvent = (id: number): Promise<void> =>
  api.delete(`/api/calendar/events/${id}`).then(() => undefined);

/** Canadian holidays and festivals in a date range (computed, never stored). */
export const listHolidays = (from: string, to: string, province?: string): Promise<HolidayResponse> =>
  api.get<HolidayResponse>('/api/calendar/holidays', {
    params: { from, to, ...(province ? { province } : {}) },
  }).then((r) => r.data);
