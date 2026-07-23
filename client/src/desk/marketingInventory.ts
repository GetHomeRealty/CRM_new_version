// Marketing / physical-asset inventory — client copy of the shared derive-live logic.
// Mirrors server/src/marketing-inventory/marketing-inventory.model.ts. Kept as its own file
// because the client and server are separate packages and cannot share a source module.

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

export interface InventoryAssignment {
  assignedTo: string;
  qty: number;
  assignedDate?: string;
  returnedDate?: string;
}

export interface MarketingInventoryItem {
  _id?: string;
  asOnDate: string;
  type: string;
  customType?: string;
  count: number;
  assignments?: InventoryAssignment[];
  assignedQty: number;
  assignedTo?: string;
  assignedDate?: string;
  returnedDate?: string;
  status: string;
  remarks?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export function balanceCount(count: number, assignedQty: number): number {
  return Math.max(0, (Number(count) || 0) - (Number(assignedQty) || 0));
}

export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** A future return date is only *scheduled* — the items are still out until it arrives. */
export function hasBeenReturned(returnedDate?: string | null, now: Date = new Date()): boolean {
  if (!returnedDate) return false;
  const date = String(returnedDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date <= todayKey(now);
}

export function isReturnScheduled(returnedDate?: string | null, now: Date = new Date()): boolean {
  return !!returnedDate && !hasBeenReturned(returnedDate, now);
}

type AssignmentSource = Pick<MarketingInventoryItem, 'assignments' | 'assignedTo' | 'assignedQty' | 'assignedDate' | 'returnedDate'>;

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
  return [{ assignedTo: (item.assignedTo || '').trim(), qty: legacyQty, assignedDate: item.assignedDate || '', returnedDate: item.returnedDate || '' }];
}

export function totalAssignedQty(item: AssignmentSource): number {
  return normalizeAssignments(item).reduce((sum, a) => sum + a.qty, 0);
}

export function outstandingQty(item: AssignmentSource, now: Date = new Date()): number {
  return normalizeAssignments(item)
    .filter((a) => !hasBeenReturned(a.returnedDate, now))
    .reduce((sum, a) => sum + a.qty, 0);
}

export function outstandingHolders(item: AssignmentSource, now: Date = new Date()): InventoryAssignment[] {
  return normalizeAssignments(item).filter((a) => !hasBeenReturned(a.returnedDate, now));
}

export function deriveStatusFor(item: AssignmentSource & { count: number }, now: Date = new Date()): MarketingStatus {
  if (totalAssignedQty(item) <= 0) return 'Available';
  return outstandingQty(item, now) > 0 ? 'Not Returned' : 'Returned';
}

export function balanceFor(item: AssignmentSource & { count: number }): number {
  return balanceCount(Number(item.count) || 0, totalAssignedQty(item));
}

export function countAsOnDateFor(item: AssignmentSource & { count: number }, now: Date = new Date()): number {
  return Math.max(0, (Number(item.count) || 0) - outstandingQty(item, now));
}

export function displayType(item: Pick<MarketingInventoryItem, 'type' | 'customType'>): string {
  if (item.type === 'Custom' && item.customType?.trim()) return item.customType.trim();
  return String(item.type);
}
