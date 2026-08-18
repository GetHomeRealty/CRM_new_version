import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaConnectionService } from '../meta/meta-connection.service';
import { LeadTransferService } from '../leads/lead-transfer.service';
import { isSuperAdmin } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

export interface OffboardingEffect {
  key: 'meta' | 'brokerage-leads' | 'personal-leads';
  label: string;
  detail: string;
  /** How many records this will touch, when that is a meaningful thing to say. */
  count: number | null;
}

export interface OffboardingChecklist {
  user: { id: number; name: string; status: string };
  meta: { connected: boolean; forms: number };
  leads: { total: number; personal: number; brokerage: number };
  effects: OffboardingEffect[];
}

/**
 * What happens to somebody's work when their account is switched off, and doing it.
 *
 * THE RULE, which is about who owns a lead rather than about tidiness:
 *
 *   - **Meta leads are personal.** They arrived through the agent's own Meta account, their own
 *     Page, their own lead form, paid for out of their own ad spend. They stay with that agent.
 *     They are never transferred, and deactivation does not move them.
 *   - **Everything else belongs to the brokerage** — admin- and manager-assigned leads, office
 *     walk-ins, brokerage campaigns, reception-taken enquiries. On deactivation these return to
 *     the brokerage automatically, where an administrator can hand them to whoever picks the work
 *     up.
 *   - **Meta is disconnected**, which wipes the stored tokens, releases the agent's lead-form
 *     claims so a successor can take them over, and stops the poller.
 *
 * WHY THIS IS AUTOMATIC RATHER THAN A CHECKLIST SOMEBODY WORKS THROUGH. Lead visibility is per
 * person (docs/LEAD-PRIVACY-POLICY.md), so the moment an account is switched off its book is
 * visible to nobody — not to an administrator, not to a Super Admin, who sees unattributed intake
 * (`owner_user_id IS NULL`) rather than another person's book. "The administrator can reassign it
 * afterwards" is therefore not true unless the leads are made unowned at the same moment. Leaving
 * it as a procedure meant the one step people skip is the one that makes the rest possible.
 *
 * REACTIVATION DOES NOT PUT ANY OF IT BACK, deliberately. The agent's personal leads are still
 * theirs and reappear with them, but Meta is not reconnected: access tokens expire, granted
 * permissions change, Pages get removed, and passwords change. A stored credential from before a
 * departure is not one to trust, so the agent signs in to Meta again and a fresh authorisation is
 * granted. Brokerage leads that were handed to somebody else in the meantime stay handed over —
 * they are being worked.
 */
@Injectable()
export class OffboardingService {
  private readonly log = new Logger(OffboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: MetaConnectionService,
    private readonly transfers: LeadTransferService,
  ) {}

