import type { MobileLead } from './leads-api';
export const LEAD_FILTER_KEYS = ['leadType', 'leadSource', 'leadResponse', 'clientType', 'leadConversion', 'tag', 'gender', 'language', 'religion', 'minAge', 'maxAge', 'assignedTo', 'recent'] as const;
export type LeadFilters = Partial<Record<typeof LEAD_FILTER_KEYS[number], string>>;
export function appendLeadFilters(query: URLSearchParams, filters: LeadFilters): void {
  for (const k of Object.keys(filters)) if (!(LEAD_FILTER_KEYS as readonly string[]).includes(k)) throw new Error('Unsupported lead filter.');
  for (const k of LEAD_FILTER_KEYS) { const v = filters[k]; if (v === undefined || v === '') continue; if (typeof v !== 'string' || v.length > 255) throw new Error('Lead filter is too long.'); query.set(k, v.trim()); }
  for (const k of ['minAge', 'maxAge'] as const) if (filters[k] && (!/^\d{1,3}$/.test(filters[k]!) || Number(filters[k]) > 120)) throw new Error('Age filters must be whole numbers from 0 to 120.');
  if (filters.minAge && filters.maxAge && Number(filters.minAge) > Number(filters.maxAge)) throw new Error('Minimum age must not exceed maximum age.');
  if (filters.assignedTo && filters.assignedTo !== 'unassigned' && (!/^[1-9]\d*$/.test(filters.assignedTo) || !Number.isSafeInteger(Number(filters.assignedTo)))) throw new Error('Choose a valid assignee.');
  if (filters.recent && filters.recent !== 'true') throw new Error('Invalid recent-lead filter.');
}
export const LEAD_DISPLAY_FIELDS = ['email', 'phone', 'lead_type', 'lead_source', 'location', 'assigned_to_name', 'lead_conversion', 'lead_quality', 'age', 'tags'] as const;
export type LeadDisplayField = typeof LEAD_DISPLAY_FIELDS[number];
export function leadDisplayFields(lead: MobileLead, selected: LeadDisplayField[]): { label: string; value: string }[] {
  return LEAD_DISPLAY_FIELDS.filter(k => selected.includes(k)).map(k => ({ label: k.replaceAll('_', ' '), value: Array.isArray(lead[k]) ? (lead[k] as string[]).join(', ') : String(lead[k] ?? '—') }));
}
