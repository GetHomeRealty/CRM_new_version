import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailboxService } from './mailbox.service';
import { parseAddresses, prefixSubject, replyRecipients, splitLoose, threadKeyFor } from './mailbox';

/**
 * THE WRITABLE TRANSACTION DESK INBOX.
 *
 * The tests are grouped by the thing that would be a defect, not by method:
 *
 *   SOMEBODY READS SOMEBODY ELSE'S MAIL. Every route takes an id; the only thing standing between
 *   User A and User B's correspondence is that each lookup is scoped by the session's user id. That
 *   includes an ADMIN — a mailbox is not brokerage data, and rank grants nothing here.
 *
 *   THE TWO AREAS BLEED. The same address can be connected to both CRM and Transaction Desk. A Desk
 *   draft appearing in the CRM, or a Desk reply leaving from the CRM account, is the failure this
 *   module's whole scoping design exists to prevent.
 *
 *   A MESSAGE IS MARKED SENT THAT DID NOT LEAVE. The exact defect the invoice send already had.
 *
 *   A REPLY STARTS A NEW CONVERSATION, or copies the wrong people.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

/** A mailer that records what it was asked to send, and can be told to refuse. */
class StubMailer {
  sent: { accountId: number; to: string[]; cc: string[]; bcc: string[]; subject: string; headers?: Record<string, string> }[] = [];
  fail = false;
  async sendFromAccount(account: { id: number }, opts: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; headers?: Record<string, string> }) {
    if (this.fail) throw new Error('535 authentication failed');
    this.sent.push({ accountId: account.id, to: opts.to, cc: opts.cc ?? [], bcc: opts.bcc ?? [], subject: opts.subject, headers: opts.headers });
    return { messageId: `<generated-${++seq}@spec.test>` };
  }
}

const svc = (tx: PrismaService, mailer: StubMailer) => new MailboxService(tx, mailer as never);

async function makeUser(tx: PrismaService, name: string, role = 'agent') {
  const stamp = `${Date.now()}-${++seq}`;
  return tx.users.create({
    data: {
      name, email: `mb-${stamp}@spec.test`, username: `mb-${stamp}`,
      role, status: 'Active', password: 'x', profile: '{}',
      created_at: new Date(), updated_at: new Date(),
    },
    select: { id: true, name: true },
  });
}

async function makeAccount(tx: PrismaService, userId: number, scope: 'desk' | 'crm' | null, address: string) {
  return tx.mail_accounts.create({
    data: {
      name: `${scope ?? 'legacy'} box`, from_email: address, host: 'smtp.spec.test', port: 587,
      user_id: userId, scope, is_active: true, is_default: true,
      created_at: new Date(), updated_at: new Date(),
    },
    select: { id: true, from_email: true },
  });
}

async function receive(
  tx: PrismaService,
  o: { userId: number; accountId: number; from?: string; to?: string; subject?: string; messageId?: string; refs?: string; inReplyTo?: string; body?: string },
) {
  return tx.inbound_emails.create({
    data: {
      user_id: o.userId, account_id: o.accountId, uid: ++seq,
      message_id: o.messageId ?? `<in-${seq}@spec.test>`,
      from_email: o.from ?? 'sender@outside.test', from_name: 'Outside Sender',
      to_email: o.to ?? 'me@desk.test',
      subject: o.subject ?? 'A question about the deal',
      snippet: 'A question', body_text: o.body ?? 'A question about the deal.', body_html: null,
      received_at: new Date(), seen: false,
      in_reply_to: o.inReplyTo ?? null,
      references_header: o.refs ?? null,
      thread_key: threadKeyFor({ references: o.refs, inReplyTo: o.inReplyTo, messageId: o.messageId ?? `<in-${seq}@spec.test>` }),
      created_at: new Date(),
    },
    select: { id: true, message_id: true, thread_key: true },
  });
}

