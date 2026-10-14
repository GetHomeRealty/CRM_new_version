import { environment } from '@/config/environment';
export interface MetaStatus { configured: boolean; token_storage_secure: boolean; is_connected: boolean; token_expired: boolean; needs_reconnect: boolean; facebook_user_name: string | null; page_name: string | null; connected_at: string | null; last_sync: string | null; last_error: string | null; leads_count: number; pages_count: number; connected_forms: number }
export interface MetaPage { id: string; name: string }
export interface MetaForm extends MetaPage { is_connected: boolean; leads_count: number }
export interface MetaLead { id: number; name: string; email: string | null; phone: string | null; lead_status: string | null; created_at: string | null }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const string = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length <= max;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const reference = (v: string) => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(v)) throw new Error('Invalid Meta reference.'); return v; };
async function request(token: string, path: string, signal: AbortSignal, body?: unknown, method = body ? 'POST' : 'GET'): Promise<unknown> {
  if (!token || signal.aborted) throw new Error('Sign in to view your Meta connection.');
  const response = await fetch(`${environment.apiUrl}/api/meta/${path}`, { method, signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 403 ? 'Meta access is no longer available.' : response.status === 401 ? 'Sign in again.' : 'Meta request could not be confirmed. Refresh your connection and sync history before trying again.');
  return response.json();
}
export async function fetchMetaStatus(token: string, signal: AbortSignal): Promise<MetaStatus> {
  const value = await request(token, 'status', signal);
  if (!object(value)) throw new Error('Invalid Meta status.');
  const booleans = ['configured', 'token_storage_secure', 'is_connected', 'token_expired', 'needs_reconnect'], texts = ['facebook_user_name', 'page_name', 'connected_at', 'last_sync', 'last_error'], counts = ['leads_count', 'pages_count', 'connected_forms'];
  if (booleans.some(k => typeof value[k] !== 'boolean') || texts.some(k => value[k] !== null && !string(value[k])) || counts.some(k => !count(value[k]))) throw new Error('Invalid Meta status.');
  return Object.fromEntries([...booleans, ...texts, ...counts].map(k => [k, value[k]])) as unknown as MetaStatus;
}
export async function fetchMetaPages(token: string, signal: AbortSignal): Promise<MetaPage[]> {
  const value = await request(token, 'pages', signal);
  if (!object(value) || !Array.isArray(value.pages) || value.pages.length > 2000) throw new Error('Invalid Meta pages.');
  const pages = value.pages.map(p => { if (!object(p) || !string(p.id, 128) || !string(p.name, 255)) throw new Error('Invalid Meta page.'); return { id: reference(p.id), name: p.name }; });
  if (new Set(pages.map(p => p.id)).size !== pages.length) throw new Error('Duplicate Meta page references.');
  return pages;
}
export async function fetchMetaLeads(token: string, signal: AbortSignal): Promise<{ stats: { total: number; today: number; week: number }; data: MetaLead[] }> {
  const value = await request(token, 'leads?limit=50', signal);
  if (!object(value) || !object(value.stats) || !['total', 'today', 'week'].every(k => count((value.stats as Record<string, unknown>)[k])) || !Array.isArray(value.data) || value.data.length > 50) throw new Error('Invalid Meta lead summary.');
  const data = value.data.map(l => { if (!object(l) || !count(l.id) || l.id < 1 || !string(l.name, 255) || ['email', 'phone', 'lead_status', 'created_at'].some(k => l[k] !== null && !string(l[k], 255))) throw new Error('Invalid imported lead.'); return { id: l.id, name: l.name, email: l.email, phone: l.phone, lead_status: l.lead_status, created_at: l.created_at } as MetaLead; });
  if (new Set(data.map(l => l.id)).size !== data.length) throw new Error('Duplicate Meta lead references.');
  return { stats: value.stats as { total: number; today: number; week: number }, data };
}
export async function fetchMetaHistory(token: string, signal: AbortSignal): Promise<{ id: number; started_at: string; imported: number; updated: number; errors: string[] }[]> {
  const value = await request(token, 'sync-history?limit=20', signal);
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid Meta sync history.');
  return value.map(v => { if (!object(v) || !count(v.id) || !string(v.started_at, 64) || !count(v.imported) || !count(v.updated) || !Array.isArray(v.errors) || v.errors.length > 100 || v.errors.some(e => !string(e))) throw new Error('Invalid Meta sync record.'); return { id: v.id, started_at: v.started_at, imported: v.imported, updated: v.updated, errors: v.errors as string[] }; });
}
function managed() { if (!environment.metaManagementEnabled) throw new Error('Meta connection changes are not enabled in this build.'); }
export async function fetchMetaForms(token: string, page: string, signal: AbortSignal): Promise<MetaForm[]> {
  managed(); const value = await request(token, 'forms?page_id=' + encodeURIComponent(reference(page)), signal);
  if (!object(value) || !Array.isArray(value.forms) || value.forms.length > 2000) throw new Error('Invalid Meta forms.');
  const forms = value.forms.map(f => { if (!object(f) || !string(f.id, 128) || !string(f.name, 255) || typeof f.is_connected !== 'boolean' || !count(f.leads_count)) throw new Error('Invalid Meta form.'); return { id: reference(f.id), name: f.name, is_connected: f.is_connected, leads_count: f.leads_count }; });
  if (new Set(forms.map(f => f.id)).size !== forms.length) throw new Error('Duplicate Meta forms.');
  return forms;
}
export function metaBrowserUrl(value: unknown): string {
  if (!string(value, 8192)) throw new Error('Invalid Meta sign-in link.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.facebook.com' || url.port || url.username || url.password || url.hash || !/^\/v\d+\.\d+\/dialog\/oauth$/.test(url.pathname) || url.searchParams.getAll('state').length !== 1 || !url.searchParams.get('state') || url.searchParams.getAll('redirect_uri').length !== 1 || !url.searchParams.get('redirect_uri')?.startsWith('https://')) throw new Error('Invalid Meta sign-in link.');
  return url.toString();
}
export async function startMetaConnection(token: string, signal: AbortSignal): Promise<string> { managed(); const value = await request(token, 'auth-url', signal); if (!object(value)) throw new Error('Invalid Meta sign-in link.'); return metaBrowserUrl(value.auth_url); }
export async function updateMeta(token: string, action: 'sync' | 'refresh' | 'disconnect' | 'form', signal: AbortSignal, form?: { page: string; id: string; name: string; connected: boolean }): Promise<void> {
  managed(); let path = action === 'refresh' ? 'pages/refresh' : action === 'disconnect' ? 'disconnect' : action === 'form' ? 'forms' : 'sync';
  let body: Record<string, unknown> = {};
  if (action === 'form') { if (!form || !string(form.name, 255) || typeof form.connected !== 'boolean') throw new Error('Choose a valid Meta form.'); body = { page_id: reference(form.page), form_id: reference(form.id), form_name: form.name, connect: form.connected }; }
  const value = await request(token, path, signal, action === 'disconnect' ? undefined : body, action === 'disconnect' ? 'DELETE' : 'POST');
  if (!object(value) || (action === 'form' && value.connected !== form!.connected) || (action === 'disconnect' && value.disconnected !== true) || (action === 'sync' && (!count(value.imported) || !count(value.updated)))) throw new Error('Meta change could not be confirmed. Refresh connection and sync history.');
}
