import { PrismaService } from '../prisma/prisma.service';
import type { Area } from '../common/domain';

/**
 * WHICH MAIL THE INBOX IS SHOWING — defined once, so nothing can disagree with it.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. The CRM dashboard's "unread mail" card counted
 * `inbound_emails` where `seen = false` and the account was CRM-scoped. The Inbox screen answered a
 * narrower question entirely: ONE mailbox (see `visibleAccountIds`), and only mail still in the
 * inbox folder. The two drifted the moment the Inbox was scoped to a single mailbox and the card
 * was not updated with it.
 *
 * Measured on real data, user 10108: the card read **416** while the Inbox held **50**. The missing
 * 366 belonged to a mailbox that was both non-default AND `is_active = false` — a disabled account
 * the switcher will not offer and the default lookup will not choose. The card was counting mail
 * that could not be opened from anywhere in the application. Another user's card read 1,428 against
 * an Inbox showing nothing at all, their only account being disabled.
 *
 * So the rule is: the dashboard does not get its own predicate. It calls these, the Inbox calls
 * these, and a future change to what "the Inbox shows" moves both at once. A regression spec asserts
 * the two counts are equal for the same user rather than trusting that they still agree.
 */

/**
 * Every account this user may ACT THROUGH in this area — the authorisation set.
 *
 * Deliberately NOT filtered by `is_active`: opening or moving an individual message authorises
 * against this, and a message must not become unreadable because its mailbox was later switched
 * off. What a person may READ is a question about ownership; what a list SHOWS is a separate
 * question, answered by `visibleAccountIds`.
 */
export async function permittedAccountIds(
  prisma: PrismaService,
  userId: number,
  area: Area,
): Promise<number[]> {
  const rows = await prisma.mail_accounts.findMany({
    where: { user_id: userId, OR: [{ scope: area }, { scope: null }] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * The ONE mailbox the screen is showing — never a merge.
 *
 * THE ORDER, and why each step is what it is:
 *
 *   1. AN EXPLICIT CHOICE, validated against this user's accounts in this area. The account
 *      switcher passes an id; a caller cannot name a colleague's mailbox, because an id outside
 *      the permitted set resolves to nothing rather than to "show everything".
 *   2. THE DEFAULT for this area, then a default with no area — the same order `sendingAccount`
 *      uses, so what you read and what you send from are the same mailbox.
 *   3. THE FIRST ACTIVE ACCOUNT, only when nothing is marked default. A brokerage that has never
 *      set one still gets a working Inbox, and it is ONE mailbox rather than a merge of all of
 *      them — "no default" must not silently mean "aggregate everything".
 *
 * EVERY LOOKUP REQUIRES `is_active: true`, which is what keeps a disabled mailbox out of the view
 * and — now that the dashboard shares this — out of the unread count as well.
 *
 * Returns an ARRAY so the callers' `{ in: [...] }` shape is unchanged, and so "no mailbox at all"
 * stays expressible as an empty list. It just never holds more than one id.
 */
export async function visibleAccountIds(
  prisma: PrismaService,
  userId: number,
  area: Area,
  accountId?: number | null,
): Promise<number[]> {
  const permitted = await permittedAccountIds(prisma, userId, area);
  if (permitted.length === 0) return [];

  if (accountId != null) {
    return permitted.includes(accountId) ? [accountId] : [];
  }

  const chosen = (await prisma.mail_accounts.findFirst({
    where: { user_id: userId, id: { in: permitted }, is_active: true, is_default: true, scope: area },
    select: { id: true },
  }))
    ?? (await prisma.mail_accounts.findFirst({
      where: { user_id: userId, id: { in: permitted }, is_active: true, is_default: true, scope: null },
      select: { id: true },
    }))
    ?? (await prisma.mail_accounts.findFirst({
      where: { user_id: userId, id: { in: permitted }, is_active: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    }));

  return chosen ? [chosen.id] : [];
}

/**
 * Unread mail sitting in the INBOX folder of the given accounts.
 *
 * The folder IS the pair of timestamps — see migration 20260815140000 — so "in the inbox" means
 * neither archived nor deleted. The card used to omit this and counted archived and trashed unread
 * too, which is mail the Inbox screen deliberately does not list.
 *
 * `deleted_at` here is the mail's own archive/trash state, not a record deletion: nothing in this
 * path removes a row, and an unread message excluded from the count is still present, still
 * readable, and still restorable from Trash.
 */
export const unreadInInboxWhere = (userId: number, accounts: number[]) => ({
  user_id: userId,
  account_id: { in: accounts },
  seen: false,
  deleted_at: null,
  archived_at: null,
});

/**
 * The number the "unread mail" card must show: unread, in the inbox folder, of the one mailbox the
 * Inbox screen opens on. Returns 0 when the user has no usable mailbox — which is the honest answer
 * and the one the screen itself gives.
 */
export async function unreadInboxCount(
  prisma: PrismaService,
  userId: number,
  area: Area,
): Promise<number> {
  const accounts = await visibleAccountIds(prisma, userId, area);
  if (accounts.length === 0) return 0;
  return prisma.inbound_emails.count({ where: unreadInInboxWhere(userId, accounts) });
}
