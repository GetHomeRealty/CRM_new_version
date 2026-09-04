/*
 * TD-046 (follow-up) — A FILENAME IS UTF-8; AN HTTP HEADER IS NOT.
 *
 * Node writes header values as latin-1 and REFUSES anything outside it: `res.setHeader` on a name
 * carrying a character above U+00FF throws `ERR_INVALID_CHAR`, which lands as a 500. Every download
 * route interpolated the stored filename straight into the header, so a document uploaded as
 * "契約書.pdf" — or with an emoji, or a Devanagari or Cyrillic name — could be stored and listed
 * but never opened or downloaded. It is not a naming annoyance like the defect it was found under;
 * it is a crash on a file the user can see.
 *
 * RFC 6266 answers this with two parameters, and this emits both:
 *
 *   filename="..."      an ASCII-only rendering, for anything that reads the plain parameter
 *   filename*=UTF-8''.. the real name, percent-encoded (RFC 5987), which every current browser
 *                       prefers when it is present
 *
 * The ASCII rendering is not a translation — a name that is entirely non-ASCII has nothing left to
 * render, so it degrades to `download` plus the original extension rather than a row of
 * underscores. Whoever reads only the plain parameter gets something openable; whoever reads
 * `filename*` (our own client does, and so does every browser saving the file directly) gets the
 * name that was uploaded.
 *
 * WHAT IS STRIPPED, AND WHY. Quotes and backslashes would end the quoted string early; control
 * characters and CR/LF would let a stored filename inject a header of its own; a path separator
 * would let it propose a directory. None of that survives, in either parameter.
 */

/** Characters an HTTP token/quoted-string cannot carry, plus anything a header must never see. */
const UNSAFE = /[\x00-\x1F\x7F"\\/]/g;                    // control chars, quote, backslash, slash
const NON_ASCII = /[^\x20-\x7E]/g;
/** encodeURIComponent leaves these, but RFC 5987 `attr-char` does not allow them. */
const NOT_ATTR_CHAR = /['()*]/g;

/** The name with anything header-hostile removed, path parts included. */
function clean(name: string): string {
  return String(name ?? '').replace(/[\\/]+/g, '/').split('/').pop()!.replace(UNSAFE, '').trim();
}

/**
 * An ASCII-only rendering of `name`, for the plain `filename` parameter.
 *
 * A name with SOME ASCII in it keeps that and loses the rest ("契約書 Waiver.pdf" → "Waiver.pdf");
 * a name with none left is called `download`, keeping its extension so the file still opens by
 * double-click. `fallback` is what a name that had no extension either ends up as.
 */
export function asciiFilename(name: string, fallback = 'download'): string {
  const base = clean(name);
  const ext = /(\.[A-Za-z0-9]{1,8})$/.exec(base)?.[1] ?? '';
  const stem = ext ? base.slice(0, -ext.length) : base;
  const ascii = stem.replace(NON_ASCII, ' ').replace(/\s+/g, ' ').trim();
  // The extension is kept whatever happens to the stem, so the file still opens by double-click.
  // A stem with no LETTER OR DIGIT left is not a name — "契約書.pdf" would otherwise reduce to the
  // hidden file ".pdf" — so it becomes the caller's fallback instead.
  return /[A-Za-z0-9]/.test(ascii) ? ascii + ext : fallback + ext;
}

/** RFC 5987 encoding of the real name: UTF-8, percent-encoded down to `attr-char`. */
function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(NOT_ATTR_CHAR, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * A complete `Content-Disposition` value for `name`.
 *
 * `inline` renders in the browser (previews, avatars, lead attachments); the default is a download.
 * `filename*` is added only when the real name differs from its ASCII rendering — an ordinary
 * ASCII name produces exactly the header these routes have always sent.
 */
export function contentDisposition(name: string, opts: { inline?: boolean; fallback?: string } = {}): string {
  const disposition = opts.inline ? 'inline' : 'attachment';
  const ascii = asciiFilename(name, opts.fallback ?? 'download');
  const real = clean(name);
  const header = `${disposition}; filename="${ascii}"`;
  return real && real !== ascii ? `${header}; filename*=UTF-8''${encodeRfc5987(real)}` : header;
}
