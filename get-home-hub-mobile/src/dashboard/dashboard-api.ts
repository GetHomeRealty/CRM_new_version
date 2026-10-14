import { environment } from '@/config/environment';

export interface CrmDashboard {
  leads: { total: number; new_this_week: number };
  tasks: { pending: number; due_today: number; overdue: number };
  campaigns: { total: number; sent: number };
  inbox: { unread: number };
}
export interface DeskDashboard {
  transactions: { total: number };
  closings: { next_30_days: number; overdue: number; this_month: number };
  documents: { pending: number; invalid: number; mandatory_missing: number };
  invoices: { outstanding: number } | null;
}
export interface HubDashboard { crm: CrmDashboard | null; desk: DeskDashboard | null }

async function area<T>(token: string, name: 'crm' | 'desk', signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(`${environment.apiUrl}/api/dashboard/${name}`, { signal, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (response.status === 403) return null;
  if (!response.ok) throw new Error(`Could not load the ${name === 'crm' ? 'CRM' : 'Transaction'} dashboard.`);
  return response.json() as Promise<T>;
}

export async function fetchHubDashboard(token: string, signal?: AbortSignal): Promise<HubDashboard> {
  const [crm, desk] = await Promise.all([area<CrmDashboard>(token, 'crm', signal), area<DeskDashboard>(token, 'desk', signal)]);
  return { crm, desk };
}
