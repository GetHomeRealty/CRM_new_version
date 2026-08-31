import { draftEmailWithAi, type EmailAiConfig } from './ai-provider';

/**
 * The AI draft survives a busy model.
 *
 * WHAT HAPPENED. Gemini answered `503 UNAVAILABLE — "This model is currently experiencing high
 * demand. Spikes in demand are usually temporary. Please try again later."` The request ended
 * there and the agent got that JSON on screen as a red toast. The provider's own advice was to try
 * again; the application did not, and asked the person to do it by hand instead.
 *
 * TWO THINGS ARE UNDER TEST, and the second matters as much as the first: that a transient failure
 * is retried, and that a PERMANENT one still is not. Retrying a bad API key three times would make
 * a misconfiguration slower to diagnose while fixing nothing.
 *
 * `fetch` is stubbed, so nothing here reaches a provider or spends a token.
 */

const cfg: EmailAiConfig = { provider: 'gemini', key: 'test-key', model: 'gemini-1.5-flash' };

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

/** A Gemini-shaped success body, so the caller's parsing runs for real. */
const ok = () => new Response(
  JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"subject":"Hello","html":"<p>Hi</p>"}' }] } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

const busy = (status = 503, headers: Record<string, string> = {}) => new Response(
  JSON.stringify({ error: { code: status, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } }),
  { status, headers },
);

/** The REAL body Gemini returned on this deployment, trimmed. Note: no `Retry-After` header. */
const quotaExhausted = (retryDelay = '44s', quotaId = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier') => new Response(
  JSON.stringify({
    error: {
      code: 429, status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota, please check your plan and billing details.',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue: '20' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
      ],
    },
  }),
  { status: 429 },
);

/** Replaces `fetch` with a scripted sequence and records how many times it was called. */
function scripted(responses: (() => Response)[]) {
  const calls: string[] = [];
  global.fetch = (async (url: unknown) => {
    const i = Math.min(calls.length, responses.length - 1);
    calls.push(String(url));
    return responses[i]();
  }) as typeof fetch;
  return calls;
}

// =================================================================================================

