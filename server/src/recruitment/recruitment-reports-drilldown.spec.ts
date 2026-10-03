import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService, SOURCE_NOT_RECORDED, UNASSIGNED } from './recruitment.service';

/**
 * Recruitment Reports drill-down: every "Candidates by recruiter" and "Where candidates came from"
 * row must equal the Candidates list it opens, under the same visibility scope — for an admin and
 * for a recruiter. Against the test database, in a transaction that is rolled back.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/*
 * REPEATABLE READ, so the report and the lists it is compared with read ONE snapshot.
 *
 * An admin's rows count every candidate in the database, not only this file's. Under the default
 * READ COMMITTED each statement sees whatever has been committed by then, and other recruitment
 * specs commit candidates and delete them again in `afterEach` while this runs — so "Unassigned"
 * came out 2 in the report and 3 in its list (and the reverse) in the full parallel gate, never
 * alone. One snapshot makes the comparison exact without narrowing what is compared.
 */
async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

type U = { id: number; name: string; role: string };
const as = (u: U): AuthUserRecord => ({ id: u.id, name: u.name, role: u.role, user_permissions: [] } as unknown as AuthUserRecord);
type Stats = { by_recruiter: { key: string; count: number; name: string }[]; by_source: { key: string; source: string; count: number }[] };
type List = { total: number; data: { id: number; assigned_recruiter_id: number | null; source: string | null; status: string }[] };

