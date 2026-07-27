import { useState } from 'react';

/**
 * A block-based visual builder for email templates.
 *
 * You stack granular blocks — image, heading, paragraph, button, divider, spacer, columns, plus a
 * highlight box and a list — and each produces email-safe inline-CSS HTML. A "Styles" tab holds
 * template-wide settings (a standard branded header, accent and background colours). The whole
 * model (blocks + styles) is base64-embedded in the saved HTML as a comment, so re-opening a
 * builder-made template restores it exactly; a hand-written template has no marker and opens in
 * HTML mode instead.
 */

export type Align = 'left' | 'center' | 'right';

export type Block =
  | { type: 'image'; url: string; alt: string; align: Align; width: number; link?: string }
  | { type: 'heading'; text: string; level: 1 | 2 | 3; align: Align; color: string }
  | { type: 'paragraph'; text: string; align: Align }
  | { type: 'button'; text: string; url: string; color: string; textColor?: string; align: Align }
  | { type: 'divider' }
  | { type: 'spacer'; height: number }
  | { type: 'columns'; left: string; right: string; leftImg?: string; rightImg?: string }
  | { type: 'box'; title: string; body: string; color: string }
  | { type: 'list'; title: string; items: string }
  // Combined banner — gradient header with an optional logo (image or text), heading and subtitle.
  | { type: 'banner'; text: string; subtitle?: string; logo?: string; logoText?: string; color: string; color2?: string };

export interface Styles {
  header: boolean; footer: boolean;
  logo: string; brandName: string; brand: string; accent: string; bg: string;
  footerText: string;
}

export interface Design { blocks: Block[]; styles: Styles }

export const DEFAULT_STYLES: Styles = {
  header: false, footer: false, logo: '', brandName: 'Get Home Realty', brand: '#dc2626',
  accent: '#dc2626', bg: '#ffffff', footerText: '',
};
const STD_FOOTER = '"A Tradition of Trust" — Brokerage\n{{AGENT_NAME}} · {{AGENT_EMAIL}} · {{AGENT_PHONE}}';
const MARKER = 'BUILDER:';

export const newBlock = (type: Block['type']): Block => {
  switch (type) {
    case 'image': return { type: 'image', url: '', alt: '', align: 'center', width: 100 };
    case 'heading': return { type: 'heading', text: 'Your heading', level: 2, align: 'left', color: '#111827' };
    case 'paragraph': return { type: 'paragraph', text: 'Dear {{LEAD_NAME}},\n\nWrite your message here.', align: 'left' };
    case 'button': return { type: 'button', text: 'Reply to This Email', url: 'mailto:{{AGENT_EMAIL}}', color: '#dc2626', textColor: '#ffffff', align: 'center' };
    case 'divider': return { type: 'divider' };
    case 'spacer': return { type: 'spacer', height: 24 };
    case 'columns': return { type: 'columns', left: 'Left column text.', right: 'Right column text.', leftImg: '', rightImg: '' };
    case 'box': return { type: 'box', title: 'Section title', body: 'A highlighted point.\nAnother line.', color: '#2563eb' };
    case 'list': return { type: 'list', title: 'Next steps', items: 'Schedule a viewing\nDiscuss financing\nMake an offer' };
    case 'banner': return { type: 'banner', text: 'Your headline', subtitle: '', logo: '', logoText: 'Get Home Realty', color: '#dc2626', color2: '#7c3aed' };
  }
};

export const starterDesign = (): Design => ({
  styles: { ...DEFAULT_STYLES, header: true, footer: true, footerText: STD_FOOTER },
  blocks: [
    { type: 'heading', text: 'Still Here to Help, {{LEAD_NAME}}', level: 1, align: 'center', color: '#111827' },
    { type: 'paragraph', text: 'Dear {{LEAD_NAME}},\n\nWrite your message here.', align: 'left' },
    { type: 'box', title: 'How I Can Help', body: 'Send you fresh listings\nArrange a viewing that suits you', color: '#dc2626' },
    { type: 'button', text: 'Reply to This Email', url: 'mailto:{{AGENT_EMAIL}}', color: '#dc2626', align: 'center' },
  ],
});