// ---------------------------------------------------------------------------
describe('nobody reads anybody else\'s mail', () => {
  it('User A cannot open User B\'s message', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'Box A');
      const b = await makeUser(tx, 'Box B');
      const boxA = await makeAccount(tx, a.id, 'desk', 'a@desk.test');
      const boxB = await makeAccount(tx, b.id, 'desk', 'b@desk.test');
      const mine = await receive(tx, { userId: a.id, accountId: boxA.id });
      const theirs = await receive(tx, { userId: b.id, accountId: boxB.id });

      const m = svc(tx, new StubMailer());
      await expect(m.message(a.id, 'desk', mine.id)).resolves.toMatchObject({ id: mine.id });
      await expect(m.message(a.id, 'desk', theirs.id)).rejects.toThrow(/not found/i);
    });
  });

  it('an ADMIN cannot open another user\'s message merely by being an admin', async () => {
    await inRollback(async (tx) => {
      const agent = await makeUser(tx, 'Box Agent');
      const admin = await makeUser(tx, 'Box Admin', 'admin');
      const agentBox = await makeAccount(tx, agent.id, 'desk', 'agent@desk.test');
      await makeAccount(tx, admin.id, 'desk', 'admin@desk.test');
      const theirs = await receive(tx, { userId: agent.id, accountId: agentBox.id });

      // The service takes a user id, not a role — there is no override to exercise.
      await expect(svc(tx, new StubMailer()).message(admin.id, 'desk', theirs.id)).rejects.toThrow(/not found/i);
    });
  });

  it('the list shows only the caller\'s own mail', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'List A');
      const b = await makeUser(tx, 'List B');
      const boxA = await makeAccount(tx, a.id, 'desk', 'la@desk.test');
      const boxB = await makeAccount(tx, b.id, 'desk', 'lb@desk.test');
      const mine = await receive(tx, { userId: a.id, accountId: boxA.id });
      await receive(tx, { userId: b.id, accountId: boxB.id });

      const out = await svc(tx, new StubMailer()).folder(a.id, 'desk', 'inbox');
      const ids = (out.data as { id: number }[]).map((r) => r.id);
      expect(ids).toEqual([mine.id]);
    });
  });

  it('archive, trash and delete refuse another user\'s message', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'Act A');
      const b = await makeUser(tx, 'Act B');
      await makeAccount(tx, a.id, 'desk', 'aa@desk.test');
      const boxB = await makeAccount(tx, b.id, 'desk', 'bb@desk.test');
      const theirs = await receive(tx, { userId: b.id, accountId: boxB.id });
      const m = svc(tx, new StubMailer());
      await expect(m.move(a.id, 'desk', theirs.id, 'archive')).rejects.toThrow(/not found/i);
      await expect(m.move(a.id, 'desk', theirs.id, 'trash')).rejects.toThrow(/not found/i);
    });
  });

  it('a draft belongs to its author alone', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'Draft A');
      const b = await makeUser(tx, 'Draft B');
      await makeAccount(tx, a.id, 'desk', 'da@desk.test');
      await makeAccount(tx, b.id, 'desk', 'db@desk.test');
      const m = svc(tx, new StubMailer());
      const mine = await m.saveDraft(a.id, 'desk', { to: 'x@y.test', subject: 'Private' });

      await expect(m.draft(b.id, 'desk', Number(mine.id))).rejects.toThrow(/not found/i);
      await expect(m.deleteDraft(b.id, 'desk', Number(mine.id))).rejects.toThrow(/not found/i);
      const theirDrafts = await m.folder(b.id, 'desk', 'drafts');
      expect(theirDrafts.data).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
