import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { MetaController } from './meta.controller';

/**
 * "SHOW ALL LEADS FROM THIS FORM" — paging through one form's leads without ever losing the form.
 *
 * Every page of a form-filtered list holds that form's leads and no others; the pages together hold
 * every one of them exactly once; `form_total` is the real count. Leaving out `list_page` gives the
 * first page, which is what every caller got before the parameter existed. Real tables, rolled back.
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

type Row = { id: number };
type Res = { data: Row[]; form_total?: number; page: number; per_page: number };

async function scene(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  const admin = await tx.users.create({
    data: { name: `ZZ Paging ${t}`, email: `zz-paging-${t}@probe.test`, password: 'x', role: 'admin', status: 'Active', created_at: now, updated_at: now },
    select: { id: true, name: true, role: true },
  });
  const page = `page-${t}`;
  const formA = `form-a-${t}`;
  const formB = `form-b-${t}`;
  const lead = (form: string, i: number) => tx.leads.create({
    data: {
      name: `L${i}`, email: `l-${tag()}@probe.test`, source: 'facebook_meta', facebook_page_id: page, facebook_form_id: form,
      facebook_lead_id: `fb-${tag()}`, created_at: new Date(now.getTime() - i * 1000), updated_at: now,
    },
    select: { id: true },
  });
  const a: number[] = [];
  for (let i = 0; i < 60; i += 1) a.push((await lead(formA, i)).id);
  for (let i = 0; i < 5; i += 1) await lead(formB, 100 + i);
  const controller = new MetaController(null as never, null as never, null as never, null as never, tx);
  const as = { id: admin.id, name: admin.name, role: 'admin', user_permissions: [] } as unknown as AuthUserRecord;
  return { controller, as, page, formA, formB, a };
}

describe('paging through one form', () => {
  it('every page holds only that form, and the pages hold all of it once each', async () => {
    await inRollback(async (tx) => {
      const { controller, as, page, formA, a } = await scene(tx);
      const p1 = await controller.leads(as, '50', formA, page, '1') as unknown as Res;
      const p2 = await controller.leads(as, '50', formA, page, '2') as unknown as Res;

      expect(p1).toMatchObject({ form_total: 60, page: 1, per_page: 50 });
      expect(p2).toMatchObject({ form_total: 60, page: 2, per_page: 50 });
      expect(p1.data).toHaveLength(50);
      expect(p2.data).toHaveLength(10);

      const seen = [...p1.data, ...p2.data].map((r) => r.id);
      expect(new Set(seen).size).toBe(60);
      expect(seen.sort((x, y) => x - y)).toEqual([...a].sort((x, y) => x - y)); // only Form A, all of it
    });
  });

  it('no list_page is the first page — what every caller got before', async () => {
    await inRollback(async (tx) => {
      const { controller, as, page, formA } = await scene(tx);
      const plain = await controller.leads(as, '50', formA, page) as unknown as Res;
      const first = await controller.leads(as, '50', formA, page, '1') as unknown as Res;
      expect(plain.data.map((r) => r.id)).toEqual(first.data.map((r) => r.id));
      expect(plain.page).toBe(1);
    });
  });

  it('a nonsense page is the first page; a page past the end is empty, with the real total', async () => {
    await inRollback(async (tx) => {
      const { controller, as, page, formA } = await scene(tx);
      const bad = await controller.leads(as, '50', formA, page, 'abc') as unknown as Res;
      expect(bad.page).toBe(1);
      expect(bad.data).toHaveLength(50);
      const past = await controller.leads(as, '50', formA, page, '9') as unknown as Res;
      expect(past.data).toHaveLength(0);
      expect(past.form_total).toBe(60);
    });
  });

  it('another form on the same Page is counted and listed on its own', async () => {
    await inRollback(async (tx) => {
      const { controller, as, page, formB } = await scene(tx);
      const b = await controller.leads(as, '50', formB, page) as unknown as Res;
      expect(b.form_total).toBe(5);
      expect(b.data).toHaveLength(5);
    });
  });
});
