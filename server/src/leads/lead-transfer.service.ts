import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeadAuditService } from './lead-audit.service';
import { isSuperAdmin } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/** A person a brokerage lead may be handed to. Name and role only — never a count. */
export interface LeadBookRecipient {
  user_id: number;
  name: string;
  role: string;
}

/**
 * What Lead Books shows: the size of the brokerage's unassigned pool, and who it can go to.
 *
 * There is deliberately no per-agent breakdown. Reporting how many leads each named person holds
 * is a report on their book, which this screen is not for.
 */
export interface LeadBookPool {
  /** Unassigned brokerage leads available to hand out. */
  available: number;
  recipients: LeadBookRecipient[];
}

/** One lead the confirmation is about to move, named so it can be recognised. */
export interface LeadBookCandidate {
  id: number;
  name: string;
  /** ISO date. The dialog orders by this, so showing it lets a reader check the claim. */
  created_at: string | null;
}

/**
 * What a hand-over of `count` would actually move, for the confirmation to name.
 *
 * `moving` is the leads themselves, in the order they will be taken. `available` is the size of the
 * pool, so the dialog can say "3 of 40" without a second call.
 */
export interface LeadBookPreview {
  moving: LeadBookCandidate[];
  available: number;
}

/**
 * Lead Books — the brokerage's own unassigned leads, and handing them to somebody.
 *
 * WHAT IT WORKS ON, and this is the whole rule. Only leads the BROKERAGE owns and nobody is
 * working: `owner_user_id IS NULL` and `assigned_to IS NULL`. A lead an agent owns is theirs, and is
 * neither visible here nor movable through this screen — whatever its source, and whoever asks.
 *
 * WHAT IT USED TO BE, because the difference matters when reading the history. This was "move
 * person A's whole book to person B", and it listed every person in the brokerage beside a count of
 * the leads they held. Both halves were ruled out by the business on 2026-08-02:
 *
 *   - reaching into a working agent's book is not something this screen may do, and
 *   - showing an administrator how many leads each named agent holds is a report on that agent,
 *     which Lead Books is not for.
 *
 * So there is no "from" any more. Eligible leads have no holder by definition — that is what makes
 * them the brokerage's to hand out — and the only figures returned are the size of that pool and a
 * list of names to give it to.
 *
 * HOW A DEPARTING PERSON'S WORK GETS PICKED UP. Deactivating somebody clears the ASSIGNMENTS
 * pointing at them (`OffboardingService.depart` → `returnToBrokerage`), so the brokerage leads they
 * were working become unassigned and appear here for someone else to take on. Their OWN leads are
 * not touched, do not appear here, and are never inherited by the brokerage — see
 * `returnToBrokerage`, which used to do exactly that and no longer does.
 *
 * Nothing leaves a person's book through this screen. It never did in the current design, and after
 * the departure change there is no path in the application that does.
 *
 * Nothing here returns lead content: a count, and how many are left. Every hand-over is written to
 * the audit trail with the recipient's name and the number moved.
 */