  /** What deactivating this person would do, so it can be shown before it is done. */
  async checklist(actor: AuthUserRecord | null, userId: number): Promise<OffboardingChecklist> {
    this.assertMaySee(actor);

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, name: true, status: true },
    });
    if (!user) throw new NotFoundException({ message: 'That person no longer exists.' });

    const counts = await this.counts(userId);
    return {
      user: { id: user.id, name: user.name, status: user.status ?? 'Active' },
      meta: { connected: counts.connected, forms: counts.forms },
      leads: { total: counts.personal + counts.brokerage, personal: counts.personal, brokerage: counts.brokerage },
      effects: [
        {
          key: 'meta',
          label: 'Their Meta account is disconnected',
          count: counts.forms,
          detail: counts.connected
            ? `The stored access tokens are erased and ${counts.forms} lead form${counts.forms === 1 ? '' : 's'} `
              + 'released, so whoever takes over the advertising can connect them. Polling stops. '
              + 'Reconnecting later needs a fresh Meta sign-in — tokens expire and permissions change.'
            : 'No active Meta connection — nothing to disconnect.',
        },
        {
          key: 'brokerage-leads',
          label: 'Brokerage leads they are working return to the pool',
          count: counts.brokerage,
          detail: counts.brokerage
            ? `${counts.brokerage} brokerage lead${counts.brokerage === 1 ? '' : 's'} lose their assignment and go `
              + 'back to the unassigned pool, where you can hand them to whoever picks the work up. The '
              + 'brokerage owns them throughout — nothing is deleted and nothing changes hands.'
            : 'No brokerage leads assigned to them.',
        },
        {
          key: 'personal-leads',
          label: 'Their own leads stay theirs',
          count: counts.personal,
          /*
           * SAYS PLAINLY THAT THE BROKERAGE DOES NOT INHERIT THEM, because the previous wording
           * described the opposite behaviour and an administrator reading this is deciding whether
           * to press the button. It also says the account can still be switched off regardless,
           * since the commonest question at this point is whether the leads have to be dealt with
           * first. They do not.
           */
          detail: counts.personal
            ? `${counts.personal} lead${counts.personal === 1 ? '' : 's'} belong to them personally. They are NOT `
              + 'transferred to the brokerage and remain private — nobody else can see them, then or later. '
              + 'They do not prevent this account being switched off. If they should be handed over, ask '
              + 'them to export or clear their leads before they go.'
            : 'They own no leads of their own.',
        },
      ],
    };
  }

  /**
   * Do it. Called when an account moves from Active to Inactive.
   *
   * Returns a one-line summary for the audit trail, or null when there was nothing to do.
   *
   * NOTHING HERE MAY PREVENT THE DEACTIVATION. Cutting off access has to stay immediate — an agent
   * who leaves badly is exactly when an administrator cannot be made to wait on a Meta API — so a
   * failure is logged and reported, and the account is still switched off. That is why this runs
   * after the status change rather than before it.
   */
  async depart(userId: number, name: string): Promise<string | null> {
    const parts: string[] = [];

    try {
      const r = await this.connections.disconnect(userId);
      if (r.disconnected) parts.push('Meta disconnected');
    } catch (e) {
      this.log.error(`Could not disconnect Meta for ${name} (#${userId}): ${(e as Error).message}`);
      parts.push('Meta could NOT be disconnected — disconnect it by hand');
    }

    try {
      const { unassigned, keptPrivate } = await this.transfers.returnToBrokerage(userId);
      if (unassigned) parts.push(`${unassigned} assigned lead${unassigned === 1 ? '' : 's'} released back to the brokerage pool`);
      // Said explicitly, because the important half of this operation is what it did NOT do.
      if (keptPrivate) parts.push(`${keptPrivate} private lead${keptPrivate === 1 ? '' : 's'} left with them, still theirs`);
    } catch (e) {
      this.log.error(`Could not release ${name}'s lead assignments (#${userId}): ${(e as Error).message}`);
      parts.push('lead assignments could NOT be released — clear them by hand');
    }

    return parts.length ? parts.join('; ') : null;
  }

  /**
   * Everything that would be left pointing at a user id that no longer resolves.
   *
   * WHY THIS IS NECESSARY AT ALL. `users` has no `deleted_at`, so deletion is permanent — and only
   * five of the forty-seven columns holding a user id have a foreign key. The other forty-two are
   * plain integers, so removing the row leaves them dangling with nothing to complain.
   *
   * What that costs, concretely: a deleted person's calendar becomes unreachable by anybody, because
   * a calendar is private to its owner and its owner no longer exists (B-A3). Their leads are owned
   * by an id that resolves to nobody, and `transfer-ownership` refuses to help because it cannot
   * find the source person. Their mail account and Google connection become orphaned rows that the
   * pollers may still act on.
   *
   * Rather than add cascades to forty-two columns — a migration that silently destroys history if
   * it gets a rule wrong — deletion is refused while anything would be stranded, and the
   * administrator is pointed at deactivation, which is the operation that actually handles a
   * departure properly.
   */
  async orphanRisk(userId: number): Promise<{ label: string; count: number }[]> {
    /*
     * CAMPAIGNS ARE CHECKED, and the reason they were not is worth recording as a correction.
     *
     * This originally skipped them, on the grounds that `campaigns.created_by` is a `varchar`
     * holding a name with no id to match against. That was wrong: `campaigns.created_by_id` exists
     * beside it and is written by the campaigns service on every create. So the guard was reporting
     * "nothing would be stranded" while a person's campaigns would have been — and the comment
     * justifying the gap made it look deliberate.
     *
     * `campaign_templates.user_id` is the same shape, with one wrinkle: a template with a NULL
     * `user_id` is one of the six the application ships with, belonging to everybody rather than to
     * nobody, so only rows naming this user count.
     *
     * EVERY SOFT-DELETED TABLE FILTERS `deleted_at`. Of the eight tables below, four are
     * soft-deleted — calendar_events, leads, invoices, campaign_templates — and the last two did not
     * filter it, so a row the owner had already deleted still blocked the account from being
     * removed. Nothing displays those rows and nothing reads them; counting them meant refusing a
     * deletion to protect records that no longer exist as far as the application is concerned, and
     * the administrator had no way to clear the block because the offending rows were invisible.
     *
     * lead_tasks, mail_accounts, google_connections and campaigns have no `deleted_at` at all, so
     * their absence of a filter is correct rather than the same omission repeated.
     */
    const [calendar, leads, tasks, mail, google, invoices, campaigns, templates] = await Promise.all([
      this.prisma.calendar_events.count({ where: { user_id: userId, deleted_at: null } }),
      this.prisma.leads.count({ where: { OR: [{ owner_user_id: userId }, { assigned_to: userId }], deleted_at: null } }),
      this.prisma.lead_tasks.count({ where: { OR: [{ user_id: userId }, { assigned_to: userId }] } }),
      this.prisma.mail_accounts.count({ where: { user_id: userId } }),
      this.prisma.google_connections.count({ where: { user_id: userId } }),
      this.prisma.invoices.count({ where: { created_by: userId, deleted_at: null } }),
      this.prisma.campaigns.count({ where: { created_by_id: userId } }),
      this.prisma.campaign_templates.count({ where: { user_id: userId, deleted_at: null } }),
    ]);
    return [
      { label: 'calendar appointment', count: calendar },
      { label: 'lead', count: leads },
      { label: 'lead task', count: tasks },
      { label: 'connected mailbox', count: mail },
      { label: 'Google connection', count: google },
      { label: 'invoice', count: invoices },
      { label: 'campaign', count: campaigns },
      { label: 'email template', count: templates },
    ].filter((r) => r.count > 0);
  }

  /**
   * How their book splits, without the Meta side. Used by the delete path, which has to know
   * whether personal leads would be orphaned before it removes the row they belong to.
   */
  async leadCounts(userId: number): Promise<{ personal: number; brokerage: number }> {
    const [personal, brokerage] = await Promise.all([
      this.prisma.leads.count({ where: { owner_user_id: userId, deleted_at: null } }),
      this.prisma.leads.count({ where: { owner_user_id: null, assigned_to: userId, deleted_at: null } }),
    ]);
    return { personal, brokerage };
  }

  /**
   * How a departing person's leads split, under the ownership model rather than the old source one.
   *
   * `personal`  — leads they OWN. Every one of them, however it arrived. These stay theirs.
   * `brokerage` — leads the BROKERAGE owns that are merely ASSIGNED to them. These lose the
   *               assignment and return to the pool.
   *
   * The split used to be `source = 'facebook_meta'` versus everything else, which was the right
   * question when ownership was decided at departure. It is the wrong question now: ownership is
   * decided at intake, so "whose is it?" is already recorded in `owner_user_id` and does not have to
   * be inferred from how the lead arrived.
   */
  private async counts(userId: number): Promise<{ connected: boolean; forms: number; personal: number; brokerage: number }> {
    const [connection, forms, personal, brokerage] = await Promise.all([
      this.prisma.meta_connections.findFirst({ where: { user_id: userId, is_active: true }, select: { id: true } }),
      this.prisma.meta_lead_forms.count({ where: { user_id: userId, is_active: true } }),
      this.prisma.leads.count({ where: { owner_user_id: userId, deleted_at: null } }),
      this.prisma.leads.count({ where: { owner_user_id: null, assigned_to: userId, deleted_at: null } }),
    ]);
    return { connected: connection !== null, forms, personal, brokerage };
  }

  /**
   * The same tier as moving a book, and for the same reason: it reports how many leads somebody
   * holds, which is exactly what `LeadTransferService.books()` reports and is held to Super Admin
   * rather than to a screen permission an administrator could grant themselves.
   */
  private assertMaySee(actor: AuthUserRecord | null): void {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException({
        message: 'Only a Super Admin can review what a departing person still holds.',
      });
    }
  }
}
