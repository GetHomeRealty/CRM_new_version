import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-137 — the calendar chips belong to the same theme as the page they sit on.
 *
 * THE DEFECT. Anyone whose computer is set to dark mode saw a calendar of dark maroon, navy and
 * bottle-green blocks on a white page — `--ev-closing-bg` computing to #5c1a1a against a body of
 * rgb(246,247,251). It reads as broken rather than as a theme, and the text contrast was never
 * designed for that pairing.
 *
 * THE CAUSE IS A GUARD THAT NEVER CLOSES. The dark custom properties are declared under
 * `@media (prefers-color-scheme: dark)` behind `:root:where(:not([data-theme="light"]))` — dark
 * UNLESS the page says it is light. Nothing ever said: the document root carried no `data-theme`
 * attribute at all. So the media query matched on any dark-mode machine, the guard let it through,
 * and the chips went dark while everything around them stayed light.
 *
 * LIGHT IS THE ONLY THEME THIS APPLICATION SHIPS. The Theme preference was removed from CRM
 * Settings precisely because nothing read it — "saved as `dark`, page stayed light, no `data-theme`
 * attribute, no stylesheet consulting it". So the document now declares what it actually renders.
 *
 * The load-bearing assertion here is not that the attribute exists — it is that EVERY dark block is
 * behind the guard the attribute closes. One unguarded block added later would reopen this defect
 * while the attribute sat there looking like a fix.
 */

const CLIENT = join(__dirname, '..', '..', '..', 'client');
const INDEX = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const CSS = readFileSync(join(CLIENT, 'src', 'styles', 'desk.css'), 'utf8');

/** The markup as it is served — the note explaining the fault is not the fault. */
const markup = INDEX.replace(/<!--[\s\S]*?-->/g, '');

describe('the page says which theme it renders (TD-137)', () => {
  it('stamps data-theme on the document root', () => {
    expect(markup).toMatch(/<html[^>]*\sdata-theme="light"/);
  });

  it('stamps it in the markup, not from a script', () => {
    /*
     * A script would repaint after first render: the dark chips would appear and then correct
     * themselves, which reads as a fault of its own. The attribute has to be there before the first
     * paint, which means the served HTML.
     */
    const at = markup.indexOf('data-theme="light"');
    // Guarded against -1: "not found" is less than the body index too, so a bare comparison would
    // pass on markup that never stamps the attribute at all.
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(markup.indexOf('<body'));
    expect(markup).not.toMatch(/setAttribute\(\s*['"]data-theme/);
  });

  it('tells the browser too, so scrollbars and form controls match', () => {
    // `color-scheme` themes the parts the stylesheet does not own. Without it a viewer in OS dark
    // mode gets dark scrollbars framing a light page — the same mismatch, one layer out.
    expect(CSS).toMatch(/:root\{color-scheme:light\}/);
  });
});

describe('every dark rule is behind the guard the attribute closes (TD-137)', () => {
  /** Each `@media (prefers-color-scheme: dark)` block, with the selector that follows it. */
  const darkBlocks = [...CSS.matchAll(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([^{]*)\{/g)]
    .map((m) => m[1].trim());

  it('finds the dark blocks at all, so the check below is not vacuous', () => {
    // If the regex stopped matching, every assertion in the loop would run zero times and pass.
    expect(darkBlocks.length).toBeGreaterThanOrEqual(3);
  });

  it('guards each one on :not([data-theme="light"])', () => {
    for (const selector of darkBlocks) {
      expect([selector, selector.includes('[data-theme="light"]')]).toEqual([selector, true]);
    }
  });
});

describe('the light chip colours are the ones that render (TD-137)', () => {
  it('declares a light fallback for every event type', () => {
    /*
     * THE SHAPE, NOT THE COLOUR. An earlier version of this test pinned the exact hexes — closing
     * to #fee2e2 and so on — and 72cb6c8 broke it by making the closing chip ink on purpose, which
     * is a design decision and none of this entry's business. What TD-137 is about is that each
     * chip HAS a light value to fall back to, so that when the dark tokens stop being declared
     * there is something light to render. The palette belongs to whoever is designing it.
     */
    for (const chip of ['ev-closing', 'ev-viewing', 'ev-meeting', 'ev-call']) {
      // Read as plain text rather than a regex: the prefix is fixed, and what has to follow it is
      // simply a colour rather than nothing.
      const prefix = `.${chip}{background:var(--${chip}-bg,`;
      const at = CSS.indexOf(prefix);
      expect([chip, at]).not.toEqual([chip, -1]);
      const fallback = CSS.slice(at + prefix.length, CSS.indexOf(')', at));
      expect([chip, /^#[0-9a-f]{3,8}$/i.test(fallback.trim())]).toEqual([chip, true]);
    }
  });

  it('leaves the explicit dark theme intact for when one is built', () => {
    // `:root[data-theme="dark"]` is not touched: it is how a real dark theme would be switched on,
    // and it is a different thing from the OS preference leaking into a light page.
    expect(CSS).toContain(':root[data-theme="dark"]');
  });
});
