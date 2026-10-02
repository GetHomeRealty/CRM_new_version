import {
  CANDIDATE_STATUSES, DECIDER_ONLY, allowedNext, canMove, isCandidateStatus, isInterviewStatus,
  refusalFor,
} from './recruitment.status';

/**
 * WHERE A CANDIDATE MAY GO, pinned so a new status cannot quietly become reachable from anywhere.
 *
 * The statuses read like a list, which invites treating them as one. The whole point of declaring
 * the moves is that a candidate cannot arrive at Approved without having been interviewed, or at
 * Active without an account — and a table of permitted moves is only worth having if something
 * fails when it is widened by accident.
 */

describe('the moves a candidate may make', () => {
  it('walks the intended path end to end', () => {
    expect(canMove('new', 'contacted')).toBe(true);
    expect(canMove('contacted', 'interview')).toBe(true);
    expect(canMove('interview', 'approved')).toBe(true);
    expect(canMove('approved', 'onboarding')).toBe(true);
    expect(canMove('onboarding', 'active')).toBe(true);
  });

  it('refuses the jumps that would skip a decision', () => {
    /*
     * Each of these is a step somebody could otherwise take by sending a status the screen did not
     * offer. `new → approved` is the one that matters most: it accepts somebody nobody has met.
     */
    expect(canMove('new', 'approved')).toBe(false);
    expect(canMove('new', 'active')).toBe(false);
    expect(canMove('contacted', 'approved')).toBe(false);
    expect(canMove('interview', 'onboarding')).toBe(false);
    expect(canMove('interview', 'active')).toBe(false);
    expect(canMove('approved', 'active')).toBe(false);
  });

  it('lets an interview end in Hold or Not Selected', () => {
    expect(canMove('interview', 'hold')).toBe(true);
    expect(canMove('interview', 'not_selected')).toBe(true);
  });

  it('brings a held candidate back to where they left off, not to the start', () => {
    // They have already been met. Returning them to `new` would discard that.
    expect(canMove('hold', 'interview')).toBe(true);
    expect(canMove('hold', 'contacted')).toBe(true);
    expect(canMove('hold', 'new')).toBe(false);
  });

  it('treats Not Selected as final', () => {
    /*
     * Terminal by intent. A reversal is a new application — a new record, honestly dated — rather
     * than quietly reviving a decision somebody made about a person.
     */
    expect(allowedNext('not_selected')).toEqual([]);
    for (const s of CANDIDATE_STATUSES) expect(canMove('not_selected', s)).toBe(false);
  });

  it('treats Active as final, because the account now exists', () => {
    expect(allowedNext('active')).toEqual([]);
    for (const s of CANDIDATE_STATUSES) expect(canMove('active', s)).toBe(false);
  });

  it('never allows a candidate to move to themselves through the table', () => {
    for (const s of CANDIDATE_STATUSES) expect(canMove(s, s)).toBe(false);
  });
});

describe('what only an administrator may do', () => {
  it('names exactly the three that amount to accepting somebody', () => {
    expect([...DECIDER_ONLY].sort()).toEqual(['active', 'approved', 'onboarding']);
  });

  it('leaves the recruiter everything up to the decision', () => {
    // The recruiter's whole job: contact, interview, hold, decline. None of it needs the capability.
    for (const s of ['contacted', 'interview', 'hold', 'not_selected'] as const) {
      expect(DECIDER_ONLY.includes(s)).toBe(false);
    }
  });
});

describe('a refusal says what WOULD be possible', () => {
  it('names the moves available instead', () => {
    const msg = refusalFor('contacted', 'approved');
    expect(msg).toContain('cannot become Approved');
    expect(msg).toContain('Interview');
  });

  it('says plainly when nothing follows, rather than listing nothing', () => {
    expect(refusalFor('not_selected', 'interview')).toContain('final');
    expect(refusalFor('active', 'hold')).toContain('final');
  });

  it('writes Not Selected as two words, not a column name', () => {
    expect(refusalFor('new', 'approved')).not.toContain('not_selected');
  });
});

describe('the vocabularies stay separate', () => {
  it('knows its own candidate statuses and nothing else', () => {
    expect(isCandidateStatus('approved')).toBe(true);
    expect(isCandidateStatus('scheduled')).toBe(false);   // that is an interview's
    expect(isCandidateStatus('Approved')).toBe(false);
    expect(isCandidateStatus('')).toBe(false);
    expect(isCandidateStatus(null)).toBe(false);
  });

  it('knows its own interview statuses and nothing else', () => {
    expect(isInterviewStatus('scheduled')).toBe(true);
    expect(isInterviewStatus('completed')).toBe(true);
    // An interview is never "onboarding" or "contacted" — those happen to the person.
    expect(isInterviewStatus('onboarding')).toBe(false);
    expect(isInterviewStatus('contacted')).toBe(false);
  });

  it('shares the three outcome words, which is why they must not share a column', () => {
    for (const w of ['approved', 'hold', 'not_selected']) {
      expect(isCandidateStatus(w)).toBe(true);
      expect(isInterviewStatus(w)).toBe(true);
    }
  });

  it('every status can be reached from somewhere, or it is unreachable by mistake', () => {
    const reachable = new Set(CANDIDATE_STATUSES.flatMap((s) => [...allowedNext(s)]));
    for (const s of CANDIDATE_STATUSES) {
      if (s === 'new') continue;   // where everybody starts
      expect(reachable.has(s)).toBe(true);
    }
  });
});