describe('the CRM and Transaction Desk mailboxes stay separate', () => {
  it('a CRM message does not appear in the Transaction Desk inbox, or the reverse', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Two Boxes');
      const desk = await makeAccount(tx, u.id, 'desk', 'both@company.test');
      const crm = await tx.mail_accounts.create({
        data: {
          name: 'crm box', from_email: 'both@company.test', host: 'smtp.spec.test', port: 587,
          user_id: u.id, scope: 'crm', is_active: true, is_default: true,
          created_at: new Date(), updated_at: new Date(),
        },
        select: { id: true },
      });
      const deskMsg = await receive(tx, { userId: u.id, accountId: desk.id, subject: 'Desk mail' });
      const crmMsg = await receive(tx, { userId: u.id, accountId: crm.id, subject: 'CRM mail' });

      const m = svc(tx, new StubMailer());
      const deskIds = ((await m.folder(u.id, 'desk', 'inbox')).data as { id: number }[]).map((r) => r.id);
      const crmIds = ((await m.folder(u.id, 'crm', 'inbox')).data as { id: number }[]).map((r) => r.id);

      expect(deskIds).toContain(deskMsg.id);
      expect(deskIds).not.toContain(crmMsg.id);
      expect(crmIds).toContain(crmMsg.id);
      expect(crmIds).not.toContain(deskMsg.id);

      // …and reaching across by id is refused, not merely hidden from the list.
      await expect(m.message(u.id, 'desk', crmMsg.id)).rejects.toThrow(/not found/i);
    });
  });

  it('a Transaction Desk message is SENT FROM the Transaction Desk account', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Send Box');
      const desk = await makeAccount(tx, u.id, 'desk', 'desk@company.test');
      const crm = await tx.mail_accounts.create({
        data: {
          name: 'crm', from_email: 'crm@company.test', host: 'smtp.spec.test', port: 587,
          user_id: u.id, scope: 'crm', is_active: true, is_default: true,
          created_at: new Date(), updated_at: new Date(),
        },
        select: { id: true },
      });

      const mailer = new StubMailer();
      await svc(tx, mailer).send(u.id, 'desk', { to: 'client@outside.test', subject: 'From the Desk', body_html: '<p>Hello</p>' });

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].accountId).toBe(desk.id);
      expect(mailer.sent[0].accountId).not.toBe(crm.id);
    });
  });

  it('a Desk draft does not appear in the CRM drafts', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Draft Split');
      await makeAccount(tx, u.id, 'desk', 'd@company.test');
      await tx.mail_accounts.create({
        data: {
          name: 'crm', from_email: 'c@company.test', host: 'smtp.spec.test', port: 587,
          user_id: u.id, scope: 'crm', is_active: true, is_default: true,
          created_at: new Date(), updated_at: new Date(),
        },
      });
      const m = svc(tx, new StubMailer());
      await m.saveDraft(u.id, 'desk', { to: 'x@y.test', subject: 'Desk draft' });

      const deskDrafts = (await m.folder(u.id, 'desk', 'drafts')).data as unknown[];
      const crmDrafts = (await m.folder(u.id, 'crm', 'drafts')).data as unknown[];
      expect(deskDrafts).toHaveLength(1);
      expect(crmDrafts).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
describe('compose and send', () => {
  it('sends, records it in Sent, and does not leave it in Drafts', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Composer');
      await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const mailer = new StubMailer();
      const m = svc(tx, mailer);

      const out = await m.send(u.id, 'desk', {
        to: 'one@outside.test, two@outside.test', cc: 'cc@outside.test', bcc: 'bcc@outside.test',
        subject: 'Documents attached', body_html: '<p>Please sign.</p>',
      });

      expect(out.status).toBe('sent');
      expect(mailer.sent[0].to).toEqual(['one@outside.test', 'two@outside.test']);
      expect(mailer.sent[0].cc).toEqual(['cc@outside.test']);
      expect(mailer.sent[0].bcc).toEqual(['bcc@outside.test']);

      const sent = (await m.folder(u.id, 'desk', 'sent')).data as { id: number }[];
      const drafts = (await m.folder(u.id, 'desk', 'drafts')).data as unknown[];
      expect(sent.map((r) => r.id)).toEqual([Number(out.id)]);
      expect(drafts).toHaveLength(0);
    });
  });

  it('A FAILED SEND IS NOT MARKED SENT, and the content is kept for another try', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Failer');
      await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const mailer = new StubMailer();
      mailer.fail = true;
      const m = svc(tx, mailer);

      await expect(m.send(u.id, 'desk', { to: 'x@outside.test', subject: 'Will fail', body_html: '<p>x</p>' }))
        .rejects.toThrow(/was not sent/i);

      const sent = (await m.folder(u.id, 'desk', 'sent')).data as unknown[];
      const drafts = (await m.folder(u.id, 'desk', 'drafts')).data as { id: number; status: string; error: string | null }[];
      expect(sent).toHaveLength(0);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].status).toBe('failed');
      expect(drafts[0].error).toMatch(/535/);

      // …and the retry succeeds, using the same row rather than a new one.
      mailer.fail = false;
      const retried = await m.send(u.id, 'desk', { to: 'x@outside.test', subject: 'Will fail', body_html: '<p>x</p>' }, drafts[0].id);
      expect(retried.status).toBe('sent');
      expect(((await m.folder(u.id, 'desk', 'sent')).data as unknown[])).toHaveLength(1);
    });
  });

  it('refuses a message with no recipient rather than sending it nowhere', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'No Recipient');
      await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const mailer = new StubMailer();
      await expect(svc(tx, mailer).send(u.id, 'desk', { subject: 'Nobody', body_html: '<p>x</p>' }))
        .rejects.toThrow(/at least one recipient/i);
      expect(mailer.sent).toHaveLength(0);
    });
  });

  it('refuses a malformed address instead of dropping it', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Bad Address');
      await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      await expect(svc(tx, new StubMailer()).send(u.id, 'desk', { to: 'not-an-address', subject: 'x' }))
        .rejects.toThrow(/is not an email address/i);
    });
  });

  it('refuses to send when no mailbox is connected for the area', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'No Mailbox');
      await expect(svc(tx, new StubMailer()).send(u.id, 'desk', { to: 'x@y.test', subject: 'x' }))
        .rejects.toThrow(/No mailbox is connected/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('drafts', () => {
  it('creates, edits, reads back and deletes', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Draft Life');
      await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const m = svc(tx, new StubMailer());

      const created = await m.saveDraft(u.id, 'desk', { to: 'a@b.test', subject: 'First' });
      expect(created.subject).toBe('First');

      const edited = await m.saveDraft(u.id, 'desk', { to: 'a@b.test', subject: 'Second' }, Number(created.id));
      expect(edited.id).toBe(created.id);
      expect((await m.draft(u.id, 'desk', Number(created.id))).subject).toBe('Second');

      await m.deleteDraft(u.id, 'desk', Number(created.id));
      expect((await m.folder(u.id, 'desk', 'drafts')).data).toEqual([]);
    });
  });

  it('a sent message cannot be deleted as though it were a draft', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Sent Guard');
      await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const m = svc(tx, new StubMailer());
      const sent = await m.send(u.id, 'desk', { to: 'a@b.test', subject: 'Gone' });
      await expect(m.deleteDraft(u.id, 'desk', Number(sent.id))).rejects.toThrow(/cannot be deleted/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('reply, reply all and forward', () => {
  it('a reply goes to the sender and threads to the original', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Replier');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const original = await receive(tx, {
        userId: u.id, accountId: box.id, from: 'client@outside.test',
        to: 'me@desk.test, colleague@desk.test', subject: 'Offer', messageId: '<orig@outside.test>',
      });

      const mailer = new StubMailer();
      const m = svc(tx, mailer);
      const prefill = await m.replyDraft(u.id, 'desk', original.id, 'reply');
      expect(prefill.to).toBe('client@outside.test');
      expect(prefill.cc).toBe('');
      expect(prefill.subject).toBe('Re: Offer');

      await m.send(u.id, 'desk', { to: prefill.to, subject: prefill.subject, body_html: '<p>Yes</p>', in_reply_to_id: original.id });
      expect(mailer.sent[0].headers?.['In-Reply-To']).toBe('<orig@outside.test>');

      // The reply is part of the same conversation, so the thread view shows both.
      const thread = await m.thread(u.id, 'desk', original.thread_key!);
      expect((thread.messages as unknown[]).length).toBe(2);
    });
  });

  it('reply all copies the other recipients but NOT this mailbox or the sender twice', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Reply All');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const original = await receive(tx, {
        userId: u.id, accountId: box.id, from: 'client@outside.test',
        to: 'Me <ME@desk.test>, colleague@desk.test, client@outside.test',
        subject: 'Group thread',
      });

      const prefill = await svc(tx, new StubMailer()).replyDraft(u.id, 'desk', original.id, 'reply_all');
      expect(prefill.to).toBe('client@outside.test');
      // The mailbox itself is removed case-insensitively; the sender is not duplicated into CC.
      expect(prefill.cc).toBe('colleague@desk.test');
    });
  });

  it('a forward carries the attachments and does NOT thread into the original conversation', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Forwarder');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const original = await receive(tx, { userId: u.id, accountId: box.id, subject: 'Contract' });
      await tx.inbound_emails.update({ where: { id: original.id }, data: { has_attachments: true } });
      await tx.inbound_email_attachments.create({
        data: { email_id: original.id, filename: 'contract.pdf', mime: 'application/pdf', size_bytes: 12, storage_path: 'mail/inbound/x/contract.pdf', created_at: new Date() },
      });

      const prefill = await svc(tx, new StubMailer()).replyDraft(u.id, 'desk', original.id, 'forward');
      expect(prefill.subject).toBe('Fwd: Contract');
      expect((prefill.attachments as unknown[])).toHaveLength(1);
      // A forward goes to somebody who was NOT on the original — threading it in would put a
      // stranger's client inside that history.
      expect(prefill.in_reply_to_id).toBeNull();
    });
  });

  it('a reply prefill refuses another user\'s message', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'Pre A');
      const b = await makeUser(tx, 'Pre B');
      await makeAccount(tx, a.id, 'desk', 'pa@desk.test');
      const boxB = await makeAccount(tx, b.id, 'desk', 'pb@desk.test');
      const theirs = await receive(tx, { userId: b.id, accountId: boxB.id });
      await expect(svc(tx, new StubMailer()).replyDraft(a.id, 'desk', theirs.id, 'reply')).rejects.toThrow(/not found/i);
    });
  });
});

