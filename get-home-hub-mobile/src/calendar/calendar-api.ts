import { environment } from '@/config/environment';

export interface CalendarEvent { id: number; version: number; title: string; date: string; time: string; end_time: string | null; type: string; status: string; location: string | null; description?: string | null; enable_reminder?: boolean; recurrence_id?: number | null }
export interface CalendarTodo { id: number; version: number; title: string; description: string | null; status: 'pending' | 'completed' | 'cancelled'; priority: 'low' | 'medium' | 'high'; due_date: string | null; overdue: boolean }
export interface TodoList { data: CalendarTodo[]; counts: { total: number; pending: number; completed: number; cancelled: number; overdue: number } }

export class CalendarApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly overlap: boolean) { super(message); }
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${environment.apiUrl}${path}`, { ...init, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string; conflict?: { id?: number; dates?: string[] } };
    throw new CalendarApiError(body.message || 'Could not load calendar.', response.status, response.status === 400 && Boolean(body.conflict?.id || body.conflict?.dates?.length));
  }
  return response.json() as Promise<T>;
}

export type CalendarArea = 'crm' | 'desk';
export const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export async function fetchCalendar(token: string, area: CalendarArea, month: Date, signal?: AbortSignal) {
  const from = localDate(new Date(month.getFullYear(), month.getMonth(), 1));
  const to = localDate(new Date(month.getFullYear(), month.getMonth() + 1, 0));
  const [events, todos] = await Promise.all([
    request<CalendarEvent[]>(token, `/api/calendar/events?area=${area}&from=${from}&to=${to}`, { signal }),
    request<TodoList>(token, `/api/calendar/todos?area=${area}`, { signal }),
  ]);
  return { events, todos };
}

export type TodoInput = Pick<CalendarTodo, 'title' | 'status' | 'priority'> & { description: string; due_date: string | null };

export function createTodo(token: string, input: TodoInput, area: CalendarArea) {
  return request<CalendarTodo>(token, `/api/calendar/todos?area=${area}`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateTodo(token: string, todo: CalendarTodo, changes: Partial<TodoInput>, area: CalendarArea) {
  return request<CalendarTodo>(token, `/api/calendar/todos/${todo.id}?area=${area}`, { method: 'PUT', body: JSON.stringify({ version: todo.version, ...changes }) });
}

export function deleteTodo(token: string, todo: CalendarTodo, area: CalendarArea) {
  return request<{ deleted: boolean }>(token, `/api/calendar/todos/${todo.id}?area=${area}`, { method: 'DELETE' });
}

export type EventInput = Pick<CalendarEvent, 'title' | 'date' | 'time' | 'end_time' | 'type' | 'status' | 'location'> & { description: string; enable_reminder?: boolean; recur_freq?: string; recur_count?: number; allow_overlap?: boolean };
export function createEvent(token: string, input: EventInput, area: CalendarArea) { return request<CalendarEvent>(token, `/api/calendar/events?area=${area}`, { method: 'POST', body: JSON.stringify(input) }); }
export function updateEvent(token: string, event: CalendarEvent, input: EventInput, area: CalendarArea, scope: 'this' | 'series' = 'this') { return request<CalendarEvent>(token, `/api/calendar/events/${event.id}?area=${area}&scope=${scope}`, { method: 'PUT', body: JSON.stringify({ version: event.version, ...input }) }); }
export function deleteEvent(token: string, event: CalendarEvent, area: CalendarArea, scope: 'this' | 'series' = 'this') { return request<{ deleted: boolean }>(token, `/api/calendar/events/${event.id}?area=${area}&scope=${scope}`, { method: 'DELETE' }); }
