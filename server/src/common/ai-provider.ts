import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

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
export async function draftEmailWithAi(cfg: EmailAiConfig, system: string, userText: string): Promise<string> {
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

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 300);
    throw new BadRequestException({ message: `The AI service (${cfg.provider}) returned HTTP ${res.status}. ${snippet}`.trim() });
  }

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
