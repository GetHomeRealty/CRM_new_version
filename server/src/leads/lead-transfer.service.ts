import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeadAuditService } from './lead-audit.service';
import { isSuperAdmin } from '../core/authz';
import { META_LEAD_SOURCE, brokerageLeadWhere } from './lead.constants';
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

/**
 * Lead Books — the brokerage's own unassigned leads, and handing them to somebody.
 *
 * WHAT IT WORKS ON, and this is the whole rule. Only leads that belong to nobody: no owner, no
 * assignee, not from an agent's own Meta account. An agent's leads — owned or merely assigned to
 * them — are not visible here and cannot be moved through this screen at all.
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
 * HOW A DEPARTING AGENT'S LEADS STILL GET REASSIGNED, since removing the old transfer would
 * otherwise strand them: deactivating somebody returns their brokerage leads to this pool unowned
 * (`OffboardingService.depart`), where they become eligible. Their personal Meta leads stay with
 * them, as they always did. That path is untouched, and it is now the only way leads leave a
 * person's book.
 *
 * `META_LEAD_SOURCE` is the test for "personal", deliberately, rather than `lead_source = 'meta'` —
 * see the comment on that constant. One is what the importer recorded; the other is a label
 * somebody typed.
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
   * THREE CONDITIONS, and each excludes a different thing:
   *
   *   - `owner_user_id IS NULL` — not owned by an agent. A lead in somebody's book is theirs to
   *     work, and this screen does not reach into it.
   *   - `assigned_to IS NULL` — not assigned to an agent either. A lead can be owned by nobody and
   *     still be sitting on a named person's list; taking it from under them would be the same
   *     intrusion by another route.
   *   - not a Meta lead — those are personal by origin and never transferable at all, which was
   *     already the rule.
   *
   * This is the pool an agent's brokerage leads return to when they are deactivated, and the pool
   * unattributed intake arrives in. Handing it out is what Lead Books is for.
   */
  private eligibleWhere(): Prisma.leadsWhereInput {
    return {
      deleted_at: null,
      owner_user_id: null,
      assigned_to: null,
      ...brokerageLeadWhere(),
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
    // Ids are selected first so a capped hand-over takes a definite set rather than whatever an
    // unordered updateMany happens to touch. Oldest first: the longest-waiting enquiry goes first.
    const picked = await this.prisma.leads.findMany({
      where: this.eligibleWhere(),
      select: { id: true },
      orderBy: { id: 'asc' },
      ...(limit ? { take: limit } : {}),
    });

    if (!picked.length) {
      throw new UnprocessableEntityException({
        message: 'There are no unassigned brokerage leads to hand over right now.',
      });
    }

    const now = new Date();
    const moved = await this.prisma.leads.updateMany({
      where: { id: { in: picked.map((p) => p.id) } },
      data: { owner_user_id: toUserId, assigned_to: toUserId, updated_at: now },
    });

    const remaining = await this.prisma.leads.count({ where: this.eligibleWhere() });

    await this.audit.record(
      actor as AuthUserRecord,
      'Brokerage leads assigned',
      `→ ${to.name}`,
      `${moved.count} unassigned brokerage lead${moved.count === 1 ? '' : 's'} handed to ${to.name}. `
      + `${remaining} left in the brokerage pool. `
      + 'Only leads belonging to nobody are eligible — an agent\'s own leads are never moved through this screen.',
    );

    return { moved: moved.count, to: to.name, remaining };
  }

  /**
   * Hand a departing agent's brokerage leads back to the brokerage.
   *
   * Called automatically when an account is deactivated, because "the admin can reassign them
   * later" only works if somebody can still see them — and until they are unowned, nobody can. An
   * unowned lead (`owner_user_id IS NULL`) is exactly what a Super Admin's view of unattributed
   * intake shows, so this is what puts the work back in front of the brokerage.
   *
   * Meta leads are left alone. They are the agent's own, and they stay that way.
   *
   * Not permission-checked: this is a consequence of deactivating somebody, which is already an
   * administrator-only action, rather than an operation anyone invokes directly.
   */
  async returnToBrokerage(userId: number): Promise<{ returned: number; kept: number }> {
    const now = new Date();
    const brokerage = { deleted_at: null, ...brokerageLeadWhere() } as const;

    const returned = await this.prisma.leads.updateMany({
      where: { owner_user_id: userId, ...brokerage },
      data: { owner_user_id: null, updated_at: now },
    });
    // An assignment pointing at somebody who has left is stale whoever owns the lead.
    await this.prisma.leads.updateMany({
      where: { assigned_to: userId, ...brokerage },
      data: { assigned_to: null, updated_at: now },
    });

    const kept = await this.prisma.leads.count({
      where: { owner_user_id: userId, deleted_at: null, source: META_LEAD_SOURCE },
    });
    return { returned: returned.count, kept };
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
