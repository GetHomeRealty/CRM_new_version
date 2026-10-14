import { environment } from '@/config/environment';
import { appendLeadFilters, type LeadFilters } from './list-filters';
import type { PropertyPreference } from './property-preferences';

export interface MobileLead {
  id: number;
  owner_user_id?: number | null;
  name: string;
  property?: string | null;
  property_address?: string | null;
  property_price?: string | null;
  bedrooms?: string | null;
  bathrooms?: string | null;
  square_footage?: string | null;
  key_features?: string | null;

  assigned_to?: number | null;
  assigned_to_name?: string | null;
  unsubscribed?: boolean;
  source?: string | null;
  meta?: Record<string, string | null> | null;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  lead_conversion?: string | null;
  lead_estimation?: string | null;
  lead_quality?: string | null;
  email: string | null;
  phone: string | null;
  lead_status: string | null;
  lead_type: string | null;
  lead_source: string | null;
  lead_response?: string | null;
  client_type?: string | null;
  location?: string | null;
  language?: string | null;
  age?: number | null;
  gender?: string | null;
  religion?: string | null;
  date_of_birth?: string | null;
  marriage_day?: string | null;
  notes?: string | null;
  tags: string[];
  property_preferences?: PropertyPreference[] | null;
  notes_history?: LeadNote[];
  tasks?: LeadTask[];
  showings?: LeadShowing[];
  calls?: LeadCall[];
  emails?: LeadEmail[];
  messages?: import('./communications-api').LeadMessage[];
}

export interface LeadNote { id: number; content: string; pinned: boolean; created_by: string | null; created_at: string | null }
export interface LeadTask { assigned_to?: number | null; assigned_to_name?: string | null; id: number; title: string; due_date: string; description: string | null; status: string; priority: string }
export interface LeadShowing { id: number; showing_date: string; time: string; property: string | null; notes: string | null; status: string }
export interface LeadCall { id: number; called_at: string; duration: number | null; outcome: string | null; notes: string | null; status?: string | null; recording?: import('./communications-api').CallRecording | null }
export interface LeadEmail { id: number; recipient: string; subject: string; status: string; sent_at: string }

export type LeadUpdate = Partial<Pick<MobileLead,
  'property_address' | 'property_price' | 'bedrooms' | 'bathrooms' | 'square_footage' | 'key_features' | 'property' | 'assigned_to' | 'first_name' | 'middle_name' | 'last_name' | 'lead_conversion' | 'lead_estimation' | 'lead_quality' | 'name' | 'email' | 'phone' | 'location' | 'language' | 'tags' | 'property_preferences' | 'notes' | 'lead_status' | 'lead_type' | 'lead_source' | 'lead_response' | 'client_type'
>> & import('./demographics').DemographicDraft;

export interface LeadsPage {
  data: MobileLead[];
  meta: {
    current_page: number;
    per_page: number;
    last_page: number;
    total: number;
  };
}

export interface LeadAssignee { id: number; name: string; role: string }
export type LeadOptions = Record<'lead_status' | 'lead_type' | 'lead_source' | 'lead_response' | 'client_type', string[]> & { genders?: string[]; lead_conversion?: string[]; lead_estimation?: string[]; lead_quality?: string[]; users?: LeadAssignee[] };

