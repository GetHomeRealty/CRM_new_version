import { archiveFiles, archiveMetadata, MAX_ARCHIVE_BYTES } from './mail-archive';
import { MailArchiveController } from './mail-archive.controller';

const key = '12345678-1234-4123-8123-123456789abc';
describe('bounded mail archive', () => {
  const previous = process.env.INBOX_ARCHIVE_ENABLED;
  beforeEach(() => { process.env.INBOX_ARCHIVE_ENABLED = 'true'; });
  afterEach(() => { if (previous === undefined) delete process.env.INBOX_ARCHIVE_ENABLED; else process.env.INBOX_ARCHIVE_ENABLED = previous; });
  const user = { id: 7 } as never;
  function fixture() {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      inbox_reply_submissions: { findFirst: jest.fn() },
      inbound_emails: { findFirst: jest.fn() },
      mail_accounts: { findFirst: jest.fn().mockResolvedValue({ id: 11 }) },
    };
    return { db, controller: new MailArchiveController(db as never) };
  }
  it('bounds bytes and metadata, sanitizes names, never returns bytes in metadata', () => {
    const value = archiveFiles([{ filename: '../../unsafe.html', content: Buffer.alloc(MAX_ARCHIVE_BYTES) },
      ...Array.from({ length: 22 }, () => ({ content: Buffer.from('a') }))]);
    expect(value.files).toHaveLength(20);
    expect(value.total).toBe(23);
    expect(value.files[0].name).not.toContain('/');
    expect(value.files[1].data).toBeUndefined();
    expect(archiveMetadata(value).files[0]).not.toHaveProperty('data');
    expect(archiveMetadata(null).available).toBe(false);
  });
  it('rejects disabled access and invalid area before querying', async () => {
    const { db, controller } = fixture();
    await expect(controller.sent(user, 'invalid')).rejects.toThrow();
    process.env.INBOX_ARCHIVE_ENABLED = 'false';
    await expect(controller.sent(user, 'crm')).rejects.toThrow('not enabled');
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('paginates metadata and rejects invalid pages', async () => {
    const { db, controller } = fixture();
    db.$queryRaw.mockResolvedValue(Array.from({ length: 21 }, () => ({ id: key })));
    expect(await controller.sent(user, 'crm', '2')).toMatchObject({ page: 2, has_more: true });
    const args = db.$queryRaw.mock.calls[0];
    expect(args.slice(1)).toEqual([7, 20]);
    await expect(controller.sent(user, 'crm', '0')).rejects.toThrow();
  });
  it('restricts sent detail to owner and accepted receipts; handles older content', async () => {
    const { db, controller } = fixture();
    db.inbox_reply_submissions.findFirst.mockResolvedValue({ snapshot: null, updated_at: new Date() });
    expect(await controller.sentDetail(user, key, 'crm')).toMatchObject({ content_available: false, attachments: { available: false } });
    expect(db.inbox_reply_submissions.findFirst).toHaveBeenCalledWith({ where: { user_id: 7, request_key: key, status: 'accepted' } });
    db.inbox_reply_submissions.findFirst.mockResolvedValue(null);
    await expect(controller.sentDetail(user, key, 'crm')).rejects.toThrow('not found');
  });
  it('restricts inbound download to owner and primary mailbox and uses safe filename', async () => {
    const { db, controller } = fixture();
    db.inbound_emails.findFirst.mockResolvedValue({ attachments: archiveFiles([{ filename: 'evil.html', content: Buffer.from('<script>') }]) });
    expect(await controller.inboundAttachment(user, 12, 0, 'crm')).toMatchObject({ filename: 'attachment-1.bin' });
    expect(db.inbound_emails.findFirst).toHaveBeenCalledWith({ where: { id: 12, user_id: 7, account_id: 11 }, select: { attachments: true } });
    await expect(controller.inboundAttachment(user, 12, 1, 'crm')).rejects.toThrow('unavailable');
  });
  it('rejects corrupt attachment data and never downloads another owner’s missing row', async () => {
    const { db, controller } = fixture();
    db.inbox_reply_submissions.findFirst.mockResolvedValue({ snapshot: { attachments: { files: [{ data: 'bad!' }] } } });
    await expect(controller.sentAttachment(user, key, 0, 'crm')).rejects.toThrow('Invalid attachment');
    db.inbound_emails.findFirst.mockResolvedValue(null);
    await expect(controller.inboundAttachment(user, 12, 0, 'crm')).rejects.toThrow('not found');
  });
});
