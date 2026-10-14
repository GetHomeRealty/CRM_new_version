import { applyChecklistVisibility } from './checklist-visibility';
import { environment } from '@/config/environment';

export interface MobileTransaction {
  id: number;
  trade_no: string | null;
  type: string | null;
  property: string | null;
  agent: string | null;
  price: number;
  offer_date: string | null;
  closing_date: string | null;
  valid_status: string | null;
  statuses: string[];
  deposit?: number;
  comm_status?: string;
  comm_paid_status?: string | null;
  clients?: { id: number; name: string; email: string | null; phone: string | null }[];
  conditions?: MobileCondition[];
  team?: { id: number; name: string; split: number; access: string }[];
  invoices?: { id: number; invoice_no: string; status: string; total: number; sent_at: string | null }[];
  financial?: Record<string, unknown>;
}

export interface MobileCondition { id?: number; type: string; custom_name: string | null; deadline: string | null; status: string }

export interface TransactionsPage {
  data: MobileTransaction[];
  meta?: { current_page: number; per_page: number; last_page: number; total: number };
}

export interface MobileDocument {
  id: number;
  title: string;
  mandatory: boolean;
  is_condition: boolean;
  deadline: string | null;
  status: string;
  validation: string | null;
  kind?: 'single' | 'condition' | 'multi' | 'per_client';
  agent_accepted?: string | null;
  manual?: boolean;
  drive_uploaded?: string | null;
  review_version?: string;
  reminder: boolean;
  file_name: string | null;
  has_file: boolean;
  file_count: number;
  validation_file_name?: string | null;
  has_validation_file?: boolean;
  files?: { index: number; client_name: string | null; file_name: string | null }[];
  remarks?: string | null;
}

export interface TransactionDocuments {
  reco_audit_ready?: string | null;
  reco_audit_remarks?: string | null;
  reco_audit_version?: string;
  documents: MobileDocument[];
  stats: { total: number; mandatory: number; received: number; pending: number; pct: number };
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: string | string[] };
    return Array.isArray(body.message) ? body.message.join(' ') : body.message || 'Could not load transactions.';
  } catch { return 'Could not load transactions.'; }
}

export async function fetchTransactions(token: string, search: string, signal?: AbortSignal, page = 1): Promise<TransactionsPage> {
  const query = new URLSearchParams({ page: String(page), per_page: '50' });
  if (search.trim()) query.set('q', search.trim());
  const response = await fetch(`${environment.apiUrl}/api/transactions?${query.toString()}`, {
    signal,
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<TransactionsPage>;
}

export async function fetchTransaction(token: string, id: number, signal?: AbortSignal): Promise<MobileTransaction> {
  const response = await fetch(`${environment.apiUrl}/api/transactions/${id}`, {
    signal,
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = await response.json() as { data: MobileTransaction };
  return body.data;
}

export async function fetchTransactionDocuments(token: string, id: number, signal?: AbortSignal): Promise<TransactionDocuments> {
  const response = await fetch(`${environment.apiUrl}/api/transactions/${id}/documents`, {
    signal,
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return applyChecklistVisibility(await response.json() as TransactionDocuments & { visible_document_ids?: unknown });
}

export async function updateTransaction(token: string, id: number, changes: Record<string, unknown>): Promise<MobileTransaction> {
  const response = await fetch(`${environment.apiUrl}/api/transactions/${id}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(changes),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = await response.json() as { data: MobileTransaction };
  return body.data;
}
