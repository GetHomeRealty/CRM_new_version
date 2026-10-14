export type MailSpan = { text: string; bold: boolean; italic: boolean; underline: boolean; code: boolean };
export type MailBlock = { heading: number; prefix: string; spans: MailSpan[] };
/** Linear bounded token scan. Attributes are discarded; output is native text only. */
export function formattedMail(html: string): { blocks: MailBlock[]; truncated: boolean; mediaOmitted: boolean } {
  const source = html.slice(0, 200000), lower = source.toLowerCase();
  let truncated = html.length > source.length, mediaOmitted = false, offset = 0, spanCount = 0;
  const blocks: MailBlock[] = [], stack: { tag: string; count: number }[] = [];
  let block: MailBlock = { heading: 0, prefix: '', spans: [] };
  const flush = () => { if (block.spans.some(s => s.text.trim())) blocks.push(block); block = { heading: 0, prefix: '', spans: [] }; };
  const text = (value: string) => {
    if (!value || spanCount >= 800 || blocks.length >= 200) { if (value) truncated = true; return; }
    const has = (tags: string[]) => stack.some(s => tags.includes(s.tag));
    const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', ndash: '–', mdash: '—' };
    const decoded = value.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp|copy|reg|hellip|ndash|mdash);/gi, (original, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? original;
      const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : original;
    }).replace(has(['pre']) ? /\r/g : /[\s]+/g, has(['pre']) ? '' : ' ');
    if (decoded) { spanCount++; block.spans.push({ text: decoded, bold: has(['b','strong','th']), italic: has(['i','em']), underline: has(['u','a']), code: has(['code','pre']) }); }
  };
  while (offset < source.length && spanCount < 800 && blocks.length < 200) {
    const open = source.indexOf('<', offset);
    if (open < 0) { text(source.slice(offset)); offset = source.length; break; }
    text(source.slice(offset, open));
    if (source.startsWith('<!--', open)) { const end = source.indexOf('-->', open + 4); offset = end < 0 ? source.length : end + 3; continue; }
    const close = source.indexOf('>', open + 1);
    if (close < 0) { text(source.slice(open)); offset = source.length; break; }
    const token = source.slice(open + 1, close), match = /^\s*(\/?)\s*([a-z][a-z0-9]*)/i.exec(token); offset = close + 1;
    if (!match) continue;
    const tag = match[2].toLowerCase(), ending = Boolean(match[1]);
    if (!ending && ['script','style','head','iframe','object','svg','math','form','template'].includes(tag)) {
      const end = lower.indexOf('</' + tag, offset); offset = end < 0 ? source.length : source.indexOf('>', end) + 1; if (!offset) offset = source.length; continue;
    }
    if (['img','video','audio','embed','input','link'].includes(tag)) { mediaOmitted = true; continue; }
    if (tag === 'br') { flush(); continue; }
    if (['p','div','section','article','blockquote','li','tr','pre','h1','h2','h3','h4','h5','h6'].includes(tag)) {
      flush();
      if (!ending && /^h[1-6]$/.test(tag)) block.heading = Number(tag[1]);
      if (!ending && tag === 'li') { const list = [...stack].reverse().find(s => ['ul','ol'].includes(s.tag)); block.prefix = list?.tag === 'ol' ? String(++list.count) + '. ' : '• '; }
    }
    if (!ending && ['td','th'].includes(tag) && block.spans.length) text(' | ');
    const allowed = ['b','strong','i','em','u','a','code','pre','ul','ol','th'];
    if (allowed.includes(tag)) {
      if (ending) { const index = stack.map(s => s.tag).lastIndexOf(tag); if (index >= 0) stack.splice(index); }
      else if (stack.length < 32) stack.push({ tag, count: 0 }); else truncated = true;
    }
  }
  if (offset < source.length) truncated = true;
  flush();
  return { blocks, truncated, mediaOmitted };
}
