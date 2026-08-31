import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import { ageFromDateOfBirth, dateOfBirthWindow } from './age';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-034: the Age Range filter has to find every lead whose displayed age is in range.
 *
 * THE TWO FAULTS, and they had one cause. The list DISPLAYS an age derived from `date_of_birth`,
 * while the filter asked the stored `age` COLUMN. So:
 *
 *   · a lead with a birthday and no stored age showed an age on screen and matched NO range at all;
 *   · a lead whose stored age had gone stale since it was typed was findable only at the old
 *     number — the report's "recorded as 24, findable only at 23".
 *
 * WHY THE AUDIT COULD NOT SEE IT. They checked whether the stored age and the derived age agreed
 * and found they did — but the API never exposes the raw column, so the value they compared against
 * the birthday WAS the derived one. The check compared the derived age with itself.
 *
 * THE BOUNDARIES ARE THE INTERESTING PART. `age <= max` has to be an EXCLUSIVE lower bound on the
 * date of birth: somebody born exactly `max + 1` years ago today has just had that birthday and is
 * `max + 1`, not `max`. Half of these cases exist to pin that.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const AGENT = { id: 553311, name: 'ZZ Age Agent', role: 'agent' } as unknown as AuthUserRecord;

function leadsFor(tx: PrismaService) {
  return new LeadsService(tx, new LeadAuditService(tx), new LeadNotificationService(tx, null as never));
}

/** A birthday that makes somebody exactly `age` years old today. */
function bornToBe(age: number, offsetDays = 0): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

async function makeLead(tx: PrismaService, over: Record<string, unknown>) {
  const t = tag();
  const now = new Date();
  return tx.leads.create({
    data: {
      name: `ZZ Age ${t}`, email: `zz-age-${t}@probe.invalid`, phone: '4165550000',
      lead_status: 'warm', owner_user_id: AGENT.id, assigned_to: AGENT.id,
      created_at: now, updated_at: now, ...over,
    },
  });
}

type Listed = { data: { id: number; age: number | null }[]; meta: { total: number } };
const ids = (r: Listed) => r.data.map((x) => x.id);

describe('the age filter matches the age the screen shows', () => {
  it('finds a lead that has a birthday but no stored age', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { date_of_birth: bornToBe(30), age: null });
      const res = await leadsFor(tx).list(AGENT, { limit: '200', minAge: '0', maxAge: '150' } as never) as Listed;

      // THE DEFECT: this lead displayed an age of 30 and matched no range whatsoever.
      expect(ids(res)).toContain(lead.id);
    });
  });

  it('finds a lead by the age it DISPLAYS, not a stale stored one', async () => {
    await inRollback(async (tx) => {
      // Stored 24, birthday says 25: the screen shows 25, so 25 must find it and 24 must not.
      const lead = await makeLead(tx, { date_of_birth: bornToBe(25), age: 24 });

      const atShown = await leadsFor(tx).list(AGENT, { limit: '200', minAge: '25', maxAge: '25' } as never) as Listed;
      const atStale = await leadsFor(tx).list(AGENT, { limit: '200', minAge: '24', maxAge: '24' } as never) as Listed;

      expect(ids(atShown)).toContain(lead.id);
      expect(ids(atStale)).not.toContain(lead.id);
    });
  });

  it('still uses the stored age when there is no birthday', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { date_of_birth: null, age: 41 });
      const inside = await leadsFor(tx).list(AGENT, { limit: '200', minAge: '40', maxAge: '45' } as never) as Listed;
      const outside = await leadsFor(tx).list(AGENT, { limit: '200', minAge: '20', maxAge: '30' } as never) as Listed;

      expect(ids(inside)).toContain(lead.id);
      expect(ids(outside)).not.toContain(lead.id);
    });
  });

  it('includes somebody whose birthday is today', async () => {
    // They turned `age` this morning and are exactly on the lower boundary.
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { date_of_birth: bornToBe(30), age: null });
      const res = await leadsFor(tx).list(AGENT, { limit: '200', minAge: '30', maxAge: '30' } as never) as Listed;
      expect(ids(res)).toContain(lead.id);
    });
  });

  it('excludes somebody who turned one year older today', async () => {
    /*
     * THE EXCLUSIVE BOUND. Born exactly 31 years ago today, they are 31 — not 30 — so a 20-30 range
     * must not return them. An inclusive comparison here would sweep in a whole extra birthday.
     */
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { date_of_birth: bornToBe(31), age: null });
      const res = await leadsFor(tx).list(AGENT, { limit: '200', minAge: '20', maxAge: '30' } as never) as Listed;
      expect(ids(res)).not.toContain(lead.id);
    });
  });

  it('includes somebody whose birthday is tomorrow, who is still the younger age', async () => {
    await inRollback(async (tx) => {
      // Born 31 years ago plus a day: that birthday has not happened yet, so they are still 30.
      const lead = await makeLead(tx, { date_of_birth: bornToBe(31, 1), age: null });
      const res = await leadsFor(tx).list(AGENT, { limit: '200', minAge: '20', maxAge: '30' } as never) as Listed;
      expect(ids(res)).toContain(lead.id);
    });
  });

  it('agrees with the age it reports for the same lead', async () => {
    // The strongest form of the rule: whatever the row says its age is, that age must find it.
    await inRollback(async (tx) => {
      const lead = await makeLead(tx, { date_of_birth: bornToBe(37), age: 12 });
      const one = await leadsFor(tx).list(AGENT, { limit: '200', search: 'ZZ Age' } as never) as Listed;
      const row = one.data.find((r) => r.id === lead.id);
      expect(row?.age).toBe(ageFromDateOfBirth(bornToBe(37)));

      const found = await leadsFor(tx).list(AGENT, {
        limit: '200', minAge: String(row!.age), maxAge: String(row!.age),
      } as never) as Listed;
      expect(ids(found)).toContain(lead.id);
    });
  });

  it('leaves the window open on the side that was not given', () => {
    const w = dateOfBirthWindow(30, null);
    expect(w.lte).toBeInstanceOf(Date);
    expect(w.gt).toBeUndefined();
    expect(dateOfBirthWindow(null, 30).lte).toBeUndefined();
  });
});
