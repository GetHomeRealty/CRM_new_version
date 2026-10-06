import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { PermissionService } from '../auth/permission.service';
import { isAgent } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * WHO IS TOLD WHEN AN INTERVIEW MOVES, AND WHEN IT IS NEARLY HERE.
 *
 * Two people care about a recruitment interview: the recruiter who is carrying the candidate, and
 * whoever is sitting on the panel. They care for different reasons — one arranged it, the other
 * has to turn up — and they are notified by the same rules here so that neither depends on
 * somebody remembering to pass a message on.
 *
 * ======================================================================================
 * "AUTHORIZED INTERVIEWER" IS CHECKED, NOT ASSUMED.
 *
 * `recruitment_interviews.interviewer_id` is any user id. Nothing stops an administrator naming
 * somebody who cannot open Recruitment at all — an agent, say, who is on the panel informally.
 * Notifying them would send a person a link to a screen that refuses them, which is worse than
 * silence: it tells them a candidate exists, names them, and then shuts the door.
 *
 * So an interviewer is notified only if they could open the thing the notification links to. That
 * is two questions, and both are asked, because they fail differently:
 *
 *   1. `isAgent` — mirroring `RecruitmentNoAgentsGuard`. Agents are refused by that guard whatever
 *      the permission matrix says, precisely because the compiled fallback would otherwise grant
 *      them `recruitment: 'view'`. A check here that consulted only the matrix would disagree with
 *      the guard in exactly the case the guard exists for.
 *   2. the stored permission for the `recruitment` screen.
 *
 * The assigned recruiter is checked the same way, for the same reason — assignment is a column, and
 * a column can hold somebody whose role has since changed.
 * ======================================================================================
 *
 * THE ACTOR IS NOT TOLD WHAT THEY JUST DID. Somebody who moves an interview watches the screen
 * change in front of them; a notification about their own action is noise, and it is the kind of
 * noise that teaches people to ignore the channel. This matches `task_assigned`, which fires only
 * when the assignee is not the person assigning.
 */

/** The brokerage's zone. Every time in a notification is written in it, and says so. */
const ZONE = process.env.TZ || 'America/Toronto';

/**
 * A date and time somebody can act on, with the zone named.
 *
 * THE ZONE IS NOT DECORATION. These go to people who may be reading on a phone in another province,
 * and "2:30" without a zone is a guess. `timeZoneName: 'short'` renders EDT/EST, which also tells
 * the reader which side of the clock change the interview falls on — the one day a year when a bare
 * time is actively wrong.
 */
