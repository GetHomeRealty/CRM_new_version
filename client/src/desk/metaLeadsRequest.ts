/**
 * WHEN THE META SCREEN MAY ASK FOR LEADS, AND WHOSE ANSWER COUNTS.
 *
 * Both decisions were inline in `MetaPage` and neither could be tested there: exercising them meant
 * a mounted component, a Meta connection and a live Graph call for the form list. They are pure,
 * so they are here instead, where a test can state the race directly.
 *
 * THE RACE THEY EXIST TO SETTLE. Returning to `/crm/meta?form=<id>` starts an unfiltered request
 * while the form is still being restored, and a filtered one the moment it is. Both wrote the list,
 * so the LAST TO ARRIVE won — and the filtered one asks for 200 rows and a count where the
 * unfiltered asks for 50, making it the slower of the two. It usually landed last by luck rather
 * than by rule. When it did not, a table of every Meta lead sat under a heading naming one form.
 */

export interface LeadsScope {
  /** The Page is settled — see `pageKnown` at the call site. */
  pageKnown: boolean;
  /** Nothing is waiting on the form list, or it has arrived. */
  formKnown: boolean;
  /** The form id the URL is asking for, if any. */
  wantedForm: string | null;
  /** The form the screen is currently filtered by. */
  currentFilterId: string | null;
  /** The form list has come back for this Page — true even when it came back empty. */
  formsLoaded: boolean;
}

/**
 * May the leads request go out yet?
 *
 * The condition that matters is the third: a form named in the URL that the screen has not yet
 * applied means asking now would ask the WRONG QUESTION, and the answer — every lead on the Page —
 * is one somebody could read and act on before it was replaced.
 *
 * BOUNDED BY `formsLoaded`, deliberately. If the list has come back and the id is not in it, the
 * wait ends and the screen loads unfiltered. Without that bound a stale `?form=` — a form since
 * disconnected or deleted — would hold the list on "Loading leads…" for ever, because nothing
 * clears the parameter any more.
 */
export function shouldFetchLeads(s: LeadsScope): boolean {
  if (!s.pageKnown || !s.formKnown) return false;
  const filterPending = !!s.wantedForm && s.currentFilterId !== s.wantedForm && !s.formsLoaded;
  return !filterPending;
}

/**
 * A ticket per request, so only the newest may write what it found.
 *
 * Aborting the request itself would be tidier, but would have to be threaded through `metaLeads`
 * and every caller. A counter cannot be got wrong by a caller: take a ticket before asking, and on
 * return put the answer away unless the ticket is still current.
 */
export interface Latest {
  /** Take a ticket. Every earlier ticket is now stale. */
  begin(): number;
  /** Is this ticket still the newest? */
  isCurrent(ticket: number): boolean;
}

export function createLatest(): Latest {
  let current = 0;
  return {
    begin() { current += 1; return current; },
    isCurrent(ticket: number) { return ticket === current; },
  };
}
