import { Injectable, Logger } from '@nestjs/common';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_EVENTS, renderTemplate } from '../email/mail-event-registry';
import type { NotificationChannel } from './notification-preference.service';

/**
 * The CRM's six notification events, in one place.
 *
 * WHY THIS EXISTS RATHER THAN SIX `dispatch(...)` CALLS SCATTERED ACROSS SERVICES. The dispatcher
 * already decides *how* to deliver; what still has to be decided per event is the wording, the link,
 * and — most importantly — the DEDUPE KEY. Spreading those across the leads service, the Meta sync,
 * the task scheduler and the campaign sender would put six different key formats in six files, and
 * the first one written slightly differently is a duplicate notification nobody notices until a user
 * complains about being told twice.
 *
 * So the event sites call a named method here and pass facts. They do not know the category name,
 * the key format, the wording, or which channels exist.
 *
 * NOTHING HERE THROWS. A notification is a side effect of somebody's real work — a lead must not
 * fail to save because a mail server was briefly unreachable. Every method swallows and logs, and
 * the dispatcher itself already reports per-channel outcomes.
 */
@Injectable()
export class CrmEventNotifier {
  private readonly log = new Logger(CrmEventNotifier.name);

  constructor(
    private readonly dispatcher: NotificationDispatcher,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Resolve this CRM notification's email wording from Settings → Templates.
   *
   * WHY IT LIVES HERE AND NOT IN THE DISPATCHER. `NotificationDispatcher` carries Transaction Desk's
   * notifications as well as the CRM's. Teaching it to look up templates would change how Desk
   * renders its email too. Instead this resolves the row and hands the dispatcher an `email`
   * OVERRIDE — a hook it already had for exactly this. Desk call sites pass no override and keep
   * `defaultEmailBody`, so the two paths cannot affect each other: the separation is structural
   * rather than a flag somebody could set wrongly.
   *
   * WHAT IT RETURNS is a fragment spread into the dispatch request:
   *
   *   active template   → `{ email: { subject, html } }` — every supported channel still delivers,
   *                        the email simply carries the brokerage's own wording.
   *   inactive template → `{ channels: ['in_app', 'push'] }` — EMAIL IS DROPPED and the reason is
   *                        logged. In-app and push are not template-driven, so silencing them too
   *                        would take away notice the person never asked to lose.
   *
   * FIRST USE SEEDS THE ROW from the registry, exactly as `MailerService.send` and the lead-facing
   * CRM templates do. An upgraded brokerage therefore reads the same words it read yesterday, from
   * a row it can now edit.
   *
   * A failure here never stops the notification. The in-app record is the one somebody is waiting
   * on; a template lookup that throws falls back to the dispatcher's default body rather than
   * losing the message.
   */
  private async templated(
    eventKey: string,
    vars: Record<string, unknown>,
  ): Promise<{ email?: { subject: string; html: string }; channels?: NotificationChannel[] }> {
    try {
      const meta = MAIL_EVENTS[eventKey];
      if (!meta) return {};

      let row = await this.prisma.email_templates.findUnique({ where: { event_key: eventKey } });
      if (!row) {
        const now = new Date();
        try {
          await this.prisma.email_templates.create({
            data: {
              event_key: eventKey, module: meta.module, name: meta.label,
              subject: meta.default_subject, body_html: meta.default_body_html,
              is_active: true, created_at: now, updated_at: now,
            },
          });
        } catch { /* a concurrent dispatch seeded it; the read below picks it up */ }
        row = await this.prisma.email_templates.findUnique({ where: { event_key: eventKey } });
      }
      if (!row) return {};

      if (!row.is_active) {
        this.log.log(`"${eventKey}" email not sent: the "${row.name}" template is switched off under Settings → Templates.`);
        return { channels: ['in_app', 'push'] };
      }

      const now = new Date();
      const merged: Record<string, unknown> = {
        current_date: now.toISOString().slice(0, 10),
        current_year: String(now.getFullYear()),
        ...vars,
      };
      return {
        email: {
          subject: renderTemplate(row.subject, merged),
          html: renderTemplate(row.body_html, merged),
        },
      };
    } catch (err) {
      this.log.warn(`Could not resolve the "${eventKey}" template; falling back to the default body: ${(err as Error).message}`);
      return {};
    }
  }

  /** The recipient's own name, for wording that greets them. Absent, the greeting reads plainly. */
  private async userName(userId: number): Promise<string> {
    try {
      const u = await this.prisma.users.findUnique({ where: { id: userId }, select: { name: true } });
      return (u?.name ?? '').trim() || 'there';
    } catch {
      return 'there';
    }
  }

  /** An absolute URL for the template's own link, matching what the dispatcher would have built. */
  private absoluteLink(path: string): string {
    const base = (process.env.FRONTEND_URL ?? '').replace(/\/+$/, '');
    return base ? `${base}${path}` : path;
  }

  /**
   * The lead-detail route.
   *
   * Read from the application's actual routing rather than assumed: `client/src/App.tsx` registers
   * `{ screen: 'lead', paths: ['', ':id'] }`, and `areaPath('crm', ...)` produces `/crm/...` — so a
   * single lead is `/crm/lead/{id}`.
   *
   * The link is a destination, NOT an authorization. Opening it goes through the same guards and
   * `leadScopeWhere` as any other route: a notification cannot be used to reach a lead the recipient
   * could not otherwise open.
   */
  private leadLink(leadId: number): string {
    return `/crm/lead/${leadId}`;
  }

  /**
   * The Campaigns screen, told which campaign to open.
   *
   * NOT `/crm/campaigns/{id}`, which is what this returned and which matches nothing. `App.tsx`
   * registers campaigns as `paths: ['']` — the index alone — whereas leads register `['', ':id']`,
   * which is why the lead notifications worked and these two did not. A single campaign has no URL
   * at all: the detail is a modal opened from the list, so there was no route to point at.
   *
   * `?open=` rather than a new route, because the destination genuinely is the list — the modal is
   * rendered over it. `CampaignsPage` reads this parameter and opens that campaign once the rows
   * have loaded, so the notification lands on the campaign it is about rather than on a page the
   * reader then has to search.
   *
   * Still a destination and not an authorization: opening it goes through the same guards and
   * `ownerScope` as any other route, so a link cannot reach a campaign the recipient could not
   * otherwise open.
   */
  private campaignLink(campaignId: number): string {
    return `/crm/campaigns?open=${campaignId}`;
  }

  /** A lead's display name, for wording that reads like a sentence. */
  private nameOf(lead: { first_name?: string | null; last_name?: string | null; email?: string | null }): string {
    const full = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
    return full || (lead.email ?? '').trim() || 'A new lead';
  }

  private async send(request: Parameters<NotificationDispatcher['dispatch']>[0]): Promise<void> {
    try {
      await this.dispatcher.dispatch(request);
    } catch (err) {
      // Never reaches the caller. The business operation has already succeeded.
      this.log.warn(`Could not dispatch "${request.category}" to user #${request.userId}: ${(err as Error).message}`);
    }
  }

  // ========================================================================== 1. new lead

  /**
   * A lead was created and saved.
   *
   * `actorUserId` is whoever did it. Somebody typing a lead in for themselves is NOT notified —
   * they are looking at the thing they just created, and a notification about it is noise. A lead
   * created *for* somebody else still notifies that person.
   *
   * Must be called only AFTER the row is committed. Notifying inside the transaction would announce
   * a lead that a later rollback erases.
   */
  async leadCreated(lead: {
    id: number; first_name?: string | null; last_name?: string | null; email?: string | null; source?: string | null;
  }, recipientUserId: number | null | undefined, actorUserId: number | null | undefined): Promise<void> {
    if (!recipientUserId) return;
    if (recipientUserId === actorUserId) return;   // you made it; you know

    const tpl = await this.templated('crm.lead_new', {
      user_name: await this.userName(recipientUserId),
      lead_name: this.nameOf(lead),
      // Carries its own leading " from " so the sentence reads correctly with no source recorded.
      lead_source: lead.source ? ` from ${lead.source}` : '',
      open_link: this.absoluteLink(this.leadLink(lead.id)),
    });

    await this.send({
      ...tpl,
      category: 'lead_new',
      userId: recipientUserId,
      title: 'New lead',
      body: `${this.nameOf(lead)} has been added to your leads${lead.source ? ` from ${lead.source}` : ''}.`,
      link: this.leadLink(lead.id),
      // One notification per lead per person, whatever re-runs an import or a retry performs.
      dedupeKey: `lead-created:${lead.id}:${recipientUserId}`,
    });
  }

  // ========================================================================== 2. assignment

  /**
   * A lead was assigned or transferred to somebody.
   *
   * The caller is responsible for only calling this when the effective assignee CHANGED — saving a
   * lead without touching `assigned_to` must not re-announce it. That check lives at the call site
   * because only it knows the previous value; the dedupe key below is the second line of defence,
   * not the first.
   *
   * The PREVIOUS assignee is deliberately not notified. "This is no longer yours" is a different
   * message, and inventing it here would send people a notification nobody asked for.
   */
  async leadAssigned(lead: {
    id: number; first_name?: string | null; last_name?: string | null; email?: string | null;
  }, assigneeUserId: number | null | undefined, actorUserId: number | null | undefined, actorName?: string | null): Promise<void> {
    if (!assigneeUserId) return;
    if (assigneeUserId === actorUserId) return;    // you assigned it to yourself

    const tpl = await this.templated('crm.lead_assigned', {
      user_name: await this.userName(assigneeUserId),
      lead_name: this.nameOf(lead),
      // Carries its own leading " by " so the sentence reads correctly with no actor recorded.
      actor_name: actorName ? ` by ${actorName}` : '',
      open_link: this.absoluteLink(this.leadLink(lead.id)),
    });

    await this.send({
      ...tpl,
      category: 'lead_assigned',
      userId: assigneeUserId,
      title: 'New lead assigned',
      body: `${this.nameOf(lead)} has been assigned to you${actorName ? ` by ${actorName}` : ''}.`,
      link: this.leadLink(lead.id),
      /*
       * Keyed on the lead, the recipient AND the assignee, so:
       *   - re-saving with the same assignee cannot notify twice (same key), and
       *   - assigning away and back again CAN notify again (the key differs in between only if the
       *     assignee differs — which is why the call site must also check that it changed).
       */
      dedupeKey: `lead-assigned:${lead.id}:${assigneeUserId}`,
    });
  }

  // ========================================================================== 3. Meta lead

  /**
   * A genuinely new lead arrived from a Meta lead form.
   *
   * `metaLeadId` is Meta's own identifier for the submission, and it is what makes this idempotent
   * ACROSS INTAKE MECHANISMS. The same submission can reach this application twice — once from the
   * scheduled poll and once from the webhook — and those two paths have no knowledge of each other.
   * Keying on Meta's id rather than on our row id or on a timestamp means whichever arrives second
   * is dropped by the dispatcher, deterministically, with no dependence on ordering or timing.
   *
   * Called only after the lead is persisted and deduplicated; a submission that matched an existing
   * lead is not a new lead and produces nothing.
   */
  async metaLeadArrived(lead: {
    id: number; first_name?: string | null; last_name?: string | null; email?: string | null;
  }, recipientUserId: number | null | undefined, metaLeadId: string, formName?: string | null): Promise<void> {
    if (!recipientUserId || !metaLeadId) return;

    const tpl = await this.templated('crm.meta_lead_received', {
      user_name: await this.userName(recipientUserId),
      lead_name: this.nameOf(lead),
      form_name: formName ? `"${formName}"` : 'a Facebook lead form',
      open_link: this.absoluteLink(this.leadLink(lead.id)),
    });

    await this.send({
      ...tpl,
      category: 'lead_meta',
      userId: recipientUserId,
      title: 'New Facebook lead',
      body: `${this.nameOf(lead)} submitted${formName ? ` "${formName}"` : ' a Facebook lead form'}.`,
      link: this.leadLink(lead.id),
      dedupeKey: `meta-lead:${metaLeadId}:${recipientUserId}`,
    });
  }

  // ========================================================================== 4. task due

  /**
   * A follow-up on a lead has reached its due date.
   *
   * `occurrence` distinguishes separate valid firings for the same task — a date string, so a task
   * that legitimately becomes due again on another day notifies again, while the scheduler running
   * twice in one day does not.
   */
  async leadTaskDue(task: {
    id: number; title?: string | null; due_at?: Date | null;
  }, lead: {
    id: number; first_name?: string | null; last_name?: string | null; email?: string | null;
  }, recipientUserId: number | null | undefined, occurrence: string): Promise<void> {
    if (!recipientUserId) return;

    const when = task.due_at ? task.due_at.toISOString().slice(0, 10) : '';
    const tpl = await this.templated('crm.lead_task_due', {
      user_name: await this.userName(recipientUserId),
      task_title: task.title?.trim() || 'A follow-up',
      lead_name: this.nameOf(lead),
      due_date: when || 'today',
      open_link: this.absoluteLink(this.leadLink(lead.id)),
    });

    await this.send({
      ...tpl,
      category: 'lead_task_due',
      userId: recipientUserId,
      title: 'Follow-up due',
      body: `${task.title?.trim() || 'A follow-up'} on ${this.nameOf(lead)}${when ? ` is due ${when}` : ' is due'}.`,
      link: this.leadLink(lead.id),
      dedupeKey: `lead-task-due:${task.id}:${occurrence}`,
    });
  }

  // ========================================================================== 5/6. campaigns

  /** A campaign finished sending. */
  async campaignCompleted(campaign: {
    id: number; name?: string | null;
  }, ownerUserId: number | null | undefined, summary: { recipients: number; sent: number; failed: number }): Promise<void> {
    if (!ownerUserId) return;

    const failed = summary.failed > 0 ? `, ${summary.failed} could not be delivered` : '';
    const tpl = await this.templated('crm.campaign_completed', {
      user_name: await this.userName(ownerUserId),
      campaign_name: campaign.name ?? 'Your campaign',
      recipients: summary.recipients,
      sent: summary.sent,
      // Carries its own leading clause so the sentence ends cleanly when nothing failed.
      failed,
      open_link: this.absoluteLink(this.campaignLink(campaign.id)),
    });

    await this.send({
      ...tpl,
      category: 'campaign_completed',
      userId: ownerUserId,
      title: 'Campaign finished',
      body: `"${campaign.name ?? 'Your campaign'}" finished: ${summary.sent} of ${summary.recipients} sent${failed}.`,
      link: this.campaignLink(campaign.id),
      dedupeKey: `campaign-completed:${campaign.id}:${ownerUserId}`,
    });
  }

  /**
   * A campaign stopped and will not continue.
   *
   * `terminalState` is part of the key so that two genuinely different terminal outcomes for the
   * same campaign are two notifications, while the same one reported twice is one.
   *
   * NO TECHNICAL DETAIL REACHES THE READER. Stack traces, SMTP responses, provider errors and server
   * paths stay in the log where they are useful; the person is told what happened and where to look.
   * A campaign owner cannot act on "ECONNREFUSED 10.0.0.4:587", and it should not be in their inbox.
   */
  async campaignFailed(campaign: {
    id: number; name?: string | null;
  }, ownerUserId: number | null | undefined, terminalState: string, technicalDetail?: string): Promise<void> {
    if (!ownerUserId) return;

    if (technicalDetail) {
      this.log.error(`Campaign ${campaign.id} failed (${terminalState}): ${technicalDetail}`);
    }

    const tpl = await this.templated('crm.campaign_failed', {
      user_name: await this.userName(ownerUserId),
      campaign_name: campaign.name ?? 'Your campaign',
      open_link: this.absoluteLink(this.campaignLink(campaign.id)),
      // `terminalState` and `technicalDetail` are deliberately NOT offered as variables: they are
      // for the log, and a template author cannot put them in front of a reader by accident.
    });

    await this.send({
      ...tpl,
      category: 'campaign_failed',
      userId: ownerUserId,
      title: 'Campaign could not be completed',
      body: `"${campaign.name ?? 'Your campaign'}" stopped before it finished. Open it to review the details.`,
      link: this.campaignLink(campaign.id),
      dedupeKey: `campaign-failed:${campaign.id}:${terminalState}:${ownerUserId}`,
    });
  }
}
