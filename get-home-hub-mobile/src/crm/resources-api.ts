import { environment } from '@/config/environment';

export type Listing = Record<string, unknown> & { ListingKey: string };
export interface MlsFilters { search: string; sort: string; priceMin: string; priceMax: string; beds: string; baths: string; propertyType: string; status: string }
export const emptyMlsFilters: MlsFilters = { search: '', sort: 'newest', priceMin: '', priceMax: '', beds: 'any', baths: 'any', propertyType: 'any', status: 'any' };
export interface MlsPage { properties: Listing[]; total: number; page: number; pageSize: number; totalPages: number }
export interface Favorite { id: number; listing_key: string; snapshot: Listing; notes: string; created_at: string | null }
export interface InventoryItem { _id: string; type: string; customType?: string; count: number; assignedQty: number; assignedTo?: string; assignedDate?: string; returnedDate?: string; asOnDate: string; status: string; remarks?: string; assignments: { assignedTo: string; qty: number; assignedDate?: string; returnedDate?: string }[] }
const key = (value: string) => { if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid listing reference.'); return value; };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const string = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length <= max;
export function listing(value: unknown, expected?: string): Listing {
  if (!object(value)) throw new Error('Invalid listing response.');
  const id = key(value.ListingKey as string);
  if (expected && id !== expected) throw new Error('The listing reference changed. Refresh the list.');
  // Keep bounded plain values only. No remote media, links or HTML are evaluated.
  const entries = Object.entries(value).slice(0, 200).filter(([k, v]) => k.length <= 128 && ((typeof v === 'string' && v.length <= 20000) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null));
  return { ...Object.fromEntries(entries), ListingKey: id };
}
export function listingSnapshot(value: Listing): Listing {
  const fields = ['ListingKey', 'UnparsedAddress', 'City', 'StateOrProvince', 'PostalCode', 'ListPrice', 'BedroomsTotal', 'BathroomsTotalInteger', 'LivingArea', 'PropertyType', 'StandardStatus'];
  return listing(Object.fromEntries(fields.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]])));
}
async function request(token: string, path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<unknown> {
  if (!token || signal.aborted) throw new Error('Sign in to view CRM resources.');
  const response = await fetch(`${environment.apiUrl}/api/${path}`, { method, signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again.' : response.status === 403 ? 'You no longer have access to this screen.' : response.status === 404 ? 'This item is no longer available. Refresh the list.' : 'CRM resources could not be loaded. Refresh and try again.');
  return response.json();
}
export async function fetchMlsStatus(token: string, signal: AbortSignal): Promise<boolean> {
  const value = await request(token, 'mls/status', signal);
  if (!object(value) || typeof value.configured !== 'boolean') throw new Error('Invalid MLS status.');
  return value.configured;
}
export function mlsQuery(filters: MlsFilters, page: number): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || filters.search.length > 255 || !['newest', 'price_asc', 'price_desc'].includes(filters.sort)) throw new Error('Invalid MLS search.');
  for (const field of ['priceMin', 'priceMax', 'beds', 'baths'] as const) {
    const value = filters[field];
    if (value !== '' && value !== 'any' && (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 1000000000)) throw new Error('Enter valid non-negative price, bed and bath filters.');
  }
  if (filters.priceMin && filters.priceMax && Number(filters.priceMin) > Number(filters.priceMax)) throw new Error('Minimum price must not exceed maximum price.');
  const query = new URLSearchParams({ page: String(page) });
  for (const [k, v] of Object.entries(filters)) { if (v && v !== 'any') { if (v.length > 255) throw new Error('Search filter is too long.'); query.set(k, v); } }
  return query.toString();
}
export async function fetchMls(token: string, filters: MlsFilters, page: number, signal: AbortSignal): Promise<MlsPage> {
  const value = await request(token, 'mls?' + mlsQuery(filters, page), signal);
  if (!object(value) || !Array.isArray(value.properties) || value.properties.length > 50 || !count(value.total) || value.page !== page || !count(value.pageSize) || value.pageSize < 1 || value.pageSize > 50 || !count(value.totalPages) || value.totalPages < 1) throw new Error('Invalid MLS results.');
  const properties = value.properties.map(v => listing(v));
  if (new Set(properties.map(p => p.ListingKey)).size !== properties.length) throw new Error('Duplicate MLS references.');
  return { properties, total: value.total, page, pageSize: value.pageSize, totalPages: value.totalPages };
}
export async function fetchListing(token: string, id: string, signal: AbortSignal): Promise<Listing> { return listing(await request(token, 'mls/' + encodeURIComponent(key(id)), signal), id); }
export async function fetchFavoriteKeys(token: string, signal: AbortSignal): Promise<string[]> {
  const value = await request(token, 'favorites/keys', signal);
  if (!Array.isArray(value) || value.length > 10000 || value.some(v => typeof v !== 'string')) throw new Error('Invalid favourites response.');
  value.forEach(key);
  if (new Set(value).size !== value.length) throw new Error('Duplicate favourite references.');
  return value;
}
export async function fetchFavorites(token: string, signal: AbortSignal): Promise<Favorite[]> {
  const value = await request(token, 'favorites', signal);
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid favourites response.');
  const result = value.map(v => {
    if (!object(v) || !count(v.id) || v.id < 1 || !string(v.notes) || !(v.created_at === null || (string(v.created_at, 64) && Number.isFinite(Date.parse(v.created_at))))) throw new Error('Invalid favourite item.');
    const id = key(v.listing_key as string);
    // Historical snapshots may omit ListingKey; the owner-scoped row is authoritative.
    if (!object(v.snapshot)) throw new Error('Invalid favourite snapshot.');
    return { id: v.id, listing_key: id, snapshot: listing({ ...v.snapshot, ListingKey: id }), notes: v.notes, created_at: v.created_at as string | null };
  });
  if (new Set(result.map(v => v.listing_key)).size !== result.length) throw new Error('Duplicate favourite references.');
  return result;
}
export class UnconfirmedFavorite extends Error { constructor() { super('The favourite change is unconfirmed. Refresh saved listings before making another change.'); } }
export async function changeFavorite(token: string, item: Listing, remove: boolean, signal: AbortSignal): Promise<void> {
  const id = key(item.ListingKey);
  try {
    const value = await request(token, remove ? 'favorites/' + encodeURIComponent(id) : 'favorites/toggle', signal, remove ? 'DELETE' : 'POST', remove ? undefined : { listing_key: id, snapshot: listingSnapshot(item) });
    if (!object(value) || (remove ? value.success !== true : typeof value.favorited !== 'boolean')) throw new Error('Invalid favourite save response.');
  } catch { throw new UnconfirmedFavorite(); } // A toggle must never be retried automatically.
}
export async function fetchInventory(token: string, filters: { search: string; type: string; status: string }, signal: AbortSignal): Promise<{ items: InventoryItem[]; total: number }> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) { if (!string(v, 255)) throw new Error('Invalid inventory filter.'); if (v) query.set(k, v); }
  const value = await request(token, 'marketing-inventory?' + query.toString(), signal);
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 10000 || !count(value.total) || value.total !== value.items.length) throw new Error('Invalid inventory response.');
  const items = value.items.map(v => {
    if (!object(v) || !string(v._id, 32) || !/^[1-9]\d*$/.test(v._id) || !string(v.type, 255) || !count(v.count) || !count(v.assignedQty) || !string(v.status, 255) || !string(v.asOnDate, 32) || !Array.isArray(v.assignments) || v.assignments.length > 2000) throw new Error('Invalid inventory item.');
    for (const k of ['customType', 'assignedTo', 'assignedDate', 'returnedDate', 'remarks']) if (v[k] !== undefined && !string(v[k])) throw new Error('Invalid inventory item.');
    for (const a of v.assignments) if (!object(a) || !string(a.assignedTo, 255) || !count(a.qty) || (a.assignedDate !== undefined && !string(a.assignedDate, 32)) || (a.returnedDate !== undefined && !string(a.returnedDate, 32))) throw new Error('Invalid inventory assignment.');
    return v as unknown as InventoryItem;
  });
  if (new Set(items.map(i => i._id)).size !== items.length) throw new Error('Duplicate inventory references.');
  return { items, total: value.total };
}
