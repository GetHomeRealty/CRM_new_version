import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { MetaController } from './meta.controller';

/**
 * A Meta form card shows two counts: Facebook's (`leads_count`, every submission it ever received)
 * and the CRM's (`crm_count`). The CRM's must be counted by the same rule the list below it uses, so
 * the card and the "Leads from <form> (N in CRM)" heading can never disagree.
 *
 * Against the test database, in a transaction that is rolled back.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

type U = { id: number; name: string; role: string };
const as = (u: U): AuthUserRecord => ({ id: u.id, name: u.name, role: u.role, user_permissions: [] } as unknown as AuthUserRecord);

async function makeUser(tx: PrismaService, role: string): Promise<U> {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: { name: `ZZ Counts ${t}`, email: `zz-counts-${t}@probe.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
    select: { id: true, name: true, role: true },
  }) as Promise<U>;
}

describe('a Meta form card counts the CRM side the same way the list does', () => {
  it('crm_count equals the list total for that form, for an admin and for an agent', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const agent = await makeUser(tx, 'agent');
      const colleague = await makeUser(tx, 'agent');
      const page = `page-${tag()}`;
      const formA = `form-a-${tag()}`;
      const formB = `form-b-${tag()}`;
      const now = new Date();
      const lead = (form: string, owner: number | null, assigned: number, deleted = false) => tx.leads.create({
        data: {
          name: 'X', email: `x-${tag()}@probe.test`, source: 'facebook_meta', facebook_page_id: page, facebook_form_id: form,
          facebook_lead_id: `fb-${tag()}`, owner_user_id: owner, assigned_to: assigned,
          created_at: now, updated_at: now, ...(deleted ? { deleted_at: now } : {}),
        },
      });
      // Form A: two of the agent's own, one colleague's, one deleted. Form B: one brokerage lead.
      await lead(formA, agent.id, agent.id);
      await lead(formA, agent.id, agent.id);
      await lead(formA, colleague.id, colleague.id);
      await lead(formA, agent.id, agent.id, true);
      await lead(formB, null, admin.id);

      // Facebook reports its own figures, which the CRM count must not borrow from.
      const graphForms = [{ id: formA, name: 'Form A', leads_count: 9 }, { id: formB, name: 'Form B', leads_count: 4 }];
      const controller = new MetaController(
        { find: async () => ({ pages: [{ page_id: page, name: 'Page', token: 't' }] }) } as never,
        { forms: async () => graphForms } as never,
        null as never, null as never, tx,
      );

      for (const who of [admin, agent]) {
        const cards = ((await controller.forms(as(who), page)).forms as { id: string; leads_count: number; crm_count: number }[]);
        for (const card of cards) {
          const list = await controller.leads(as(who), '200', card.id, page);
          expect({ who: who.role, form: card.id, crm: card.crm_count }).toEqual({ who: who.role, form: card.id, crm: list.form_total });
        }
        const a = cards.find((c) => c.id === formA)!;
        const b = cards.find((c) => c.id === formB)!;
        expect(a.leads_count).toBe(9);
        // Visibility follows the lead rules: an agent's private leads are theirs alone, so the admin
        // counts none on form A and the brokerage lead on form B; the agent counts their own two on A.
        // The deleted lead is never counted, and the colleague's never reaches the agent.
        expect([a.crm_count, b.crm_count]).toEqual(who === admin ? [0, 1] : [2, 0]);
      }
    });
  });
});
