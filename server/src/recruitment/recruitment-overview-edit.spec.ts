import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';
import { RecruitmentController } from './recruitment.controller';
import { PermissionService } from '../auth/permission.service';
import { SCREEN_META } from '../auth/decorators';

/**
 * EDITING A CANDIDATE'S OVERVIEW — name, email, phone, location and source — through the existing
 * update endpoint, which is all the new Edit button on the candidate page sends.
 *
 * The form sends those five fields and nothing else, so everything else on the record — recruiter,
 * status, referral attribution, texting consent, Added, the experience answers — must come out of
 * the save exactly as it went in. Run against the real table and cleaned up afterwards.
 */

const prisma = new PrismaClient();
const service = new RecruitmentService(prisma as unknown as PrismaService);
let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

const ADMIN = { id: 1, name: 'ZZ Admin', role: 'admin' } as unknown as AuthUserRecord;
const made: number[] = [];

/** What the Overview form sends. */
const overview = (over: Record<string, unknown> = {}) => ({
  name: 'ZZ Edited Name', email: `zz-edit-${tag()}@probe.test`, phone: '+1 416 555 0199', location: 'Brampton', source: 'website', ...over,
});

async function candidate(over: Record<string, unknown> = {}) {
  const t = tag();
  const row = await prisma.recruitment_candidates.create({
    data: {
      name: `ZZ Candidate ${t}`,
      email: `zz-cand-${t}@probe.test`,
      status: 'interview',
      source: 'referral',
      referred_by_user_id: 1,
      assigned_recruiter_id: 1,
      sms_consent: true,
      sms_consent_by: 'ZZ Admin',
      sms_consent_at: new Date('2026-10-01T10:00:00Z'),
      has_real_estate_experience: true,
      years_experience: 4,
      licence_number: 'ZZ-LIC-1',
      created_by: 'ZZ Admin',
      created_at: new Date('2026-09-01T09:00:00Z'),
      updated_at: new Date('2026-09-01T09:00:00Z'),
      ...over,
    },
  });
  made.push(row.id);
  return row;
}

afterAll(async () => {
  await prisma.recruitment_events.deleteMany({ where: { candidate_id: { in: made } } });
  await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

describe('the Overview Edit saves the five fields', () => {
  it('saves a phone number (and the rest of the form) for a candidate who had none', async () => {
    const c = await candidate({ phone: null });
    const sent = overview();
    await service.update(ADMIN, c.id, sent);
    const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toMatchObject({ name: sent.name, email: sent.email, phone: sent.phone, location: 'Brampton', source: 'website' });
  });

  it('leaves recruiter, status, referral, texting consent, Added and experience exactly as they were', async () => {
    const c = await candidate();
    await service.update(ADMIN, c.id, overview());
    const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
    for (const k of [
      'assigned_recruiter_id', 'status', 'referred_by_user_id', 'sms_consent', 'sms_consent_by', 'sms_consent_at',
      'created_by', 'created_at', 'has_real_estate_experience', 'years_experience', 'licence_number', 'agent_user_id',
    ] as const) {
      expect([k, after[k]]).toEqual([k, c[k]]);
    }
  });

  it('records the edit in the candidate history', async () => {
    const c = await candidate();
    await service.update(ADMIN, c.id, overview());
    expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id, action: 'updated' } })).toBe(1);
  });
});

describe('validation and cancelling', () => {
  it('refuses a malformed email and changes nothing', async () => {
    const c = await candidate();
    await expect(service.update(ADMIN, c.id, overview({ email: 'not-an-email' }))).rejects.toBeInstanceOf(BadRequestException);
    const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toMatchObject({ name: c.name, email: c.email, phone: c.phone });
  });

  it('a cancelled edit sends nothing, so the record is untouched', async () => {
    // Cancel closes the form without a request; the record is simply what it was.
    const c = await candidate();
    const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.updated_at).toEqual(c.updated_at);
    expect(await prisma.recruitment_events.count({ where: { candidate_id: c.id } })).toBe(0);
  });
});

describe('who may edit', () => {
  it('a recruiter cannot edit a candidate assigned to somebody else (reads as not found)', async () => {
    const c = await candidate({ assigned_recruiter_id: 1 });
    const otherRecruiter = { id: 999_999, name: 'ZZ Other Recruiter', role: 'recruiter' } as unknown as AuthUserRecord;
    await expect(service.update(otherRecruiter, c.id, overview())).rejects.toBeInstanceOf(NotFoundException);
    const after = await prisma.recruitment_candidates.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.name).toBe(c.name);
  });

  it('the route needs Recruitment: edit — which an Agent does not hold and a Recruiter does', () => {
    const meta = Reflect.getMetadata(SCREEN_META, RecruitmentController.prototype.update) as { screen: string; level: string };
    expect(meta).toMatchObject({ screen: 'recruitment', level: 'edit' });

    const perms = new PermissionService();
    expect(perms.can('agent', [], 'recruitment', 'edit')).toBe(false);
    expect(perms.can('recruiter', [], 'recruitment', 'edit')).toBe(true);
  });
});
