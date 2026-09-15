/**
 * WHETHER A DEAL IS STILL BEING WAITED ON - the one list, read by everything that chases.
 *
 * TD-188, 2026-09-15. This lived as a private method inside ReminderSweepService, so the nightly
 * sweep knew that a Closed or Mutual Release deal is not waiting for anything and the SAVE-time
 * lawyer reminder did not. On 2026-09-13 the master-sheet import saved 852 deals and the save-time
 * path fired on every buying deal with blank lawyer details: 267 emails to 55 agents, 235 of them
 * about deals this very list already called finished. One agent replied that his closed in
 * February; another asked why a mutual release needed a lawyer.
 *
 * It is exported from a file of its own rather than from lawyer-details.ts because it is not about
 * lawyers - closing reminders and listing expiry ask the same question.
 */

/** A deal in any of these is done; nobody is waiting on it. */
export const SETTLED_STATUSES = [
  'Closed', 'Sold', 'Leased', 'Void', 'Terminated', 'Mutual Release',
  'Expired', 'Cancelled', 'Archived', 'Completed', 'Suspended',
] as const;

/**
 * True when ANY of the deal's status rows is a finished one - matching the behaviour this replaced.
 * A deal carries its status history, so one finished row is enough to say it is over.
 */
export function isSettledDeal(statuses: { status: string }[] | null | undefined): boolean {
  return (statuses ?? []).some((s) => (SETTLED_STATUSES as readonly string[]).includes(s.status));
}
