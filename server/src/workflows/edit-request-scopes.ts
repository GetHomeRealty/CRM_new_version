/**
 * WHICH APPROVALS UNLOCK A LOCKED DEAL, and which authorise one particular change.
 *
 * `transaction_edit_requests` started with a single meaning - "let me edit this locked deal" - and
 * has since grown scopes for particular changes. The DFT lock was written before that and asks for
 * ANY approved request on the deal, with no filter on scope at all. That was harmless while the
 * only other scope was `financial`, which an Admin would only ever raise on a deal they were
 * already editing. It stops being harmless the moment a scope exists that somebody BELOW Admin can
 * raise: an approval to untick one Mandatory box would otherwise also unlock the whole deal.
 *
 * TD-159 - so the question is asked explicitly here rather than by omission, and both sides read
 * the same list. `documentation`, `accounting` and `crm` can now ask for a `mandatory` approval,
 * and that approval means what it says and nothing more.
 *
 * `financial` IS DELIBERATELY STILL ON THE UNLOCKING SIDE, which is today's behaviour and not
 * obviously right. An approved financial request currently unlocks a DFT deal for any edit. It is
 * left exactly as it is because changing it would alter something that works today, and the
 * brokerage has not been asked. It is raised for them separately.
 */

/** A request that lifts the DFT / Closed edit lock on the whole deal. */
export function unlocksLockedDeal(scope: string | null | undefined): boolean {
  return scope === null || scope === undefined || scope === '' || scope === 'financial';
}

/**
 * The same rule as a Prisma filter.
 *
 * Written as an explicit OR rather than `{ not: 'mandatory' }` because `scope` is nullable, and a
 * negated comparison against a NULL column is a class of bug that reads as correct: in SQL,
 * `scope <> 'mandatory'` is UNKNOWN when scope is NULL, so the general requests - the ones that
 * actually unlock the deal - would be silently excluded and the lock could never be lifted.
 */
export const UNLOCKING_SCOPE_FILTER = { OR: [{ scope: null }, { scope: 'financial' }] };
