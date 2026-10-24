/**
 * TEAM-SPLIT CLIENT REVIEW EMAIL — EACH AGENT HAS THEIR OWN SAY, AND ANY "RESTRICT" WINS.
 *
 * Rule chosen by Madhu (2026-10-23): on a deal with several agents, each one picks Send or Restrict
 * for the client review email. The deal is included in the batch only when at least one person
 * asked for it to be sent AND nobody restricted it. One agent cannot send the email over another
 * agent's Restrict.
 *
 * Stored in `activity_tracker`:
 *   - `batch_review_votes` — one entry per person, keyed `user:<id>` for an agent on the deal and
 *     `office` for staff (admin / accounting), each { choice, name, user_id, at }.
 *   - `batch_review_email` — the RESULT of the rule, kept beside the votes so anything that reads
 *     the old deal-level flag (the panel, a future sender) gets the answer, not one person's tick.
 *     Only `withBatchReviewVote` writes it; a normal save carries the stored value through
 *     (`keepStoredBatchReview`), so nobody can tick the deal-level flag past a Restrict.
 *
 * A deal from before this change has the flag and no votes: it keeps reading as it was until the
 * first choice is made, and then an earlier tick is kept as the office's "send" so nothing that was
 * already asked for is lost silently.
 */

export type BatchReviewChoice = 'send' | 'restrict';

export interface BatchReviewVote {
  choice: BatchReviewChoice;
  name: string;
  user_id: number | null;
  at: string;
}

export const OFFICE_VOTE_KEY = 'office';
export const agentVoteKey = (userId: number): string => `user:${userId}`;

const isChoice = (v: unknown): v is BatchReviewChoice => v === 'send' || v === 'restrict';

/** The stored votes, with anything malformed dropped. */
export function batchReviewVotes(tracker: Record<string, unknown>): Record<string, BatchReviewVote> {
  const raw = tracker.batch_review_votes;
  const out: Record<string, BatchReviewVote> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const vote = v as Record<string, unknown>;
    if (!isChoice(vote.choice)) continue;
    out[key] = {
      choice: vote.choice,
      name: typeof vote.name === 'string' ? vote.name : '',
      user_id: typeof vote.user_id === 'number' ? vote.user_id : null,
      at: typeof vote.at === 'string' ? vote.at : '',
    };
  }
  return out;
}

/** The rule itself: included only when somebody asked and nobody restricted. */
export function batchReviewIncluded(tracker: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(tracker, 'batch_review_votes')) return !!tracker.batch_review_email;
  const votes = Object.values(batchReviewVotes(tracker));
  return votes.some((v) => v.choice === 'send') && !votes.some((v) => v.choice === 'restrict');
}

/**
 * The tracker with one person's choice set (or withdrawn, for `null`) and the deal-level flag
 * recomputed from every choice. Does not modify `tracker`.
 */
export function withBatchReviewVote(
  tracker: Record<string, unknown>,
  key: string,
  vote: BatchReviewVote | null,
): Record<string, unknown> {
  const votes = batchReviewVotes(tracker);
  // A deal ticked before per-person choices existed: that tick becomes the office's request.
  if (!Object.prototype.hasOwnProperty.call(tracker, 'batch_review_votes') && tracker.batch_review_email === true && !votes[OFFICE_VOTE_KEY]) {
    votes[OFFICE_VOTE_KEY] = { choice: 'send', name: 'Earlier deal-level tick', user_id: null, at: '' };
  }
  if (vote) votes[key] = vote;
  else delete votes[key];
  const next: Record<string, unknown> = { ...tracker, batch_review_votes: votes };
  next.batch_review_email = batchReviewIncluded(next);
  return next;
}

/**
 * A normal save's tracker with the two batch-review keys put back to what is stored. The votes are
 * changed only through their own endpoint, one person at a time; a whole-form save is somebody's
 * copy of the screen and must not carry a deal-level tick past an agent's Restrict.
 */
export function keepStoredBatchReview(
  stored: Record<string, unknown>,
  sent: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...sent };
  for (const k of ['batch_review_email', 'batch_review_votes'] as const) {
    if (Object.prototype.hasOwnProperty.call(stored, k)) next[k] = stored[k];
    else delete next[k];
  }
  // A deal that never had the key reads as excluded; say so rather than leaving it absent-or-true.
  if (!Object.prototype.hasOwnProperty.call(next, 'batch_review_email')) next.batch_review_email = false;
  return next;
}
