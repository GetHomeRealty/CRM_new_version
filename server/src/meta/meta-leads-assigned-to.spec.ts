import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { MetaController } from './meta.controller';

/**
 * "ASSIGNED TO" ON THE META LEADS LIST — the agent's name from the lead's own `assigned_to`, or null
 * when nobody is assigned, in the unfiltered list and in a form's latest and paged views alike.
 *
 * The name is read fresh on every request, so a reassignment shows on the next load; and it only
 * ever accompanies rows the viewer's lead scope already allowed. Real tables, rolled back.
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

type Row = { id: number; assigned_to: number | null; assigned_to_name: string | null };
type Res = { data: Row[] };

async function scene(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  const user = (name: string, role: string) => tx.users.create({
    data: { name: `${name} ${t}`, email: `zz-assign-${role}-${tag()}@probe.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
    select: { id: true, name: true, role: true },
  });
  const admin = await user('ZZ Admin', 'admin');
  const agent = await user('ZZ Agent', 'agent');
  const other = await user('ZZ Other', 'agent');
  const page = `page-${t}`;
  const form = `form-${t}`;
  const lead = (name: string, i: number, assigned: number | null) => tx.leads.create({
    data: {
      name, email: `l-${tag()}@probe.test`, source: 'facebook_meta', facebook_page_id: page, facebook_form_id: form,
      facebook_lead_id: `fb-${tag()}`, assigned_to: assigned, created_at: new Date(now.getTime() - i * 1000), updated_at: now,
    },
    select: { id: true },
  });
  const mine = await lead('Assigned to agent', 0, agent.id);
  const theirs = await lead('Assigned to other', 1, other.id);
  const nobody = await lead('Nobody', 2, null);
  const controller = new MetaController(null as never, null as never, null as never, null as never, tx);
  const as = (u: { id: number; name: string; role: string }) =>
    ({ id: u.id, name: u.name, role: u.role, user_permissions: [] }) as unknown as AuthUserRecord;
  return { controller, as, admin, agent, other, page, form, mine, theirs, nobody };
}

const byId = (res: Res, id: number) => res.data.find((r) => r.id === id);

describe('Assigned To on the Meta leads list', () => {
  it('names the assigned agent and leaves an unassigned lead null — unfiltered, latest and paged', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      const views = [
        await s.controller.leads(s.as(s.admin), '50', undefined, s.page),
        await s.controller.leads(s.as(s.admin), '50', s.form, s.page),
        await s.controller.leads(s.as(s.admin), '50', s.form, s.page, '1'),
      ] as unknown as Res[];
      for (const v of views) {
        expect(byId(v, s.mine.id)).toMatchObject({ assigned_to: s.agent.id, assigned_to_name: s.agent.name });
        expect(byId(v, s.theirs.id)).toMatchObject({ assigned_to: s.other.id, assigned_to_name: s.other.name });
        expect(byId(v, s.nobody.id)).toMatchObject({ assigned_to: null, assigned_to_name: null });
      }
    });
  });

  it('a reassignment shows on the next read', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      await tx.leads.update({ where: { id: s.nobody.id }, data: { assigned_to: s.other.id } });
      await tx.leads.update({ where: { id: s.mine.id }, data: { assigned_to: null } });
      const res = await s.controller.leads(s.as(s.admin), '50', s.form, s.page) as unknown as Res;
      expect(byId(res, s.nobody.id)?.assigned_to_name).toBe(s.other.name);
      expect(byId(res, s.mine.id)?.assigned_to_name).toBeNull();
    });
  });

  it('an agent still sees only their own leads — the column adds no rows', async () => {
    await inRollback(async (tx) => {
      const s = await scene(tx);
      const res = await s.controller.leads(s.as(s.agent), '50', s.form, s.page) as unknown as Res;
      expect(res.data.map((r) => r.id)).toEqual([s.mine.id]);
      expect(res.data[0].assigned_to_name).toBe(s.agent.name);
    });
  });
});
