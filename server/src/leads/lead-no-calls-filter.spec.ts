import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-013: the No Calls tile has to show the leads it counted.
 *
 * WHAT WAS WRONG WAS THE CONTROL, NOT THE COUNT. The number was always right. Pressing the tile
 * cleared the Recent filter and raised a toast reading "9 lead(s) have no logged call" - and the
 * list underneath went on showing all ten. An agent looking for the people nobody had rung was told
 * how many there were and shown a list that did not distinguish them.
 *
 * SO THE ASSERTION IS THAT THE TWO AGREE. Not that the filter returns "some uncalled leads" - that
 * would pass with a filter subtly narrower than the tile, which is this module's recurring failure:
 * a count and a list answering slightly different questions. The count and the filtered total are
 * compared directly, on the same data, through the same call.
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
const AGENT = { id: 987654, name: 'ZZ NoCalls Agent', role: 'agent' } as unknown as AuthUserRecord;

function leadsFor(tx: PrismaService) {
  return new LeadsService(tx, new LeadAuditService(tx), new LeadNotificationService(tx, null as never));
}

async function makeLead(tx: PrismaService, withCall: boolean) {
  const t = tag();
  const now = new Date();
  const lead = await tx.leads.create({
    data: {
      name: `ZZ NoCalls ${t}`, email: `zz-nocalls-${t}@probe.test`, phone: '4165550000',
      lead_status: 'warm', owner_user_id: AGENT.id, assigned_to: AGENT.id,
      created_at: now, updated_at: now,
    },
  });
  if (withCall) {
    await tx.lead_calls.create({
      // `called_at` is required and there is no `updated_at` on this table.
      data: { lead_id: lead.id, called_at: now, created_at: now },
    });
  }
  return lead;
}

type Listed = { data: { id: number }[]; meta: { total: number }; stats: { noCalls: number } };

describe('the No Calls tile filters to what it counted', () => {
  it('narrows the list to exactly the leads it reports', async () => {
    await inRollback(async (tx) => {
      const uncalled = [await makeLead(tx, false), await makeLead(tx, false), await makeLead(tx, false)];
      await makeLead(tx, true);
      await makeLead(tx, true);
      const svc = leadsFor(tx);

      const all = await svc.list(AGENT, { limit: '200' } as never) as Listed;
      expect(all.meta.total).toBe(5);
      expect(all.stats.noCalls).toBe(3);

      const filtered = await svc.list(AGENT, { limit: '200', noCalls: 'true' } as never) as Listed;

      // THE DEFECT: this returned all five while the toast said three.
      expect(filtered.meta.total).toBe(all.stats.noCalls);
      expect(filtered.data.map((r) => r.id).sort()).toEqual(uncalled.map((l) => l.id).sort());
    });
  });

  it('a lead that gets a call leaves the filter', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, false);
      const svc = leadsFor(tx);

      const before = await svc.list(AGENT, { limit: '200', noCalls: 'true' } as never) as Listed;
      expect(before.data.map((r) => r.id)).toContain(lead.id);

      await tx.lead_calls.create({ data: { lead_id: lead.id, called_at: new Date(), created_at: new Date() } });

      const after = await svc.list(AGENT, { limit: '200', noCalls: 'true' } as never) as Listed;
      expect(after.data.map((r) => r.id)).not.toContain(lead.id);
    });
  });

  it('combines with the other filters instead of replacing them', async () => {
    // The old handler CLEARED the Recent filter. Tiles beside it stack; this one wiped your work.
    await inRollback(async (tx) => {
      await makeLead(tx, false);
      const svc = leadsFor(tx);

      const both = await svc.list(AGENT, { limit: '200', noCalls: 'true', leadStatus: 'hot' } as never) as Listed;
      // Everything seeded here is 'warm', so a status that stacks must return nothing.
      expect(both.meta.total).toBe(0);
    });
  });

  it('is off unless asked for', async () => {
    await inRollback(async (tx) => {
      await makeLead(tx, false);
      await makeLead(tx, true);
      const svc = leadsFor(tx);

      for (const q of [{}, { noCalls: '' }, { noCalls: 'false' }]) {
        const res = await svc.list(AGENT, { limit: '200', ...q } as never) as Listed;
        expect(res.meta.total).toBe(2);
      }
    });
  });
});
