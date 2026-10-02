import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { RecruitmentService } from './recruitment.service';

/**
 * EXPERIENCE AND LICENCE, AND THE THREE STATES A NULLABLE FIELD HAS.
 *
 * The questions here — has experience, how many years, licensed, licence number, brokerage,
 * availability, training needs — are all optional, and the reason this file exists is that OPTIONAL
 * MEANS THREE STATES, NOT TWO: yes, no, and nobody asked. A recruiter taking a name down over the
 * phone has asked none of it. Collapsing the third state into "no" would record an answer the
 * candidate never gave, and somebody reading the file later could not tell which it was.
 *
 * So the tests below are mostly about which of `undefined`, `null`, `''` and a value means what:
 *
 *   field absent from the request  →  leave the column alone      (the form did not mention it)
 *   null or ''                     →  write NULL                  (somebody cleared it)
 *   a value                        →  write the value
 *
 * The middle two matter because `update` is called with whatever the form holds. If a missing field
 * meant "clear", editing a phone number would wipe a licence number.
 */

const prisma = new PrismaClient();
const service = new RecruitmentService(prisma as unknown as PrismaService);

const ADMIN: AuthUserRecord = { id: 1, name: 'ZZ Admin', role: 'admin' } as unknown as AuthUserRecord;

let seq = 0;
const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const made: number[] = [];

type Row = {
  id: number;
  has_real_estate_experience: boolean | null;
  years_experience: number | null;
  is_licensed: boolean | null;
  licence_number: string | null;
  brokerage_name: string | null;
  availability: string | null;
  training_needs: string | null;
};

async function create(over: Record<string, unknown> = {}): Promise<Row> {
  const t = tag();
  const res = await service.create(ADMIN, {
    name: `ZZ Experience ${t}`,
    email: `zz-exp-${t}@probe.test`,
    ...over,
  }) as { data: Row };
  made.push(res.data.id);
  return res.data;
}

const reload = (id: number): Promise<Row> =>
  prisma.recruitment_candidates.findUniqueOrThrow({ where: { id } }) as unknown as Promise<Row>;

afterEach(async () => {
  if (made.length) await prisma.recruitment_candidates.deleteMany({ where: { id: { in: made.splice(0) } } });
});

afterAll(async () => { await prisma.$disconnect(); });

describe('experience and licence on create', () => {
  it('leaves every field NULL when none was asked', async () => {
    const row = await create();
    expect(row.has_real_estate_experience).toBeNull();
    expect(row.years_experience).toBeNull();
    expect(row.is_licensed).toBeNull();
    expect(row.licence_number).toBeNull();
    expect(row.brokerage_name).toBeNull();
    expect(row.availability).toBeNull();
    expect(row.training_needs).toBeNull();
  });

  it('stores what was asked, including an explicit No', async () => {
    const row = await create({
      has_real_estate_experience: 'true',
      years_experience: '7',
      is_licensed: 'false',
      licence_number: 'ABC-123456',
      brokerage_name: 'Somewhere Realty',
      availability: 'part_time',
      training_needs: 'Needs the listing paperwork walked through.',
    });

    /*
     * `is_licensed` FALSE AND `is_licensed` NULL ARE DIFFERENT ANSWERS, and this is the assertion
     * that says so: somebody with experience who is not licensed yet is a real and common case, and
     * it must not read the same as somebody nobody has asked.
     */
    expect(row.has_real_estate_experience).toBe(true);
    expect(row.is_licensed).toBe(false);
    expect(row.years_experience).toBe(7);
    expect(row.licence_number).toBe('ABC-123456');
    expect(row.brokerage_name).toBe('Somewhere Realty');
    expect(row.availability).toBe('part_time');
    expect(row.training_needs).toBe('Needs the listing paperwork walked through.');
  });

  it('reads an empty string from the form as "not asked", not as an answer', async () => {
    // Which is what an untouched dropdown or text box actually sends.
    const row = await create({
      has_real_estate_experience: '', years_experience: '', is_licensed: '',
      licence_number: '', brokerage_name: '', availability: '', training_needs: '',
    });
    expect(row.has_real_estate_experience).toBeNull();
    expect(row.years_experience).toBeNull();
    expect(row.is_licensed).toBeNull();
    expect(row.licence_number).toBeNull();
    expect(row.availability).toBeNull();
  });

  it('accepts a real zero, which is not the same as blank', async () => {
    // Somebody asked, and the answer was none. `0` must survive every falsy check on the way in.
    const row = await create({ has_real_estate_experience: 'false', years_experience: '0' });
    expect(row.years_experience).toBe(0);
    expect(row.has_real_estate_experience).toBe(false);
  });
});