describe('a busy model is retried', () => {
  it('recovers when the second attempt succeeds', async () => {
    const calls = scripted([() => busy(), ok]);

    const text = await draftEmailWithAi(cfg, 'system', 'welcome');

    expect(JSON.parse(text).subject).toBe('Hello');
    expect(calls).toHaveLength(2);   // the 503 did not reach the agent at all
  });

  it('recovers on the third attempt', async () => {
    const calls = scripted([() => busy(), () => busy(), ok]);

    await expect(draftEmailWithAi(cfg, 'system', 'welcome')).resolves.toBeTruthy();
    expect(calls).toHaveLength(3);
  });

  it('gives up after three and reports it as a service problem, not a bad request', async () => {
    scripted([() => busy()]);

    /*
     * A 503 upstream is not the agent's fault, and it used to surface as a 400 — telling them their
     * input was wrong when nothing about it was.
     */
    await expect(draftEmailWithAi(cfg, 'system', 'welcome')).rejects.toMatchObject({ status: 503 });
  });

  it('does not put the provider\'s JSON on the screen', async () => {
    scripted([() => busy()]);

    const err = await draftEmailWithAi(cfg, 'system', 'welcome').catch((e: Error) => e);
    const message = JSON.stringify((err as { response?: unknown }).response ?? (err as Error).message);

    // What made it alarming rather than routine was a paragraph of JSON the agent could not act on.
    expect(message).not.toContain('UNAVAILABLE');
    expect(message).not.toContain('"code"');
    expect(message).toMatch(/busy/i);
    expect(message).toMatch(/try Generate again/i);
  });

  it('retries the other transient statuses too', async () => {
    for (const status of [429, 500, 502, 504]) {
      const calls = scripted([() => busy(status), ok]);
      await expect(draftEmailWithAi(cfg, 'system', 'welcome')).resolves.toBeTruthy();
      expect(calls).toHaveLength(2);
    }
  });

  it('honours Retry-After when the provider sends one', async () => {
    const calls = scripted([() => busy(429, { 'retry-after': '1' }), ok]);

    const started = Date.now();
    await draftEmailWithAi(cfg, 'system', 'welcome');

    expect(calls).toHaveLength(2);
    // Waited roughly the second it asked for, rather than ignoring the header.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});

describe('a permanent failure is NOT retried', () => {
  it('fails immediately on a rejected key', async () => {
    const calls = scripted([() => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 401 })]);

    /*
     * 503, not 400. A rejected key is a SERVER misconfiguration — the agent's request was fine, and
     * calling it a Bad Request points the person who can see the message at the one thing they
     * cannot fix.
     */
    await expect(draftEmailWithAi(cfg, 'system', 'welcome')).rejects.toMatchObject({ status: 503 });
    // One attempt. Three would make a misconfiguration slower to find and fix nothing.
    expect(calls).toHaveLength(1);
  });

  it('keeps the provider detail for a permanent error, which IS diagnosable', async () => {
    scripted([() => new Response(JSON.stringify({ error: { message: 'models/nope is not found' } }), { status: 404 })]);

    const err = await draftEmailWithAi(cfg, 'system', 'welcome').catch((e: Error) => e);
    const message = JSON.stringify((err as { response?: unknown }).response ?? (err as Error).message);

    // A wrong model name is fixed by reading the message, so the snippet stays here.
    expect(message).toContain('404');
    expect(message).toContain('is not found');
  });

  it('never includes the API key in what it reports', async () => {
    scripted([() => new Response('denied', { status: 403 })]);

    const err = await draftEmailWithAi(cfg, 'system', 'welcome').catch((e: Error) => e);
    expect(JSON.stringify(err)).not.toContain(cfg.key);
  });
});

describe('the network being unreachable', () => {
  it('surfaces as a service problem rather than a bad request', async () => {
    global.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch;

    await expect(draftEmailWithAi(cfg, 'system', 'welcome')).rejects.toMatchObject({ status: 503 });
  });
});

describe('a used-up quota is not "busy"', () => {
  it('THE ROOT CAUSE: a per-DAY quota is reported as an allowance problem, not high demand', async () => {
    scripted([quotaExhausted]);

    const err = await draftEmailWithAi(cfg, 'system', 'welcome').catch((e: Error) => e);
    const message = JSON.stringify((err as { response?: unknown }).response ?? (err as Error).message);

    /*
     * The observed failure. Gemini's free tier allows 20 requests per day; once spent, "busy — try
     * again in a moment" sends the agent round a loop that cannot succeed until the quota resets.
     */
    expect(message).toMatch(/allowance|quota/i);
    expect(message).not.toMatch(/busy/i);
    expect(message).toMatch(/will not help|billing/i);
  });

  it('does not waste attempts retrying a daily allowance', async () => {
    const calls = scripted([quotaExhausted]);
    await draftEmailWithAi(cfg, 'system', 'welcome').catch(() => undefined);
    // Retrying cannot succeed, so it is not attempted three times.
    expect(calls).toHaveLength(1);
  });

  it('names the quota so the server log identifies which limit was hit', async () => {
    scripted([quotaExhausted]);
    const err = await draftEmailWithAi(cfg, 'system', 'welcome').catch((e: Error) => e);
    expect(JSON.stringify((err as { response?: unknown }).response)).toContain('PerDay');
  });

  it('a per-MINUTE limit IS retried, using the delay from the body', async () => {
    // Google sends no `Retry-After` header — the wait is a `RetryInfo` entry in `error.details`.
    const calls = scripted([() => quotaExhausted('1s', 'GenerateRequestsPerMinutePerProject'), ok]);

    const started = Date.now();
    await expect(draftEmailWithAi(cfg, 'system', 'welcome')).resolves.toBeTruthy();

    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('stops rather than sleeping through a wait longer than a request should be held', async () => {
    const calls = scripted([() => quotaExhausted('44s', 'GenerateRequestsPerMinutePerProject')]);

    const started = Date.now();
    await draftEmailWithAi(cfg, 'system', 'welcome').catch(() => undefined);

    // Answering honestly in a moment beats holding the request open for 44 seconds.
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('an invalid API key', () => {
  it('says the key was rejected, and does not blame the lead or the message', async () => {
    const calls = scripted([() => new Response(
      JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } }),
      { status: 400 },
    )]);

    const err = await draftEmailWithAi(cfg, 'system', 'welcome').catch((e: Error) => e);
    const message = JSON.stringify((err as { response?: unknown }).response ?? (err as Error).message);

    // Google returns 400 for a bad key, so status alone is not enough to classify it.
    expect(message).toMatch(/API key/i);
    expect(calls).toHaveLength(1);
  });
});

describe('OpenAI expresses an exhausted allowance differently', () => {
  /** The REAL body OpenAI returned on this deployment. No quota details, no retry delay. */
  const insufficientQuota = () => new Response(
    JSON.stringify({
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota', param: null, code: 'insufficient_quota',
      },
    }),
    { status: 429 },
  );

  it('is treated as exhausted rather than rate limited', async () => {
    const openai: EmailAiConfig = { provider: 'openai', key: 'test-key', model: 'gpt-4o-mini' };
    scripted([insufficientQuota]);

    const err = await draftEmailWithAi(openai, 'system', 'welcome').catch((e: Error) => e);
    const message = JSON.stringify((err as { response?: unknown }).response ?? (err as Error).message);

    /*
     * It carries none of Google's `QuotaFailure` details, so a `PerDay` check alone reads it as a
     * rate limit — three pointless retries and "try again shortly" for a balance that clears only
     * when somebody pays.
     */
    expect(message).toMatch(/allowance|quota/i);
    expect(message).toMatch(/billing|will not help/i);
    expect(message).not.toMatch(/shortly/i);
  });

  it('is not retried', async () => {
    const openai: EmailAiConfig = { provider: 'openai', key: 'test-key', model: 'gpt-4o-mini' };
    const calls = scripted([insufficientQuota]);

    await draftEmailWithAi(openai, 'system', 'welcome').catch(() => undefined);

    expect(calls).toHaveLength(1);
  });
});
