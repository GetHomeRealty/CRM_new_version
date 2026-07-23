import api from './axios';
import type { Todo, TodoFilters, TodoInput, TodoListResponse } from '../types';

/** Calendar todo list API. */

export const listTodos = (filters: Partial<TodoFilters> = {}): Promise<TodoListResponse> => {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
  return api.get<TodoListResponse>('/api/calendar/todos', { params }).then((r) => r.data);
};

export const createTodo = (body: TodoInput): Promise<Todo> =>
  api.post<Todo>('/api/calendar/todos', body).then((r) => r.data);

export const updateTodo = (id: number, body: Partial<TodoInput>): Promise<Todo> =>
  api.put<Todo>(`/api/calendar/todos/${id}`, body).then((r) => r.data);

export const deleteTodo = (id: number): Promise<void> =>
  api.delete(`/api/calendar/todos/${id}`).then(() => undefined);