describe('what the service refuses', () => {
  const refuses = async (body: Record<string, unknown>, matching: RegExp) => {
    const t = tag();
    await expect(service.create(ADMIN, { name: `ZZ Bad ${t}`, email: `zz-bad-${t}@probe.test`, ...body }))
      .rejects.toMatchObject({ response: { message: expect.stringMatching(matching) } });
    // And nothing was written on the way to refusing.
    expect(await prisma.recruitment_candidates.count({ where: { email: `zz-bad-${t}@probe.test` } })).toBe(0);
  };

  it('refuses negative years, in words rather than a constraint name', async () => {
    await refuses({ years_experience: '-3' }, /cannot be negative/i);
  });

  it('refuses years that are not a whole number', async () => {
    await refuses({ years_experience: '4.5' }, /whole number/i);
    await refuses({ years_experience: 'about ten' }, /whole number/i);
  });

  it('refuses a figure nobody could mean', async () => {
    // 90 years in real estate is a typo, and storing it quietly skews every report that averages it.
    await refuses({ years_experience: '900' }, /looks wrong/i);
  });

  it('refuses an availability that is not one of the three', async () => {
    await refuses({ availability: 'weekends' }, /Full time, Part time or Flexible/i);
    await refuses({ availability: 'FULL_TIME' }, /Full time, Part time or Flexible/i);
  });
});

describe('the database refuses the same things, whatever route they arrive by', () => {
  /*
   * THE CHECK CONSTRAINTS ARE NOT BELT AND BRACES. The service is the only thing an HTTP request can
   * get past, but an import, a migration or a hand-written UPDATE at a psql prompt never touches it,
   * and -3 years is wrong however it arrives. These two tests go around the service deliberately, to
   * show the column itself refuses.
   */
  it('will not store negative years written directly', async () => {
    const row = await create();
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "recruitment_candidates" SET "years_experience" = -1 WHERE "id" = ${row.id}`,
    )).rejects.toThrow(/years_experience_chk/);
    expect((await reload(row.id)).years_experience).toBeNull();
  });

  it('will not store an availability outside the three written directly', async () => {
    const row = await create();
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "recruitment_candidates" SET "availability" = 'sometimes' WHERE "id" = ${row.id}`,
    )).rejects.toThrow(/availability_chk/);
    expect((await reload(row.id)).availability).toBeNull();
  });

  it('allows NULL through both constraints, which is the point of them being nullable', async () => {
    const row = await create({ years_experience: '3', availability: 'flexible' });
    await prisma.$executeRawUnsafe(
      `UPDATE "recruitment_candidates" SET "years_experience" = NULL, "availability" = NULL WHERE "id" = ${row.id}`,
    );
    const after = await reload(row.id);
    expect(after.years_experience).toBeNull();
    expect(after.availability).toBeNull();
  });
});

describe('editing', () => {
  it('leaves a field alone when the request does not mention it', async () => {
    /*
     * THE ONE THAT WOULD HURT. An edit that sent only a phone number must not wipe a licence —
     * which is what would happen if a missing field were read as "clear this".
     */
    const row = await create({ is_licensed: 'true', licence_number: 'XYZ-9', years_experience: '5' });
    await service.update(ADMIN, row.id, { phone: '905-555-0100' });

    const after = await reload(row.id);
    expect(after.is_licensed).toBe(true);
    expect(after.licence_number).toBe('XYZ-9');
    expect(after.years_experience).toBe(5);
  });

  it('clears a field that was deliberately emptied', async () => {
    const row = await create({ is_licensed: 'true', licence_number: 'XYZ-9', availability: 'full_time' });
    await service.update(ADMIN, row.id, { licence_number: '', availability: '', is_licensed: '' });

    const after = await reload(row.id);
    expect(after.licence_number).toBeNull();
    expect(after.availability).toBeNull();
    expect(after.is_licensed).toBeNull();
  });

  it('changes what it is given', async () => {
    const row = await create({ years_experience: '2', availability: 'part_time' });
    await service.update(ADMIN, row.id, { years_experience: '6', availability: 'full_time' });

    const after = await reload(row.id);
    expect(after.years_experience).toBe(6);
    expect(after.availability).toBe('full_time');
  });

  it('refuses a bad value on edit too, and changes nothing', async () => {
    const row = await create({ years_experience: '2' });
    await expect(service.update(ADMIN, row.id, { years_experience: '-1' })).rejects.toBeDefined();
    await expect(service.update(ADMIN, row.id, { availability: 'maybe' })).rejects.toBeDefined();
    expect((await reload(row.id)).years_experience).toBe(2);
  });
});
