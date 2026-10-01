/**
 * WHERE A SCREEN MAY SEND SOMEBODY BACK TO.
 *
 * A `returnTo` in the URL is a destination supplied by whoever wrote the link, which on a screen
 * reachable by a pasted URL means anybody. Handed to `navigate()` unchecked, `?returnTo=https://…`
 * is an open redirect: the application itself walks the person off to another site, from a link
 * that looked like its own.
 *
 * So the rule is allow-list, not deny-list. Only an absolute path into one of this application's
 * own areas is accepted, and anything else falls back to where the screen would have gone anyway.
 * A rejected value is never an error — the person still lands somewhere sensible, which is what
 * makes it safe to apply silently.
 *
 * WHAT IS REFUSED, AND WHY EACH ONE IS LISTED SEPARATELY:
 *
 *   https://evil.test/x     an absolute URL; no leading slash
 *   //evil.test/x           protocol-relative, which a browser treats as a full URL
 *   /\evil.test/x           backslash after the slash; some parsers read it as //
 *   javascript:alert(1)     no leading slash
 *   /crm/meta/../../x       traversal, refused rather than normalised
 *   /nonsense               a path this application does not serve
 */

/** The areas this application serves, mirroring `AREAS` in `area.ts`. */
const AREA = '(?:crm|desk)';

/** `/crm/meta`, `/crm/lead/42`, `/desk/transactions` — an area, a screen, and optional segments. */
const INTERNAL_PATH = new RegExp(`^/${AREA}/[a-z0-9-]+(?:/[A-Za-z0-9._-]+)*$`);

/**
 * The destination to use, given a caller-supplied `returnTo` and where the screen would otherwise
 * go. Query string and fragment are preserved, because that is where the Meta screen carries the
 * form filter it has to come back to.
 */
export function safeReturnTo(raw: string | null | undefined, fallback: string): string {
  const value = (raw ?? '').trim();
  if (!value) return fallback;

  // Anything that could address another host. `//` and `/\` are the two spellings of
  // protocol-relative that browsers accept; a backslash anywhere else is not a path we emit.
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;

  // Control characters, which can hide the real target from a reader checking the link.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;

  const path = value.split(/[?#]/)[0];
  if (path.includes('..')) return fallback;

  return INTERNAL_PATH.test(path) ? value : fallback;
}

/**
 * Which screen a destination belongs to, for labelling the button that goes there. "Back to Leads"
 * pointing at the Meta screen is a smaller bug than an open redirect and a more common one, because
 * the label is written once and the destination later becomes conditional.
 */
export function returnLabel(destination: string): string {
  const path = destination.split(/[?#]/)[0];
  if (/^\/(?:crm|desk)\/meta$/.test(path)) return 'Meta';
  return 'Leads';
}