const esc = (s: string): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const brs = (s: string): string => esc(s).replace(/\n/g, '<br>');
function tint(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return `rgba(37,99,235,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function blockHtml(b: Block): string {
  switch (b.type) {
    case 'image': {
      const img = `<img src="${esc(b.url)}" alt="${esc(b.alt)}" style="width:${b.width}%;max-width:100%;display:inline-block;border:0;">`;
      const inner = b.link ? `<a href="${esc(b.link)}" style="text-decoration:none;">${img}</a>` : img;
      return `<div style="text-align:${b.align};margin:14px 4px;">${inner}</div>`;
    }
    case 'heading': {
      const size = b.level === 1 ? 26 : b.level === 2 ? 21 : 17;
      return `<h${b.level} style="text-align:${b.align};color:${b.color};font-family:Arial,Helvetica,sans-serif;font-size:${size}px;font-weight:700;line-height:1.3;margin:16px 4px;">${esc(b.text)}</h${b.level}>`;
    }
    case 'paragraph':
      return `<p style="text-align:${b.align};font-size:15px;line-height:1.65;color:#1f2937;margin:14px 4px;">${brs(b.text)}</p>`;
    case 'button':
      return `<div style="text-align:${b.align};margin:20px 4px;"><a href="${esc(b.url)}" style="display:inline-block;background:${b.color};color:${b.textColor ?? '#ffffff'};text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600;font-size:15px;">${esc(b.text)}</a></div>`;
    case 'divider':
      return `<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 4px;">`;
    case 'spacer':
      return `<div style="height:${Math.max(0, b.height)}px;line-height:${Math.max(0, b.height)}px;font-size:1px;">&nbsp;</div>`;
    case 'columns': {
      const cell = (text: string, img?: string): string =>
        `<td valign="top" style="width:50%;padding:0 8px;font-size:14px;line-height:1.6;color:#334155;">`
        + (img ? `<img src="${esc(img)}" alt="" style="width:100%;max-width:100%;display:block;border:0;border-radius:6px;margin-bottom:8px;">` : '')
        + `${brs(text)}</td>`;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0;"><tr>`
        + cell(b.left, b.leftImg) + cell(b.right, b.rightImg)
        + `</tr></table>`;
    }
    case 'box':
      return `<div style="background:${tint(b.color, 0.08)};border-left:4px solid ${b.color};border-radius:8px;padding:15px 18px;margin:16px 4px;">`
        + `<div style="color:${b.color};font-weight:700;font-size:15px;margin-bottom:7px;">${esc(b.title)}</div>`
        + `<div style="color:#334155;font-size:14px;line-height:1.65;">${brs(b.body)}</div></div>`;
    case 'list': {
      const items = b.items.split('\n').map((i) => i.trim()).filter(Boolean).map((i) => `<li style="margin:4px 0;">${esc(i)}</li>`).join('');
      return `<div style="margin:16px 4px;">${b.title ? `<div style="font-weight:700;font-size:15px;margin-bottom:6px;color:#1f2937;">${esc(b.title)}</div>` : ''}`
        + `<ul style="margin:0;padding-left:20px;color:#334155;font-size:14px;line-height:1.6;">${items}</ul></div>`;
    }
    case 'banner': {
      const bg = b.color2 ? `background:${b.color};background:linear-gradient(135deg,${b.color},${b.color2});` : `background:${b.color};`;
      // A real logo image if one is given; otherwise a clean text logo, so there's never a broken
      // image where the brand should be.
      const logo = b.logo
        ? `<img src="${esc(b.logo)}" alt="${esc(b.logoText ?? '')}" style="max-height:46px;margin:0 auto 14px;display:block;">`
        : b.logoText
          ? `<div style="font-size:15px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;margin-bottom:14px;">${esc(b.logoText)}</div>`
          : '';
      const sub = b.subtitle ? `<div style="font-size:14px;font-weight:400;opacity:.92;margin-top:9px;">${esc(b.subtitle)}</div>` : '';
      return `<div style="${bg}color:#ffffff;padding:${logo ? '30px' : '38px'} 24px 34px;text-align:center;border-radius:10px 10px 0 0;">${logo}<div style="font-size:26px;font-weight:700;line-height:1.25;">${esc(b.text)}</div>${sub}</div>`;
    }
  }
}

