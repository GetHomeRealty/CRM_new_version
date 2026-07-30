import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { AREA_LABEL, type Area } from '../common/domain';

/**
 * How many email accounts one person may connect in one area.
 *
 * An agent gets exactly one per area — one for the CRM and one for the Transaction Desk — and must
 * disconnect the current one before connecting a different address. Administrators and managers are
 * unrestricted, as they were before.
 *
 * The two areas are independent: an agent holding a CRM account is not thereby connected to the
 * Transaction Desk, and connecting one there is a separate act with its own limit of one.
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

/** What the limit is for this user in this area, for showing on screen and for enforcing. */
export async function emailLimitFor(prisma: PrismaService, userId: number, area: Area): Promise<EmailLimit> {
  const user = await prisma.users.findUnique({ where: { id: userId }, select: { role: true } });
  const max = LIMITS[String(user?.role ?? '')] ?? null;
  if (max === null) return { max: null, used: 0, canAdd: true };

  // Counted within the area only. An account with no scope pre-dates the split and is deliberately
  // NOT counted against either area's limit: it is already visible on both sides, and counting it
  // twice would leave an agent unable to connect anywhere until they had assigned it.
  const used = await prisma.mail_accounts.count({ where: { user_id: userId, scope: area } });
  return { max, used, canAdd: used < max };
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
    where: { user_id: userId, scope: area },
    select: { from_email: true },
    orderBy: { id: 'asc' },
  });
  throw new BadRequestException({
    message: `Your role allows one ${AREA_LABEL[area]} email account${existing?.from_email ? `, and ${existing.from_email} is already connected` : ''}. Disconnect it first, then connect the new address.`,
    errors: { from_email: ['Only one email account can be connected here.'] },
  });
}
