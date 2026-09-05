import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { Area } from '../common/domain';

/**
 * How many email accounts one person may connect across the Hub.
 *
 * An agent gets one account shared by CRM and Transactions and must disconnect it before connecting
 * a different address. Administrators and managers remain unrestricted.
 *
 * Declared as a function over Prisma rather than a method on either service because both routes
 * into account creation have to honour it — the manual SMTP form and the Gmail OAuth callback —
 * and those live in different modules. A rule enforced in one of two places is not a rule.
 */

/** Roles with a per-area account limit, and what that limit is. */
const LIMITS: Record<string, number> = { agent: 1 };

export interface EmailLimit {
  /** Null when this role has no limit. */
  max: number | null;
  used: number;
  /** Whether another account may be connected in this area right now. */
  canAdd: boolean;
}

/** What the Hub-wide limit is for this user, for showing on screen and enforcing. */
export async function emailLimitFor(prisma: PrismaService, userId: number, _area: Area): Promise<EmailLimit> {
  const user = await prisma.users.findUnique({ where: { id: userId }, select: { role: true } });
  const max = LIMITS[String(user?.role ?? '')] ?? null;

  /*
   * `used` IS COUNTED EVEN WHEN THERE IS NO LIMIT.
   *
   * An unlimited role used to short-circuit here and return `used: 0` without counting, so an
   * administrator with two CRM accounts and two Desk accounts was told none were in use, at every
   * scope. The number was simply untrue, and it is published by an endpoint whose stated contract
   * is how many accounts are in use.
   *
   * IT WAS NEVER A CORRECTNESS FAULT, and it is worth being exact about that rather than
   * overstating it: the short-circuit only ran when `max` was null, and with no maximum `canAdd` is
   * true whatever `used` says. Nothing was ever wrongly allowed or refused. The reported figure was
   * the only casualty - which is why this is Trivial, and why the fix is to count rather than to
   * delete the field as its sibling defect required.
   *
   * Every personal account counts once across the Hub, regardless of its legacy area stamp.
   */
  const used = await prisma.mail_accounts.count({ where: { user_id: userId } });

  // `canAdd` still comes from the limit, not from the count: no maximum means no ceiling to reach.
  return { max, used, canAdd: max === null || used < max };
}

/**
 * Refuse a new connection that would exceed the limit.
 *
 * Called before creating an account, never on reconnecting an existing one — re-authorising an
 * account the agent already has does not add a second address, and blocking it would leave an agent
 * with an expired token permanently stuck.
 */
export async function assertCanConnectEmail(prisma: PrismaService, userId: number, area: Area): Promise<void> {
  const limit = await emailLimitFor(prisma, userId, area);
  if (limit.canAdd) return;

  const existing = await prisma.mail_accounts.findFirst({
    where: { user_id: userId },
    select: { from_email: true },
    orderBy: { id: 'asc' },
  });
  throw new BadRequestException({
    message: `Your role allows one Hub email account${existing?.from_email ? `, and ${existing.from_email} is already connected` : ''}. Disconnect it first, then connect the new address.`,
    errors: { from_email: ['Only one email account can be connected across CRM and Transactions.'] },
  });
}
