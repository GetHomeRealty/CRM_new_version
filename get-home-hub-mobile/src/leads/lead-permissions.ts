export function leadIdentityLocked(
  user: { id?: number; role?: string } | null,
  lead: { owner_user_id?: number | null } | undefined,
): boolean {
  if (!user || !lead) return true;
  if (user.role === 'admin' || user.role === 'manager') return false;
  return typeof user.id !== 'number' || lead.owner_user_id !== user.id;
}

export const lockedLeadIdentityFields = ['name', 'first_name', 'middle_name', 'last_name', 'email', 'phone', 'lead_source', 'assigned_to'] as const;

export function assertLeadIdentityUpdateAllowed(locked: boolean, update: object): void {
  if (locked && lockedLeadIdentityFields.some((key) => key in update)) {
    throw new Error('The brokerage owns this lead’s contact details and source. Ask a manager or administrator to change them.');
  }
}
