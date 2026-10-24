import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { SCREEN_META } from '../auth/decorators';
import { RecruitmentOnboardingService, readValue, splitName } from './recruitment-onboarding.service';
import { RecruitmentOnboardingController } from './recruitment-onboarding.controller';
import { RecruitmentNoAgentsGuard } from './recruitment-no-agents.guard';

/**
 * RECRUITMENT → ONBOARDING & TRAINING, against the real tables (myapp_test), cleaned up afterwards.
 * Every person and candidate made here carries `T` in its name; steps added here are deleted.
 */

const prisma = new PrismaClient();
const svc = new RecruitmentOnboardingService(prisma as unknown as PrismaService);
const T = `${Date.now()}`;
const n = (s: string) => `ZZ Ob ${s} ${T}`;

const ADMIN = { id: 1, name: 'ZZ Ob Admin', email: 'zz-ob-admin@probe.test', role: 'admin' } as unknown as AuthUserRecord;
const RECRUITER = { id: 2, name: 'ZZ Ob Recruiter', email: 'zz-ob-rec@probe.test', role: 'recruiter' } as unknown as AuthUserRecord;
const addedSteps: number[] = [];

type Listed = {
  steps: { id: number; kind: string; title: string; position: number; hidden: boolean }[];
  people: { id: number; name: string; tag: string | null; candidate_id: number | null; marks: Record<string, string> }[];
  can_manage: boolean;
};
const listed = async (u = ADMIN) => (await svc.list(u)) as unknown as Listed;
const mine = (l: Listed) => l.people.filter((p) => p.name.includes(T));
const stepId = async (kind: string, title: string) =>
  (await prisma.recruitment_onboarding_steps.findFirstOrThrow({ where: { kind, title } })).id;

afterAll(async () => {
  await prisma.recruitment_onboarding_people.deleteMany({ where: { name: { contains: T } } });
  await prisma.recruitment_candidates.deleteMany({ where: { name: { contains: T } } });
  if (addedSteps.length) await prisma.recruitment_onboarding_steps.deleteMany({ where: { id: { in: addedSteps } } });
  await prisma.$disconnect();
});

describe('the sheet vocabulary', () => {
  it('reads the sheet\'s values and names as written', () => {
    expect(readValue('YES')).toBe('yes');
    expect(readValue(' Not Attended ')).toBe('not_attended');
    expect(readValue('Agent using own email')).toBe('own_email');
    expect(readValue('N/A')).toBe('na');
    expect(readValue(' .')).toBe('');
    expect(readValue('')).toBe('');
    expect(readValue('Digital card')).toBeNull();
    expect(splitName('Meenu Gulerya\n(FE)')).toEqual({ name: 'Meenu Gulerya', tag: 'FE' });
    expect(splitName('Dilawarjeet Mangat  (FE0\n')).toEqual({ name: 'Dilawarjeet Mangat', tag: 'FE' });
    expect(splitName('SAIVARDHAN REDDY(FF)')).toEqual({ name: 'SAIVARDHAN REDDY', tag: 'FF' });
    expect(splitName('Satish Yangala')).toEqual({ name: 'Satish Yangala', tag: null });
  });

  it('is seeded with the sheet\'s 17 onboarding steps and 12 training topics', async () => {
    const l = await listed();
    const seeded = (kind: string) => l.steps.filter((s) => s.kind === kind && !addedSteps.includes(s.id));
    expect(seeded('onboarding').length).toBeGreaterThanOrEqual(17);
    expect(seeded('training').length).toBeGreaterThanOrEqual(12);
    expect(l.steps.map((s) => s.title)).toEqual(expect.arrayContaining(['ONBOARDING EMAIL', 'EXPLORING MLS', 'Case Study']));
  });
});

