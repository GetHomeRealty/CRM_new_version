import type { AuthUser } from '../types';

/**
 * Whether this person may change WHO a lead is — its name, email, source and assignment.
 *
 * ================================================================================================
 * ONE DEFINITION, BECAUSE TWO SCREENS OPEN THE SAME EDITOR. The Leads list and the lead detail page
 * both render `LeadEditorModal` and both decide `lockIdentity` for themselves. They agreed with each
 * other and both disagreed with the server, which is the worst arrangement of the three: the screens
 * looked consistent, so nothing pointed at the rule being wrong.
 *
 * WHAT THEY GOT WRONG. Both asked:
 *
 *     user.role === 'agent' && lead.owner_user_id != null && lead.owner_user_id !== user.id
 *
 * while `LeadsService.isBrokerageAssigned` asks:
 *
 *     !can(user, 'leads.rewrite-identity') && lead.owner_user_id !== user.id
 *
 * Two differences, and each one is a real case:
 *
 *   `owner_user_id != null` EXEMPTED THE BROKERAGE'S OWN LEADS. A brokerage lead has a null owner,
 *   so the client concluded "not somebody else's" and offered the fields as editable. The server
 *   reads the same null as "not yours" and refuses the save. An agent working a lead the brokerage
 *   handed them could therefore retype the client's email address, press Update, and be told no.
 *
 *   `role === 'agent'` EXEMPTED crm, accounting AND documentation — three roles that already exist
 *   and sit below manager, so the server locks them and the screens did not. This is the same
 *   mistake `authz.ts` records having fixed on the server side: "written as `role === 'agent'`,
 *   which quietly exempted `crm`, `accounting` and `documentation` … and would exempt every role
 *   added after it".
 *
 * SO THE RULE IS EXPRESSED THE WAY THE SERVER EXPRESSES IT: a capability, not a role name.
 * `is_admin_or_above` is the same `rank >= manager` threshold the `leads.rewrite-identity`
 * capability is set at, and the server already sends it on the session — so this is the server's own
 * answer, not a second opinion about it.
 * ================================================================================================
 *
 * DELIBERATELY NOT USED FOR THE DELETE BUTTON. Deleting is a different question with a different
 * answer: `LeadsService.remove` scopes by visibility alone, so an agent may delete a brokerage lead
 * they can see. The list's own `isBrokerageLead` still governs that, and changing it here would have
 * quietly removed a control that works.
 */
export function identityLocked(
  lead: { owner_user_id?: number | null } | null | undefined,
  user: Pick<AuthUser, 'id' | 'is_admin_or_above'> | null | undefined,
): boolean {
  if (!lead || !user) return false;
  // Admin and above may correct a lead's details on anyone's desk.
  if (user.is_admin_or_above) return false;
  // Everyone else may rewrite only what is their own. A null owner is the brokerage's, not theirs.
  return (lead.owner_user_id ?? null) !== user.id;
}
