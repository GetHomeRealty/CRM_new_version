/** Text-only approximation, never HTML input to a browser or WebView. */
export function templateText(content: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return content.slice(0, 200000)
    .replace(/<!--[^]*?(?:-->|$)/g, '')
    .replace(/<(script|style|head)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\s*br\b[^>]*>|<\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? original;
      const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : original;
    }).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