export async function fetchLeadTags(token: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${environment.apiUrl}/api/leads/tags`, { signal, headers: authHeaders(token) });
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = await response.json() as { tags?: unknown };
  if (!Array.isArray(body?.tags) || !body.tags.every((tag) => typeof tag === 'string')) {
    throw new Error('Existing tags are unavailable. Please retry.');
  }
  return [...new Set(body.tags as string[])];
}

export async function fetchLeadOptions(token: string, signal?: AbortSignal): Promise<LeadOptions> {
  const response = await fetch(`${environment.apiUrl}/api/leads/options`, { signal, headers: authHeaders(token) });
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = await response.json() as LeadOptions;
  for (const field of ['lead_status', 'lead_type', 'lead_source', 'lead_response', 'client_type'] as const) {
    if (!Array.isArray(body?.[field]) || !body[field].every((value) => typeof value === 'string')) {
      throw new Error('Lead classifications are unavailable. Please retry.');
    }
  }
  for (const field of ['lead_conversion', 'lead_estimation', 'lead_quality'] as const) {
    if (body[field] !== undefined && (!Array.isArray(body[field]) || !body[field].every(value => typeof value === 'string'))) throw new Error('Lead classifications are unavailable. Please retry.');
  }
  if (body.genders !== undefined && (!Array.isArray(body.genders) || !body.genders.every((value) => typeof value === 'string'))) {
    throw new Error('Gender options are unavailable. Please retry.');
  }
  if (body.users !== undefined && (!Array.isArray(body.users) || body.users.length > 2000 || body.users.some(u => !u || !Number.isSafeInteger(u.id) || u.id < 1 || typeof u.name !== 'string' || u.name.length > 255 || typeof u.role !== 'string') || new Set(body.users.map(u => u.id)).size !== body.users.length)) throw new Error('Lead assignment choices are unavailable. Please retry.');
  return body;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: string | string[]; errors?: Record<string, string[]> };
    const details = Object.values(body.errors ?? {}).flat().filter((value) => typeof value === 'string');
    if (details.length) return [...new Set(details)].join('\n');
    if (Array.isArray(body.message)) return body.message.join(' ');
    return body.message || 'Could not load leads.';
  } catch {
    return 'Could not load leads.';
  }
}

export async function fetchLeads(
  token: string,
  search: string,
  signal?: AbortSignal,
  page = 1,
  status = '',
  filters?: LeadFilters,
): Promise<LeadsPage> {
  const query = new URLSearchParams({ page: String(page), limit: '50' });
  if (search.trim()) query.set('search', search.trim());
  if (status) query.set('leadStatus', status);
  if (filters) appendLeadFilters(query, filters);

  const response = await fetch(`${environment.apiUrl}/api/leads?${query.toString()}`, {
    signal,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<LeadsPage>;
}

function authHeaders(token: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

export async function createLead(token: string, input: LeadUpdate): Promise<MobileLead> {
  const name = input.name?.trim() || '';
  const email = input.email?.trim() || '';
  const phone = input.phone?.trim() || '';
  if (!name || name.length > 255) throw new Error('Enter a name of 1–255 characters.');
  if (!phone || phone.length > 64) throw new Error('Enter a phone number of 1–64 characters.');
  if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255)) throw new Error('Enter a valid email address or leave it blank.');
  const response = await fetch(`${environment.apiUrl}/api/leads`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, name, phone, email: email || null }),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<MobileLead>;
}

export async function fetchLead(token: string, id: number, signal?: AbortSignal): Promise<MobileLead> {
  const response = await fetch(`${environment.apiUrl}/api/leads/${id}`, {
    signal,
    headers: authHeaders(token),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<MobileLead>;
}

export async function updateLead(token: string, id: number, update: LeadUpdate): Promise<MobileLead> {
  const response = await fetch(`${environment.apiUrl}/api/leads/${id}`, {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<MobileLead>;
}

export async function addLeadActivity<T>(token: string, id: number, kind: 'notes' | 'tasks' | 'showings' | 'calls', body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${environment.apiUrl}/api/leads/${id}/${kind}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<T>;
}

export async function changeLeadActivity(token: string, leadId: number, change:
  | { kind: 'tasks'; id: number; status: 'pending' | 'completed' | 'cancelled' }
  | { kind: 'showings'; id: number; status: 'scheduled' | 'completed' | 'cancelled' }
  | { kind: 'notes'; id: number; pinned: boolean }
): Promise<LeadTask | LeadNote | LeadShowing> {
  const body = change.kind === 'notes' ? { pinned: change.pinned } : { status: change.status };
  const response = await fetch(`${environment.apiUrl}/api/leads/${leadId}/${change.kind}/${change.id}`, {
    method: 'PUT', headers: { ...authHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<LeadTask | LeadNote | LeadShowing>;
}

export async function sendLeadEmail(token: string, id: number, subject: string, body: string): Promise<LeadEmail> {
  const response = await fetch(`${environment.apiUrl}/api/leads/${id}/email`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, body }),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<LeadEmail>;
}
