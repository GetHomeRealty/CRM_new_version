/**
 * The Simple Email body: the author's words, in an email that looks typed rather than designed.
 *
 * WHY A SIMPLIFIER AND NOT A SECOND TEMPLATE LIBRARY. The brokerage's templates are the content
 * they have written and keep writing; asking them to maintain a plain copy of each one guarantees
 * the two drift, and the one that drifts is the one nobody proofreads. So this renders an EXISTING
 * template in a plainer form, and the template library is untouched.
 *
 * WHY AN ALLOW-LIST RATHER THAN STRIPPING. "Remove the promotional parts" is not a thing a program
 * can judge. An allow-list is decidable: these tags survive, everything else is unwrapped, and the
 * result is the same for the same input every time. Unwrapped rather than deleted, because deleting
 * `<table>` would delete the words inside it — the whole message, in a table-laid-out template.
 *
 * WHAT IT KEEPS, AND WHY EACH ONE:
 *   p, br          - paragraphs are the shape of a written message
 *   a (href only)  - a message with something to click is not dishonest; dropping links would
 *                    silently break every call to action
 *   strong, b, em, i - emphasis somebody typed on purpose
 *   ul, ol, li     - a list is prose, not decoration
 *
 * WHAT IT DROPS: images, tables, buttons, background colours, fonts, every inline style and class,
 * and anything executable. Those are the newsletter furniture — and `analyseContent` already names
 * image-heavy, link-heavy, markup-heavy mail as what correlates with the Promotions tab.
 *
 * WHAT THIS IS NOT. It is not a way around Gmail's classifier, and nothing here is disguised as a
 * personal reply: the message still carries its unsubscribe link, its List-Unsubscribe headers and
 * its bulk-mail footer, because it IS marketing mail. Placement is decided per recipient from
 * engagement history and no sender controls it. This makes the mail more readable and lighter,
 * which is worth doing on its own merits.
 */

/** Tags that survive simplification. Everything else is unwrapped, keeping its text. */
const KEEP = new Set(['p', 'br', 'a', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li']);

/** Tags whose CONTENT is dropped as well as their markup — none of it is message text. */
const DROP_WHOLE = ['script', 'style', 'head', 'title', 'noscript', 'iframe', 'object', 'svg'];

/**
 * Turn one tag into its simplified form, or into nothing.
 *
 * `<a>` keeps only `href`, and only an http(s) or mailto one: a `javascript:` href in a template is
 * either a mistake or an attack, and neither should reach a recipient's mail client.
 */
function keepTag(raw: string, name: string, closing: boolean): string {
  if (!KEEP.has(name)) return '';
  if (closing) return `</${name}>`;
  if (name === 'br') return '<br />';
  if (name === 'a') {
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(raw);
    const url = (href?.[2] ?? href?.[3] ?? '').trim();
    // Anything else becomes a plain <a> with no destination, which renders as text rather than
    // as a link somebody can follow to somewhere unexpected.
    return /^(https?:\/\/|mailto:)/i.test(url) ? `<a href="${url}">` : '<a>';
  }
  return `<${name}>`;
}

/**
 * The author's HTML reduced to readable markup.
 *
 * Operates on the string rather than a DOM because the server has no DOM and a parser dependency
 * for ten tags is not worth the supply chain. The inputs are the brokerage's own templates, and the
 * output is passed through the same sanitising the standard body already gets downstream.
 */
export function simplifyHtml(html: string): string {
  let s = String(html ?? '');

  for (const tag of DROP_WHOLE) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    // An unclosed one would otherwise leave its opening tag behind to be unwrapped into nothing.
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '');
  }

  // Comments can hold conditional markup for Outlook; none of it is message text.
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  /*
   * BLOCK BOUNDARIES BECOME PARAGRAPH BREAKS BEFORE THE TAGS GO.
   *
   * A template laid out in `<div>`s or `<td>`s has no `<p>` anywhere, so unwrapping first would run
   * every line of the message into one paragraph — the words would all be there and it would be
   * unreadable. Marking the boundaries while they still exist is what keeps the shape.
   */
  s = s.replace(/<\/(div|tr|table|h[1-6]|blockquote|section|article|header|footer)\s*>/gi, '</p><p>');
  s = s.replace(/<\/(td|th)\s*>/gi, '<br />');

  // Now unwrap or keep each remaining tag.
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (raw, name: string) =>
    keepTag(raw, name.toLowerCase(), raw.startsWith('</')));

  // Collapse what the boundary substitution produced: empty paragraphs, stacked breaks, and the
  // whitespace that table layouts leave between cells.
  s = s.replace(/(&nbsp;|\s)+/g, ' ');
  s = s.replace(/<p>\s*(<br \/>\s*)*<\/p>/gi, '');
  s = s.replace(/(<br \/>\s*){3,}/gi, '<br /><br />');
  s = s.replace(/<p>\s*/gi, '<p>').replace(/\s*<\/p>/gi, '</p>');

  return s.trim();
}

/**
 * A greeting, if the message does not already open with one.
 *
 * NOT ADDED BLINDLY. Most of the brokerage's templates already begin "Hi {{LEAD_NAME}}" — adding a
 * second greeting above that is the kind of detail that makes an email look machine-assembled,
 * which is the opposite of the point. So this looks first.
 *
 * `{{LEAD_NAME}}` rather than a resolved name: this runs before personalisation, so the token is
 * filled per recipient by the same `personalize` call the standard body uses, and falls back to
 * "there" exactly as it does everywhere else.
 */
export function ensureGreeting(html: string): string {
  const opening = String(html ?? '').replace(/<[^>]*>/g, ' ').trim().slice(0, 60);
  if (/^(hi|hello|hey|dear|good\s+(morning|afternoon|evening))\b/i.test(opening)) return html;
  return `<p>Hi {{LEAD_NAME}},</p>\n${html}`;
}

/**
 * The whole Simple Email body, ready for personalisation.
 *
 * SYSTEM FONTS AND ONE COLOUR, set on a single wrapper rather than on every element: a mail client
 * with no styling at all should render this correctly, and the styling that is here only makes it
 * match what the reader's own mail looks like. No width, no background, no borders — a fixed-width
 * centred card is the single most recognisable newsletter shape there is.
 *
 * The unsubscribe footer is NOT added here. It is appended at send time by `injectTracking`, for
 * every mode, so that one piece of compliance has exactly one implementation and cannot be
 * forgotten by a caller that assembles a body some other way.
 */
export function simpleEmailBody(html: string): string {
  const body = ensureGreeting(simplifyHtml(html));
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
    + 'font-size:15px;line-height:1.6;color:#222;">\n'
    + `${body}\n`
    + '</div>';
}