/** The fixed branded header shown above the content when Styles → Standard header is on. */
function headerHtml(s: Styles): string {
  if (!s.header) return '';
  const logo = s.logo
    ? `<img src="${s.logo}" alt="${esc(s.brandName)}" style="max-height:48px;display:inline-block;border:0;">`
    : `<div style="font-size:18px;font-weight:800;color:${s.brand};letter-spacing:.04em;text-transform:uppercase;">${esc(s.brandName || 'Your Logo')}</div>`;
  return `<div style="text-align:center;padding:12px 24px 10px;background:#ffffff;">${logo}</div><div style="height:3px;background:${s.accent};"></div>`;
}

/** The fixed branded footer shown below the content when Styles → Standard footer is on. */
function footerHtml(s: Styles): string {
  if (!s.footer) return '';
  return `<div style="border-top:1px solid #e5e7eb;background:#f8fafc;padding:22px 24px;text-align:center;font-size:12px;line-height:1.7;color:#94a3b8;">`
    + (s.brandName ? `<div style="font-weight:800;color:${s.brand};letter-spacing:.04em;text-transform:uppercase;">${esc(s.brandName)}</div>` : '')
    + (s.footerText ? `<div style="margin-top:4px;">${brs(s.footerText)}</div>` : '')
    + `</div>`;
}

const b64encode = (s: string): string => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s: string): string => decodeURIComponent(escape(atob(s)));

/** Full email HTML for a design, with the model embedded so it can be re-edited. */
export function renderBuilder(blocks: Block[], styles: Styles = DEFAULT_STYLES): string {
  const marker = `<!--${MARKER}${b64encode(JSON.stringify({ v: 2, blocks, styles }))}-->`;
  const body = blocks.map(blockHtml).join('\n');
  return `${marker}\n<div style="max-width:600px;margin:0 auto;background:${styles.bg};font-family:Arial,Helvetica,sans-serif;">\n${headerHtml(styles)}\n${body}\n${footerHtml(styles)}\n</div>`;
}

/** Pull the design back out of a builder-made template; null if it wasn't built here. */
export function parseBuilder(content: string): Design | null {
  const m = new RegExp(`<!--${MARKER}([A-Za-z0-9+/=]*)-->`).exec(content ?? '');
  if (!m) return null;
  try {
    const parsed = JSON.parse(b64decode(m[1]));
    // v1 stored a bare block array; v2 stores { blocks, styles }.
    if (Array.isArray(parsed)) return { blocks: parsed as Block[], styles: { ...DEFAULT_STYLES } };
    if (parsed && Array.isArray(parsed.blocks)) {
      return { blocks: parsed.blocks as Block[], styles: { ...DEFAULT_STYLES, ...(parsed.styles ?? {}) } };
    }
    return null;
  } catch {
    return null;
  }
}

const COLORS = ['#dc2626', '#f97316', '#f59e0b', '#16a34a', '#0ea5e9', '#2563eb', '#7c3aed', '#111827'];

/** Read a picked image file into a base64 data URI so it can be embedded straight into the email. */
const fileToDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result ?? ''));
  r.onerror = () => reject(new Error('That image could not be read.'));
  r.readAsDataURL(file);
});

