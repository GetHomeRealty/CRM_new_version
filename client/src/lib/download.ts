/*
 * TD-046 — ONE PLACE THAT DECIDES WHAT A DOWNLOADED FILE IS CALLED.
 *
 * Every export route names its own file on `Content-Disposition`, and six client helpers each read
 * that header with their own copy of a regex. Five of those copies were the naive form
 * (`/filename="?([^";]+)"?/`), which cannot read the RFC 5987 encoding — given
 * `filename*=UTF-8''Trade%20Sheet.xlsx` it captures the literal `*=UTF-8''Trade%20Sheet.xlsx` and
 * hands THAT to the browser as the filename, and it never percent-decodes. No route emits that form
 * today, so this is the copy that was right by luck rather than by rule.
 *
 * Both readers live here now, so a download's name and the mechanics of saving it are one decision:
 *
 *   `filenameFromDisposition` prefers `filename*` (the encoded form, which is the one that can
 *   carry a non-ASCII name), falls back to plain `filename`, and falls back again to the caller's
 *   own descriptive default. Any name it returns is stripped of a path — a header is not trusted to
 *   choose where a file lands.
 *
 *   `saveBlob` appends the anchor before clicking it, which some browsers require, and defers
 *   `revokeObjectURL` to the next tick, because revoking synchronously can cancel the download it
 *   just started.
 *
 * The header is only READABLE cross-origin when the API exposes it; `enableCors` in the server's
 * `main.ts` now does. Without that, every one of these callers silently gets its fallback name.
 */

/** Response headers as axios hands them over — lower-cased keys, values of unknown shape. */
type Headers = Record<string, unknown> | undefined;

const FILENAME_STAR = /filename\*\s*=\s*(?:UTF-8|ISO-8859-1)?''([^;]+)/i;
const FILENAME_PLAIN = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i;

/** Strip any directory part: the file is named by the server, but placed by the browser. */
const baseName = (name: string): string => name.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';

/**
 * The filename the server asked for, or `fallback` when the header is missing, unreadable or
 * empty. `fallback` should always carry the right extension — it is what the user actually gets
 * whenever the header cannot be read.
 */
export function filenameFromDisposition(headers: Headers, fallback: string): string {
  const dispo = String(headers?.['content-disposition'] ?? '');
  const encoded = FILENAME_STAR.exec(dispo);
  if (encoded) {
    // A malformed percent sequence must not lose the download — fall through to the plain form.
    try {
      const name = baseName(decodeURIComponent(encoded[1].trim()));
      if (name) return name;
    } catch { /* not decodable — try the plain parameter below */ }
  }
  const plain = FILENAME_PLAIN.exec(dispo);
  const name = baseName(plain ? (plain[1] ?? plain[2] ?? '') : '');
  return name || fallback;
}

/**
 * Hand a blob to the browser as a download, then release the object URL.
 *
 * `revokeAfterMs` is how long the object URL is kept alive after the click. Zero — the next tick —
 * is enough for an ordinary file and is what the small exports have always used; the bulk and
 * Export Centre downloads hold theirs for a minute or two, which is the behaviour they shipped
 * with and is preserved rather than quietly shortened here. What must never happen is revoking
 * SYNCHRONOUSLY: that can cancel the download it just started.
 */
export function saveBlob(blob: Blob, filename: string, revokeAfterMs = 0): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}
