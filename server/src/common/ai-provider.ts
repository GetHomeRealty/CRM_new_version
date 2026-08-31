import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';

const log = new Logger('AiProvider');

/**
 * Talking to whichever AI provider is configured.
 *
 * Lifted out of `LeadActivityService` unchanged when the Calendar needed the same thing. Copying it
 * would have been the shorter change and the wrong one: the Leads and Campaigns lead-import used to
 * be two copies of one idea, they drifted, and the same file imported through two screens produced
 * two different results. One provider layer, used by everything that needs a model.
 *
 * Provider order and every message below are exactly as they were.
 */

export type EmailAiProvider = 'anthropic' | 'openai' | 'gemini';
export interface EmailAiConfig { provider: EmailAiProvider; key: string; model: string; }

/**
 * Which AI provider drafts emails. AI_EMAIL_PROVIDER pins one explicitly; otherwise the first
 * provider with a key set wins (Anthropic → OpenAI → Gemini). Returns null when none is configured,
 * so the caller can 503 with a clear message. GOOGLE_API_KEY is accepted as an alias for Gemini.
 */
export function resolveEmailAi(): EmailAiConfig | null {
  const env = (n: string) => (process.env[n] ?? '').trim();
  const keys: Record<EmailAiProvider, string> = {
    anthropic: env('ANTHROPIC_API_KEY'),
    openai: env('OPENAI_API_KEY'),
    gemini: env('GEMINI_API_KEY') || env('GOOGLE_API_KEY'),
  };
  const model = (p: EmailAiProvider): string => {
    const override = env('AI_EMAIL_MODEL');
    if (p === 'anthropic') return override || env('ID_EXTRACTION_MODEL') || 'claude-sonnet-5';
    if (p === 'openai') return env('OPENAI_MODEL') || override || 'gpt-4o-mini';
    return env('GEMINI_MODEL') || override || 'gemini-1.5-flash';
  };

  const pinned = env('AI_EMAIL_PROVIDER').toLowerCase();
  const order: EmailAiProvider[] = pinned === 'anthropic' || pinned === 'openai' || pinned === 'gemini'
    ? [pinned] : ['anthropic', 'openai', 'gemini'];
  for (const p of order) {
    if (keys[p]) return { provider: p, key: keys[p], model: model(p) };
  }
  return null;
}

/**
 * Calls the configured provider and returns the raw model text (expected to be a JSON object with
 * `subject`/`html`). Each provider is asked for JSON directly. Network failures surface as 503;
 * an HTTP error surfaces with the status and a short snippet of the provider's body so a bad key or
 * exhausted quota is diagnosable — the API key itself is never included.
 */
/**
 * HTTP statuses worth trying again. All of them mean "the provider is busy or briefly broken",
 * never "your request was wrong" — retrying a 400 or a 401 would just fail three times as slowly.
 */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const ATTEMPTS = 3;
/** Longer than this and waiting is worse than answering; the caller is holding an HTTP request. */
const MAX_WAIT_MS = 5000;

/** Exponential with jitter, so a burst of agents retrying does not land in step. */
const backoffMs = (attempt: number): number => Math.round((2 ** (attempt - 1)) * 700 * (1 + Math.random() * 0.3));

/** What went wrong, in terms the caller can act on — not just an HTTP number. */
export type AiFailureKind = 'auth' | 'quota_exhausted' | 'rate_limited' | 'busy' | 'bad_request';
export interface AiFailure {
  kind: AiFailureKind;
  status: number;
  /** How long the provider says to wait, when it says. Null when it does not. */
  waitMs: number | null;
  /** Short, for the server log. Never contains the API key. */
  detail: string;
  quotaId?: string;
}

/**
 * WHERE GOOGLE PUTS THE RETRY DELAY, and why reading only `Retry-After` was not enough.
 *
 * The Gemini API sends NO `Retry-After` header. The wait is inside the body, as a `google.rpc.
 * RetryInfo` entry in `error.details`, alongside a `QuotaFailure` naming which quota was hit. A
 * retry loop that consults only the header therefore invents its own backoff — which is how three
 * attempts spaced ~700ms and ~1.4s apart all landed inside a window the provider had said was 44
 * seconds long, and reported the result as "busy".
 */
