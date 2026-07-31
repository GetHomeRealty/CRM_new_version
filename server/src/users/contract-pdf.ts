import pdfMake from 'pdfmake';
import type { Content, ContentCanvas, ContentTable, TDocumentDefinitions, TableCell } from 'pdfmake/interfaces';

/**
 * The contract agreement as a PDF, rendered from the same HTML the review screen shows.
 *
 * Built from the message rather than from a second layout definition on purpose: the agreement an
 * agent signs must be the one that was read and approved on screen, down to a sentence corrected for
 * this one agent. A separate pdfmake definition would drift from the template the first time anybody
 * edited it, and nothing would say so.
 *
 * That means converting HTML, and this converter handles only what the template uses — paragraphs,
 * lists, inline emphasis, links, line breaks and a two-column table. Anything else falls back to its
 * text, which keeps a clause an admin pasted in from disappearing silently even if it loses styling.
 */

const FONTS = {
  // The 14 standard PDF fonts need no files: every reader has them, and nothing has to ship.
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
};

/**
 * The built-in PDF fonts, which pdfmake asks the local access policy about by name before pdfkit
 * resolves them from its own bundle. They have to be allowed through or nothing can be measured.
 */
const STANDARD_FONTS = new Set([
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Symbol', 'ZapfDingbats',
]);

let configured = false;
function configure(): void {
  if (configured) return;
  pdfMake.addFonts(FONTS);
  // The body is editable, so it is untrusted input as far as resource loading goes: a template able
  // to pull a URL or a path would turn document generation into a way to read this server. Only the
  // standard font names get through; embedded `data:` images need no policy.
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy((target) => STANDARD_FONTS.has(target));
  configured = true;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', deg: '°',
};

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith('#')) {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * The marks the paper agreement is set with — a tick against every term, an arrowhead against every
 * section heading.
 *
 * Drawn rather than typed. The glyphs the form uses (✓, ➢) are absent from the standard PDF fonts,
 * so a literal character would arrive as a blank or a substitute, and the alternative — embedding a
 * Unicode font — would put a megabyte of typeface into the repository to print two shapes.
 */
const MARK_COLOR = '#111827';

const checkMark = (): ContentCanvas => ({
  canvas: [{
    type: 'polyline',
    lineWidth: 1.05,
    lineColor: MARK_COLOR,
    points: [{ x: 0, y: 3.1 }, { x: 1.9, y: 5.1 }, { x: 5.6, y: 0.3 }],
  }],
});

const arrowHead = (): ContentCanvas => ({
  canvas: [{
    type: 'polyline',
    closePath: true,
    color: MARK_COLOR,
    points: [{ x: 0, y: 0 }, { x: 4.4, y: 2.4 }, { x: 0, y: 4.8 }],
  }],
});

/** Put a drawn mark beside a block, the way the form sets its lists and headings. */
function marked(mark: ContentCanvas, body: Content, indent: number, top = 2.2): Content {
  return {
    columns: [
      { width: 8, stack: [{ ...mark, margin: [0, top, 0, 0] as [number, number, number, number] }] },
      { width: '*', stack: [body] },
    ],
    columnGap: 4,
    margin: [indent, 0, 0, 0],
  };
}

/** Inline formatting carried down the tree — pdfmake wants it on each text run. */
interface Marks { bold?: boolean; italics?: boolean; color?: string; link?: string; fontSize?: number; alignment?: 'center' | 'left' | 'right' }

/** The handful of CSS declarations the template uses to say something a PDF should keep. */
function marksFromStyle(style: string, inherited: Marks): Marks {
  const out: Marks = { ...inherited };
  const value = (name: string): string => {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(style);
    return m ? m[1].trim() : '';
  };
  const color = value('color');
  if (/^#[0-9a-f]{3,8}$/i.test(color)) out.color = color;
  const align = value('text-align');
  if (align === 'center' || align === 'right' || align === 'left') out.alignment = align;
  if (/^(bold|[6-9]00)$/i.test(value('font-weight'))) out.bold = true;
  if (/^italic$/i.test(value('font-style'))) out.italics = true;
  const size = /^([\d.]+)px$/i.exec(value('font-size'));
  // px to points, the ratio every browser uses at default zoom.
  if (size) out.fontSize = Math.round(Number(size[1]) * 0.75 * 10) / 10;
  return out;
}

type Token =
  | { kind: 'open'; name: string; style: string; href: string; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string };

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /<!--[\s\S]*?-->|<\/([a-z][a-z0-9]*)\s*>|<([a-z][a-z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>|([^<]+)/gi;
  for (let m = pattern.exec(html); m; m = pattern.exec(html)) {
    const [whole, closeName, openName, attrs, slash, text] = m;
    if (whole.startsWith('<!--')) continue;
    if (closeName) { tokens.push({ kind: 'close', name: closeName.toLowerCase() }); continue; }
    if (openName) {
      const style = /style\s*=\s*"([^"]*)"/i.exec(attrs ?? '')?.[1] ?? '';
      const href = /href\s*=\s*"([^"]*)"/i.exec(attrs ?? '')?.[1] ?? '';
      const name = openName.toLowerCase();
      tokens.push({ kind: 'open', name, style, href, selfClosing: slash === '/' || VOID_TAGS.has(name) });
      continue;
    }
    if (text) tokens.push({ kind: 'text', text });
  }
  return tokens;
}

