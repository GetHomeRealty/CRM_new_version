import type { LeadAssignee, LeadUpdate, MobileLead } from './leads-api';
/** Only explicit changes from server choices; an absent option never means unassign. */
export function assignmentChange(lead: MobileLead | undefined, update: LeadUpdate, choices: LeadAssignee[] | undefined): { id: number | null; label: string } | null {
  if (!Object.hasOwn(update, 'assigned_to') || update.assigned_to === lead?.assigned_to) return null;
  if (!lead || lead.assigned_to === undefined) throw new Error('Refresh this lead before changing assignment.');
  const id = update.assigned_to;
  if (id === null) return { id: null, label: 'Unassigned' };
  const choice = choices?.find(u => u.id === id);
  if (!Number.isSafeInteger(id) || !choice) throw new Error('Reload assignment choices before saving.');
  return { id: choice.id, label: choice.name };
}
