import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadActivityService } from './lead-activity.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Removing one entry from a lead's email history.
 *
 * WHY IT WAS ASKED FOR. A mailbox whose OAuth had been revoked produced five identical
 * `invalid_grant` failures on one lead, stacked on top of the two real messages — noise burying the
 * correspondence that matters, with no way to clear it.
 *
 * WHAT MAKES THIS DIFFERENT FROM DELETING A NOTE. `lead_emails` has no `deleted_at`, so the row is
 * gone for good, and an email record is evidence that the brokerage did or did not contact a client
 * — the kind of thing somebody asks about months later. So the whole of it is written to the audit
 * trail BEFORE it is removed. These tests assert that content, not merely that an audit line was
 * written: "an email was deleted" answers none of the questions that get asked afterwards.
 *
 * Every case runs inside a rolled-back transaction, so nothing here touches real data.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/** Captures what reached the audit trail, so the content can be asserted rather than assumed. */
function harness(tx: PrismaService, allowed = true) {
  const audits: { action: string; detail: string }[] = [];
  const access = {
    assertLead: async () => {
      if (!allowed) throw new Error('Forbidden');
    },
  } as never;
  const audit = { record: async (_u: unknown, action: string, _s: string, detail: string) => { audits.push({ action, detail }); } } as never;
  const svc = new LeadActivityService(
    access, tx, audit,
    {} as never, {} as never, {} as never, {} as never,
  );
  return { svc, audits };
}

const user = { id: 1, name: 'Tester', role: 'admin' } as unknown as AuthUserRecord;

async function makeLead(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  return tx.leads.create({
    data: { name: `Email del ${t}`, email: `emaildel-${t}@example.test`, created_at: now, updated_at: now },
  });
}

async function makeEmail(tx: PrismaService, leadId: number, over: Record<string, unknown> = {}) {
  return tx.lead_emails.create({
    data: {
      lead_id: leadId, recipient: `to-${tag()}@example.test`, subject: `Subject ${tag()}`,
      body: '<p>hi</p>', status: 'sent', sent_by: 'Akhilesh', sent_at: new Date(), ...over,
    },
  });
}

// =================================================================================================

describe('deleting one email record', () => {
  it('removes it from the lead', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const email = await makeEmail(tx, lead.id);
      const keep = await makeEmail(tx, lead.id);
      const { svc } = harness(tx);

      expect(await svc.removeEmail(lead.id, email.id, user)).toEqual({ deleted: true });

      expect(await tx.lead_emails.findUnique({ where: { id: email.id } })).toBeNull();
      // Only the one named — the rest of the history is untouched.
      expect(await tx.lead_emails.findUnique({ where: { id: keep.id } })).not.toBeNull();
    });
  });

  it('writes the whole record to the audit trail before removing it', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const email = await makeEmail(tx, lead.id, {
        recipient: 'client@example.test', subject: 'Welcome — quick introduction',
        status: 'failed', error: 'invalid_grant: Token has been expired or revoked.',
        sent_by: 'Aswini',
      });
      const { svc, audits } = harness(tx);

      await svc.removeEmail(lead.id, email.id, user);

      expect(audits).toHaveLength(1);
      const [entry] = audits;
      expect(entry.action).toBe('Lead email deleted');
      /*
       * The row is unrecoverable once deleted, so every field somebody would later ask about has
       * to be in this line: who it went to, what it said, whether it arrived, when, and who sent it.
       */
      expect(entry.detail).toContain('client@example.test');
      expect(entry.detail).toContain('Welcome — quick introduction');
      expect(entry.detail).toContain('failed');
      expect(entry.detail).toContain('Aswini');
      expect(entry.detail).toContain('invalid_grant');
    });
  });

  it('records a successful send just as fully, with no error text invented', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const email = await makeEmail(tx, lead.id, { status: 'sent', error: null, subject: 'hello Aswini' });
      const { svc, audits } = harness(tx);

      await svc.removeEmail(lead.id, email.id, user);

      expect(audits[0].detail).toContain('sent');
      expect(audits[0].detail).toContain('hello Aswini');
      expect(audits[0].detail).not.toMatch(/\(\)/);   // no empty parenthesis where an error would go
    });
  });
});

describe('what it refuses', () => {
  it('will not delete an email belonging to a DIFFERENT lead', async () => {
    await inRollback(async (tx) => {
      const mine = await makeLead(tx);
      const other = await makeLead(tx);
      const theirs = await makeEmail(tx, other.id);
      const { svc, audits } = harness(tx);

      /*
       * Scoped by `lead_id` as well as `id`. Without that, an email id from any lead could be
       * deleted through a lead the caller happens to be allowed to see — the id is just a number
       * in the URL.
       */
      await expect(svc.removeEmail(mine.id, theirs.id, user)).rejects.toThrow(/not on this lead/i);
      expect(await tx.lead_emails.findUnique({ where: { id: theirs.id } })).not.toBeNull();
      expect(audits).toEqual([]);
    });
  });

  it('refuses an id that does not exist', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const { svc } = harness(tx);
      await expect(svc.removeEmail(lead.id, 999_999_999, user)).rejects.toThrow(/not on this lead/i);
    });
  });

  it('checks access to the lead before touching anything', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const email = await makeEmail(tx, lead.id);
      const { svc, audits } = harness(tx, false);   // assertLead throws

      await expect(svc.removeEmail(lead.id, email.id, user)).rejects.toThrow(/Forbidden/);
      // Nothing removed, nothing logged — the guard runs first.
      expect(await tx.lead_emails.findUnique({ where: { id: email.id } })).not.toBeNull();
      expect(audits).toEqual([]);
    });
  });
});

describe('the lead itself', () => {
  it('is not altered by removing one of its emails', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      const email = await makeEmail(tx, lead.id);
      const before = await tx.leads.findUnique({ where: { id: lead.id } });
      const { svc } = harness(tx);

      await svc.removeEmail(lead.id, email.id, user);

      // Clearing a stale failure must not look like activity on the lead.
      expect(await tx.leads.findUnique({ where: { id: lead.id } })).toEqual(before);
    });
  });
});