async function makeUser(tx: PrismaService, role: string): Promise<U> {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: { name: `ZZ Rep ${role} ${t}`, email: `zz-rep-${t}@probe.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
    select: { id: true, name: true, role: true },
  }) as Promise<U>;
}

/** A known spread: two recruiters, unassigned, three sources plus both kinds of "not recorded". */
async function seed(tx: PrismaService) {
  const admin = await makeUser(tx, 'admin');
  const a = await makeUser(tx, 'recruiter');
  const b = await makeUser(tx, 'recruiter');
  const t = tag();
  const referral = `referral-${t}`;
  const website = `website-${t}`;
  const now = new Date();
  const add = (recruiter: number | null, source: string | null, status = 'new') => tx.recruitment_candidates.create({
    data: { name: `ZZ Rep cand ${tag()}`, email: `c-${tag()}@probe.test`, status, source, assigned_recruiter_id: recruiter, created_at: now, updated_at: now },
  });
  await add(a.id, referral, 'new');
  await add(a.id, referral, 'new');
  await add(b.id, referral, 'contacted');
  await add(a.id, website, 'new');
  await add(null, website, 'new');
  await add(b.id, null, 'hold');
  await add(null, '', 'new');
  await add(a.id, null, 'interview');
  return { admin, a, b, referral, website };
}

async function expectParity(svc: RecruitmentService, user: AuthUserRecord) {
  const stats = await svc.stats(user) as unknown as Stats;
  for (const r of stats.by_recruiter) {
    const list = await svc.list(user, { recruiter: r.key }) as unknown as List;
    expect({ recruiter: r.name, total: list.total }).toEqual({ recruiter: r.name, total: r.count });
  }
  for (const r of stats.by_source) {
    const list = await svc.list(user, { source: r.key }) as unknown as List;
    expect({ source: r.source, total: list.total }).toEqual({ source: r.source, total: r.count });
  }
  return stats;
}

describe('Recruitment Reports drill-down: each row equals the list it opens', () => {
  it('admin: every recruiter and source row, including Unassigned and Not recorded', async () => {
    await inRollback(async (tx) => {
      const { admin, a, b, referral, website } = await seed(tx);
      const svc = new RecruitmentService(tx);
      const stats = await expectParity(svc, as(admin));

      const row = (key: string) => stats.by_recruiter.find((r) => r.key === key)?.count;
      const src = (key: string) => stats.by_source.find((r) => r.key === key)?.count;
      expect(row(String(a.id))).toBe(4);
      expect(row(String(b.id))).toBe(2);
      expect(src(referral)).toBe(3);
      expect(src(website)).toBe(2);
      // Null and empty are one "Not recorded" row, and its drill-down returns both kinds.
      expect(stats.by_source.filter((r) => r.key === SOURCE_NOT_RECORDED)).toHaveLength(1);
      const notRecorded = await svc.list(as(admin), { source: SOURCE_NOT_RECORDED }) as unknown as List;
      expect(notRecorded.data.every((c) => c.source === null || c.source === '')).toBe(true);
      expect(notRecorded.data.some((c) => c.source === '')).toBe(true);
      const unassigned = await svc.list(as(admin), { recruiter: UNASSIGNED }) as unknown as List;
      expect(unassigned.data.every((c) => c.assigned_recruiter_id === null)).toBe(true);
    });
  });

  it('combined filters return only candidates meeting all of them', async () => {
    await inRollback(async (tx) => {
      const { admin, a, referral } = await seed(tx);
      const list = await new RecruitmentService(tx).list(as(admin), { status: 'new', recruiter: String(a.id), source: referral }) as unknown as List;
      expect(list.total).toBe(2);
      expect(list.data.every((c) => c.status === 'new' && c.assigned_recruiter_id === a.id && c.source === referral)).toBe(true);
    });
  });

  it('recruiter: counts and drill-downs cover only their own candidates — never another recruiter\'s', async () => {
    await inRollback(async (tx) => {
      const { a, b, referral } = await seed(tx);
      const svc = new RecruitmentService(tx);
      const stats = await expectParity(svc, as(a));

      expect(stats.by_recruiter.map((r) => r.key)).toEqual([String(a.id)]);
      expect(stats.by_source.find((r) => r.key === referral)?.count).toBe(2);
      // Asking for another recruiter's, or the unassigned, candidates shows nothing.
      expect((await svc.list(as(a), { recruiter: String(b.id) }) as unknown as List).total).toBe(0);
      expect((await svc.list(as(a), { recruiter: UNASSIGNED }) as unknown as List).total).toBe(0);
      const refs = await svc.list(as(a), { source: referral }) as unknown as List;
      expect(refs.data.every((c) => c.assigned_recruiter_id === a.id)).toBe(true);
    });
  });

  it('an unknown recruiter filter is refused rather than ignored', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      await expect(new RecruitmentService(tx).list(as(admin), { recruiter: 'akhil' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('the Candidates list is paged, so every matching candidate is reachable', () => {
  it('120 matches → pages of 50, 50 and 20, each candidate exactly once, total constant', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const source = `paged-${tag()}`;
      const now = new Date(); // the same second for all — the id must keep the order fixed
      await tx.recruitment_candidates.createMany({
        data: Array.from({ length: 120 }, (_, i) => ({
          name: `ZZ Page ${i}`, email: `p-${i}-${tag()}@probe.test`, status: 'new', source, created_at: now, updated_at: now,
        })),
      });
      const svc = new RecruitmentService(tx);
      type Page = List & { page: number; per_page: number; last_page: number };
      const pages: Page[] = [];
      for (const page of [1, 2, 3]) pages.push(await svc.list(as(admin), { source, page }) as unknown as Page);

      expect(pages.map((p) => p.data.length)).toEqual([50, 50, 20]);
      expect(pages.map((p) => [p.total, p.page, p.per_page, p.last_page])).toEqual([[120, 1, 50, 3], [120, 2, 50, 3], [120, 3, 50, 3]]);
      const ids = pages.flatMap((p) => p.data.map((c) => c.id));
      expect(new Set(ids).size).toBe(120);

      // Past the end answers the last page; nonsense answers the first.
      expect((await svc.list(as(admin), { source, page: 99 }) as unknown as Page).page).toBe(3);
      expect((await svc.list(as(admin), { source, page: 'x' }) as unknown as Page).page).toBe(1);
    });
  });
});

describe('paging keeps every filter and the recruiter scope', () => {
  type Page = List & { page: number; per_page: number; last_page: number };
  const allPages = async (svc: RecruitmentService, user: AuthUserRecord, q: Record<string, unknown>) => {
    const first = await svc.list(user, { ...q, page: 1 }) as unknown as Page;
    const pages = [first];
    for (let p = 2; p <= first.last_page; p += 1) pages.push(await svc.list(user, { ...q, page: p }) as unknown as Page);
    return pages;
  };

  async function bigSeed(tx: PrismaService) {
    const admin = await makeUser(tx, 'admin');
    const a = await makeUser(tx, 'recruiter');
    const b = await makeUser(tx, 'recruiter');
    const source = `bulk-ref-${tag()}`;
    const now = new Date();
    const rows = (n: number, recruiter: number | null, status: string, src: string | null) => Array.from({ length: n }, (_, i) => ({
      name: `ZZ Bulk ${status} ${recruiter ?? 'u'} ${i}`, email: `b-${tag()}@probe.test`, status, source: src, assigned_recruiter_id: recruiter, created_at: now, updated_at: now,
    }));
    await tx.recruitment_candidates.createMany({ data: [
      ...rows(110, a.id, 'new', source), ...rows(15, a.id, 'contacted', source), ...rows(10, a.id, 'new', `other-${source}`),
      ...rows(60, b.id, 'new', source), ...rows(40, null, 'new', source),
    ] });
    return { admin, a, b, source };
  }

  it('Status + Recruiter + Source, paged at 50 and at 20: complete, no duplicates, every row matches', async () => {
    await inRollback(async (tx) => {
      const { admin, a, source } = await bigSeed(tx);
      const svc = new RecruitmentService(tx);
      const q = { status: 'new', recruiter: String(a.id), source };
      for (const per_page of [undefined, 20]) {
        const pages = await allPages(svc, as(admin), per_page ? { ...q, per_page } : q);
        const ids = pages.flatMap((p) => p.data.map((c) => c.id));
        expect(pages[0].total).toBe(110);
        expect(pages.map((p) => p.data.length)).toEqual(per_page ? [20, 20, 20, 20, 20, 10] : [50, 50, 10]);
        expect(new Set(ids).size).toBe(110);
        expect(pages.flatMap((p) => p.data).every((c) => c.status === 'new' && c.assigned_recruiter_id === a.id && c.source === source)).toBe(true);
      }
    });
  });

  it('a recruiter pages only through their own candidates, and the total equals their report row', async () => {
    await inRollback(async (tx) => {
      const { admin, a, b, source } = await bigSeed(tx);
      const svc = new RecruitmentService(tx);
      const adminRow = ((await svc.stats(as(admin))) as unknown as Stats).by_source.find((r) => r.key === source)!;
      expect(adminRow.count).toBe(225); // 110 + 15 + 60 + 40 — over 200
      const adminPages = await allPages(svc, as(admin), { source });
      expect(adminPages[0].total).toBe(225);
      expect(new Set(adminPages.flatMap((p) => p.data.map((c) => c.id))).size).toBe(225);

      const theirRow = ((await svc.stats(as(a))) as unknown as Stats).by_source.find((r) => r.key === source)!;
      const theirPages = await allPages(svc, as(a), { source });
      expect([theirRow.count, theirPages[0].total, theirPages.length]).toEqual([125, 125, 3]);
      expect(theirPages.flatMap((p) => p.data).every((c) => c.assigned_recruiter_id === a.id)).toBe(true);
      // Another recruiter's candidates stay out, however the pages are asked for.
      expect((await svc.list(as(a), { source, recruiter: String(b.id), page: 2 }) as unknown as Page).total).toBe(0);
    });
  });
});
