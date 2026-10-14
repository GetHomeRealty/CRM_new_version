import { environment } from '@/config/environment';
import { validActivityDate } from './activity-date';
export type EditableActivity = 'notes' | 'tasks' | 'showings';
export type RemovableActivity = EditableActivity | 'calls';
export type ActivityFields = Record<string, string>;
export function activityBody(kind: EditableActivity, draft: ActivityFields): Record<string, unknown> {
  const text = (k: string, limit = 20000) => { const v = (draft[k] ?? '').trim(); if (v.length > limit) throw new Error('Activity text is too long.'); return v; };
  if (kind === 'notes') { const content = text('content'); if (!content) throw new Error('The note cannot be empty.'); return { content }; }
  if (kind === 'tasks') {
    const title = text('title', 255), due_date = text('due_date', 10);
    if (!title || !validActivityDate(due_date)) throw new Error('Enter a task title and a valid due date (YYYY-MM-DD).');
    if (!['low', 'medium', 'high'].includes(draft.priority) || !['pending', 'completed', 'cancelled'].includes(draft.status)) throw new Error('Choose a valid task priority and status.');
    return { title, due_date, description: text('description') || null, priority: draft.priority, status: draft.status };
  }
  if (kind !== 'showings') throw new Error('This activity cannot be edited.');
  const showing_date = text('showing_date', 10), time = text('time', 5);
  if (!validActivityDate(showing_date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Enter a valid showing date and 24-hour time.');
  if (!['scheduled', 'completed', 'cancelled'].includes(draft.status)) throw new Error('Choose a valid showing status.');
  return { showing_date, time, property: text('property', 255) || null, notes: text('notes') || null, status: draft.status };
}
export async function saveActivityRecord(token: string, leadId: number, kind: RemovableActivity, id: number, draft: ActivityFields | null): Promise<void> {
  if (!token || !Number.isSafeInteger(leadId) || leadId < 1 || !Number.isSafeInteger(id) || id < 1 || !['notes', 'tasks', 'showings', 'calls'].includes(kind)) throw new Error('Invalid activity reference.');
  if (draft && kind === 'calls') throw new Error('Call logs cannot be edited through this API.');
  const body = draft ? activityBody(kind as EditableActivity, draft) : undefined;
  const response = await fetch(`${environment.apiUrl}/api/leads/${leadId}/${kind}/${id}`, { method: draft ? 'PUT' : 'DELETE', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    if (response.status === 403) throw new Error('You cannot change this activity. Notes may only be edited by their author.');
    if (response.status === 404) throw new Error('This activity is no longer available. Refresh the lead.');
    throw new Error('Activity change could not be confirmed. Refresh the lead to check its current state.');
  }
  const value = await response.json() as { id?: number; deleted?: boolean };
  if (draft ? value.id !== id : value.deleted !== true) throw new Error('Activity change could not be confirmed. Refresh the lead.');
}