export function interviewWhen(at: Date | null | undefined): string {
  if (!at) return 'a time not yet set';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: ZONE,
    }).format(at);
  } catch {
    // An unknown TZ must not stop a notification going out; the instant is still correct.
    return at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

export type InterviewChange = 'booked' | 'moved' | 'cancelled';

@Injectable()
export class RecruitmentInterviewNotifyService {
  private readonly log = new Logger(RecruitmentInterviewNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * The people who should hear about this interview, already filtered to those who could open it.
   *
   * Returned as ids so the caller can exclude the actor without a second query.
   */
  async recipients(candidateRecruiterId: number | null, interviewerId: number | null): Promise<number[]> {
    const wanted = [...new Set([candidateRecruiterId, interviewerId].filter((v): v is number => !!v))];
    if (!wanted.length) return [];

    const users = await this.prisma.users.findMany({
      where: { id: { in: wanted }, status: 'Active' },
      select: { id: true, role: true, user_permissions: true },
    });

    return users
      .filter((u) => {
        // An account that cannot sign in has nobody to read the notification.
        const record = { id: u.id, role: u.role } as unknown as AuthUserRecord;
        if (isAgent(record)) return false;
        return this.permissions.can(u.role || 'agent', u.user_permissions ?? [], 'recruitment', 'view');
      })
      .map((u) => u.id);
  }

  /**
   * Tell the recruiter and the interviewer that a booking changed.
   *
   * NEVER THROWS INTO THE CALLER. Booking an interview is the real work; telling people is a
   * consequence of it. A dispatcher failure — a push endpoint gone, a mail server refusing — must
   * not roll back an interview that was correctly recorded, so every failure is logged and
   * swallowed here rather than surfacing as a 500 on a save that actually succeeded.
   */
  async changed(
    candidate: { id: number; name: string; assigned_recruiter_id: number | null },
    interview: { id: number; interviewer_id: number | null; scheduled_at: Date | null },
    change: InterviewChange,
    actor: AuthUserRecord | null,
  ): Promise<void> {
    try {
      const to = (await this.recipients(candidate.assigned_recruiter_id, interview.interviewer_id))
        .filter((id) => id !== (actor?.id ?? -1));
      if (!to.length) return;

      const when = interviewWhen(interview.scheduled_at);
      const by = actor?.name ? ` by ${actor.name}` : '';
      const title = change === 'booked'
        ? `Interview booked: ${candidate.name}`
        : change === 'moved'
          ? `Interview moved: ${candidate.name}`
          : `Interview cancelled: ${candidate.name}`;
      const body = change === 'cancelled'
        ? `The interview with ${candidate.name} that was set for ${when} has been cancelled${by}.`
        : `${candidate.name}'s interview is ${when}${by}.`;

      for (const userId of to) {
        await this.dispatcher.dispatch({
          category: 'recruitment_interview',
          userId,
          title,
          body,
          link: this.link(candidate.id),
          /*
           * NO DEDUPE KEY, DELIBERATELY. Each of these is raised BY something a person did, and the
           * dispatcher's own rule is that such calls are not deduped: two reschedules in a morning
           * are two real events, and a synthesised key would silently merge them. The reminders
           * below are the opposite case and do carry one.
           */
        });
      }
    } catch (ex) {
      this.log.warn(`Interview notification for candidate ${candidate.id} failed: ${(ex as Error).message}`);
    }
  }

  /**
   * The reminder itself. Called by the sweep, once per (interview, lead time).
   *
   * THE DEDUPE KEY CARRIES THE SCHEDULED TIME, and that single detail is what makes rescheduling
   * work without anything needing to be cancelled. The key names the occurrence — this interview,
   * at this time, this far ahead — so moving the interview produces a different key and a genuinely
   * new reminder, while a sweep that runs twice, overlaps itself or restarts mid-pass produces the
   * same key and is dropped by the unique index on the delivery ledger.
   */
  async remind(
    candidate: { id: number; name: string; assigned_recruiter_id: number | null },
    interview: { id: number; interviewer_id: number | null; scheduled_at: Date | null },
    leadMinutes: number,
  ): Promise<number> {
    const to = await this.recipients(candidate.assigned_recruiter_id, interview.interviewer_id);
    if (!to.length || !interview.scheduled_at) return 0;

    const when = interviewWhen(interview.scheduled_at);
    const ahead = leadMinutes >= 60 ? `${Math.round(leadMinutes / 60)} hour${leadMinutes >= 120 ? 's' : ''}` : `${leadMinutes} minutes`;
    const stamp = interview.scheduled_at.toISOString();

    let sent = 0;
    for (const userId of to) {
      const result = await this.dispatcher.dispatch({
        category: 'recruitment_interview_reminder',
        userId,
        title: `Interview in ${ahead}: ${candidate.name}`,
        body: `${candidate.name}'s interview is ${when}.`,
        link: this.link(candidate.id),
        dedupeKey: `recruitment-interview-reminder:${interview.id}:${leadMinutes}:${stamp}`,
      });
      if (result.delivered.length) sent += 1;
    }
    return sent;
  }

  /** Where "open the interview" goes: the candidate, scrolled to their interviews. */
  private link(candidateId: number): string {
    return `/crm/recruitment/${candidateId}?focus=interviews`;
  }
}