const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link']);
/** Tags that end a run of text, so a paragraph is not glued to the list that follows it. */
const BLOCK_TAGS = new Set(['p', 'div', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'br']);

/**
 * Walk the tokens, building pdfmake content. One pass, with an explicit stack rather than recursion:
 * the input is a flat token list and mail-safe HTML nests shallowly.
 */
function convert(html: string): Content[] {
  const tokens = tokenize(html);
  const root: Content[] = [];
  // Each frame collects content for one container; `marks` is the formatting in force inside it.
  const stack: { name: string; marks: Marks; runs: Content[]; children: Content[] }[] = [
    { name: 'root', marks: {}, runs: [], children: root },
  ];

  const top = (): (typeof stack)[0] => stack[stack.length - 1];

  /** True while anything is being written inside a table cell, where section markers do not belong. */
  const insideTable = (): boolean => stack.some((f) => f.name === 'table');

  /** Close the current run of inline text into the frame's children as one paragraph. */
  const flush = (frame = top()): void => {
    if (!frame.runs.length) return;
    const runs = frame.runs;
    frame.runs = [];
    const onlyWhitespace = runs.every((r) => typeof r === 'object' && 'text' in r && !String(r.text).trim());
    if (onlyWhitespace) return;

    const paragraph: Content = { text: runs, margin: [0, 0, 0, 3.5], alignment: frame.marks.alignment };

    // A section heading on the paper form carries an arrowhead: "➢ Key Terms:". They are the
    // paragraphs that open in bold — "Agent Type:", "Commission Structure:", "Termination:" — which
    // is what tells them apart from a numbered party or a sentence that merely contains bold. The
    // centred title and the names inside the signature boxes are bold too, hence both exclusions.
    const first = runs[0];
    const opensBold = typeof first === 'object' && first !== null && 'text' in first
      && (first as { bold?: boolean }).bold === true && String((first as { text: unknown }).text).trim().length > 0;
    if (opensBold && frame.marks.alignment !== 'center' && !insideTable()) {
      frame.children.push(marked(arrowHead(), paragraph, 2));
      return;
    }
    frame.children.push(paragraph);
  };

  for (const token of tokens) {
    const frame = top();

    if (token.kind === 'text') {
      // Collapse the whitespace HTML would collapse, so source indentation is not printed.
      const text = decode(token.text).replace(/\s+/g, ' ');
      if (!text.trim() && !frame.runs.length) continue;
      frame.runs.push({ text, ...frame.marks, link: frame.marks.link || undefined });
      continue;
    }

    if (token.kind === 'open') {
      const { name } = token;
      if (name === 'br') { frame.runs.push({ text: '\n' }); continue; }
      if (name === 'img' || name === 'hr') continue;

      const marks = marksFromStyle(token.style, frame.marks);
      if (name === 'strong' || name === 'b') marks.bold = true;
      if (name === 'em' || name === 'i') marks.italics = true;
      if (name === 'a') { marks.link = token.href; marks.color = marks.color ?? '#1d4ed8'; }
      if (/^h[1-4]$/.test(name)) { marks.bold = true; marks.fontSize = marks.fontSize ?? 14; }

      if (BLOCK_TAGS.has(name)) flush(frame);
      if (token.selfClosing) continue;

      // Inline tags keep writing into the same run; block tags open a frame of their own.
      if (!BLOCK_TAGS.has(name)) {
        stack.push({ name, marks, runs: frame.runs, children: frame.children });
      } else {
        stack.push({ name, marks, runs: [], children: [] });
      }
      continue;
    }

    // close
    const index = [...stack].reverse().findIndex((f) => f.name === token.name);
    if (index === -1) continue; // stray close tag — ignore rather than unwind the wrong frame
    const closing = stack[stack.length - 1 - index];
    // Unwind anything left open inside it, so unbalanced markup cannot strand a frame.
    while (top() !== closing) closeFrame(stack, flush);
    closeFrame(stack, flush);
  }

  while (stack.length > 1) closeFrame(stack, flush);
  flush(stack[0]);
  return root;
}

