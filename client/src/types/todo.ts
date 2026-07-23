/** Calendar todo list types. */

export type TodoStatus = 'pending' | 'completed' | 'cancelled';
export type TodoPriority = 'low' | 'medium' | 'high';

export interface Todo {
  id: number;
  title: string;
  description: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  due_date: string | null;
  /** Pending and past its due date. Computed server-side so every client agrees. */
  overdue: boolean;
  completed_at: string | null;
  created_by: string | null;
  created_at: string | null;
}

export interface TodoCounts {
  total: number;
  pending: number;
  completed: number;
  cancelled: number;
  overdue: number;
}

export interface TodoListResponse {
  data: Todo[];
  counts: TodoCounts;
}

export interface TodoFilters {
  search: string;
  status: string;
  priority: string;
}

export interface TodoInput {
  title: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  due_date?: string;
}
