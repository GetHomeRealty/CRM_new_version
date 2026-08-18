import { BadRequestException } from '@nestjs/common';

/**
 * The small, sharp pieces the Inbox needs: address parsing, threading and reply construction.
 *
 * Kept out of the service because every one of them is a pure function with a right answer, and
 * because two of them are the difference between a working mail client and a confusing one:
 *
 *   THREAD KEYS decide whether a reply joins a conversation or starts a new one.
 *   REPLY-ALL RECIPIENTS decide whether the wrong person is copied on a private answer.
 */

/** How many recipients one message may carry, across To, CC and BCC together. */
export const MAX_RECIPIENTS = 100;

/** A single address, as strict as is useful — the mail server is the real judge. */
const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Split a recipient field into addresses.
 *
 * Accepts what people actually paste: commas, semicolons, newlines, and `Name <a@b.c>` forms. An
 * entry that is not an address is REFUSED rather than dropped — silently discarding a recipient
 * means the person believes they wrote to somebody they did not.
 */
export function parseAddresses(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  const parts = text.split(/[,;\n]+/).map((p) => p.trim()).filter((p) => p !== '');
  const out: string[] = [];
  for (const part of parts) {
    // `Display Name <someone@example.com>` → the address inside the angle brackets.
    const angled = part.match(/<([^>]+)>/);
    const addr = (angled ? angled[1] : part).trim().toLowerCase();
    if (!ADDRESS.test(addr)) {
      throw new BadRequestException({
        message: `"${part}" is not an email address.`,
        errors: { [field]: [`"${part}" is not an email address.`] },
      });
    }
    if (!out.includes(addr)) out.push(addr);
  }
  return out;
}

/**
 * The conversation a message belongs to.
 *
 * The FIRST id in `References` is the root of the thread, so every reply down a chain resolves to
 * the same key in one step — no recursive walk, and no dependence on having received the parent.
 * Falling back to `In-Reply-To` covers clients that send only that, and falling back to the message's
 * own id makes a new conversation its own thread rather than a null.
 */
export function threadKeyFor(opts: { references?: string | null; inReplyTo?: string | null; messageId?: string | null }): string | null {
  const refs = (opts.references ?? '').trim();
  if (refs) {
    const first = refs.split(/\s+/).find((r) => r.startsWith('<'));
    if (first) return first.slice(0, 512);
  }
  const parent = (opts.inReplyTo ?? '').trim();
  if (parent) return parent.slice(0, 512);
  const own = (opts.messageId ?? '').trim();
  return own ? own.slice(0, 512) : null;
}

/** `Re:` / `Fwd:` without stacking them — "Re: Re: Re:" is how a thread stops being readable. */
export function prefixSubject(subject: string | null | undefined, prefix: 'Re' | 'Fwd'): string {
  const base = (subject ?? '').trim();
  const already = new RegExp(`^${prefix}:\\s*`, 'i');
  if (already.test(base)) return base;
  return `${prefix}: ${base}`.trim();
}

/**
 * Who a reply goes to.
 *
 * REPLY goes to the sender alone. REPLY ALL adds everyone who was on the original — minus the
 * mailbox doing the replying, because copying yourself on your own answer is noise, and minus any
 * duplicate of the sender.
 *
 * `own` is the address of the mailbox replying. It is removed case-insensitively; a mailbox that
 * received a message addressed to a capitalised form of itself would otherwise be copied.
 */
export function replyRecipients(
  original: { from_email: string | null; to_email: string | null },
  own: string,
  all: boolean,
): { to: string[]; cc: string[] } {
  const me = own.trim().toLowerCase();
  const sender = (original.from_email ?? '').trim().toLowerCase();
  const to = sender ? [sender] : [];
  if (!all) return { to, cc: [] };

  const others = splitLoose(original.to_email)
    .filter((a) => a !== me && a !== sender);
  return { to, cc: [...new Set(others)] };
}

/**
 * Addresses out of a stored header, forgivingly.
 *
 * Unlike `parseAddresses` this NEVER throws: it is reading what a remote server sent, not what a
 * person typed, and a malformed address in somebody else's header must not stop a reply from being
 * composed. Anything unparseable is dropped.
 */
export function splitLoose(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map((p) => {
      const angled = p.match(/<([^>]+)>/);
      return (angled ? angled[1] : p).trim().toLowerCase();
    })
    .filter((a) => ADDRESS.test(a));
}

/** The quoted original, as every mail client writes it. */
export function quoteBody(opts: { fromName: string | null; fromEmail: string | null; date: Date; html: string | null; text: string | null }): string {
  const who = opts.fromName ? `${opts.fromName} &lt;${opts.fromEmail ?? ''}&gt;` : (opts.fromEmail ?? 'someone');
  const when = opts.date.toISOString().slice(0, 16).replace('T', ' ');
  const body = opts.html ?? (opts.text ? `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(opts.text)}</pre>` : '');
  return `<br><br><div style="border-left:2px solid #ccc;padding-left:12px;color:#555">`
    + `<p>On ${when}, ${who} wrote:</p>${body}</div>`;
}

/** Minimal escaping for text being placed into an HTML quote block. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
