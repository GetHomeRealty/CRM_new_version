import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-045: the Suppression List response says whether it is the whole list.
 *
 * WHAT WAS DISPLAYED. An agent's screen read "0 addresses suppressed" and "Nobody is suppressed"
 * at a moment when the brokerage HAD a suppressed address, with the Super Admin's view of the same
 * list showing the entry. The screen was rendering exactly what it was given; what it was never
 * given was the fact that it had been handed a slice. "Nobody is suppressed" is a claim, not an
 * absence, and it was false - on the one page a brokerage would open to answer a compliance
 * question, to a person who can send campaigns.
 *
 * THE SCOPING ITSELF IS NOT THE DEFECT, and the report's triage note guessed otherwise - it read
 * the scope as an accident, "the index appears to scope results by the requesting user despite the
 * list being brokerage-wide". It is deliberate and was a change FROM brokerage-wide:
 * `CampaignAudienceService.suppressedEmails` filters every send against the WHOLE table whoever is
 * sending, so an address hidden from this list is still unmailable and no wrongful send can follow
 * from hiding it. What a brokerage-wide LIST did was show every agent the addresses of every
 * colleague's clients - the boundary the lead list, the audience and the export all hold.
 *
 * So this fixes what the report's own severity note concluded: "If the intent is that agents should
 * not see other people's clients' addresses - which is a perfectly reasonable design - then the fix
 * is a sentence saying so, not a zero."
 *
 * SENT FROM THE SERVER, like `can_remove` beside it. The rule that decides the scope lives in
 * `listSuppressions`; a screen that works it out from the viewer's role is a second copy of that
 * rule, waiting to disagree with the first.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 30000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const tag = () => `${Date.now()}-${++seq}`;

/** Only `prisma` is reached by `listSuppressions`; the rest are never called on this path. */
const svc = (tx: PrismaService) =>
  new CampaignsService(tx, null as never, null as never, null as never, null as never);

type Meta = { total: number; scoped?: boolean; can_remove?: boolean };
const metaOf = (r: Record<string, unknown>) => r.meta as Meta;

const ADMIN = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;

describe('the suppression list says whose list it is', () => {
  it('tells a marketing role it is seeing everything', async () => {
    await inRollback(async (tx) => {
      const res = await svc(tx).listSuppressions(ADMIN, {});
      expect(metaOf(res).scoped).toBe(false);
    });
  });

  it('tells an agent it is seeing a slice', async () => {
    await inRollback(async (tx) => {
      const t = tag();
      const agent = await tx.users.create({
        data: { name: `ZZ Agent ${t}`, email: `zz-agent-${t}@x.test`, password: 'x', role: 'agent', status: 'Active', created_at: new Date(), updated_at: new Date() },
      });

      const res = await svc(tx).listSuppressions({ id: agent.id, name: agent.name, role: 'agent' } as unknown as AuthUserRecord, {});

      // THE DEFECT: this came back looking exactly like an empty brokerage list.
      expect(metaOf(res).scoped).toBe(true);
    });
  });

  it('says so even when the agent owns no leads at all', async () => {
    /*
     * The early return. An agent with no leads short-circuits before the query, and that path
     * returned a meta of its own - so it was the one most likely to keep saying nothing.
     */
    await inRollback(async (tx) => {
      const t = tag();
      const agent = await tx.users.create({
        data: { name: `ZZ Leadless ${t}`, email: `zz-leadless-${t}@x.test`, password: 'x', role: 'agent', status: 'Active', created_at: new Date(), updated_at: new Date() },
      });

      const res = await svc(tx).listSuppressions({ id: agent.id, name: agent.name, role: 'agent' } as unknown as AuthUserRecord, {});

      expect(metaOf(res).total).toBe(0);
      expect(metaOf(res).scoped).toBe(true);
      expect(metaOf(res).can_remove).toBe(false);
    });
  });

  it('an agent still cannot see a colleague\'s client, which is the point of the scope', async () => {
    await inRollback(async (tx) => {
      const t = tag();
      const now = new Date();
      const [mine, theirs] = [`zz-mine-${t}@x.test`, `zz-theirs-${t}@x.test`];
      const agent = await tx.users.create({
        data: { name: `ZZ Owner ${t}`, email: `zz-owner-${t}@x.test`, password: 'x', role: 'agent', status: 'Active', created_at: now, updated_at: now },
      });
      await tx.leads.create({ data: { name: `ZZ Mine ${t}`, email: mine, owner_user_id: agent.id, assigned_to: agent.id, created_at: now, updated_at: now } });
      for (const email of [mine, theirs]) {
        await tx.email_suppressions.create({ data: { email, reason: 'unsubscribed', created_at: now, updated_at: now } });
      }

      const res = await svc(tx).listSuppressions({ id: agent.id, name: agent.name, role: 'agent' } as unknown as AuthUserRecord, {});
      const emails = (res.data as { email: string }[]).map((r) => r.email);

      expect(emails).toContain(mine);
      expect(emails).not.toContain(theirs);
      expect(metaOf(res).scoped).toBe(true);
    });
  });

  it('the whole list is still what a marketing role gets', async () => {
    // The scope narrowed the VIEW, never the enforcement — and never the marketing roles' view.
    await inRollback(async (tx) => {
      const t = tag();
      const now = new Date();
      const email = `zz-broker-${t}@x.test`;
      await tx.email_suppressions.create({ data: { email, reason: 'unsubscribed', created_at: now, updated_at: now } });

      const res = await svc(tx).listSuppressions(ADMIN, { search: `zz-broker-${t}` });
      expect((res.data as { email: string }[]).map((r) => r.email)).toContain(email);
      expect(metaOf(res).scoped).toBe(false);
    });
  });
});