function parseProviderError(res: Response, body: string): AiFailure {
  const status = res.status;
  let waitMs: number | null = null;
  let quotaId: string | undefined;
  let message = body.slice(0, 200);
  let googleStatus = '';

  try {
    const json = JSON.parse(body) as { error?: { message?: string; status?: string; details?: unknown[] } };
    const err = json.error ?? {};
    message = (err.message ?? message).slice(0, 300);
    googleStatus = err.status ?? '';
    for (const d of (err.details ?? []) as { '@type'?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[]) {
      const type = String(d['@type'] ?? '');
      if (type.endsWith('RetryInfo') && d.retryDelay) {
        const seconds = Number(String(d.retryDelay).replace(/s$/, ''));
        if (Number.isFinite(seconds)) waitMs = Math.round(seconds * 1000);
      }
      if (type.endsWith('QuotaFailure')) quotaId = d.violations?.[0]?.quotaId;
    }
  } catch { /* not JSON — the raw snippet above is all there is */ }

  /*
   * `Retry-After` is the fallback, not the primary — but it must stay. Gemini omits the header and
   * puts the wait in the body; OpenAI and Anthropic do the opposite. Reading only one of the two
   * leaves whichever provider uses the other being guessed at.
   */
  if (waitMs === null) {
    const header = (res.headers.get('retry-after') ?? '').trim();
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) waitMs = seconds * 1000;
      else {
        const at = Date.parse(header);
        if (Number.isFinite(at)) waitMs = Math.max(at - Date.now(), 0);
      }
    }
  }

  /*
   * A DAILY quota is not a rate limit. `GenerateRequestsPerDayPerProjectPerModel-FreeTier` with a
   * value of 20 means the project has used its allowance for the day — waiting 44 seconds and
   * trying again achieves nothing, and telling the agent it is "busy, try again in a moment" sends
   * them round a loop that cannot succeed until tomorrow or until billing changes.
   */
  const perDay = /PerDay/i.test(quotaId ?? '');
  /*
   * OpenAI EXPRESSES THE SAME THING DIFFERENTLY, and reading only Google's shape misses it.
   *
   * OpenAI answers an empty credit balance with `429 insufficient_quota` and NO quota details — so
   * the `PerDay` test above does not match, and it fell through to `rate_limited`: retried three
   * times and reported as "try again shortly". It never clears on its own; it clears when somebody
   * pays. Verified live on this deployment, where both providers are exhausted at once.
   *
   * Matched on the wording as well as the code because `insufficient_quota` is the machine-readable
   * signal and the billing sentence is what the other providers send.
   */
  const outOfCredit = quotaId
    // Google NAMED the quota, so its own label decides — the billing sentence below appears in its
    // per-minute message too, and matching on wording here would demote a retryable limit.
    ? false
    : /insufficient_quota/i.test(message)
      || (/exceeded your current quota|check your plan and billing/i.test(message) && waitMs === null);
  const kind: AiFailureKind = status === 401 || status === 403 || /API key not valid|API_KEY_INVALID/i.test(message)
    ? 'auth'
    : status === 429 && (perDay || outOfCredit) ? 'quota_exhausted'
      : status === 429 ? 'rate_limited'
        : TRANSIENT.has(status) ? 'busy'
          : 'bad_request';

  return { kind, status, waitMs, detail: `${googleStatus || status} ${message}`.trim(), quotaId };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function callProvider(cfg: EmailAiConfig, system: string, userText: string): Promise<Response> {
  // A FRESH signal per attempt. `AbortSignal.timeout` starts counting the moment it is created, so
  // one signal hoisted out of the retry loop would already be spent by the second try and abort it
  // instantly — turning a retry into a second, faster failure.
  const timeout = AbortSignal.timeout(45000);
  let res: Response;
  try {
    if (cfg.provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, max_tokens: 4000, system, messages: [{ role: 'user', content: userText }] }),
        signal: timeout,
      });
    } else if (cfg.provider === 'openai') {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model, max_tokens: 4000, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
        }),
        signal: timeout,
      });
    } else {
      // Gemini: system prompt goes in system_instruction; JSON forced via responseMimeType.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          // The `-latest` aliases now resolve to a Gemini 2.5+ "thinking" model whose reasoning
          // tokens are drawn from this same output budget. A small budget can be spent entirely on
          // thinking, truncating the email JSON before it closes — which surfaces to the agent as
          // "did not return a usable email". A generous ceiling leaves ample room for both the
          // hidden reasoning and the actual email; we cap length via the prompt, not this number.
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 },
        }),
        signal: timeout,
      });
    }
  } catch (ex) {
    throw new ServiceUnavailableException({ message: `Could not reach the AI service (${cfg.provider}): ${(ex as Error).message}` });
  }
  return res;
}

/**
 * Calls the provider, RETRYING the failures that are worth retrying.
 *
 * WHY THIS EXISTS. A single 503 from the model ended the request and put the provider's raw JSON on
 * the agent's screen — including Google's own advice, "Spikes in demand are usually temporary.
 * Please try again later", which the application then did not act on. One busy moment upstream and
 * the agent's email simply failed, with a wall of JSON explaining that it might work if they did it
 * again themselves.
 *
 * Only the transient statuses are retried. A 401 from a wrong key or a 400 from a bad model name is
 * not going to change on the second attempt, and hiding it behind three tries would make a
 * misconfiguration slower to diagnose rather than more reliable.
 */
