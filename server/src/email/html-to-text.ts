/**
 * HTML to readable plain text — the `text/plain` half of a multipart message.
 *
 * WHY IT LIVES HERE RATHER THAN UNDER `leads/`. It began in `personal-email.ts`, beside the
 * personal-mail styling, and campaign mail needed the same thing. Importing it across would have
 * tripped the guard in `personal-email.spec.ts` — rightly: that guard exists so bulk mail cannot
 * quietly acquire the PERSONAL treatment and lose the tracking, branding and unsubscribe
 * machinery campaigns are required to have.
 *
 * The guard protects the styling, not a string function. So the string function moved to the mail
 * module both sides already depend on, and the physical barrier between `leads/` and `campaigns/`
 * is left exactly as it was. `personal-email.ts` re-exports it, so nothing that imported it from
 * there had to change.
 */

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', shy: '',
};

/**
 * The `text/plain` half of the message.
 *
 * WHY IT IS WORTH ADDING. The mailer sent `html` and nothing else, so every message left as
 * HTML-only. Real correspondence between two people is almost always multipart/alternative — Gmail,
 * Outlook and Apple Mail all send a text part — and an HTML-only message is one of the cheap signals
 * that separates machine-generated mail from typed mail. Supplying the text alternative is a
 * genuine structural improvement to how the message is put together; it is not a trick, and it
 * makes no promise about which Gmail tab the result lands in.
 *
 * It also means the message stays readable in a plain-text client and in the preview lines a mail
 * app shows, which is the ordinary reason to send one.
 */
export function htmlToText(input: string): string {
  let s = String(input ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|h[1-6]|li|blockquote|table|section)\s*>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<[^>]+>/g, '');
  /*
   * ONE PASS, not one replace per entity. Decoding `&amp;` before `&lt;` turns the literal text
   * `&amp;lt;` into `<` — the reader typed an escaped entity and would be shown a tag. A single
   * scan cannot double-decode, because each match is consumed once.
   */
  s = s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    const named = ENTITIES[ref.toLowerCase()];
    return named === undefined ? whole : named;
  });
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