describe('who may do what', () => {
  it('every route is a recruitment screen route, and agents are refused at the controller', () => {
    const p = RecruitmentOnboardingController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(SCREEN_META, p.list as object)).toMatchObject({ screen: 'recruitment', level: 'view' });
    for (const h of ['setMark', 'addPerson', 'updatePerson', 'removePerson', 'addStep', 'updateStep', 'importPreview', 'importSheet']) {
      expect(Reflect.getMetadata(SCREEN_META, p[h] as object)).toMatchObject({ screen: 'recruitment', level: 'edit' });
    }
    expect(Reflect.getMetadata('__guards__', RecruitmentOnboardingController)).toContain(RecruitmentNoAgentsGuard);
  });

  it('a recruiter fills in cells and adds people, but the step list, removal and import are administrators\'', async () => {
    expect((await listed(RECRUITER)).can_manage).toBe(false);
    expect((await listed(ADMIN)).can_manage).toBe(true);
    const { data } = (await svc.addPerson(RECRUITER, { name: n('Recruiter Added') })) as { data: { id: number } };
    await expect(svc.setMark(RECRUITER, data.id, await stepId('onboarding', 'ONBOARDING EMAIL'), { value: 'yes' })).resolves.toBeDefined();
    await expect(svc.addStep(RECRUITER, { kind: 'training', title: n('step') })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.updateStep(RECRUITER, await stepId('training', 'Leases'), { hidden: true })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.removePerson(RECRUITER, data.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.importPreview(RECRUITER, { filename: 'x.xlsx', content_base64: 'UEs=' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('cells', () => {
  it('saves a value, refuses one that is not the step\'s, and clears on blank', async () => {
    const { data } = (await svc.addPerson(ADMIN, { name: n('Cells'), tag: 'fe' })) as { data: { id: number; tag: string } };
    expect(data.tag).toBe('FE');
    const email = await stepId('onboarding', 'ONBOARDING EMAIL');
    const mls = await stepId('training', 'EXPLORING MLS');
    await svc.setMark(ADMIN, data.id, email, { value: 'own_email' });
    await svc.setMark(ADMIN, data.id, mls, { value: 'interested' });
    await expect(svc.setMark(ADMIN, data.id, mls, { value: 'own_email' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setMark(ADMIN, data.id, email, { value: 'interested' })).rejects.toBeInstanceOf(BadRequestException);
    let p = mine(await listed()).find((x) => x.id === data.id)!;
    expect(p.marks).toEqual({ [email]: 'own_email', [mls]: 'interested' });
    await svc.setMark(ADMIN, data.id, email, { value: '' });
    p = mine(await listed()).find((x) => x.id === data.id)!;
    expect(p.marks).toEqual({ [mls]: 'interested' });
    await expect(svc.setMark(ADMIN, 0, email, { value: 'yes' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a removed person leaves the list but keeps their marks', async () => {
    const { data } = (await svc.addPerson(ADMIN, { name: n('Removed') })) as { data: { id: number } };
    await svc.setMark(ADMIN, data.id, await stepId('onboarding', 'BUSINESS CARDS'), { value: 'no' });
    await svc.removePerson(ADMIN, data.id);
    expect(mine(await listed()).some((x) => x.id === data.id)).toBe(false);
    expect(await prisma.recruitment_onboarding_marks.count({ where: { person_id: data.id } })).toBe(1);
  });
});

describe('the step list', () => {
  it('an administrator adds, renames, moves and hides a step', async () => {
    const { data } = (await svc.addStep(ADMIN, { kind: 'training', title: `  ${n('Topic')}  ` })) as { data: { id: number; title: string; position: number } };
    addedSteps.push(data.id);
    expect(data.title).toBe(n('Topic'));
    const trainingIds = async () => (await listed()).steps.filter((s) => s.kind === 'training').map((s) => s.id);
    expect((await trainingIds()).at(-1)).toBe(data.id);
    await svc.updateStep(ADMIN, data.id, { move: 'up' });
    expect((await trainingIds()).at(-2)).toBe(data.id);
    await svc.updateStep(ADMIN, data.id, { move: 'down' });
    expect((await trainingIds()).at(-1)).toBe(data.id);
    const renamed = (await svc.updateStep(ADMIN, data.id, { title: n('Renamed'), hidden: true })) as { data: { title: string; hidden: boolean } };
    expect(renamed.data).toMatchObject({ title: n('Renamed'), hidden: true });
    await expect(svc.addStep(ADMIN, { kind: 'other', title: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.addStep(ADMIN, { kind: 'training', title: ' ' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('candidates join the list by themselves', () => {
  const candidate = async (name: string, status: string) => {
    const now = new Date();
    return prisma.recruitment_candidates.create({ data: { name, email: `zz-ob-${status}-${T}-${Math.random()}@probe.test`, status, created_at: now, updated_at: now } });
  };

  it('Onboarding and Active candidates appear once; earlier statuses do not', async () => {
    const a = await candidate(n('Active Cand'), 'active');
    const o = await candidate(n('Onboarding Cand'), 'onboarding');
    const x = await candidate(n('New Cand'), 'new');
    await listed();
    const l = mine(await listed());
    expect(l.filter((p) => p.candidate_id === a.id)).toHaveLength(1);
    expect(l.filter((p) => p.candidate_id === o.id)).toHaveLength(1);
    expect(l.some((p) => p.candidate_id === x.id)).toBe(false);
  });

  it('an imported agent with the same name is linked, not doubled; a removed one stays removed', async () => {
    const { data: twin } = (await svc.addPerson(ADMIN, { name: n('Twin') })) as { data: { id: number } };
    const c = await candidate(n('twin'), 'active');
    const l = mine(await listed());
    expect(l.filter((p) => p.name.toLowerCase() === n('twin').toLowerCase())).toHaveLength(1);
    expect(l.find((p) => p.id === twin.id)?.candidate_id).toBe(c.id);

    await svc.removePerson(ADMIN, twin.id);
    await listed();
    expect(await prisma.recruitment_onboarding_people.count({ where: { candidate_id: c.id } })).toBe(1);
    expect(mine(await listed()).some((p) => p.candidate_id === c.id)).toBe(false);
  });
});

describe('importing the Onboarding & Trainings sheet', () => {
  /** A cut-down copy of the real workbook: the same tab names and the two layouts. */
  async function workbook(extra: { onboardingValue?: string } = {}) {
    const wb = new ExcelJS.Workbook();
    const ob = wb.addWorksheet('NEW ONBOARD TASK SHEET');
    ob.addRow(['Agent Name', 'ONBOARDING EMAIL', 'Highlight New Agent on Internal Agent’s Closed Deals in Advertising', 'ZZ Not A Step']);
    ob.addRow([n('Alpha'), extra.onboardingValue ?? 'YES', 'NO', 'YES']);
    ob.addRow([`${n('Aman Multani')}(FE)`, 'Agent using own email', 'Maybe', '']);
    ob.addRow([n('Onboard Only'), 'N/A', '', '']);
    const tr = wb.addWorksheet('Training topics');
    tr.addRow(['AGENT NAME/TRAINING TOPICS', `${n('Alpha')}\n(FE)`, `ZZ Ob Aman ${T}   (FE)`, n('Trainee Solo')]);
    tr.addRow(['EXPLORING MLS ', 'YES', 'Not Attended', 'Interested']);
    tr.addRow(['NEGOTIATION SKILLS  ', ' .', 'IN PROGRESS', 'YES']);
    wb.addWorksheet('Onboard Tasks').addRow([' ', 'Somebody']);
    wb.addWorksheet('NEW AGENT DATA').addRow(['DATE', 'NAME']);
    return { filename: 'Onboarding & Trainings.xlsx', content_base64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
  }
  type Summary = {
    ignored_sheets: string[];
    people: { total: number; new: number; existing: number };
    marks: { new: number; already_same: number; kept_crm_value: number };
    unknown_columns: { title: string }[];
    unknown_values: { cell: string; value: string }[];
    unmatched: { key: string; name: string; suggestion: string | null }[];
    imported?: { people: number; marks: number };
  };

  it('previews without writing, suggests the near-match, and reports what it cannot read', async () => {
    const before = await prisma.recruitment_onboarding_people.count();
    const s = (await svc.importPreview(ADMIN, await workbook())) as unknown as Summary;
    expect(await prisma.recruitment_onboarding_people.count()).toBe(before);
    expect(s.ignored_sheets).toEqual(['Onboard Tasks', 'NEW AGENT DATA']);
    expect(s.unknown_columns.map((u) => u.title)).toEqual(['ZZ Not A Step']);
    expect(s.unknown_values).toEqual([expect.objectContaining({ cell: 'C3', value: 'Maybe' })]);
    // "Aman" on the training tab is offered "Aman Multani"; "Trainee Solo" has no likely match.
    const aman = s.unmatched.find((u) => u.name === `ZZ Ob Aman ${T}`)!;
    expect(aman.suggestion).toBe(n('Aman Multani').toLowerCase());
    expect(s.unmatched.find((u) => u.name === n('Trainee Solo'))?.suggestion).toBeNull();
    expect(s.people).toEqual({ total: 4, new: 4, existing: 0 });
    // Onboarding: Alpha 2 (+ the unknown column skipped), Aman 1, Onboard Only 1. Training: Alpha 1, Aman 2, Trainee Solo 2.
    expect(s.marks).toEqual({ new: 9, already_same: 0, kept_crm_value: 0 });
  });

  it('refuses a match to a name that was not offered, two names matched to one, and files that are not the sheet', async () => {
    const file = await workbook();
    const preview = (await svc.importPreview(ADMIN, file)) as unknown as Summary;
    const [first, second] = preview.unmatched;
    await expect(svc.importSheet(ADMIN, { ...file, matches: { [first.key]: 'nobody at all' } })).rejects.toBeInstanceOf(BadRequestException);
    if (first && second) {
      const target = n('Onboard Only').toLowerCase();
      await expect(svc.importSheet(ADMIN, { ...file, matches: { [first.key]: target, [second.key]: target } })).rejects.toBeInstanceOf(BadRequestException);
    }
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['Name']);
    const other = { filename: 'other.xlsx', content_base64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') };
    await expect(svc.importPreview(ADMIN, other)).rejects.toThrow(/NEW ONBOARD TASK SHEET/);
    await expect(svc.importPreview(ADMIN, { filename: 'x.csv', content_base64: 'YQ==' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.importPreview(ADMIN, { filename: 'x.xlsx', content_base64: 'YWJj' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('imports with the administrator\'s matches, once, and never overwrites a value set in the CRM', async () => {
    const file = await workbook();
    const preview = (await svc.importPreview(ADMIN, file)) as unknown as Summary;
    const matches = Object.fromEntries(preview.unmatched.map((u) => [u.key, u.suggestion ?? '']));
    const first = (await svc.importSheet(ADMIN, { ...file, matches })) as unknown as Summary;
    expect(first.imported).toEqual({ people: 4, marks: 9 });

    const people = await prisma.recruitment_onboarding_people.findMany({ where: { name: { contains: T }, removed_at: null, candidate_id: null }, include: { marks: true } });
    const aman = people.find((p) => p.name === n('Aman Multani'))!;
    expect(aman.tag).toBe('FE');
    expect(aman.marks).toHaveLength(3);
    expect(people.find((p) => p.name === n('Alpha'))?.tag).toBe('FE');
    expect(people.some((p) => p.name === `ZZ Ob Aman ${T}`)).toBe(false);

    // Somebody changes Alpha's onboarding email on the screen, then the old sheet is imported again.
    const alpha = people.find((p) => p.name === n('Alpha'))!;
    await svc.setMark(ADMIN, alpha.id, await stepId('onboarding', 'ONBOARDING EMAIL'), { value: 'in_progress' });
    const again = (await svc.importSheet(ADMIN, { ...file, matches })) as unknown as Summary;
    expect(again.imported).toEqual({ people: 0, marks: 0 });
    expect(again.marks).toEqual({ new: 0, already_same: 8, kept_crm_value: 1 });
    const kept = await prisma.recruitment_onboarding_marks.findFirstOrThrow({ where: { person_id: alpha.id, step_id: await stepId('onboarding', 'ONBOARDING EMAIL') } });
    expect(kept.value).toBe('in_progress');
  });

});
