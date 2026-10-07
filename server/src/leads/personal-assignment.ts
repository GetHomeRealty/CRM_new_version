import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';

export type AssignmentMode = 'keep' | 'transfer';
interface AssignmentLead {
  owner_user_id: number | null;
  assigned_to: number | null;
  team_id: number | null;
  assigned_team_lead_id?: number | null;
  collaborator_user_ids?: number[];
}

/** Personal-list membership is separate from brokerage ownership and role access. */
export function personalAssignment(
  lead: AssignmentLead, actorId: number, recipient: number | null | undefined,
  mode: unknown, mayRouteBrokerage: boolean,
): { collaborator_user_ids: number[]; owner_user_id?: number } | null {
  const explicit = mode !== undefined;
  if (explicit && mode !== 'keep' && mode !== 'transfer') {
    throw new UnprocessableEntityException({ errors: { assignment_mode: ['Choose Keep with me too or Transfer completely.'] } });
  }
  if (!explicit && (recipient == null || recipient === actorId || recipient === lead.assigned_to)) return null;
  if (lead.team_id != null || lead.assigned_team_lead_id != null) {
    if (!explicit) return null; // Separate team workflows are unchanged.
    throw new UnprocessableEntityException({ errors: { assignment_mode: ['Use the team assignment controls for this lead.'] } });
  }
  if (lead.owner_user_id !== actorId && !(lead.owner_user_id === null && mayRouteBrokerage)) {
    if (!explicit) return null; // Existing assignment authorization still applies.
    throw new ForbiddenException('Only the owner or an authorized brokerage assigner can choose this option.');
  }
  if (!Number.isInteger(recipient) || !recipient || recipient < 1 || recipient === actorId) {
    throw new UnprocessableEntityException({ errors: { assignment_mode: ['Select another active agent first.'] } });
  }
  const retained = new Set(lead.collaborator_user_ids ?? []);
  if (mode === 'transfer') retained.delete(actorId);
  else retained.add(actorId);
  return {
    collaborator_user_ids: [...retained],
    // A brokerage lead STAYS brokerage-owned. Private ownership moves only at its owner's request.
    ...(mode === 'transfer' && lead.owner_user_id === actorId ? { owner_user_id: recipient } : {}),
  };
}
