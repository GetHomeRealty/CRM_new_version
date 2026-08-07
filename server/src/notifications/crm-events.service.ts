import { Injectable, Logger } from '@nestjs/common';
import { NotificationDispatcher } from './notification-dispatcher.service';

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

  constructor(private readonly dispatcher: NotificationDispatcher) {}

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

    await this.send({
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

    await this.send({
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

    await this.send({
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
    await this.send({
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
    await this.send({
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

    await this.send({
      category: 'campaign_failed',
      userId: ownerUserId,
      title: 'Campaign could not be completed',
      body: `"${campaign.name ?? 'Your campaign'}" stopped before it finished. Open it to review the details.`,
      link: this.campaignLink(campaign.id),
      dedupeKey: `campaign-failed:${campaign.id}:${terminalState}:${ownerUserId}`,
    });
  }
}
