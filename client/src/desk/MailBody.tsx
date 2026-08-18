import { useEffect, useMemo, useState } from 'react';
import { fetchMailboxAttachmentBlob, type MailboxMessage } from '../lib/accountApi';
import type { Area } from './area';

/**
 * A received message's body, rendered as the sender wrote it.
 *
 * WHAT THIS REPLACED, AND WHY IT WAS NOT ENOUGH. The reader used to strip every tag and print the
 * result in a `<pre>`. That is safe, and it is also unreadable: a mail with a logo, a table of
 * figures or a photo arrived as a wall of text with bare URLs where the links had been, and the
 * images simply were not there. The comment justifying it was right about the danger — a stranger's
 * raw HTML must never run in our origin — but the answer to that is isolation, not deletion.
 *
 * HOW IT IS ISOLATED. The body goes into a `srcdoc` iframe with a `sandbox` attribute that grants
 * NEITHER `allow-scripts` NOR `allow-same-origin`. Without the second the frame is an opaque origin:
 * it cannot read our cookies, our storage or our DOM, and it cannot call our API even though the
 * browser would attach the session. Without the first, no script in the message runs at all. That is
 * the actual security boundary, and it is enforced by the browser rather than by our code.
 *
 * `scrubEmailHtml` is therefore DEFENCE IN DEPTH, not the control. It is deliberately blunt.
 *
 * WHAT LINKS DO. `allow-popups` plus a `<base target="_blank">` is what lets a link work at all —
 * a sandboxed frame may not navigate the page that contains it, so without these a click does
 * nothing. `allow-popups-to-escape-sandbox` means the opened tab is an ordinary tab rather than
 * another sandboxed one, which is what people expect when they click through to a website.
 *
 * REMOTE IMAGES ARE BLOCKED UNTIL ASKED FOR. Fetching an image from the sender's server is a report
 * that this message was opened, by this person, at this moment, from this IP — which is what a
 * tracking pixel is, and a one-pixel transparent GIF looks exactly like a layout image to us. So
 * nothing off-network loads until somebody presses Show images.
 *
 * INLINE IMAGES ARE NOT AFFECTED, and that distinction is the point of doing it this way. A `cid:`
 * image arrived WITH the message and is served from our own storage, so displaying it tells the
 * sender nothing at all. Blocking those too would mean logos and signatures — the images people
 * actually want — vanish in service of a privacy risk that does not exist for them. They are
 * resolved to `data:` URIs before the blocking pass runs, which is why the pass cannot touch them:
 * by then they are not remote references any more.
 */

/** Inline images are meant to be logos and signatures; past this a message is not worth inlining. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

/**
 * The `cid:` a message writes and the `content_id` we stored are the same value spelled differently.
 *
 * The database keeps the RFC form with angle brackets, `<abc@mail>`; the `src` attribute carries the
 * bare value, sometimes percent-encoded because it contains an `@`. Both sides come through here so
 * the comparison is made on one shape.
 */
const normalizeCid = (raw: string): string => {
  let v = raw.trim();
  try { v = decodeURIComponent(v); } catch { /* a stray % is not a reason to drop the image */ }
  return v.replace(/^<|>$/g, '').trim().toLowerCase();
};

/**
 * Strip what an email has no business carrying.
 *
 * Regex, not a parser, and that is a deliberate choice: this is the SECOND line of defence, behind
 * the sandbox, so its job is to be obvious rather than to be complete. A parser here would invite
 * the belief that the output is trustworthy HTML. It is not; it is untrusted HTML in a box.
 *
 * `<style>` deliberately SURVIVES. Inside the iframe the message's own CSS reaches nothing of ours,
 * and it is most of what makes a formatted email look like the sender meant it to.
 */