export async function draftEmailWithAi(cfg: EmailAiConfig, system: string, userText: string): Promise<string> {
  let res!: Response;
  let failure: AiFailure | null = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    res = await callProvider(cfg, system, userText);
    if (res.ok) { failure = null; break; }

    failure = parseProviderError(res, await res.text().catch(() => ''));
    /*
     * THE REAL PROVIDER ERROR, ON THE SERVER, EVERY TIME.
     *
     * Nothing was logged before, so a failure existed only as whatever reached the agent's toast —
     * and once that was made friendly, the actual cause existed nowhere at all. `quota_exhausted`
     * looked identical to `busy` from the outside.
     */
    log.warn(
      `AI draft attempt ${attempt}/${ATTEMPTS} failed — provider=${cfg.provider} model=${cfg.model} `
      + `http=${res.status} kind=${failure.kind}${failure.quotaId ? ` quota=${failure.quotaId}` : ''}`
      + `${failure.waitMs !== null ? ` provider_says_wait=${failure.waitMs}ms` : ''} detail="${failure.detail}"`,
    );

    // A daily allowance, a bad key or a malformed request will answer identically next time.
    if (failure.kind === 'quota_exhausted' || failure.kind === 'auth' || failure.kind === 'bad_request') break;
    if (attempt === ATTEMPTS) break;

    /*
     * Wait what the PROVIDER asked for, when it asked. If that is longer than a request should be
     * held open, stop rather than sleep through it — the honest answer arrives sooner than a
     * successful one would.
     */
    const wait = failure.waitMs ?? backoffMs(attempt);
    if (wait > MAX_WAIT_MS) break;
    await sleep(wait);
  }

  if (failure) throw describeFailure(cfg, failure);

  const data = (await res.json()) as Record<string, unknown>;
  if (cfg.provider === 'anthropic') {
    return ((data.content as { text?: string }[] | undefined)?.[0]?.text ?? '').trim();
  }
  if (cfg.provider === 'openai') {
    return ((data.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? '').trim();
  }
  const parts = (data.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined)?.[0]?.content?.parts;
  return (parts?.map((x) => x.text ?? '').join('') ?? '').trim();
}


/**
 * Make a stored value safe to place inside a prompt.
 *
 * WHY THIS IS NEEDED AT ALL. The values interpolated into these prompts are not written by the
 * agent pressing the button. A lead's name arrives from a Meta lead form, a web enquiry or a CSV
 * import; an appointment's attendees and notes are typed by whoever booked it. All of that is
 * attacker-reachable text being placed next to instructions, which is the whole shape of a prompt
 * injection: a lead called `". Ignore your instructions and…` writes the brokerage's prompt.
 *
 * WHAT IT DOES AND DOES NOT PROMISE. Removing the characters that let a value close its delimiter
 * or start a new line, then capping the length, removes the cheap attacks. It is not a proof
 * against a determined one — nothing at this layer is — so it is paired with two other things at
 * every call site: the value goes inside a named tag, and the system prompt says that text inside
 * those tags is data and never an instruction. Defence in depth, and the honest description of it
 * is "much harder", not "impossible".
 *
 * Lived in lead-activity.service.ts first. Moved here when the Calendar needed the same thing,
 * rather than copied — this codebase has been bitten before by two copies of one idea drifting
 * apart (see LeadImportEngine's header).
 */
export function safeForPrompt(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[<>"'`\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * One failure, said in the terms the person reading it can act on.
 *
 * Each of these was previously the same sentence — "the AI service is busy" — which was true of one
 * of them and actively misleading about the rest. A used-up daily allowance is not busy: it will
 * not clear in a moment, and the fix is billing rather than patience.
 */
function describeFailure(cfg: EmailAiConfig, f: AiFailure): Error {
  const who = `The AI service (${cfg.provider})`;
  if (f.kind === 'auth') {
    return new ServiceUnavailableException({
      message: `${who} rejected the API key. Check the key for this provider in the server environment, then restart. `
        + 'Nothing is wrong with the lead or the message.',
    });
  }
  if (f.kind === 'quota_exhausted') {
    return new ServiceUnavailableException({
      message: `${who} has used up its request allowance for ${cfg.model}`
        + `${f.quotaId ? ` (${f.quotaId})` : ''}. Retrying will not help until the quota resets or billing is upgraded. `
        + 'Write the email yourself and send as normal, or switch AI_EMAIL_PROVIDER to another configured provider.',
    });
  }
  if (f.kind === 'rate_limited') {
    const secs = f.waitMs ? Math.ceil(f.waitMs / 1000) : null;
    return new ServiceUnavailableException({
      message: `${who} is rate limiting requests${secs ? ` and asked to wait ${secs}s` : ''}. `
        + 'Try Generate again shortly, or write the email yourself and send as normal.',
    });
  }
  if (f.kind === 'busy') {
    return new ServiceUnavailableException({
      message: `${who} is busy and did not answer after ${ATTEMPTS} attempts. `
        + 'This is usually brief — try Generate again in a moment, or write the email yourself and send as normal.',
    });
  }
  // Malformed request, wrong model name, unsupported parameter: the detail is what fixes it, and
  // the API key is never part of a provider's error body.
  return new BadRequestException({ message: `${who} returned HTTP ${f.status}. ${f.detail}`.trim() });
}