// ---------------------------------------------------------------------------
describe('folders and search', () => {
  it('archive moves a message out of the Inbox and into Archive, reversibly', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Archiver');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const msg = await receive(tx, { userId: u.id, accountId: box.id });
      const m = svc(tx, new StubMailer());

      await m.move(u.id, 'desk', msg.id, 'archive');
      expect((await m.folder(u.id, 'desk', 'inbox')).data).toEqual([]);
      expect(((await m.folder(u.id, 'desk', 'archive')).data as unknown[])).toHaveLength(1);

      await m.move(u.id, 'desk', msg.id, 'unarchive');
      expect(((await m.folder(u.id, 'desk', 'inbox')).data as unknown[])).toHaveLength(1);
    });
  });

  it('trash is a folder, not a deletion — the message can be restored', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Trasher');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const msg = await receive(tx, { userId: u.id, accountId: box.id });
      const m = svc(tx, new StubMailer());

      await m.move(u.id, 'desk', msg.id, 'trash');
      expect((await m.folder(u.id, 'desk', 'inbox')).data).toEqual([]);
      expect(((await m.folder(u.id, 'desk', 'trash')).data as unknown[])).toHaveLength(1);
      // Still in the mailbox: the row is there and can come back.
      expect(await tx.inbound_emails.count({ where: { id: msg.id } })).toBe(1);

      await m.move(u.id, 'desk', msg.id, 'restore');
      expect(((await m.folder(u.id, 'desk', 'inbox')).data as unknown[])).toHaveLength(1);
    });
  });

  it('search runs in the database and matches sender, subject and body', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Searcher');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      await receive(tx, { userId: u.id, accountId: box.id, subject: 'Closing on Tuesday', from: 'lawyer@outside.test' });
      await receive(tx, { userId: u.id, accountId: box.id, subject: 'Unrelated', from: 'other@outside.test', body: 'nothing here' });

      const m = svc(tx, new StubMailer());
      expect(((await m.folder(u.id, 'desk', 'inbox', { q: 'closing' })).data as unknown[])).toHaveLength(1);
      expect(((await m.folder(u.id, 'desk', 'inbox', { q: 'LAWYER' })).data as unknown[])).toHaveLength(1);
      expect(((await m.folder(u.id, 'desk', 'inbox', { q: 'zzz-no-match' })).data as unknown[])).toHaveLength(0);
    });
  });

  it('search still cannot cross into another user\'s mail', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'Search A');
      const b = await makeUser(tx, 'Search B');
      await makeAccount(tx, a.id, 'desk', 'sa@desk.test');
      const boxB = await makeAccount(tx, b.id, 'desk', 'sb@desk.test');
      await receive(tx, { userId: b.id, accountId: boxB.id, subject: 'Secret closing' });

      const found = (await svc(tx, new StubMailer()).folder(a.id, 'desk', 'inbox', { q: 'Secret' })).data as unknown[];
      expect(found).toHaveLength(0);
    });
  });

  it('the list is paged and never returns the whole mailbox', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Pager');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      for (let i = 0; i < 35; i++) await receive(tx, { userId: u.id, accountId: box.id, subject: `Message ${i}` });

      const page1 = await svc(tx, new StubMailer()).folder(u.id, 'desk', 'inbox', { page: 1 });
      expect((page1.data as unknown[]).length).toBe(30);
      expect((page1.meta as { total: number; last_page: number }).total).toBe(35);
      expect((page1.meta as { last_page: number }).last_page).toBe(2);
      // …and no body is carried in the list payload.
      expect(JSON.stringify(page1.data)).not.toContain('body_text');
    });
  });

  it('reading a message marks it seen and clears it from the unread count', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Reader');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const msg = await receive(tx, { userId: u.id, accountId: box.id });
      const m = svc(tx, new StubMailer());

      expect((await m.folder(u.id, 'desk', 'inbox')).unread).toBe(1);
      await m.message(u.id, 'desk', msg.id);
      expect((await m.folder(u.id, 'desk', 'inbox')).unread).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
describe('attachments', () => {
  it('a received attachment is refused to anybody but the mailbox owner', async () => {
    await inRollback(async (tx) => {
      const a = await makeUser(tx, 'Att A');
      const b = await makeUser(tx, 'Att B');
      await makeAccount(tx, a.id, 'desk', 'aa@desk.test');
      const boxB = await makeAccount(tx, b.id, 'desk', 'ab@desk.test');
      const theirs = await receive(tx, { userId: b.id, accountId: boxB.id });
      const att = await tx.inbound_email_attachments.create({
        data: { email_id: theirs.id, filename: 'private.pdf', mime: 'application/pdf', size_bytes: 3, storage_path: 'mail/inbound/x/private.pdf', created_at: new Date() },
        select: { id: true },
      });

      await expect(svc(tx, new StubMailer()).attachment(a.id, 'desk', 'received', att.id)).rejects.toThrow(/not found/i);
    });
  });

  it('an oversized attachment is refused before it is decoded', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Big Att');
      await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      // 11 MB of base64 — over the 10 MB per-attachment limit.
      const big = 'A'.repeat(Math.ceil((11 * 1024 * 1024 * 4) / 3));
      await expect(svc(tx, new StubMailer()).saveDraft(u.id, 'desk', {
        to: 'x@y.test', subject: 'Big', attachments: [{ filename: 'big.bin', mime: 'application/octet-stream', data: big }],
      })).rejects.toThrow(/larger than/i);
    });
  });

  it('too many attachments are refused', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Many Att');
      await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const one = { filename: 'a.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') };
      await expect(svc(tx, new StubMailer()).saveDraft(u.id, 'desk', {
        to: 'x@y.test', subject: 'Many', attachments: Array.from({ length: 21 }, () => one),
      })).rejects.toThrow(/at most 20 attachments/i);
    });
  });

  /*
   * An inline image is part of the BODY, and the reader cannot draw the body without it. It stays
   * out of the download list — nobody wants a button for a signature logo — but it has to be
   * reachable, and the `content_id` is the only thing that ties it to the `<img src="cid:…">`.
   * Before this, the filter dropped it from the payload entirely and the image could not render.
   */
  it('inline images are listed for the body, separately from the downloadable files', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Inline Img');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const msg = await receive(tx, { userId: u.id, accountId: box.id });
      await tx.inbound_emails.update({
        where: { id: msg.id },
        data: { body_html: '<p>Regards</p><img src="cid:logo-1@sender.test">' },
      });
      const logo = await tx.inbound_email_attachments.create({
        data: {
          email_id: msg.id, filename: 'logo.png', mime: 'image/png', size_bytes: 12,
          content_id: '<logo-1@sender.test>', storage_path: 'mail/inbound/x/logo.png', created_at: new Date(),
        },
        select: { id: true },
      });
      const doc = await tx.inbound_email_attachments.create({
        data: {
          email_id: msg.id, filename: 'offer.pdf', mime: 'application/pdf', size_bytes: 9,
          storage_path: 'mail/inbound/x/offer.pdf', created_at: new Date(),
        },
        select: { id: true },
      });

      const out = await svc(tx, new StubMailer()).message(u.id, 'desk', msg.id) as {
        attachments: { id: number }[];
        inline_images: { id: number; content_id: string | null; mime: string | null }[];
      };

      // The download list is unchanged: the file, and only the file.
      expect(out.attachments.map((a) => a.id)).toEqual([doc.id]);
      // The image is reachable, with the id the attachment route serves and the cid that finds it.
      expect(out.inline_images).toEqual([
        { id: logo.id, content_id: '<logo-1@sender.test>', mime: 'image/png', filename: 'logo.png' },
      ]);
    });
  });

  /*
   * FOUND BY OPENING REAL MAIL, not by reading the code. A forwarded message in the mailbox carries
   * two signed Agreement-to-Lease PDFs, both with a Content-ID, and a body that references neither.
   * Splitting on "has a content id" put them in neither list: not downloadable, because they looked
   * inline; not rendered, because nothing pointed at them. The message advertised attachments and
   * offered none. What the BODY references is the only thing that makes a part inline.
   */
  it('a part with a content id the body never references is still offered as a download', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx, 'Fwd Att');
      const box = await makeAccount(tx, u.id, 'desk', 'me@desk.test');
      const msg = await receive(tx, { userId: u.id, accountId: box.id });
      // A forward whose body mentions no cid at all — exactly the real message's shape.
      await tx.inbound_emails.update({
        where: { id: msg.id },
        data: { body_html: '<p>See attached, please sign.</p>' },
      });
      const contract = await tx.inbound_email_attachments.create({
        data: {
          email_id: msg.id, filename: 'agreement-to-lease.pdf', mime: 'application/pdf', size_bytes: 44,
          content_id: '<19fbb8c3a102f8e19051>', storage_path: 'mail/inbound/x/atl.pdf', created_at: new Date(),
        },
        select: { id: true },
      });

      const out = await svc(tx, new StubMailer()).message(u.id, 'desk', msg.id) as {
        attachments: { id: number }[]; inline_images: unknown[];
      };

      expect(out.attachments.map((a) => a.id)).toEqual([contract.id]);
      expect(out.inline_images).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
