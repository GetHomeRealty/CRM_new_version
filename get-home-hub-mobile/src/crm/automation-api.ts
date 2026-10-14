import { environment } from '@/config/environment';
export type Channel = 'email' | 'in_app' | 'push';
export interface TriggerSettings { triggers: Record<string, boolean>; customised: Record<string, boolean>; brokerage_defaults: Record<string, boolean>; sending_allowed: boolean; trigger_keys: string[]; unreadable: boolean }
export interface Communication { key: string; name: string; description: string; kind: string; audience: string; channels: Record<Channel, boolean>; preferences: Partial<Record<Channel, boolean>>; template: { id: number; name: string; subject: string; is_active: boolean } | null }
export interface Communications { brokerage: { auto_send_enabled: boolean }; communications: Communication[] }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const text = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length <= max;
function booleanMap(v: unknown): v is Record<string, boolean> { return object(v) && Object.keys(v).length <= 64 && Object.entries(v).every(([k, b]) => /^[a-zA-Z0-9_.-]{1,128}$/.test(k) && typeof b === 'boolean'); }
async function request(token: string, path: string, signal: AbortSignal, body?: unknown, method = body ? 'PUT' : 'GET'): Promise<unknown> {
  if (!token || signal.aborted) throw new Error('Sign in to review CRM communications.');
  const response = await fetch(`${environment.apiUrl}/api/${path}`, { method, signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 403 ? 'You no longer have access to change these choices.' : response.status === 401 ? 'Sign in again.' : 'The communication choice could not be confirmed. Refresh to review its saved state.');
  return response.json();
}
function triggerSettings(v: unknown): TriggerSettings {
  if (!object(v) || !booleanMap(v.triggers) || !booleanMap(v.customised) || !booleanMap(v.brokerage_defaults) || typeof v.sending_allowed !== 'boolean' || typeof v.unreadable !== 'boolean' || !Array.isArray(v.trigger_keys) || v.trigger_keys.length > 64 || new Set(v.trigger_keys).size !== v.trigger_keys.length || v.trigger_keys.some(k => typeof k !== 'string' || !Object.hasOwn(v.triggers as object, k) || !Object.hasOwn(v.customised as object, k) || !Object.hasOwn(v.brokerage_defaults as object, k))) throw new Error('Invalid CRM trigger choices.');
  return v as unknown as TriggerSettings;
}
export async function fetchTriggers(token: string, signal: AbortSignal): Promise<TriggerSettings> { return triggerSettings(await request(token, 'crm-settings/triggers', signal)); }
export async function saveTrigger(token: string, key: string, enabled: boolean, allowedKeys: string[], signal: AbortSignal): Promise<TriggerSettings> {
  if (!allowedKeys.includes(key) || typeof enabled !== 'boolean' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(key)) throw new Error('Refresh the trigger list before changing this choice.');
  return triggerSettings(await request(token, 'crm-settings/triggers', signal, { triggers: { [key]: enabled } }));
}
export async function fetchCommunications(token: string, signal: AbortSignal): Promise<Communications> {
  const value = await request(token, 'crm-communications', signal);
  if (!object(value) || !object(value.brokerage) || typeof value.brokerage.auto_send_enabled !== 'boolean' || !Array.isArray(value.communications) || value.communications.length > 64) throw new Error('Invalid communications response.');
  const communications = value.communications.map(c => {
    if (!object(c) || !text(c.key, 128) || !/^[a-zA-Z0-9_.-]+$/.test(c.key) || !text(c.name, 255) || !text(c.description) || !['automated', 'manual'].includes(String(c.kind)) || !['lead', 'staff'].includes(String(c.audience)) || !booleanMap(c.channels) || !booleanMap(c.preferences)) throw new Error('Invalid communication.');
    for (const k of ['email', 'in_app', 'push']) if (typeof c.channels[k] !== 'boolean' || c.channels[k] && typeof c.preferences[k] !== 'boolean') throw new Error('Invalid communication channels.');
    if (c.template !== null && (!object(c.template) || !Number.isSafeInteger(c.template.id) || Number(c.template.id) < 1 || !text(c.template.name, 255) || !text(c.template.subject, 255) || typeof c.template.is_active !== 'boolean')) throw new Error('Invalid communication template.');
    return c as unknown as Communication;
  });
  if (new Set(communications.map(c => c.key)).size !== communications.length) throw new Error('Duplicate communication keys.');
  return { brokerage: { auto_send_enabled: value.brokerage.auto_send_enabled }, communications };
}
export async function saveCommunication(token: string, row: Communication, channel: Channel, enabled: boolean, signal: AbortSignal): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(row.key) || !['email', 'in_app', 'push'].includes(channel) || row.channels[channel] !== true || typeof enabled !== 'boolean') throw new Error('This channel is not available for this communication.');
  const value = await request(token, `crm-communications/preferences/${encodeURIComponent(row.key)}/${channel}`, signal, { enabled });
  if (!object(value) || value.ok !== true || value.key !== row.key || value.channel !== channel || value.enabled !== enabled) throw new Error('Communication choice could not be confirmed. Refresh to review it.');
}
export async function previewCommunication(token: string, id: number, signal: AbortSignal): Promise<{ subject: string; html: string }> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid template reference.');
  const value = await request(token, `crm-communications/templates/${id}/preview`, signal, {}, 'POST');
  if (!object(value) || !text(value.subject, 255) || !text(value.html, 200000)) throw new Error('Invalid communication preview.');
  return { subject: value.subject, html: value.html };
}
