import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RecruitmentInterviewNotifyService } from './recruitment-interview-notify.service';

/**
 * Reminders before a recruitment interview: one a day ahead, one an hour ahead.
 *
 * ======================================================================================
 * NOTHING IS STORED, AND THAT IS THE DESIGN RATHER THAN A SHORTCUT.
 *
 * The obvious build is a `recruitment_interview_reminders` table: a row per (interview, lead time),
 * created when the interview is booked, deleted and recreated when it moves, deleted when it is
 * cancelled. That table is also where this kind of feature goes wrong, because every one of those
 * deletes is a thing somebody has to remember to do. Miss the one in the cancel path and a reminder
 * fires for an interview that is not happening — a notification that is not merely redundant but
 * false.
 *
 * So there is no table. The sweep reads the interview's CURRENT state each pass and asks whether a
 * reminder is due. Which means:
 *
 *   RESCHEDULING needs no cancellation. The query matches on `scheduled_at`, so an interview moved
 *   to next week stops matching this week's window the instant it is saved. Nothing to delete.
 *
 *   CANCELLING needs no cancellation. The query takes only `status = 'scheduled'`, so an interview
 *   that is cancelled, completed or decided is simply not selected. Nothing to delete.
 *
 *   A DELETED candidate drops out too, via `deleted_at`.
 *
 * The one thing a stateless sweep cannot do by itself is avoid sending twice, and that is handled a
 * layer down: the dedupe key carries the interview's scheduled time, and the unique index on the
 * notification delivery ledger refuses the second attempt. See `recruitment-interview-notify`.
 * ======================================================================================
 *
 * WHY A WINDOW AND NOT AN INSTANT. The sweep runs every ten minutes, so "exactly 60 minutes before"
 * is never true when it looks. Each reminder is due across a window that starts at its lead time and
 * runs back towards the interview, and the window is sized to the tick with room to spare — a tick
 * delayed by a slow pass or a restart still catches it.
 *
 * THE WINDOWS DO NOT OVERLAP. 24 hours and 1 hour are far enough apart that no interview can be due
 * for both in one pass, so an interview booked two hours before it happens gets the 1-hour reminder
 * and never the 24-hour one — which is right: a reminder for a time already past is noise.
 */

/** Minutes before the interview. One a day ahead, one an hour ahead. */
export const LEAD_TIMES_MINUTES = [24 * 60, 60] as const;

/**
 * How wide each window is. The sweep ticks every 10 minutes; 20 gives it a missed tick of slack
 * without ever being wide enough for two lead times to collide.
 */
const WINDOW_MINUTES = 20;

@Injectable()
export class RecruitmentInterviewReminderService {
  private readonly log = new Logger(RecruitmentInterviewReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: RecruitmentInterviewNotifyService,
  ) {}

