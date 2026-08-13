import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MailRetentionService, retentionPolicy } from './mail-retention.service';

/**
 * Retention deletes correspondence, so the tests that matter are the ones about what it must NOT
 * touch. Every case runs inside a transaction that is rolled back, so this exercises the real
 * queries against the real schema without removing a single real message.
 *
 * The four things that would each be a serious incident:
 *
 *   deleting anything when no policy is configured   — the default must be inert
 *   deleting mail that is newer than the window      — the window must be honoured
 *   deleting mail attached to a lead                 — that is part of the record of a deal
 *   stripping a body but losing the message with it  — the gentler lever must stay gentle
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 20000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

/** One mailbox with four messages spanning the interesting cases. */
async function scene(tx: PrismaService) {
  const n = ++seq;
  const now = new Date();
  const lead = await tx.leads.create({
    data: { name: `retention lead ${n}`, email: `ret-${Date.now()}-${n}@x.test`, created_at: now, updated_at: now },
  });

  // inbound_emails.account_id is a real foreign key, so the mailbox has to exist.
  const account = await tx.mail_accounts.create({
    data: { name: `retention box ${n}`, from_email: `box-${Date.now()}-${n}@x.test`, host: 'imap.x.test', created_at: now, updated_at: now },
  });

  const mail = async (tag: string, receivedAt: Date, leadId: number | null) => tx.inbound_emails.create({
    data: {
      user_id: 1, account_id: account.id, uid: ++seq,
      from_email: 'someone@x.test', to_email: 'agent@x.test',
      subject: tag, snippet: 'snip',
      body_text: 'plain body', body_html: '<p>html body</p>',
      received_at: receivedAt, lead_id: leadId, created_at: now,
    },
  });

  return {
    lead,
    recent: await mail('recent', daysAgo(5), null),
    old: await mail('old', daysAgo(400), null),
    older: await mail('older', daysAgo(800), null),
    linked: await mail('old but linked to a lead', daysAgo(400), lead.id),
  };
}

const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
  const before = { ...process.env };
  Object.assign(process.env, vars);
  try { await fn(); } finally { process.env = before; }
};

const svcFor = (tx: PrismaService) => new MailRetentionService(tx);
const idsIn = async (tx: PrismaService, ids: number[]) =>
  (await tx.inbound_emails.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id);

describe('inbound mail retention', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('does nothing at all when no policy is set', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      await withEnv({ MAIL_RETENTION_DAYS: '', MAIL_STRIP_BODIES_AFTER_DAYS: '' }, async () => {
        expect(retentionPolicy()).toEqual({ deleteAfterDays: 0, stripBodiesAfterDays: 0, includeLinked: false });
        const result = await svcFor(tx).sweep();
        expect(result).toEqual({ stripped: 0, deleted: 0 });
      });
      // The default must be indistinguishable from the behaviour before this feature existed.
      const survivors = await idsIn(tx, [s.recent.id, s.old.id, s.older.id, s.linked.id]);
      expect(survivors).toHaveLength(4);
    });
  });

  it('deletes only messages older than the window', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      await withEnv({ MAIL_RETENTION_DAYS: '365', MAIL_STRIP_BODIES_AFTER_DAYS: '' }, async () => {
        await svcFor(tx).sweep();
      });
      expect(await idsIn(tx, [s.recent.id])).toEqual([s.recent.id]);   // 5 days old — kept
      expect(await idsIn(tx, [s.old.id, s.older.id])).toEqual([]);     // 400 and 800 days — gone
    });
  });

  it('never deletes mail attached to a lead unless explicitly told to', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      await withEnv({ MAIL_RETENTION_DAYS: '30' }, async () => { await svcFor(tx).sweep(); });
      // Same age as `old`, which was removed — spared only because it belongs to a lead.
      expect(await idsIn(tx, [s.linked.id])).toEqual([s.linked.id]);
      expect(await idsIn(tx, [s.old.id])).toEqual([]);
    });
  });

  it('includes lead-linked mail when that is opted into', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      await withEnv({ MAIL_RETENTION_DAYS: '30', MAIL_RETENTION_INCLUDE_LINKED: 'true' }, async () => {
        await svcFor(tx).sweep();
      });
      expect(await idsIn(tx, [s.linked.id])).toEqual([]);
    });
  });

  it('strips bodies without losing the message', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      await withEnv({ MAIL_STRIP_BODIES_AFTER_DAYS: '365', MAIL_RETENTION_DAYS: '' }, async () => {
        const r = await svcFor(tx).sweep();
        expect(r.deleted).toBe(0);
        expect(r.stripped).toBeGreaterThanOrEqual(2);
      });

      // The bytes are gone; the fact of the conversation is not.
      const old = await tx.inbound_emails.findUnique({ where: { id: s.old.id } });
      expect(old).not.toBeNull();
      expect(old?.body_text).toBeNull();
      expect(old?.body_html).toBeNull();
      expect(old?.subject).toBe('old');
      expect(old?.from_email).toBe('someone@x.test');

      // Recent mail keeps its body.
      const recent = await tx.inbound_emails.findUnique({ where: { id: s.recent.id } });
      expect(recent?.body_html).toBe('<p>html body</p>');
    });
  });

  it('reports what a sweep would do without doing it', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      await withEnv({ MAIL_RETENTION_DAYS: '365' }, async () => {
        const preview = await svcFor(tx).preview();
        expect(preview.toDelete).toBeGreaterThanOrEqual(2);
        expect(preview.policy.deleteAfterDays).toBe(365);
      });
      // preview() must not have removed anything.
      expect(await idsIn(tx, [s.old.id, s.older.id])).toHaveLength(2);
    });
  });

  it('ignores a nonsense window rather than deleting everything', async () => {
    // `MAIL_RETENTION_DAYS=abc` must not become NaN — a NaN cutoff compares false and would be
    // survivable, but `-1` or `0` read as "older than now" would delete the entire mailbox.
    await withEnv({ MAIL_RETENTION_DAYS: 'abc' }, async () => {
      expect(retentionPolicy().deleteAfterDays).toBe(0);
    });
    await withEnv({ MAIL_RETENTION_DAYS: '-5' }, async () => {
      expect(retentionPolicy().deleteAfterDays).toBe(0);
    });
  });
});