/** The editing surface: a palette + Blocks/Styles tabs, then each block with its own controls. */
export function TemplateBuilder({ blocks, setBlocks, styles, setStyles }: {
  blocks: Block[]; setBlocks: (b: Block[]) => void;
  styles: Styles; setStyles: (s: Styles) => void;
}) {
  const [tab, setTab] = useState<'blocks' | 'styles'>('blocks');

  const update = (i: number, patch: Partial<Block>) =>
    setBlocks(blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as Block) : b)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = blocks.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setBlocks(next);
  };
  const remove = (i: number) => setBlocks(blocks.filter((_, j) => j !== i));
  const add = (type: Block['type']) => setBlocks([...blocks, newBlock(type)]);

  const swatch = (value: string, onPick: (c: string) => void) => (
    <div className="tb-colors">
      {COLORS.map((c) => (
        <button key={c} type="button" className={`tb-swatch${value === c ? ' on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => onPick(c)} />
      ))}
      <input type="color" value={value} onChange={(e) => onPick(e.target.value)} title="Custom colour" />
    </div>
  );
  const alignBtns = (value: Align, onPick: (a: Align) => void) => (
    <div className="tb-seg">
      {(['left', 'center', 'right'] as Align[]).map((a) => (
        <button key={a} type="button" className={`tb-seg-b${value === a ? ' on' : ''}`} onClick={() => onPick(a)} title={a}>
          {a === 'left' ? '⯇' : a === 'center' ? '≡' : '⯈'}
        </button>
      ))}
    </div>
  );

  const PALETTE: { type: Block['type']; label: string; ico: string }[] = [
    { type: 'banner', label: 'Banner', ico: '▬' },
    { type: 'image', label: 'Image', ico: '🖼' }, { type: 'heading', label: 'Heading', ico: 'H' },
    { type: 'paragraph', label: 'Paragraph', ico: '¶' }, { type: 'button', label: 'Button', ico: '⬢' },
    { type: 'divider', label: 'Divider', ico: '―' }, { type: 'spacer', label: 'Spacer', ico: '↕' },
    { type: 'columns', label: 'Columns', ico: '▥' }, { type: 'box', label: 'Highlight box', ico: '▣' },
    { type: 'list', label: 'List', ico: '☰' },
  ];

  return (
    <div className="tb2">
      <div className="tb2-side">
        <div className="tb2-tabs">
          <button type="button" className={`tb2-tab${tab === 'blocks' ? ' on' : ''}`} onClick={() => setTab('blocks')}>Blocks</button>
          <button type="button" className={`tb2-tab${tab === 'styles' ? ' on' : ''}`} onClick={() => setTab('styles')}>Styles</button>
        </div>

        {tab === 'blocks' ? (
          <>
            <div className="tb2-plabel">Content blocks</div>
            <div className="tb2-palette">
              {PALETTE.map((p) => (
                <button key={p.type} type="button" className="tb2-pblock" onClick={() => add(p.type)}>
                  <span className="tb2-pico">{p.ico}</span>{p.label}
                </button>
              ))}
            </div>
            <p className="help" style={{ marginTop: 8 }}>Click a block to add it to the bottom of your email.</p>
          </>
        ) : (
          <div className="tb2-styles">
            <label className="acct-toggle">
              <input type="checkbox" checked={styles.header} onChange={(e) => setStyles({ ...styles, header: e.target.checked })} />
              <span><strong>Standard header</strong><span className="muted"> — logo + accent line at the top.</span></span>
            </label>
            <label className="acct-toggle">
              <input type="checkbox" checked={styles.footer} onChange={(e) => setStyles({ ...styles, footer: e.target.checked })} />
              <span><strong>Standard footer</strong><span className="muted"> — brand + contact at the bottom.</span></span>
            </label>
            <div className="field"><label>Brand name</label><input value={styles.brandName} onChange={(e) => setStyles({ ...styles, brandName: e.target.value })} placeholder="Get Home Realty" /></div>
            <div className="field"><label>Logo image (URL or data:image…)</label><input value={styles.logo} onChange={(e) => setStyles({ ...styles, logo: e.target.value })} placeholder="Header logo (falls back to the brand name)" /></div>
            <div className="field"><label>Footer text</label><textarea rows={3} value={styles.footerText} onChange={(e) => setStyles({ ...styles, footerText: e.target.value })} placeholder={'"A Tradition of Trust" — Brokerage\n{{AGENT_NAME}} · {{AGENT_EMAIL}} · {{AGENT_PHONE}}'} /></div>
            <div className="field"><label>Brand / footer colour</label>{swatch(styles.brand, (c) => setStyles({ ...styles, brand: c }))}</div>
            <div className="field"><label>Accent line colour</label>{swatch(styles.accent, (c) => setStyles({ ...styles, accent: c }))}</div>
            <div className="field"><label>Background</label>{swatch(styles.bg, (c) => setStyles({ ...styles, bg: c }))}</div>
          </div>
        )}
      </div>

      <div className="tb2-canvas">
        {styles.header && (
          <div className="tb2-locked">🔒 Standard header <span className="muted">— edit in the Styles tab</span></div>
        )}

        {blocks.length === 0 && <p className="help">Add a block from the left to start building.</p>}

        {blocks.map((b, i) => (
          <div key={i} className="tb2-block">
            <div className="tb2-bhead">
              <span className="tb2-btype">{b.type}</span>
              <div className="tb2-btools">
                <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} title="Move up">↑</button>
                <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} title="Move down">↓</button>
                <button type="button" className="icon-btn danger" onClick={() => remove(i)} title="Remove">🗑️</button>
              </div>
            </div>
            <div className="tb2-bbody">
              {b.type === 'image' && (
                <>
                  <label className="tb2-drop">
                    {b.url
                      ? <img src={b.url} alt="" style={{ maxHeight: 90, maxWidth: '100%', borderRadius: 6 }} />
                      : <span className="tb2-drop-hint">⬆ Click to upload image</span>}
                    <input type="file" accept="image/*" style={{ display: 'none' }}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void fileToDataUrl(f).then((d) => update(i, { url: d })); e.currentTarget.value = ''; }} />
                  </label>
                  <input value={b.url} onChange={(e) => update(i, { url: e.target.value })} placeholder="or paste an image URL" />
                  <input value={b.alt} onChange={(e) => update(i, { alt: e.target.value })} placeholder="Alt text" />
                  <input value={b.link ?? ''} onChange={(e) => update(i, { link: e.target.value })} placeholder="Link URL (optional)" />
                  <div className="tb2-row">{alignBtns(b.align, (a) => update(i, { align: a }))}
                    <label className="tb2-width">Width <input type="range" min={20} max={100} value={b.width} onChange={(e) => update(i, { width: Number(e.target.value) })} /> {b.width}%</label>
                  </div>
                </>
              )}
              {b.type === 'heading' && (
                <>
                  <input value={b.text} onChange={(e) => update(i, { text: e.target.value })} placeholder="Heading text" />
                  <div className="tb2-row">
                    <div className="tb-seg">
                      {([1, 2, 3] as const).map((l) => <button key={l} type="button" className={`tb-seg-b${b.level === l ? ' on' : ''}`} onClick={() => update(i, { level: l })}>H{l}</button>)}
                    </div>
                    {alignBtns(b.align, (a) => update(i, { align: a }))}
                    <span className="muted">Colour</span>{swatch(b.color, (c) => update(i, { color: c }))}
                  </div>
                </>
              )}
              {b.type === 'paragraph' && (
                <>
                  <textarea rows={3} value={b.text} onChange={(e) => update(i, { text: e.target.value })} placeholder="Your message. Use {{LEAD_NAME}} etc." />
                  {alignBtns(b.align, (a) => update(i, { align: a }))}
                </>
              )}
              {b.type === 'button' && (
                <>
                  <input value={b.text} onChange={(e) => update(i, { text: e.target.value })} placeholder="Button label" />
                  <input value={b.url} onChange={(e) => update(i, { url: e.target.value })} placeholder="Link (https:// or mailto:)" />
                  <div className="tb2-row">
                    {alignBtns(b.align, (a) => update(i, { align: a }))}
                    <span className="muted">Fill</span>{swatch(b.color, (c) => update(i, { color: c }))}
                    <span className="muted">Text</span>{swatch(b.textColor ?? '#ffffff', (c) => update(i, { textColor: c }))}
                  </div>
                </>
              )}
              {b.type === 'spacer' && (
                <label className="tb2-width">Height <input type="range" min={4} max={80} value={b.height} onChange={(e) => update(i, { height: Number(e.target.value) })} /> {b.height}px</label>
              )}
              {b.type === 'columns' && (
                <div className="g2">
                  {([['leftImg', 'left'], ['rightImg', 'right']] as const).map(([imgKey, textKey], side) => (
                    <div key={imgKey} className="tb2-col">
                      <label className="tb2-drop tb2-drop-sm">
                        {b[imgKey]
                          ? <img src={b[imgKey]} alt="" style={{ maxHeight: 64, maxWidth: '100%', borderRadius: 6 }} />
                          : <span className="tb2-drop-hint">⬆ Image (optional)</span>}
                        <input type="file" accept="image/*" style={{ display: 'none' }}
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) void fileToDataUrl(f).then((d) => update(i, { [imgKey]: d })); e.currentTarget.value = ''; }} />
                      </label>
                      <div className="tb2-row">
                        <input value={b[imgKey] ?? ''} onChange={(e) => update(i, { [imgKey]: e.target.value })} placeholder="or image URL" style={{ flex: 1 }} />
                        {b[imgKey] && <button type="button" className="icon-btn danger" title="Remove image" onClick={() => update(i, { [imgKey]: '' })}>🗑️</button>}
                      </div>
                      <textarea rows={3} value={b[textKey]} onChange={(e) => update(i, { [textKey]: e.target.value })} placeholder={`${side === 0 ? 'Left' : 'Right'} column text`} />
                    </div>
                  ))}
                </div>
              )}
              {b.type === 'box' && (
                <>
                  <input value={b.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Box title" />
                  <textarea rows={3} value={b.body} onChange={(e) => update(i, { body: e.target.value })} placeholder="One point per line" />
                  {swatch(b.color, (c) => update(i, { color: c }))}
                </>
              )}
              {b.type === 'list' && (
                <>
                  <input value={b.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="List title (optional)" />
                  <textarea rows={3} value={b.items} onChange={(e) => update(i, { items: e.target.value })} placeholder="One item per line" />
                </>
              )}
              {b.type === 'banner' && (
                <>
                  <input value={b.text} onChange={(e) => update(i, { text: e.target.value })} placeholder="Headline" />
                  <input value={b.subtitle ?? ''} onChange={(e) => update(i, { subtitle: e.target.value })} placeholder="Subtitle (optional)" />
                  <input value={b.logoText ?? ''} onChange={(e) => update(i, { logoText: e.target.value })} placeholder="Logo text (shown if no image)" />
                  <input value={b.logo ?? ''} onChange={(e) => update(i, { logo: e.target.value })} placeholder="Logo image (URL or data:image…)" />
                  <div className="tb2-row"><span className="muted">Colour</span>{swatch(b.color, (c) => update(i, { color: c }))}</div>
                  <div className="tb2-row"><span className="muted">Gradient to</span>{swatch(b.color2 ?? b.color, (c) => update(i, { color2: c }))}
                    {b.color2 && <button type="button" className="btn ghost sm" onClick={() => update(i, { color2: '' })}>Solid</button>}
                  </div>
                </>
              )}
              {b.type === 'divider' && <div className="help">A horizontal line.</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