  /**
   * One pass. Returns how many reminders were delivered, for the log and for the tests.
   *
   * `now` is a parameter so a test can place itself relative to an interview rather than having to
   * create one at a contrived real-world time.
   */
  async run(now: Date = new Date()): Promise<number> {
    let delivered = 0;

    for (const lead of LEAD_TIMES_MINUTES) {
      /*
       * The window: interviews whose start is between `lead` and `lead - WINDOW` minutes away.
       * Expressed as absolute instants so the database does the comparison on an indexed column.
       *
       * ROUNDED OUT TO WHOLE SECONDS, because `scheduled_at` is `Timestamp(0)` and Postgres ROUNDS
       * to that precision rather than truncating — a time saved as 07:58:16.677 comes back as
       * 07:58:17.000, which is 323ms LATER than it was given. A bound carrying milliseconds is
       * therefore being compared against a column that cannot hold them, and a row sitting on the
       * edge falls outside a window it belongs in. Measured, not guessed: an interview created
       * exactly 24 hours ahead matched nothing at all.
       *
       * Widening by less than a second cannot pull in a neighbouring lead time — they are hours
       * apart — so this costs nothing and removes the whole class of edge.
       */
      const floorSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);
      const ceilSecond = (ms: number) => new Date(Math.ceil(ms / 1000) * 1000);
      const from = floorSecond(now.getTime() + (lead - WINDOW_MINUTES) * 60_000);
      const to = ceilSecond(now.getTime() + lead * 60_000);

      /*
       * What still qualifies: booked, due in this window, on a candidate who is still here. Used
       * BOTH to find the batch and to re-check each one at the moment it is dispatched — see below
       * for why the second use is not redundant.
       */
      const stillDue = {
        status: 'scheduled',
        scheduled_at: { gte: from, lte: to },
        // A candidate removed from recruitment has no interview worth reminding anybody about.
        candidate: { deleted_at: null },
      };
      /*
       * ================================================================================================
       * THE CANDIDATE IS FETCHED SEPARATELY, AND THAT IS NOT A STYLE CHOICE.
       *
       * Selecting `candidate` as a nested relation makes Prisma treat it as REQUIRED: it reads the
       * interview rows, then resolves their candidates, and if one has gone in between it raises
       * `Inconsistent query result: Field candidate is required to return data, got null instead`
       * and the whole pass dies — so every other interview due in that window silently loses its
       * reminder because somebody deleted an unrelated candidate at the wrong moment.
       *
       * That window is not theoretical. `recruitment_interviews.candidate` cascades, so deleting a
       * candidate removes their interviews too; the sweep can read an interview row and find its
       * candidate already gone a moment later. It was measured, not reasoned about: running these
       * suites in parallel reproduced the crash three times in ten runs.
       *
       * So the interview carries only `candidate_id`, and the candidate is read in the loop below
       * where a missing one is an ordinary skip. The `where` clause still joins on the candidate to
       * filter deleted ones out — a filter is a join, not a materialised relation, and does not
       * raise.
       * ================================================================================================
       */
      const shape = {
        id: true,
        interviewer_id: true,
        scheduled_at: true,
        candidate_id: true,
      };

      const due = await this.prisma.recruitment_interviews.findMany({ where: stillDue, select: shape });

      for (const snapshot of due) {
        try {
          /*
           * ================================================================================
           * RE-READ BEFORE DISPATCHING, AND THIS IS NOT BELT AND BRACES.
           *
           * The query above takes ONE SNAPSHOT of the whole batch; the loop then dispatches them
           * one at a time, and each dispatch resolves recipients and writes to the notification
           * ledger — work measured in hundreds of milliseconds, per recipient. A batch of twenty
           * therefore spans seconds, and a recruiter cancelling an interview during that span is
           * not a contrived race: it is a Tuesday morning.
           *
           * Without this, the interview cancelled at the start of the pass would still be reminded
           * about at the end of it, using the details captured before it was called off — a
           * notification that is not merely redundant but WRONG, telling two people to attend
           * something that is not happening.
           *
           * Checking the next pass is no answer: by then the window has moved past and the harm is
           * already done. The only moment that matters is the moment of sending.
           *
           * `null` means it was cancelled, moved out of the window, or its candidate removed while
           * this pass was in flight. Nothing is sent, and nothing needs cleaning up.
           * ================================================================================
           */
          const current = await this.prisma.recruitment_interviews.findFirst({
            where: { AND: [{ id: snapshot.id }, stillDue] },
            select: shape,
          });
          if (!current) continue;

          /*
           * Read now rather than joined above, so a candidate removed during this pass is a skipped
           * reminder instead of a failed sweep. `deleted_at` is re-checked here for the same reason
           * the interview is re-read at all: the row may have changed since the batch was chosen.
           */
          const candidate = await this.prisma.recruitment_candidates.findFirst({
            where: { id: current.candidate_id, deleted_at: null },
            select: { id: true, name: true, assigned_recruiter_id: true },
          });
          if (!candidate) continue;

          // Dispatched from what was just read, never from the snapshot — details must be today's.
          delivered += await this.notify.remind(candidate, current, lead);
        } catch (ex) {
          /*
           * One bad interview must not end the pass. The others in this window are due now and
           * will not be due again — the window will have moved past them by the next tick.
           */
          this.log.warn(`Reminder for interview ${snapshot.id} failed: ${(ex as Error).message}`);
        }
      }
    }

    if (delivered) this.log.log(`Recruitment interview reminders delivered: ${delivered}.`);
    return delivered;
  }
}
