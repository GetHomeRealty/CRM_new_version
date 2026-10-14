import { ImapSyncService, normalizeInboundText } from './imap-sync.service';

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

describe('incoming MIME attachment archive', () => {
  const previous = process.env.INBOX_ARCHIVE_ENABLED;
  afterEach(() => { if (previous === undefined) delete process.env.INBOX_ARCHIVE_ENABLED; else process.env.INBOX_ARCHIVE_ENABLED = previous; });
  it('parses attachment bytes only into the opt-in archive', async () => {
    const source = Buffer.from([
      'From: sender@example.invalid', 'To: agent@example.invalid', 'Subject: Synthetic MIME',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="testboundary"', '',
      '--testboundary', 'Content-Type: text/plain', '', 'Synthetic body',
      '--testboundary', 'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="test.txt"', 'Content-Transfer-Encoding: base64', '',
      'dGVzdA==', '--testboundary--', '',
    ].join('\r\n'));
    const service = Object.create(ImapSyncService.prototype);
    const client = { fetchOne: jest.fn().mockResolvedValue({ source }) };
    process.env.INBOX_ARCHIVE_ENABLED = 'true';
    expect((await service.fetchOne(client, 1)).attachments).toMatchObject({ total: 1, files: [{ name: 'test.txt', size: 4, data: 'dGVzdA==' }] });
    process.env.INBOX_ARCHIVE_ENABLED = 'false';
    expect((await service.fetchOne(client, 1)).attachments.files).toHaveLength(0);
  });
});
