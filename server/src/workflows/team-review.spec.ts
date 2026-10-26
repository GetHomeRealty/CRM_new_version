import { PrismaClient } from '@prisma/client';
import { mayDecide, teamLeadOfRequester } from './team-review';

/**
 * DOCUMENTATION / ACCOUNTING TEAM LEADS REVIEW THEIR OWN TEAM'S REQUESTS (Sai, 25 Oct 2026).
 * Real rows in a rolled-back transaction: the rule reads users, so it is tested against the database.
 */
const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
afterAll(async () => { await prisma.$disconnect(); });

describe('who may decide a request', () => {
  jest.setTimeout(60_000);
  it('a Super Admin always; a Team Lead only their own team, never their own request', async () => {
    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const stamp = `${Date.now()}`;
        const mk = (name: string, role: string, extra: Record<string, unknown> = {}) => tx.users.create({
          data: { name: `ZZ ${name} ${stamp}`, email: `zz.${name.toLowerCase().replace(/\s+/g, '')}.${stamp}@spec.test`, role, status: 'Active', password: 'x', created_at: now, updated_at: now, ...extra } as never,
        });
        const docLead = await mk('Doc Lead', 'documentation', { is_team_lead: true });
        const acctLead = await mk('Acct Lead', 'accounting', { is_team_lead: true });
        const docMember = await mk('Doc Member', 'documentation', { team_lead_id: docLead.id });
        const loneDoc = await mk('Lone Doc', 'documentation');
        const agentLead = await mk('Agent Lead', 'agent', { is_team_lead: true });
        const agent = await mk('Agent', 'agent', { team_lead_id: agentLead.id });
        const admin = { id: -1, role: 'admin', status: 'Active' };

        expect(await mayDecide(tx, admin, docMember.id)).toBe(true);
        expect(await mayDecide(tx, docLead, docMember.id)).toBe(true);          // their team
        expect(await mayDecide(tx, acctLead, docMember.id)).toBe(false);        // another team
        expect(await mayDecide(tx, docLead, docLead.id)).toBe(false);           // their own request
        expect(await mayDecide(tx, docLead, loneDoc.id)).toBe(false);           // not in their team
        expect(await mayDecide(tx, docMember, docMember.id)).toBe(false);       // a member decides nothing
        expect(await mayDecide(tx, agentLead, agent.id)).toBe(false);           // an Agent Team Lead reviews no Desk requests
        expect((await teamLeadOfRequester(tx, docMember.id))?.id).toBe(docLead.id);
        expect(await teamLeadOfRequester(tx, agent.id)).toBeNull();

        // An inactive lead decides nothing, and is told nothing.
        await tx.users.update({ where: { id: docLead.id }, data: { status: 'Inactive' } });
        expect(await mayDecide(tx, { ...docLead, status: 'Inactive' }, docMember.id)).toBe(false);
        expect(await teamLeadOfRequester(tx, docMember.id)).toBeNull();
        throw new Error(ROLLBACK);
      }, { timeout: 60000 });
    } catch (e) { if (!String((e as Error).message).includes(ROLLBACK)) throw e; }
  });
});
