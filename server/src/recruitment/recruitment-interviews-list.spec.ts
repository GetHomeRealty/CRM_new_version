import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';

/**
 * The Interviews list the "Interviews Scheduled" and "Completed Interviews" cards open. Each card's
 * count must equal the list it opens, so both are checked against `stats()` on the same data.
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
    data: { name: `ZZ Iv ${role} ${t}`, email: `zz-iv-${t}@probe.test`, password: 'x', role, status: 'Active', created_at: now, updated_at: now },
    select: { id: true, name: true, role: true },
  }) as Promise<U>;
}

describe('the Interviews list behind the interview cards', () => {
  it('for each interview status, the list total equals the card count, for an admin and a recruiter', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const recruiter = await makeUser(tx, 'recruiter');
      const now = new Date();
      const candidate = (assigned: number | null) => tx.recruitment_candidates.create({
        data: { name: `ZZ Cand ${tag()}`, email: `c-${tag()}@probe.test`, status: 'interview', assigned_recruiter_id: assigned, created_at: now, updated_at: now },
      });
      const mine = await candidate(recruiter.id);
      const theirs = await candidate(null);
      const interview = (candidateId: number, status: string, day: number) => tx.recruitment_interviews.create({
        data: { candidate_id: candidateId, status, scheduled_at: new Date(Date.UTC(2026, 9, day, 15)), created_at: now, updated_at: now },
      });
      await interview(mine.id, 'scheduled', 10);
      await interview(mine.id, 'completed', 2);
      await interview(theirs.id, 'scheduled', 12);
      await interview(theirs.id, 'completed', 3);
      await interview(theirs.id, 'completed', 4);

      const svc = new RecruitmentService(tx);
      for (const who of [admin, recruiter]) {
        const stats = await svc.stats(as(who)) as { interviews: Record<string, number> };
        for (const status of ['scheduled', 'completed']) {
          const list = await svc.interviews(as(who), { status }) as { total: number; data: { status: string }[] };
          expect({ who: who.role, status, total: list.total }).toEqual({ who: who.role, status, total: stats.interviews[status] });
          expect(list.data.every((r) => r.status === status)).toBe(true);
        }
      }

      // The recruiter sees only their own candidate's interviews.
      const recruiterScheduled = await svc.interviews(as(recruiter), { status: 'scheduled' }) as { data: { candidate: { id: number } }[] };
      expect(recruiterScheduled.data.map((r) => r.candidate.id)).toEqual([mine.id]);
    });
  });

  it('lists scheduled interviews soonest first, and refuses an unknown status', async () => {
    await inRollback(async (tx) => {
      const admin = await makeUser(tx, 'admin');
      const now = new Date();
      const c = await tx.recruitment_candidates.create({
        data: { name: `ZZ Cand ${tag()}`, email: `c-${tag()}@probe.test`, status: 'interview', created_at: now, updated_at: now },
      });
      for (const day of [20, 11, 15]) {
        await tx.recruitment_interviews.create({ data: { candidate_id: c.id, status: 'scheduled', scheduled_at: new Date(Date.UTC(2026, 9, day, 15)), created_at: now, updated_at: now } });
      }
      const svc = new RecruitmentService(tx);
      const list = await svc.interviews(as(admin), { status: 'scheduled' }) as { data: { scheduled_at: string; candidate: { id: number } }[] };
      const ours = list.data.filter((r) => r.candidate.id === c.id).map((r) => r.scheduled_at.slice(8, 10));
      expect(ours).toEqual(['11', '15', '20']);
      await expect(svc.interviews(as(admin), { status: 'nonsense' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