describe('the address, subject and threading helpers', () => {
  it('parses the forms people actually paste', () => {
    expect(parseAddresses('a@b.test, Name <c@d.test>; e@f.test', 'to')).toEqual(['a@b.test', 'c@d.test', 'e@f.test']);
    expect(parseAddresses('', 'to')).toEqual([]);
    expect(parseAddresses(undefined, 'to')).toEqual([]);
    // Duplicates collapse, case is normalised.
    expect(parseAddresses('A@B.test, a@b.test', 'to')).toEqual(['a@b.test']);
  });

  it('refuses rather than dropping an unparseable recipient', () => {
    expect(() => parseAddresses('a@b.test, nonsense', 'to')).toThrow(/is not an email address/i);
  });

  it('does not stack Re: and Fwd:', () => {
    expect(prefixSubject('Offer', 'Re')).toBe('Re: Offer');
    expect(prefixSubject('Re: Offer', 'Re')).toBe('Re: Offer');
    expect(prefixSubject('re: Offer', 'Re')).toBe('re: Offer');
    expect(prefixSubject(null, 'Fwd')).toBe('Fwd:');
  });

  it('resolves a thread to the root of the References chain', () => {
    expect(threadKeyFor({ references: '<root@x> <mid@x>', inReplyTo: '<mid@x>', messageId: '<leaf@x>' })).toBe('<root@x>');
    expect(threadKeyFor({ inReplyTo: '<parent@x>', messageId: '<leaf@x>' })).toBe('<parent@x>');
    // A message that starts a conversation is its own thread rather than a null.
    expect(threadKeyFor({ messageId: '<first@x>' })).toBe('<first@x>');
    expect(threadKeyFor({})).toBeNull();
  });

  it('reads a header forgivingly and never throws on somebody else\'s malformed address', () => {
    expect(splitLoose('good@x.test, <>, broken')).toEqual(['good@x.test']);
    expect(splitLoose(null)).toEqual([]);
  });

  it('reply-all removes this mailbox and the sender from the copy list', () => {
    const out = replyRecipients(
      { from_email: 'sender@x.test', to_email: 'ME@desk.test, other@x.test, sender@x.test' },
      'me@desk.test',
      true,
    );
    expect(out.to).toEqual(['sender@x.test']);
    expect(out.cc).toEqual(['other@x.test']);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
