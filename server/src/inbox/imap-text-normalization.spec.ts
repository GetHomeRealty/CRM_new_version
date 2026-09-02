import { normalizeInboundText } from './imap-sync.service';

describe('normalizeInboundText', () => {
  it('removes PostgreSQL-forbidden NUL characters without discarding the message', () => {
    expect(normalizeInboundText('before\u0000after')).toBe('beforeafter');
  });

  it('replaces unmatched UTF-16 surrogates that Prisma cannot encode', () => {
    expect(normalizeInboundText(`start\ud800middle\udc00end`)).toBe('start\ufffdmiddle\ufffdend');
  });

  it('preserves valid surrogate pairs and ordinary backslash sequences', () => {
    expect(normalizeInboundText('Canada \ud83c\udde8\ud83c\udde6 and literal \\x')).toBe('Canada \ud83c\udde8\ud83c\udde6 and literal \\x');
  });

  it('does not leave half of a surrogate pair when applying a database length limit', () => {
    expect(normalizeInboundText('ab\ud83d\ude00cd', 3)).toBe('ab\ufffd');
  });
});