export const scrubEmailHtml = (html: string): string => html
  // Script, with its content — the content is the payload, so removing the tags alone would print it.
  .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
  .replace(/<\/?script\b[^>]*>/gi, '')
  // Nested frames, plugins, forms, and the tags that pull in or redirect to something else.
  .replace(/<\/?(?:iframe|frame|frameset|object|embed|applet|form|base|link|meta)\b[^>]*>/gi, '')
  // Inline event handlers: onclick, onerror, onload. Dead without `allow-scripts`, gone anyway.
  .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // Script-bearing URLs. `data:` survives for images — that is how the inline ones are injected —
  // but not `data:text/html`, which is a document pretending to be a resource.
  .replace(/\s(href|src|action|xlink:href)\s*=\s*(["'])\s*(?:javascript|vbscript|data:text\/html)[^"']*\2/gi, ' $1="#"')
  .replace(/\s(href|src|action|xlink:href)\s*=\s*(?:javascript|vbscript):[^\s>]*/gi, ' $1="#"')
  // A whole document is about to be placed inside one, so drop the outer skeleton and keep what it
  // wrapped. The tags go; the styles and the content they contained stay.
  .replace(/<!doctype[^>]*>/gi, '')
  .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '');

/**
 * Swap every `cid:` reference the message makes for the bytes we hold, quoted or bare.
 *
 * Exported, with `scrubEmailHtml`, because these two are the whole risk in this file — everything
 * else is a fetch and an iframe — and a pure function is the only part of it that can be checked
 * without a browser.
 */
export const resolveInlineImages = (html: string, byCid: Map<string, string>): string => html
  .replace(/(\ssrc\s*=\s*)(["'])\s*cid:([^"']+)\2/gi, (whole, pre: string, quote: string, raw: string) => {
    const uri = byCid.get(normalizeCid(raw));
    return uri ? `${pre}${quote}${uri}${quote}` : whole;
  })
  .replace(/(\ssrc\s*=\s*)cid:([^\s>]+)/gi, (whole, pre: string, raw: string) => {
    const uri = byCid.get(normalizeCid(raw));
    return uri ? `${pre}"${uri}"` : whole;
  });

/**
 * Anything that would make the browser fetch from the sender's server, and the count of them.
 *
 * RUN AFTER `resolveInlineImages`, never before. By that point a `cid:` image is a `data:` URI and
 * so cannot match any pattern here — which is exactly how "inline images always show, remote images
 * never do until asked" is enforced: by ordering, not by a second rule that could disagree.
 *
 * The four shapes are the four ways an email fetches an image without a script. `src` is the obvious
 * one; `srcset` is how a retina image slips past a check that only looked at `src`; `background=` is
 * the old table-layout attribute that most mail still uses; and `url(…)` covers both the `style`
 * attribute and everything inside a `<style>` block, which is where a background image hides in a
 * modern template. A pixel tracker can be any of them.
 *
 * The original URL is kept in a `data-blocked-*` attribute rather than deleted. Nothing reads it
 * today — pressing Show images re-renders from the untouched source — but a blocked image that has
 * silently lost its address is not recoverable, and the attribute makes what happened visible to
 * anybody inspecting the frame.
 */
export const blockRemoteAssets = (html: string): { html: string; blocked: number } => {
  let blocked = 0;
  const count = <T,>(v: T): T => { blocked++; return v; };
  // `https:`, `http:`, or protocol-relative `//host/…`, which resolves to https here.
  const REMOTE = String.raw`(?:https?:)?\/\/`;

  const out = html
    .replace(new RegExp(String.raw`(\ssrc\s*=\s*)(["'])\s*(${REMOTE}[^"']*)\2`, 'gi'),
      (_w, _pre: string, q: string, url: string) => count(` data-blocked-src=${q}${url}${q}`))
    .replace(new RegExp(String.raw`(\ssrc\s*=\s*)(${REMOTE}[^\s>]+)`, 'gi'),
      (_w, _pre: string, url: string) => count(` data-blocked-src="${url}"`))
    .replace(/\ssrcset\s*=\s*(["'])([^"']*)\1/gi,
      (whole, q: string, val: string) => (new RegExp(REMOTE).test(val) ? count(` data-blocked-srcset=${q}${val}${q}`) : whole))
    .replace(new RegExp(String.raw`(\sbackground\s*=\s*)(["'])\s*(${REMOTE}[^"']*)\2`, 'gi'),
      (_w, _pre: string, q: string, url: string) => count(` data-blocked-background=${q}${url}${q}`))
    /*
     * `url(…)`, however the delimiter is spelled — INCLUDING as an HTML entity.
     *
     * A real message got through the first version of this rule with
     * `style="background:url(&quot;https://…/BG_Desktop.png&quot;)"`. Because the style attribute is
     * itself double-quoted, the inner quotes have to be entities; a pattern that only knew about `'`
     * and `"` did not match, and the browser — which decodes entities before parsing the CSS —
     * fetched the image anyway. That is the whole failure mode of this kind of filter: it sees the
     * source text, the browser sees what the text MEANS.
     *
     * Matching to the closing paren rather than to a matching delimiter is deliberate. There is
     * nothing to be gained by parsing the URL precisely when the entire construct is being replaced.
     */
    .replace(new RegExp(String.raw`url\(\s*(?:&quot;|&#34;|&apos;|&#39;|["'])?\s*(?:${REMOTE})[^)]*\)`, 'gi'),
      () => count('none'))
    // SVG's own image reference. Rare in mail, but it fetches like any other and `href` cannot be
    // blocked wholesale — that is how every link in the message works.
    .replace(new RegExp(String.raw`(\sxlink:href\s*=\s*)(["'])\s*(${REMOTE}[^"']*)\2`, 'gi'),
      (_w, _pre: string, q: string, url: string) => count(` data-blocked-xlink=${q}${url}${q}`));

  return { html: out, blocked };
};

/**
 * The page the iframe actually loads.
 *
 * `img{max-width:100%}` is the one piece of our own styling that is not negotiable: mail is written
 * for a full-width client, and a 900px banner inside this modal would otherwise force the whole
 * body to scroll sideways.
 */
const shell = (body: string): string => `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<base target="_blank">
<style>
  html,body{margin:0;padding:0}
  body{font:13px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2937;word-break:break-word;padding:2px}
  img{max-width:100%;height:auto}
  /* A blocked image keeps its place rather than collapsing, so the layout still reads and it is
     obvious that something was withheld instead of missing. */
  img[data-blocked-src]{min-width:14px;min-height:14px;background:#f3f4f6;border:1px dashed #cbd5e1;border-radius:3px}
  table{max-width:100%}
  a{color:#1d4ed8}
  blockquote{margin:0 0 0 8px;padding-left:10px;border-left:2px solid #d1d5db;color:#4b5563}
</style>
</head><body>${body}</body></html>`;

/** A blob as a `data:` URI — the only form an image can take in an opaque-origin frame. */
const blobToDataUri = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
  reader.readAsDataURL(blob);
});

interface Props {
  area: Area;
  /**
   * The opened message, whole.
   *
   * Taken as one object rather than as `html` and `inlineImages` separately so the effect below has
   * a STABLE dependency. Passing `message.inline_images ?? []` from the parent would hand this a
   * fresh array on every render, and an effect that sets state on a dependency that changes every
   * render is a render loop.
   */
  message: MailboxMessage;
}

export default function MailBody({ area, message }: Props) {
  /**
   * The inline images, once fetched. `null` while that is still happening.
   *
   * Held as state of its OWN rather than folded into the document string, because the Show images
   * button rebuilds the document and must not re-download anything to do it. Fetching is keyed to
   * the message; rendering is keyed to the message and the choice.
   */
  const [byCid, setByCid] = useState<Map<string, string> | null>(null);
  const [showRemote, setShowRemote] = useState(false);

  useEffect(() => {
    let live = true;
    const fetchInline = async () => {
      const map = new Map<string, string>();
      let budget = MAX_INLINE_BYTES;

      for (const img of message.inline_images ?? []) {
        if (!img.content_id) continue;
        try {
          const blob = await fetchMailboxAttachmentBlob(area, 'received', img.id);
          // Checked after the fetch because the list carries no size — an inline image is not
          // offered as a download, so it has no size_bytes to filter on beforehand.
          if (blob.size > budget) continue;
          budget -= blob.size;
          map.set(normalizeCid(img.content_id), await blobToDataUri(blob));
        } catch {
          /*
           * One image that will not load is not a reason to withhold the message. The `cid:` is
           * left as it was, the browser shows a broken image, and everything else renders.
           */
        }
      }

      if (live) setByCid(map);
    };

    // A new message starts blocked again, however the last one was left. Consenting to a sender's
    // images once is not consent for the next sender's.
    setByCid(null);
    setShowRemote(false);
    void fetchInline();
    return () => { live = false; };
  }, [area, message]);

  /**
   * The document, and how much of it was withheld.
   *
   * Recomputed rather than patched when `showRemote` flips: the blocking pass throws the URL into a
   * `data-blocked-*` attribute, so unblocking by editing the rendered HTML would mean writing the
   * inverse of that transformation and keeping the two in step. Rebuilding from the original source
   * has one code path and cannot drift.
   */
  const { doc, blocked } = useMemo(() => {
    if (byCid === null) return { doc: null, blocked: 0 };
    const resolved = resolveInlineImages(scrubEmailHtml(message.body_html ?? ''), byCid);
    if (showRemote) return { doc: shell(resolved), blocked: 0 };
    const gated = blockRemoteAssets(resolved);
    return { doc: shell(gated.html), blocked: gated.blocked };
  }, [byCid, showRemote, message.body_html]);

  if (doc === null) return <p className="help">Loading message…</p>;

  return (
    <>
      {blocked > 0 && (
        /*
         * Outside the frame, not inside it. The frame has no scripts and no same-origin access, so
         * nothing in it could talk back to this component — the control has to live out here, which
         * is also where it belongs: it is our decision to present, not the sender's.
         */
        <div className="inbox-remote-note">
          <span>
            {blocked === 1
              ? 'One image was not loaded, to keep the sender from being told you opened this.'
              : `${blocked} images were not loaded, to keep the sender from being told you opened this.`}
          </span>
          <button className="btn ghost sm" type="button" onClick={() => setShowRemote(true)}>Show images</button>
        </div>
      )}
      <iframe
        className="inbox-html"
        title="Message"
        /*
         * No `allow-scripts` and no `allow-same-origin`. Adding either — and especially both together,
         * which cancels the sandbox outright — would put a stranger's markup back inside our origin.
         */
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={doc}
      />
    </>
  );
}
