import api from './axios';
import type { Area } from '../desk/area';
import type { Todo, TodoFilters, TodoInput, TodoListResponse } from '../types';

/**
 * The To-Do list API, per area.
 *
 * Each dashboard has its own list: a CRM task must not appear on the Transaction Management list and
 * vice versa (section 11). The area is on every call, including the writes — a task added from the
 * CRM's dashboard belongs to the CRM, and the counts have to be scoped the same way or a tally would
 * describe items the list never shows.
 */

export const listTodos = (area: Area, filters: Partial<TodoFilters> = {}): Promise<TodoListResponse> => {
  const params: Record<string, string> = { area };
  for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
  return api.get<TodoListResponse>('/api/calendar/todos', { params }).then((r) => r.data);
};

export const createTodo = (area: Area, body: TodoInput): Promise<Todo> =>
  api.post<Todo>('/api/calendar/todos', body, { params: { area } }).then((r) => r.data);

export const updateTodo = (area: Area, id: number, body: Partial<TodoInput>): Promise<Todo> =>
  api.put<Todo>(`/api/calendar/todos/${id}`, body, { params: { area } }).then((r) => r.data);

export const deleteTodo = (area: Area, id: number): Promise<void> =>
  api.delete(`/api/calendar/todos/${id}`, { params: { area } }).then(() => undefined);
