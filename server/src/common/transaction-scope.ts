import { Prisma } from '@prisma/client';
import { isAgent } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Which deals a signed-in user may see — written once, for every screen that asks.
 *
 * `TransactionsService` spelled this rule inline in four places and the Calendar did not spell it
 * at all: linking an event to a deal checked only that the deal EXISTED. That was enough for an
 * agent whose Transactions screen showed nothing to walk the id range and read back every deal's
 * trade number and street address, and to leave an audit entry in each one on the way past.
 *
 * The rule itself is unchanged:
 *
 *   - An agent sees the deals they are the agent on, and the deals they are split into as a team
 *     member.
 *   - A deal with no agent at all is unassigned brokerage work and is administrator-only, even
 *     when team rows exist — matching `authorizeAgentAccess`.
 *   - Every other role sees the brokerage's deals; the deal core is deliberately shared, unlike
 *     the personal CRM modules.
 */
export function transactionScopeWhere(user: AuthUserRecord | null): Prisma.transactionsWhereInput {
  if (!user || !isAgent(user)) return {};
  const name = user.name;
  return {
    OR: [
      { agent: name },
      { AND: [{ agent: { not: null } }, { agent: { not: '' } }, { team_members: { some: { name } } }] },
    ],
  };
}
