import {
  PERMANENT_SYNC_REASONS, isPermanentSyncFailure, isUnmanageableEvent,
} from './google.service';

/**
 * The outstanding appointment that could never clear.
 *
 * WHAT HAPPENED. Google manufactures an all-day event from each Contact's birthday. It sits on the
 * primary calendar looking like any other entry, so the pull imported it and stamped the CRM row
 * with its `google_calendar_id`. When that row was later deleted, the push tried to DELETE the
 * birthday from Google and was refused:
 *
 *     HTTP 400  reason=eventTypeRestriction
 *     "Attempt made to modify 'birthday' event"
 *
 * That refusal is permanent for every caller, but it was recorded through the ordinary failure path
 * — which sets `google_sync_error`, and a non-null `google_sync_error` IS the definition of "owed to
 * Google". So the screen said "1 appointment has not reached Google yet" for ever. The sweep did
 * stop at MAX_SYNC_ATTEMPTS, but the Retry button resets that counter, so every press restarted a
 * loop whose only possible outcome was "0 of 1 reached Google".
 *
 * Two guards, tested here:
 *   PREVENTION — never adopt an entry Google will not let us manage.
 *   CURE       — a permanent refusal releases the row instead of queueing another attempt.
 */

describe('entries Google will not let us modify', () => {
  it('recognises a birthday event', () => {
    expect(isUnmanageableEvent({ eventType: 'birthday' })).toBe(true);
  });

  it('recognises a Gmail-derived entry', () => {
    expect(isUnmanageableEvent({ eventType: 'fromGmail' })).toBe(true);
  });

  it('treats an ordinary appointment as ours to manage', () => {
    expect(isUnmanageableEvent({ eventType: 'default' })).toBe(false);
  });

  it('treats a MISSING eventType as ordinary — older payloads omit it', () => {
    // The important default. Reading absence as "special" would stop every legacy event syncing.
    expect(isUnmanageableEvent({})).toBe(false);
    expect(isUnmanageableEvent(undefined)).toBe(false);
    expect(isUnmanageableEvent(null)).toBe(false);
  });

  it('leaves out-of-office, focus time and working location alone', () => {
    /*
     * These are non-default but genuinely user-created, and the API can manage them. Excluding
     * them would silently stop syncing appointments somebody actually booked — a bigger bug than
     * the one being fixed.
     */
    for (const t of ['outOfOffice', 'focusTime', 'workingLocation']) {
      expect(isUnmanageableEvent({ eventType: t })).toBe(false);
    }
  });
});

describe('classifying a Google write failure', () => {
  /** The shape `deleteEvent` throws: status line plus Google's JSON body. */
  const refusal = 'Google Calendar delete failed (HTTP 400). {\n "error": {\n  "errors": [\n   {\n'
    + '    "domain": "calendar",\n    "reason": "eventTypeRestriction",\n'
    + '    "message": "Attempt made to modify \'birthday\' event."\n   }\n  ],\n  "code": 400\n }\n}';

  it('reads eventTypeRestriction out of the real error body', () => {
    expect(isPermanentSyncFailure(refusal)).toBe(true);
  });

  it('keeps a rate limit retryable', () => {
    expect(isPermanentSyncFailure('Google Calendar patch failed (HTTP 403). "reason": "rateLimitExceeded"')).toBe(false);
  });

  it('keeps a server error retryable', () => {
    expect(isPermanentSyncFailure('Google Calendar insert failed (HTTP 503). backendError')).toBe(false);
  });

  it('keeps a network failure retryable', () => {
    expect(isPermanentSyncFailure('fetch failed: ECONNRESET')).toBe(false);
  });

  it('is not fooled by an empty or absent message', () => {
    expect(isPermanentSyncFailure('')).toBe(false);
    expect(isPermanentSyncFailure(undefined as unknown as string)).toBe(false);
  });

  it('every listed reason is treated as permanent', () => {
    for (const reason of PERMANENT_SYNC_REASONS) {
      expect(isPermanentSyncFailure(`Google Calendar delete failed (HTTP 400). "reason": "${reason}"`)).toBe(true);
    }
  });

  it('the reason survives the message truncation', () => {
    /*
     * Guards the 400-character snippet in `deleteEvent`. Google's `reason` sits a little way into
     * the body; at the previous 160 it was inside the window only by luck, and a reordering of the
     * JSON would have turned a permanent refusal back into an endlessly retried one with no test
     * failing.
     */
    const body = JSON.stringify({
      error: {
        errors: [{
          domain: 'calendar', reason: 'eventTypeRestriction',
          message: "Attempt made to modify 'birthday' event.", location: 'eventId', locationType: 'parameter',
        }],
        code: 400,
        message: "Attempt made to modify 'birthday' event.",
      },
    });
    const thrown = `Google Calendar delete failed (HTTP 400). ${body.slice(0, 400)}`;
    expect(isPermanentSyncFailure(thrown)).toBe(true);
  });
});