/** Fold the top frame into its parent, as a list, table, or plain block of content. */
function closeFrame(
  stack: { name: string; marks: Marks; runs: Content[]; children: Content[] }[],
  flush: (frame: { name: string; marks: Marks; runs: Content[]; children: Content[] }) => void,
): void {
  const frame = stack.pop();
  if (!frame) return;
  const parent = stack[stack.length - 1];
  if (!parent) return;

  // An inline frame shares its parent's run buffer — nothing to fold.
  if (frame.runs === parent.runs && frame.children === parent.children) return;

  flush(frame);

  if (frame.name === 'ul') {
    // Ticked, one per term, indented under the heading they belong to — pdfmake's own `ul` can only
    // offer a disc, square or circle, and the form is set with check marks.
    parent.children.push({
      stack: frame.children.map((item) => marked(checkMark(), item, 14, 1.4)),
      margin: [0, 0, 0, 4],
    });
    return;
  }
  if (frame.name === 'ol') {
    parent.children.push({ ol: frame.children.length ? frame.children : [''], margin: [0, 0, 0, 4] });
    return;
  }
  if (frame.name === 'td' || frame.name === 'th' || frame.name === 'li') {
    parent.children.push(frame.children.length === 1 ? frame.children[0] : { stack: frame.children });
    return;
  }
  if (frame.name === 'tr') {
    parent.children.push({ __row: frame.children } as unknown as Content);
    return;
  }
  if (frame.name === 'table') {
    const rows = frame.children
      .filter((c): c is Content & { __row: TableCell[] } => typeof c === 'object' && c !== null && '__row' in c)
      .map((c) => c.__row);
    if (rows.length) {
      const columns = Math.max(...rows.map((r) => r.length));
      const table: ContentTable = {
        table: {
          widths: Array.from({ length: columns }, () => '*' as const),
          body: rows.map((r) => [...r, ...Array.from({ length: columns - r.length }, () => '')]),
        },
        margin: [0, 2, 0, 5],
        // Moved whole to the next page rather than split: a signature block with the line on one
        // page and the name on the next is not a document anybody should be asked to sign.
        unbreakable: true,
      };
      parent.children.push(table);
    }
    return;
  }
  parent.children.push(...frame.children);
}

/**
 * Render the reviewed message as a PDF.
 *
 * `logo` is a data URI for the brand mark placed above the title, as the paper agreement has it.
 */
export async function renderContractPdf(html: string, logo: string | null): Promise<Buffer> {
  configure();

  const body = convert(html);

  // The form rules off under its title. Applied to the first block when that block is the centred
  // heading, rather than to anything that happens to be centred further down.
  const heading = body[0];
  const isTitle = typeof heading === 'object' && heading !== null && 'alignment' in heading
    && (heading as { alignment?: string }).alignment === 'center';
  if (isTitle) {
    body.splice(1, 0, {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 527, y2: 0, lineWidth: 1.1, lineColor: '#1f3b73' }],
      margin: [0, 1, 0, 8],
    });
  }

  const content: Content[] = [];
  if (logo) content.push({ image: logo, width: 118, alignment: 'center', margin: [0, 0, 0, 5] });
  content.push(...body);

  // Set close to the paper form: a contract that fits one page is one an agent reads and signs, and
  // two pages of loose type is worse to handle than the density this saves.
  const definition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [34, 26, 34, 34],
    defaultStyle: { font: 'Helvetica', fontSize: 8.4, lineHeight: 1.14, color: '#111827' },
    content,
    // Page number centred, and the brand mark in the bottom-right corner where the form carries it —
    // on the closing page only, which is where it sits on paper.
    footer: (page, total) => ({
      columns: [
        { width: '*', text: '' },
        { width: 'auto', text: `Page ${page} of ${total}`, fontSize: 7.5, color: '#9ca3af' },
        logo && page === total
          ? { width: '*', stack: [{ image: logo, width: 62, alignment: 'right', margin: [0, -6, 0, 0] as [number, number, number, number] }] }
          : { width: '*', text: '' },
      ],
      margin: [34, 10, 34, 0],
    }),
  };

  const buffer = await pdfMake.createPdf(definition).getBuffer();
  return Buffer.from(buffer);
}
