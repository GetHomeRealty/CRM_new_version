// Marketing / physical asset inventory (signboards, lock boxes, banners, ...)
// Ported from the Next.js app's lib/models/MarketingInventory.ts — pure, framework-free
// logic shared by the service (and mirrored on the client). Distinct from property-listing
// "inventory". The DB stores snake_case columns; these functions work on the camelCase
// "logical" shape the service maps rows into, so the API and the client port stay identical.

export const MARKETING_ITEM_TYPES = [
  'For Sale Signboards',
  'Lock Box',
  'Roll Up Banner',
  'Post Card',
  'For Lease Signboards',
  'Open House Signboards',
  'Directional Signboards',
  'Custom',
] as const;

export type MarketingItemType = (typeof MARKETING_ITEM_TYPES)[number];

export const MARKETING_STATUSES = ['Available', 'Not Returned', 'Returned'] as const;
export type MarketingStatus = (typeof MARKETING_STATUSES)[number];

/** One person holding some of this item, with their own dates. */
export interface InventoryAssignment {
  assignedTo: string;
  qty: number;
  assignedDate?: string;
  /** Set once they hand the units back; a future date means "due back". */
  returnedDate?: string;
}

/** The camelCase logical shape used across the service and API. */
export interface MarketingInventoryItem {
  _id?: string;
  asOnDate: string;
  type: MarketingItemType | string;
  customType?: string;
  count: number;
  assignments?: InventoryAssignment[];
  // Legacy single-holder mirrors, kept so old rows still read correctly.
  assignedQty: number;
  assignedTo?: string;
  assignedDate?: string;
  returnedDate?: string;
  status: MarketingStatus | string;
  remarks?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

/** Balance = total stock minus what is currently assigned out. Never negative. */
export function balanceCount(count: number, assignedQty: number): number {
  return Math.max(0, (Number(count) || 0) - (Number(assignedQty) || 0));
}

/** Today as `YYYY-MM-DD` in local time (not UTC — avoids an off-by-one evening shift). */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * True only once the return date has actually arrived. A future date is a *scheduled*
 * return — the items are still out, so the row must not read as Returned yet.
 */
export function hasBeenReturned(returnedDate?: string | null, now: Date = new Date()): boolean {
  if (!returnedDate) return false;
  const date = String(returnedDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date <= todayKey(now); // ISO dates compare correctly as strings
}

/** True when a return is booked but the date has not arrived yet. */
export function isReturnScheduled(returnedDate?: string | null, now: Date = new Date()): boolean {
  return !!returnedDate && !hasBeenReturned(returnedDate, now);
}

type AssignmentSource = Pick<
  MarketingInventoryItem,
  'assignments' | 'assignedTo' | 'assignedQty' | 'assignedDate' | 'returnedDate'
>;

/**
 * The per-person list for any record, old or new. Rows saved before multi-assign have only
 * the flat `assignedTo`/`assignedQty` fields; those present as a single-entry list.
 */
export function normalizeAssignments(item: AssignmentSource): InventoryAssignment[] {
  if (Array.isArray(item.assignments) && item.assignments.length > 0) {
    return item.assignments
      .map((a) => ({
        assignedTo: String(a?.assignedTo ?? '').trim(),
        qty: Math.max(0, Number(a?.qty) || 0),
        assignedDate: a?.assignedDate || '',
        returnedDate: a?.returnedDate || '',
      }))
      .filter((a) => a.assignedTo !== '' || a.qty > 0);
  }

  const legacyQty = Number(item.assignedQty) || 0;
  if (legacyQty <= 0 && !item.assignedTo) return [];

  return [
    {
      assignedTo: (item.assignedTo || '').trim(),
      qty: legacyQty,
      assignedDate: item.assignedDate || '',
      returnedDate: item.returnedDate || '',
    },
  ];
}

/** Clean a per-person list arriving from a client. */
export function sanitizeAssignments(raw: unknown): InventoryAssignment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a: Record<string, unknown>) => ({
      assignedTo: String(a?.assignedTo ?? '').trim(),
      qty: Math.max(0, Number(a?.qty) || 0),
      assignedDate: String(a?.assignedDate ?? '').slice(0, 10),
      returnedDate: String(a?.returnedDate ?? '').slice(0, 10),
    }))
    .filter((a) => a.assignedTo !== '' || a.qty > 0);
}

/** Units handed out in total, whether or not they have come back. */
export function totalAssignedQty(item: AssignmentSource): number {
  return normalizeAssignments(item).reduce((sum, a) => sum + a.qty, 0);
}

/** Units still in someone's hands right now (a future return date counts as still out). */
export function outstandingQty(item: AssignmentSource, now: Date = new Date()): number {
  return normalizeAssignments(item)
    .filter((a) => !hasBeenReturned(a.returnedDate, now))
    .reduce((sum, a) => sum + a.qty, 0);
}

/** People who still hold units. */
export function outstandingHolders(item: AssignmentSource, now: Date = new Date()): InventoryAssignment[] {
  return normalizeAssignments(item).filter((a) => !hasBeenReturned(a.returnedDate, now));
}

/** Status derived from the per-person list, so it can never contradict it. */
export function deriveStatusFor(item: AssignmentSource & { count: number }, now: Date = new Date()): MarketingStatus {
  if (totalAssignedQty(item) <= 0) return 'Available';
  return outstandingQty(item, now) > 0 ? 'Not Returned' : 'Returned';
}

/** Balance = stock minus everything ever handed out (ignores returns, by design). */
export function balanceFor(item: AssignmentSource & { count: number }): number {
  return balanceCount(Number(item.count) || 0, totalAssignedQty(item));
}

/** Stock actually on hand as at today: total minus what is still out. */
export function countAsOnDateFor(item: AssignmentSource & { count: number }, now: Date = new Date()): number {
  return Math.max(0, (Number(item.count) || 0) - outstandingQty(item, now));
}

/** Compact "who has it" label for the table. */
export function assignedToLabel(item: AssignmentSource): string {
  const list = normalizeAssignments(item).filter((a) => a.assignedTo);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0].assignedTo;
  if (list.length === 2) return `${list[0].assignedTo}, ${list[1].assignedTo}`;
  return `${list[0].assignedTo} +${list.length - 1} more`;
}

/** Resolves the label shown in the Type column, honouring custom names. */
export function displayType(item: Pick<MarketingInventoryItem, 'type' | 'customType'>): string {
  if (item.type === 'Custom' && item.customType?.trim()) return item.customType.trim();
  return String(item.type);
}
