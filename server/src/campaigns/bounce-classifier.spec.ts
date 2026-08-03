import { classifyBounce, nextRetryAt, MAX_SOFT_RETRIES, RETRY_BACKOFF_MS } from './bounce-classifier';

/**
 * The two mistakes this can make are not symmetric, and the tests are written around that.
 *
 * Classifying a live mailbox as hard means the brokerage permanently stops emailing a real client
 * and nobody finds out — there is no bounce-back for a message that was never sent. Classifying a
 * dead mailbox as soft costs four retries and then gives up. So: every real permanent rejection
 * must be caught, and everything ambiguous must land on soft or unknown.
 */
describe('bounce classification', () => {
  it('treats a dead mailbox as permanent, whatever wording the server chose', () => {
    const permanent = [
      '550 5.1.1 The email account that you tried to reach does not exist',
      '550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown in local recipient table',
      "551 No such user here",
      '550 Requested action not taken: mailbox unavailable',
      '553 5.1.2 We weren\'t able to find the recipient domain',
      '550 5.4.1 Recipient address rejected: Access denied',
      'Bounced: email domain cannot receive mail',
      '550 Invalid recipient',
      '550 This account has been closed',
    ];
    for (const m of permanent) {
      expect({ m, type: classifyBounce(m).type }).toEqual({ m, type: 'hard' });
    }
  });

  it('treats a temporary refusal as retryable', () => {
    const transient = [
      '452 4.2.2 The email account that you tried to reach is over quota',
      '450 4.2.0 Greylisted, please try again in 300 seconds',
      '421 4.7.0 Try again later, closing connection',
      '451 Temporarily deferred, please retry',
      '452 4.5.3 Too many recipients',
      '421 4.7.28 Our system has detected an unusual rate of unsolicited mail — rate limited',
      '441 Service not available',
    ];
    for (const m of transient) {
      expect({ m, type: classifyBounce(m).type }).toEqual({ m, type: 'soft' });
    }
  });

  /**
   * The case that made classification necessary in the first place. An expired app password
   * fails every recipient in the campaign with a 5xx; reading those as hard bounces would put the
   * sender's entire audience on the suppression list, and nothing in the product removes them in
   * bulk. Our own faults must never touch the address.
   */
  it('never blames the address for a fault at our end', () => {
    const ours = [
      'No active SMTP account is configured',
      '535-5.7.8 Username and Password not accepted. BadCredentials',
      'Invalid login: 535 authentication failed',
      'connect ECONNREFUSED 127.0.0.1:587',
      'getaddrinfo ENOTFOUND smtp.example.com',
      'self signed certificate in certificate chain',
    ];
    for (const m of ours) {
      expect({ m, type: classifyBounce(m).type }).toEqual({ m, type: 'unknown' });
    }
  });

  it('reads a mailbox-full reply as transient even behind a permanent code', () => {
    // Some servers answer 5xx for a full mailbox. The condition is still temporary, and the
    // wording is the more reliable signal.
    expect(classifyBounce('550 5.2.2 Mailbox full').type).toBe('soft');
  });

  it('falls back to the status class when the wording says nothing useful', () => {
    expect(classifyBounce('550 Administrative prohibition').type).toBe('hard');
    expect(classifyBounce('451 Requested action aborted').type).toBe('soft');
    expect(classifyBounce('something went wrong').type).toBe('unknown');
    expect(classifyBounce('').type).toBe('unknown');
    expect(classifyBounce(undefined).type).toBe('unknown');
  });

  it('does not read a status code out of an unrelated number', () => {
    // A message id or a byte count containing "550" must not be mistaken for a rejection.
    expect(classifyBounce('queued as 550ABC12 after 4501 bytes').type).toBe('unknown');
  });

  it('reports the code it decided on, so the results screen can show it', () => {
    expect(classifyBounce('550 5.1.1 user unknown').code).toBe('5.1.1');
    expect(classifyBounce('550 mailbox unavailable').code).toBe('550');
  });
});

describe('soft-bounce retry schedule', () => {
  it('backs off, and gives up rather than retrying for ever', () => {
    const from = new Date('2026-08-02T10:00:00.000Z');
    const gaps = [1, 2, 3, 4].map((n) => nextRetryAt(n, from).getTime() - from.getTime());
    expect(gaps).toEqual(RETRY_BACKOFF_MS);
    expect(MAX_SOFT_RETRIES).toBe(RETRY_BACKOFF_MS.length);
    // Asking beyond the last attempt clamps rather than reading past the end of the table.
    expect(nextRetryAt(99, from).getTime() - from.getTime()).toBe(RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
  });
});
