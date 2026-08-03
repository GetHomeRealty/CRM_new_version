import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isAdminOrAbove, isAgent, isSuperAdmin } from './authz';

/**
 * Ownership — the authorization question the tenant filter cannot answer.
 *
 * Tenant isolation stops one brokerage reading another's records. It says nothing about one agent
 * reading a colleague's, because both rows belong to the same company and the filter is satisfied.
 * That second question has to be asked per resource, and it was being asked in some places and not
 * others: `GET /api/transactions/:id` refused an agent who had no part in the deal, while
 * `GET /api/transactions/:id/messages` handed over the whole chat thread. Found by signing in as a
 * real agent and asking, not by reading the code.
 *
 * The rule itself is unchanged and still the transaction list's rule: an agent may reach a deal
 * they are named on, or one they are split into. An unassigned deal is nobody's, and therefore
 * administrators only. Everyone above agent is unaffected.
 *
 * Kept here rather than in the transactions service so anything hanging off a transaction — chat,
 * documents, invoices, the next thing — asks the same question in the same words, instead of each
 * one deciding for itself whether to ask at all.
 */
@Injectable()
export class ResourceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Throw unless this person may reach this transaction.
   *
   * A missing transaction is a 404 whether or not the caller could have seen it — the answer to
   * "does deal 812 exist?" must not depend on who is asking, or the error code becomes a way to
   * enumerate other people's deals.
   */
  async assertTransaction(user: { id?: number; name?: string | null; role?: string | null } | null, transactionId: number): Promise<void> {
    const txn = await this.prisma.transactions.findFirst({
      where: { id: transactionId, deleted_at: null },
      select: { id: true, agent: true },
    });
    if (!txn) {
      throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${transactionId}.` });
    }
    if (!user || !isAgent(user)) return;

    const name = user.name ?? '';
    // An unassigned deal has no agent to be, so team rows on it grant nothing.
    const allowed =
      txn.agent === name ||
      (!!txn.agent && (await this.prisma.team_members.findFirst({ where: { transaction_id: txn.id, name } })) !== null);

    if (!allowed) {
      throw new ForbiddenException({ message: 'You do not have access to this transaction.' });
    }
  }

  /**
   * Throw unless this person may work this lead.
   *
   * The same rule the lead list uses: an agent reaches a lead they own or one assigned to them, and
   * both of those people can work it together — an assignment is how a lead is handed over. The
   * brokerage is not scoped.
   *
   * This exists because the lead's own endpoints applied that rule and everything hanging off it did
   * not: notes, tasks, showings, calls and email all took a lead id and trusted it, so an agent could
   * log a call against a colleague's lead, or read the number back, without ever being able to see
   * the lead itself.
   */
  async assertLead(user: { id?: number; name?: string | null; role?: string | null } | null, leadId: number): Promise<void> {
    const lead = await this.prisma.leads.findFirst({
      where: { id: leadId, deleted_at: null },
      select: { id: true, owner_user_id: true, assigned_to: true },
    });
    /*
     * ONE ANSWER FOR BOTH QUESTIONS. A lead that does not exist and a lead that is somebody else's
     * are indistinguishable from outside — the same 404, the same wording.
     *
     * They used to differ: 404 for missing, 403 for existing-but-forbidden. That turned every
     * activity endpoint into a way to ask "is lead 4,182 real?" and get a truthful answer, one id at
     * a time, from an account with no right to know. `LeadsService.get` already refused to make that
     * distinction — it filters by scope in the query, so a colleague's lead simply is not found —
     * and this is the same rule said the same way, so the two cannot disagree about what a caller
     * may learn.
     *
     * The cost is a slightly less helpful message for the legitimate case where somebody genuinely
     * has lost access to a lead they expected. That is the right trade: the alternative discloses
     * the existence and id range of every lead in the brokerage to everyone who can sign in.
     */
    const notFound = new NotFoundException({ message: 'Lead not found.' });
    if (!lead) throw notFound;
    if (!user) return;

    // No role is exempt. A manager cannot read an agent's book, and an agent cannot read another's
    // until it is assigned to them. The administrator sees the brokerage's leads because the
    // brokerage owns them, and unattributed intake so that it lands somewhere.
    const id = user.id ?? -1;
    const mine = lead.owner_user_id === id || lead.assigned_to === id;
    const unattributedIntake = lead.owner_user_id === null && isSuperAdmin(user);
    if (!mine && !unattributedIntake) throw notFound;
  }

  /**
   * WHY ONLY NOTES CARRY AN AUTHOR RULE.
   *
   * All five kinds of lead activity — notes, tasks, showings, calls and messages — record who
   * created them. Only notes restrict who may change them, and the distinction is about what each
   * record IS rather than about being consistent:
   *
   *   NOTES are testimony. "Client seemed hesitant about the price" is one person's reading of a
   *     conversation, published under their name. Another agent rewriting it does not correct a
   *     record, they put words in somebody's mouth. Author-only to edit; author or administrator to
   *     delete.
   *
   *   TASKS and SHOWINGS are shared work. Whoever is working the lead needs to complete, reschedule
   *     or drop them, whoever set them up — that is the point of handing a lead over. Restricting
   *     them to their creator would break the collaboration an assignment exists to enable.
   *
   *   CALLS and MESSAGES are shared FACTS: a conversation happened, at a time, with an outcome.
   *     Anyone on the lead may correct or remove one. The protection they need is different — not
   *     "who may delete this" but "the deletion must not be silent" — because under CASL a call log
   *     is evidence of contact. Both therefore write what was deleted, and its author, into the
   *     audit trail. See `removeCall` and `removeMessage`.
   *
   * Applying the author rule to all five would have been the tidier-looking change and the wrong
   * one; the useful question is what each record is for.
   */

  /**
   * Throw unless this person may change a note somebody else wrote.
   *
   * A note is a record of what a particular person observed, signed with their name and shown with
   * it. Anyone who could reach the lead could previously edit or delete anyone else's — so an
   * assignee could rewrite the administrator's observation, under the administrator's name, and the
   * audit trail recorded that a note changed without keeping what it had said.
   *
   * The rule splits editing from deleting, because they are different acts:
   *
   *   EDIT   — the author only. Rewriting another person's words while their name stays on them is
   *            misattribution, and no rank makes that right.
   *   DELETE — the author, or an administrator. Removing a note is moderation, which is a real need
   *            (an address posted in the wrong place, something written about the wrong lead), and
   *            it leaves the record honest rather than altered.
   *
   * `user_id` is null on notes written before it was recorded. Those fall back to matching on the
   * author's name, which is what the screen has always displayed.
   */
  assertNoteAuthor(
    user: { id?: number; name?: string | null; role?: string | null } | null,
    note: { user_id: number | null; created_by: string | null },
    action: 'edit' | 'delete',
  ): void {
    if (!user) return;
    const byId = note.user_id !== null && note.user_id === (user.id ?? -1);
    const byName = note.user_id === null && !!note.created_by && note.created_by === (user.name ?? '');
    if (byId || byName) return;

    if (action === 'delete' && isAdminOrAbove(user)) return;

    throw new ForbiddenException({
      message: action === 'edit'
        ? `This note was written by ${note.created_by ?? 'someone else'}, so it cannot be edited here. Add your own note instead.`
        : `This note was written by ${note.created_by ?? 'someone else'}. Only its author or an administrator can delete it.`,
    });
  }
}
