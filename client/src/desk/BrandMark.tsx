import { useState, type CSSProperties } from 'react';
import { companyLogoUrl } from '../lib/api';

/**
 * The brokerage logo, wherever branding appears.
 *
 * The uploaded logo (Settings → Company → Brand Logo) is shown when one exists; otherwise
 * this falls back to the built-in text wordmark, so a brokerage that never uploads anything
 * still gets a proper letterhead. No data fetch is needed: the logo lives at a fixed public
 * URL, so a 404 simply means "none uploaded" and the fallback renders.
 *
 * `printDoc` clones the rendered HTML into a print window, so this must stay a plain <img>
 * with inline styles — a CSS class would not survive the copy.
 */

/** Bumped after an upload/removal so mounted components pick up the new file. */
let logoVersion = 0;
export const bumpLogoVersion = (): number => ++logoVersion;

/**
 * How tall the logo may render, in real pixels — one dial for every letterhead.
 *
 * This is a cap on the ARTWORK, because uploads are trimmed of their transparent border
 * server-side. Before trimming, a logo centred on a square canvas spent most of this
 * budget on empty space: a 750x750 file whose mark occupied only 205px of height rendered
 * the mark at barely a quarter of the cap. With the padding gone the number below is what
 * you actually see, so it is deliberately much smaller than the pre-trim equivalent.
 */
export const LOGO_MAX_HEIGHT = 86;

export interface BrandMarkProps {
  /** Maximum rendered height in pixels. Defaults to LOGO_MAX_HEIGHT. */
  height?: number;
  /** Accent colour of the fallback wordmark. */
  color?: string;
  /** Shown under the wordmark; omitted when a real logo is in use. */
  tagline?: string | false;
  /** Cache-buster; pass company settings' updated_at to refresh after a change. */
  version?: string | number | null;
  style?: CSSProperties;
}

/** The built-in wordmark — the letterhead used before any logo was uploaded. */
export function TextWordmark({ color = '#c8102e', tagline = '"A Tradition of Trust" — Brokerage', style }: {
  color?: string; tagline?: string | false; style?: CSSProperties;
}) {
  return (
    <div style={{ fontSize: 22, fontWeight: 800, color, letterSpacing: '-0.5px', ...style }}>
      GET<span style={{ color: '#0f172a' }}>&#9730;</span>HOME REALTY
      {tagline !== false && (
        <div style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic', fontWeight: 400 }}>{tagline}</div>
      )}
    </div>
  );
}

/**
 * Letterhead as an HTML string, for the emailed copies of documents. A plain string can't
 * carry React's onError fallback, so the caller says whether a logo exists (from company
 * settings) and gets either the image or the wordmark — never a broken-image icon in
 * someone's inbox.
 */
export function brandMarkHtml(hasLogo: boolean, opts: { height?: number; color?: string; tagline?: string | false; version?: string | number | null } = {}): string {
  const { height = LOGO_MAX_HEIGHT, color = '#c8102e', tagline = '"A Tradition of Trust" — Brokerage', version } = opts;
  if (hasLogo) {
    return `<img src="${companyLogoUrl(version ?? (logoVersion || null))}" alt="Brokerage logo" `
      + `style="max-height:${height}px;max-width:100%;width:auto;height:auto;`
      + `display:block;border:0;">`;
  }
  return `<div style="font-size:22px;font-weight:800;color:${color};letter-spacing:-0.5px">GET&#9730;HOME REALTY`
    + (tagline === false ? '' : `<div style="font-size:10px;color:#64748b;font-style:italic;font-weight:400">${tagline}</div>`)
    + `</div>`;
}

export default function BrandMark({ height = LOGO_MAX_HEIGHT, color, tagline, version, style }: BrandMarkProps) {
  // `failed` flips on a 404 (no logo uploaded) or an unreadable file.
  const [failed, setFailed] = useState(false);
  if (failed) return <TextWordmark color={color} tagline={tagline} style={style} />;
  return (
    <img
      src={companyLogoUrl(version ?? (logoVersion || null))}
      alt="Brokerage logo"
      onError={() => setFailed(true)}
      style={{
        // Sized by CAPS, not a fixed height. A fixed height plus a width cap makes the
        // browser letterbox the image inside a tall box — it stays small and gains a band
        // of whitespace. Capping both dimensions instead lets the logo grow to whatever
        // its aspect ratio and the letterhead allow, with no distortion and no overflow.
        maxHeight: height,
        maxWidth: '100%',
        width: 'auto',
        height: 'auto',
        display: 'block',
        ...style,
      }}
    />
  );
}
