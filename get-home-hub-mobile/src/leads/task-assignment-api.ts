import { environment } from '@/config/environment';
import type { LeadAssignee } from './leads-api';
export async function assignLeadTask(token: string, leadId: number, taskId: number, assignedTo: number | null, choices: LeadAssignee[], signal: AbortSignal): Promise<void> {
  if (!token || signal.aborted || !Number.isSafeInteger(leadId) || leadId < 1 || !Number.isSafeInteger(taskId) || taskId < 1) throw new Error('Task assignment is unavailable.');
  if (assignedTo !== null && (!Number.isSafeInteger(assignedTo) || assignedTo < 1 || !choices.some(u => u.id === assignedTo))) throw new Error('Choose an available task assignee.');
  const response = await fetch(`${environment.apiUrl}/api/leads/${leadId}/tasks/${taskId}`, { method: 'PUT', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ assigned_to: assignedTo }) });
  if (!response.ok) throw new Error(response.status === 403 ? 'You cannot assign this task.' : 'Task assignment could not be confirmed. Refresh before trying again.');
  const value = await response.json() as { id?: number; assigned_to?: number | null };
  if (value.id !== taskId || value.assigned_to !== assignedTo) throw new Error('Task assignment could not be confirmed. Refresh before trying again.');
}