@Injectable()
export class LeadTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: LeadAuditService,
  ) {}

  /**
   * Leads nobody holds — the brokerage's own pool — and the people they may be handed to.
   *
   * DELIBERATELY NO PER-AGENT FIGURES. This used to return, for every person in the brokerage, how
   * many leads they owned and how many of those were transferable. That is a report on individual
   * agents' books, which the business ruled out on 2026-08-02: Lead Books manages the brokerage's
   * own leads, and shows nothing about anybody's personal one. An administrator cannot learn from
   * this screen how many leads any named agent holds.
   *
   * The people are listed by name and role only, because a lead has to be handed TO somebody and
   * the screen needs a list to choose from — the same list the lead form's assignee picker already
   * shows.
   */
  async books(actor: AuthUserRecord | null): Promise<LeadBookPool> {
    this.assertMayTransfer(actor);
    const [available, recipients] = await Promise.all([
      this.prisma.leads.count({ where: this.eligibleWhere() }),
      this.prisma.users.findMany({
        where: { status: 'Active' },
        select: { id: true, name: true, role: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      available,
      recipients: recipients.map((u) => ({ user_id: u.id, name: u.name, role: u.role ?? 'agent' })),
    };
  }

  /**
   * What Lead Books is allowed to touch: brokerage leads that nobody holds.
   *
   * TWO CONDITIONS, and each excludes a different thing:
   *
   *   - `owner_user_id IS NULL` — the BROKERAGE owns it. A lead in somebody's own book is theirs to
   *     work, and this screen does not reach into it.
   *   - `assigned_to IS NULL` — and nobody is working it. A brokerage lead can be sitting on a named
   *     person's list; taking it from under them would be the same intrusion by another route.
   *
   * THE META EXCLUSION HAS GONE, and its removal is a correction rather than a loosening.
   * `brokerageLeadWhere()` — "not `source = 'facebook_meta'`" — was here to keep an agent's personal
   * Meta leads out of the pool. It is now redundant for that, because a personal Meta lead is OWNED
   * by its agent and the first condition already excludes it.
   *
   * Worse than redundant, it had become wrong. A Page connected by brokerage staff now produces
   * brokerage-owned Meta leads (`ownerAtIntake`), and when the person triaging them leaves, their
   * assignment is cleared and the lead lands here unowned and unassigned — the definition of the
   * pool. The old predicate would have filtered it straight back out, stranding a lead the brokerage
   * paid for where nothing could ever hand it on.
   *
   * Ownership decides this, not the source column. That is the same correction made everywhere else
   * in this module: `source` records HOW a lead arrived, `owner_user_id` records WHOSE it is.
   *
   * This is the pool a departing person's brokerage leads return to, and the pool unattributed
   * intake arrives in. Handing it out is what Lead Books is for.
   */
  private eligibleWhere(): Prisma.leadsWhereInput {
    return {
      deleted_at: null,
      owner_user_id: null,
      assigned_to: null,
    };
  }

  /**
   * OLDEST FIRST, MEANING OLDEST - and this is a correction, not a restatement.
   *
   * The selection ordered by `id: 'asc'` while the confirmation promised "Oldest first, so the
   * longest-waiting enquiry goes over first". Those are not the same sort. Ids are assigned on
   * insert, and this table's ids do not run in creation order: on the development database 220 pairs
   * of live leads have the LOWER id and the LATER `created_at`. A capped hand-over therefore took a
   * set that was not the longest-waiting, while the dialog said it was.
   *
   * `created_at` is the field the promise is about. `id` follows it only as a tie-break, so two
   * leads recorded in the same instant still come out in a fixed order and a capped hand-over is
   * repeatable rather than left to whatever the planner returns.
   */
  private eligibleOrder(): Prisma.leadsOrderByWithRelationInput[] {
    return [{ created_at: 'asc' }, { id: 'asc' }];
  }

  /**
   * THE ONE PLACE THAT DECIDES WHICH LEADS MOVE.
   *
   * Both the preview and the hand-over call this, because a confirmation that names its leads is
   * worth nothing if it is a second implementation of the choice - the two would agree until the day
   * they did not, and the day they did not is the day somebody relies on the dialog.
   */
  private async pick(limit?: number): Promise<{ id: number; name: string | null; created_at: Date | null }[]> {
    return this.prisma.leads.findMany({
      where: this.eligibleWhere(),
      select: { id: true, name: true, created_at: true },
      orderBy: this.eligibleOrder(),
      ...(limit ? { take: limit } : {}),
    });
  }

  /**
   * The leads a hand-over of `count` would move, named.
   *
   * WHY THIS EXISTS. The confirmation stated a number, a recipient and the ordering rule, and never
   * which lead. The consequence is permanent - nothing in the application moves an assigned lead
   * back to the pool - so the one fact needed to judge the risk was the one fact withheld, and the
   * system already knew it, because that is how it chooses. On the brokerage that reported this the
   * pool held four leads, of which the oldest was a real client and the other three were test
   * records: handing over "just one" moved the real client, and the dialog gave no way to see it.
   *
   * IT RETURNS LEAD CONTENT, WHICH THIS SERVICE OTHERWISE DOES NOT, and the exception is narrow on
   * purpose. Every lead it can name is unowned and unassigned by definition of `eligibleWhere` -
   * that is what makes it the brokerage's to hand out - so no agent's book is exposed by it. The
   * rule this screen was built around is that an administrator learns nothing here about what any
   * NAMED PERSON holds, and naming leads that belong to nobody does not touch that. Super Admin
   * only, like everything else on this screen.
   */
  async preview(actor: AuthUserRecord | null, count?: number): Promise<LeadBookPreview> {
    this.assertMayTransfer(actor);
    const limit = Number.isFinite(count) && (count as number) > 0 ? Math.floor(count as number) : undefined;
    const [moving, available] = await Promise.all([
      this.pick(limit),
      this.prisma.leads.count({ where: this.eligibleWhere() }),
    ]);
    return {
      moving: moving.map((l) => ({
        id: l.id,
        name: l.name ?? `Lead #${l.id}`,
        created_at: l.created_at ? l.created_at.toISOString() : null,
      })),
      available,
    };
  }

  /**
   * Hand brokerage leads out of the pool to one person.
   *
   * WHAT CHANGED, AND WHY IT IS NOT THE SAME OPERATION. This was "move person A's book to person
   * B", which necessarily reached into a working agent's leads. The business ruled on 2026-08-02
   * that Lead Books works only with the brokerage's own leads: an agent's own or assigned leads are
   * not available here and cannot be moved through it. There is therefore no "from" any more —
   * eligible leads belong to nobody by definition, which is what makes them the brokerage's to
   * hand out.
   *
   * A departing agent's brokerage leads still reach this pool: deactivating them returns those
   * leads unowned (`OffboardingService.depart`), and they appear here for reassignment. That path
   * is untouched and is now the only way a person's leads leave their book.
   *
   * `count` caps how many are handed over, so a pool of four hundred can be shared out rather than
   * given to one person in a single press. Absent means all of them.
   */
  async transfer(actor: AuthUserRecord | null, toUserId: number, count?: number): Promise<{ moved: number; to: string; remaining: number }> {
    this.assertMayTransfer(actor);

    /*
     * THE RECIPIENT IS VALIDATED BEFORE IT REACHES THE DATABASE.
     *
     * The controller reads this from the request body with `Number(body?.to_user_id)`, and that
     * yields `NaN` for a missing field and for anything non-numeric — `Number(undefined)` and
     * `Number('abc')` both do. `NaN` is not a value Prisma can compile into a `where`, so it threw a
     * validation error out of `findUnique` and the request ended as a 500 with a stack in the log.
     * A malformed request body is the caller's mistake and must read as one.
     *
     * The test is for a POSITIVE integer, not merely a number. `Number(null)` is `0`, which IS an
     * integer and reached the database as a lookup for user zero — answering "that person no longer
     * exists" to what is actually a missing field. Zero and negatives are malformed input, so they
     * are refused here; a well-formed id that simply matches nobody is still the 404 below, because
     * those are genuinely different answers.
     *
     * Checked in the service rather than the controller so it holds for every caller, not only the
     * HTTP one.
     */
    if (!Number.isInteger(toUserId) || toUserId <= 0) {
      throw new UnprocessableEntityException({
        message: 'Choose who the leads should go to.',
        errors: { to_user_id: ['A valid recipient is required.'] },
      });
    }

    const to = await this.prisma.users.findUnique({
      where: { id: toUserId }, select: { id: true, name: true, status: true },
    });
    if (!to) throw new NotFoundException({ message: 'That person no longer exists.' });
    if ((to.status ?? 'Active') === 'Inactive') {
      throw new UnprocessableEntityException({
        message: `${to.name}'s account is inactive, so the leads would be invisible again the moment they moved.`,
      });
    }

    const limit = Number.isFinite(count) && (count as number) > 0 ? Math.floor(count as number) : undefined;
    /*
     * Selected first so a capped hand-over takes a definite set rather than whatever an unordered
     * updateMany happens to touch - and selected through `pick`, the SAME call the confirmation
     * used to name these leads. That shared call is the fix for CRM-043: a dialog that names its
     * leads has to be naming the ones that will actually move.
     */
    const picked = await this.pick(limit);

    if (!picked.length) {
      throw new UnprocessableEntityException({
        message: 'There are no unassigned brokerage leads to hand over right now.',
      });
    }

    const now = new Date();
    /*
     * ASSIGNS. DOES NOT TRANSFER OWNERSHIP — and that single-field difference is the model.
     *
     * This used to set `owner_user_id: toUserId` as well, which CONVERTED a brokerage lead into that
     * agent's private one. The brokerage then lost sight of a lead it had generated and paid for:
     * the moment it was handed out it left every brokerage-scoped view, and the only way back was
     * for the agent to leave. Ownership and assignment are separate fields precisely so they can
     * say different things, and collapsing them threw away the distinction.
     *
     * Leaving `owner_user_id` NULL keeps the lead the brokerage's while the assignee works it:
     *
     *   brokerage roles   keep seeing it            (`owner_user_id IS NULL` is in their scope)
     *   the assignee      gains it                  (`assigned_to = them`)
     *   every other agent sees nothing              (neither clause matches)
     *
     * Reassigning later moves it from one agent to the next with the brokerage's visibility intact
     * throughout, and no second record is created.
     *
     * It also stays OUT of `eligibleWhere`, so it cannot be handed out twice — that predicate
     * requires `assigned_to IS NULL`, which this has just filled in.
     */
    const moved = await this.prisma.leads.updateMany({
      where: { id: { in: picked.map((p) => p.id) } },
      data: { assigned_to: toUserId, updated_at: now },
    });

    const remaining = await this.prisma.leads.count({ where: this.eligibleWhere() });

    await this.audit.record(
      actor as AuthUserRecord,
      'Brokerage leads assigned',
      `→ ${to.name}`,
      `${moved.count} unassigned brokerage lead${moved.count === 1 ? '' : 's'} handed to ${to.name}. `
      // WHICH ones, not just how many. There is no control anywhere that moves an assigned lead
      // back to the pool, so this entry is the only record of what a hand-over actually did.
      + `Leads: ${picked.map((p) => `#${p.id} ${p.name ?? ''}`.trim()).join(', ')}. `
      + `${remaining} left in the brokerage pool. `
      + 'The brokerage remains the owner — these were assigned, not given away, so they stay visible '
      + 'to the brokerage and can be reassigned. '
      + 'Only leads belonging to nobody are eligible — an agent\'s own leads are never moved through this screen.',
    );

    return { moved: moved.count, to: to.name, remaining };
  }

  /**
   * Release a departing person's ASSIGNMENTS. Ownership is never touched.
   *
   * ================================================================================================
   * WHAT THIS USED TO DO, AND WHY IT WAS WRONG.
   *
   * It ran `owner_user_id = NULL` over every non-Meta lead the leaver OWNED, which silently
   * converted their private book into brokerage leads. The reasoning at the time was sound given the
   * model at the time — every lead was owned by whoever made it, so an agent's book contained the
   * brokerage's walk-ins and campaign enquiries too, and unless those were unowned at the moment of
   * departure nobody could ever see them again.
   *
   * That reasoning no longer applies, because intake now decides ownership up front: a lead the
   * brokerage generated is ALREADY `owner_user_id IS NULL` (see `ownerAtIntake`), whoever is working
   * it. There is nothing left to convert — and converting anyway would take the one category that is
   * genuinely private, an agent's own clients, and publish it to the brokerage on the day they left.
   * ================================================================================================
   *
   * SO THIS CLEARS ONE COLUMN AND ONLY ONE. An assignment pointing at somebody who has gone is a
   * stale pointer:
   *
   *   a BROKERAGE lead assigned to them  → returns to the pool, unassigned, still the brokerage's,
   *                                        still in the CRM, ready to be handed to whoever takes over
   *   an AGENT'S lead assigned to them   → the owner keeps it; only the extra assignee is dropped
   *   their OWN leads                    → untouched. Still theirs, still private, still invisible
   *                                        to the brokerage
   *
   * Not permission-checked: this is a consequence of deactivating somebody, which is already an
   * administrator-only action, rather than an operation anyone invokes directly.
   */
  async returnToBrokerage(userId: number): Promise<{ unassigned: number; keptPrivate: number }> {
    const now = new Date();

    /*
     * NO `brokerageLeadWhere()` FILTER ANY MORE, and its absence is deliberate.
     *
     * That predicate answered "which of this agent's leads may the brokerage keep?", a question
     * about OWNERSHIP that this method no longer asks. Clearing a stale assignment is safe on every
     * lead including a Meta one: it changes who is working the record, never whose it is.
     */
    const unassigned = await this.prisma.leads.updateMany({
      where: { assigned_to: userId, deleted_at: null },
      data: { assigned_to: null, updated_at: now },
    });

    // Reported so the departure summary can say plainly what stayed with them.
    const keptPrivate = await this.prisma.leads.count({
      where: { owner_user_id: userId, deleted_at: null },
    });
    return { unassigned: unassigned.count, keptPrivate };
  }

  /**
   * Only the top tier, and never quietly.
   *
   * This is the one route by which somebody can reach leads that are not theirs, so it is held to
   * the narrowest role the application has rather than to a screen permission that an administrator
   * could grant around.
   */
  private assertMayTransfer(actor: AuthUserRecord | null): void {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException({
        message: 'Only a Super Admin can move a book of leads, and every transfer is recorded.',
      });
    }
  }
}
