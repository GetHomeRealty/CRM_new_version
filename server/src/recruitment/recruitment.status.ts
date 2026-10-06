/**
 * WHERE A CANDIDATE MAY GO FROM WHERE THEY ARE, and nowhere else.
 *
 * The statuses read like a list, which invites treating them as one — anything to anything, with
 * the screen deciding what to offer. That is how a candidate ends up Active without ever having
 * been approved, and the record then says an account was created by a step that never happened.
 *
 * So the moves are declared, not inferred. Everything in the module asks this one table, and a
 * transition nobody listed is refused with the reasons it could have been allowed.
 */

export const CANDIDATE_STATUSES = [
  'new', 'contacted', 'interview', 'approved', 'onboarding', 'active', 'hold', 'not_selected',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/**
 * `cancelled` IS NOT AN OUTCOME, AND THAT IS WHY IT HAD TO BE ADDED.
 *
 * The other four all describe an interview that HAPPENED: it was completed, and the interviewer
 * concluded approved, hold or not selected. None of them can say "this is not going ahead", so
 * until now there was no way to call an interview off — the only options were to leave it sitting
 * as `scheduled` for ever, or to mark it with an outcome nobody reached.
 *
 * That gap mattered once interviews started sending reminders: an interview nobody could cancel is
 * an interview that keeps reminding two people to attend it. The reminder sweep selects only
 * `scheduled`, so cancelling stops the reminders with nothing to clean up.
 *
 * Added at the end, after the outcomes, so nothing that reads this list positionally changes. No
 * existing status changed meaning and no existing transition was touched.
 */
export const INTERVIEW_STATUSES = [
  'scheduled', 'completed', 'approved', 'hold', 'not_selected', 'cancelled',
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/**
 * THE DECISIONS ONLY AN ADMINISTRATOR MAY MAKE — the ones `recruitment.decide` guards.
 *
 * `approved` is here because it is the brokerage accepting somebody, and `onboarding` and `active`
 * because they follow from it. A recruiter runs everything up to that point and recommends; this is
 * the line they do not cross, and it is listed here so the rule lives beside the moves themselves
 * rather than being re-derived at each call site.
 */
export const DECIDER_ONLY: readonly CandidateStatus[] = ['approved', 'onboarding', 'active'];

/**
 * The permitted moves.
 *
 * `hold` returns to `interview` rather than to `new`: a candidate put on hold has already been met,
 * and sending them back to the start would discard that. `not_selected` is terminal by intent — a
 * reversal is a new application, which is a new record and an honest one, rather than quietly
 * reviving a decision somebody made.
 *
 * `active` has no exits. The account exists; what happens to the person afterwards is a question
 * about that account, and answering it here would mean the recruitment record and the user row
 * could disagree about whether somebody works here.
 */
const MOVES: Record<CandidateStatus, readonly CandidateStatus[]> = {
  new: ['contacted', 'not_selected'],
  contacted: ['interview', 'hold', 'not_selected'],
  interview: ['approved', 'hold', 'not_selected'],
  approved: ['onboarding', 'hold', 'not_selected'],
  onboarding: ['active', 'hold'],
  active: [],
  hold: ['interview', 'contacted', 'not_selected'],
  not_selected: [],
};

export function isCandidateStatus(v: unknown): v is CandidateStatus {
  return typeof v === 'string' && (CANDIDATE_STATUSES as readonly string[]).includes(v);
}

export function isInterviewStatus(v: unknown): v is InterviewStatus {
  return typeof v === 'string' && (INTERVIEW_STATUSES as readonly string[]).includes(v);
}

export function allowedNext(from: CandidateStatus): readonly CandidateStatus[] {
  return MOVES[from];
}

export function canMove(from: CandidateStatus, to: CandidateStatus): boolean {
  return MOVES[from].includes(to);
}

/**
 * Why a move was refused, in words the person who tried it can act on.
 *
 * Naming what IS possible matters more than naming what is not: somebody who tried to approve a
 * candidate still at `contacted` needs to know an interview comes first, not merely that they were
 * refused. A terminal status says so plainly rather than listing an empty set.
 */
export function refusalFor(from: CandidateStatus, to: CandidateStatus): string {
  const next = MOVES[from];
  if (next.length === 0) {
    return `This candidate is ${label(from)}, which is final. Nothing follows it.`;
  }
  return `A candidate who is ${label(from)} cannot become ${label(to)}. `
    + `From here they can be marked: ${next.map(label).join(', ')}.`;
}

export function label(s: CandidateStatus | InterviewStatus): string {
  return s === 'not_selected' ? 'Not Selected' : s.charAt(0).toUpperCase() + s.slice(1);
}
