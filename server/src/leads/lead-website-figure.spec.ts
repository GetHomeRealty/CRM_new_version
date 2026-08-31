import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-014: one website figure, and it is the right one.
 *
 * WHAT WAS THERE. `stats.websiteEnquiries` summed `WEBSITE_ENQUIRY_SOURCES`, a constant named for
 * the website whose contents were `['google ads', 'meta']`. So the leads response carried two
 * website figures that disagreed - 3 against a correct 4 - and shipped the wrong one to the browser
 * on every request. Nothing rendered it, which is why nobody saw it, and is also why it survived.
 *
 * WHY IT WAS DELETED RATHER THAN CORRECTED. A fixed duplicate is still two figures answering one
 * question, and two figures answering one question is how they drift apart again. That has happened
 * four separate times in this module - the dashboard tile against the Inbox, the Delete button
 * against the server, the No Calls count against its own filter, and this.
 *
 * SO THE TEST IS ABOUT ABSENCE AS WELL AS CORRECTNESS. Asserting only that `bySource.website` is
 * right would pass just as happily with the wrong second figure sitting beside it, which is exactly
 * the state this defect describes.
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
const AGENT = { id: 876543, name: 'ZZ Website Agent', role: 'agent' } as unknown as AuthUserRecord;

function leadsFor(tx: PrismaService) {
  return new LeadsService(tx, new LeadAuditService(tx), new LeadNotificationService(tx, null as never));
}

async function makeLead(tx: PrismaService, source: string) {
  const t = tag();
  const now = new Date();
  return tx.leads.create({
    data: {
      name: `ZZ Website ${t}`, email: `zz-web-${t}@probe.test`, phone: '4165550000',
      lead_status: 'warm', lead_source: source,
      owner_user_id: AGENT.id, assigned_to: AGENT.id, created_at: now, updated_at: now,
    },
  });
}

type Listed = { meta: { total: number }; stats: Record<string, unknown> & { bySource: Record<string, number> } };

describe('the leads stats carry one website figure', () => {
  it('counts the website leads, and only the website leads', async () => {
    await inRollback(async (tx) => {
      await makeLead(tx, 'website');
      await makeLead(tx, 'website');
      await makeLead(tx, 'website');
      await makeLead(tx, 'website');
      // The two sources the deleted constant actually summed.
      await makeLead(tx, 'google ads');
      await makeLead(tx, 'meta');

      const res = await leadsFor(tx).list(AGENT, { limit: '200' } as never) as Listed;

      expect(res.stats.bySource.website).toBe(4);
      expect(res.stats.bySource.google).toBe(1);
      expect(res.stats.bySource.meta).toBe(1);
    });
  });

  it('agrees with filtering on the same source', async () => {
    // The tile is a filter; the count and the filtered list must be the same question.
    await inRollback(async (tx) => {
      await makeLead(tx, 'website');
      await makeLead(tx, 'website');
      await makeLead(tx, 'google ads');
      const svc = leadsFor(tx);

      const all = await svc.list(AGENT, { limit: '200' } as never) as Listed;
      const filtered = await svc.list(AGENT, { limit: '200', leadSource: 'website' } as never) as Listed;

      expect(filtered.meta.total).toBe(all.stats.bySource.website);
    });
  });

  it('ships no second website figure for anybody to pick up by mistake', async () => {
    await inRollback(async (tx) => {
      await makeLead(tx, 'website');
      const res = await leadsFor(tx).list(AGENT, { limit: '200' } as never) as Listed;

      // THE DEFECT: `websiteEnquiries` sat here, wrong, unused and shipped on every request.
      expect(res.stats).not.toHaveProperty('websiteEnquiries');
      // Nothing else at the top level claims to be a website count either.
      const strays = Object.keys(res.stats).filter((k) => /website/i.test(k));
      expect(strays).toEqual([]);
    });
  });
});
