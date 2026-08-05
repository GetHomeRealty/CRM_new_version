import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto';
import { GLOBAL_LIMIT, SETTINGS_WRITE_LIMIT } from '../config/rate-limits';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The CRM › Settings items that were still open after the High and Medium remediations of
 * 2026-08-04: S-M3, S-L1, S-L4 and L11.
 *
 * The rest of the recorded 19 were re-measured against the code on 2026-08-05 and found already
 * closed — S-M9 / S-L7 / L15 (the signature is sanitised in `CrmAdvancedEmailService.shell`),
 * S-M10 / L13 (the two foreign keys exist, migration 20260804120000), S-L5 (`listLog` takes
 * `Math.min(500, limit)`), L16 (`listLog` filters on `data.read-all`), L3 (`useUnsavedGuard`),
 * L4 and L5. Recorded here rather than re-tested, because a test for a fix somebody else already
 * pinned is duplicate cover, and the misleading part was the register, not the code.
 *
 * Written as the failure, not the feature.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const noMailer = { send: async () => ({ ok: true }) } as never;
const noAccounts = { defaultSender: async () => null } as never;
const asUser = (role: string, id: number, name: string) => ({ id, name, role } as unknown as AuthUserRecord);

afterAll(async () => { await prisma.$disconnect(); });

/** A throwaway account, inside the caller's rolled-back transaction. */
async function makeUser(tx: PrismaService, email: string, username: string | null) {
  const now = new Date();
  return tx.users.create({
    data: {
      name: `ZZ Low ${tag()}`, email, username, role: 'agent', status: 'Active',
      password: 'x', created_at: now, updated_at: now,
    },
    select: { id: true, name: true, email: true },
  });
}

describe('S-M3 — a profile email differing only in capitalisation is refused, not 500', () => {
  /*
   * `users_email_lower_key` and `users_username_lower_key` are UNIQUE on `lower(...)` — migration
   * 20260803000000. `saveProfile` compared the RAW string, so `ADMIN@test.local` passed the
   * application's own check, reached the INSERT, violated the index and surfaced as a bare 500.
   *
   * `users.service.ts` has compared case-insensitively since that migration landed. This is the
   * other door onto the same row.
   */
  const svc = (tx: PrismaService) => new CrmSettingsService(tx, noMailer, noAccounts);

  it('an address that differs only in case is a clash', async () => {
    await inRollback(async (tx) => {
      const taken = `zz-lower-${tag()}@probe.test`;
      await makeUser(tx, taken, null);
      const me = await makeUser(tx, `zz-mine-${tag()}@probe.test`, null);

      await expect(
        svc(tx).saveProfile(asUser('agent', me.id, me.name), { name: me.name, email: taken.toUpperCase() }),
      ).rejects.toMatchObject({ response: { errors: { email: ['That email address is already in use.'] } } });
    });
  });

  it('…and the refusal is a 400, which is the whole point of the finding', async () => {
    await inRollback(async (tx) => {
      const taken = `zz-status-${tag()}@probe.test`;
      await makeUser(tx, taken, null);
      const me = await makeUser(tx, `zz-status-mine-${tag()}@probe.test`, null);

      // A 500 here means the database refused what the application accepted. `getStatus()` is what
      // the client actually receives, so it is what the test asserts.
      const err = await svc(tx)
        .saveProfile(asUser('agent', me.id, me.name), { name: me.name, email: taken.toUpperCase() })
        .then(() => null, (e: { getStatus?: () => number }) => e);
      expect(err?.getStatus?.()).toBe(400);
    });
  });

  it('a username differing only in case is a clash too — same index, same gap', async () => {
    await inRollback(async (tx) => {
      const held = `zzlower${tag()}`.replace(/-/g, '');
      await makeUser(tx, `zz-u-${tag()}@probe.test`, held);
      const me = await makeUser(tx, `zz-u-mine-${tag()}@probe.test`, `zzmine${tag()}`.replace(/-/g, ''));

      await expect(
        svc(tx).saveProfile(asUser('agent', me.id, me.name), { name: me.name, username: held.toUpperCase() }),
      ).rejects.toMatchObject({ response: { errors: { username: ['That username is already taken.'] } } });
    });
  });

  it('changing the case of YOUR OWN address is still allowed', async () => {
    // The `id: { not: id }` clause is what makes this work, and it is the case a naive
    // case-insensitive check breaks: nobody should be locked out of tidying their own capitalisation.
    await inRollback(async (tx) => {
      const mine = `zz-self-${tag()}@probe.test`;
      const me = await makeUser(tx, mine, null);
      await expect(
        svc(tx).saveProfile(asUser('agent', me.id, me.name), { name: me.name, email: mine.toUpperCase() }),
      ).resolves.toMatchObject({ message: 'Personal information updated successfully' });
    });
  });
});

describe('S-L1 — company settings text is trimmed before it is stored', () => {
  /*
   * `"  Padded Brokerage  "` was stored verbatim and then printed, padding included, on invoices and
   * deposit receipts. The Users module was fixed for this (U-M1); Settings was not.
   */
  const dto = (body: Record<string, unknown>) => plainToInstance(UpdateCompanySettingsDto, body);

  it('surrounding whitespace is gone from the name', () => {
    expect(dto({ name: '  Padded Brokerage  ' }).name).toBe('Padded Brokerage');
  });

  it.each([
    ['address', '  12 King St W  ', '12 King St W'],
    ['phone', ' 905-565-9933 ', '905-565-9933'],
    ['bank_name', '  TD  ', 'TD'],
    ['transit_no', ' 01234 ', '01234'],
    ['invoice_prefix', ' INV- ', 'INV-'],
    ['default_terms', '  Net 30  ', 'Net 30'],
    ['thank_you_note', '\n  Thank you.  \n', 'Thank you.'],
  ])('%s is trimmed', (field, given, expected) => {
    expect((dto({ name: 'X', [field]: given }) as unknown as Record<string, unknown>)[field]).toBe(expected);
  });

  it('a whitespace-only name is now REFUSED rather than stored', () => {
    /*
     * This is the half of S-L2 that trimming closes. `@IsNotEmpty()` passed `"   "` because the
     * string is not empty; `current()` then self-healed it to the hardcoded factory default, so an
     * administrator saw somebody else's brokerage name appear. H6 removed the self-heal, which left
     * three spaces as the brokerage's name. Trimming first is what makes `@IsNotEmpty` mean what it
     * says.
     */
    const errors = validateSync(dto({ name: '   ' }));
    expect(errors.map((e) => e.property)).toContain('name');
  });

  it('interior whitespace is untouched — this trims, it does not reformat', () => {
    expect(dto({ name: '  Get Home  Realty INC  ' }).name).toBe('Get Home  Realty INC');
  });
});

describe('S-L4 — the company email has to look like an email', () => {
  /*
   * The field had no format check at all: `"not-an-email"` was accepted and stored, and it prints on
   * client-facing invoices and deposit receipts as the brokerage's contact address.
   */
  const errorsFor = (body: Record<string, unknown>) =>
    validateSync(plainToInstance(UpdateCompanySettingsDto, { name: 'X', ...body })).map((e) => e.property);

  it.each(['not-an-email', 'info@', '@gethomerealty.ca', 'info gethome@realty.ca', 'info@localhost'])(
    '%s is refused', (email) => { expect(errorsFor({ email })).toContain('email'); },
  );

  it.each(['info@gethomerealty.ca', 'first.last+tag@sub.example.co.uk'])('%s is accepted', (email) => {
    expect(errorsFor({ email })).not.toContain('email');
  });

  it('EMPTY is accepted, because clearing the box is how you unset it', () => {
    // `@IsOptional()` skips only undefined and null, so an `@IsEmail()` here would have made the
    // field impossible to clear — a validator that is a worse bug than the gap it closes.
    expect(errorsFor({ email: '' })).not.toContain('email');
  });

  it('a padded address is trimmed and then accepted, not refused for its padding', () => {
    expect(errorsFor({ email: '  info@gethomerealty.ca  ' })).not.toContain('email');
  });
});

describe('L11 — configuration writes have their own, tighter bucket', () => {
  /*
   * 40 consecutive `PUT /api/crm-settings` in a tight loop all returned 200 under the general
   * 600-a-minute limit. The cost is not load — it is the audit trail, which is the only record of
   * who changed the brokerage's bank account, and which every one of those writes appends to.
   */
  it('is stricter than the general bucket', () => {
    expect(SETTINGS_WRITE_LIMIT.limit).toBeLessThan(GLOBAL_LIMIT.limit);
  });

  it('is not so strict that working through the screen trips it', () => {
    // CRM Settings has several cards, each with its own Save. A limit that refused the fourth save
    // of a session would be the worse bug.
    expect(SETTINGS_WRITE_LIMIT.limit).toBeGreaterThanOrEqual(10);
  });

  it('is measured over a minute, like every other bucket here', () => {
    expect(SETTINGS_WRITE_LIMIT.ttl).toBe(GLOBAL_LIMIT.ttl);
  });

  it('is looser than the broadcast bucket — a settings row is not an email to every member of staff', () => {
    // Ordering the two on purpose: if somebody later tunes one by environment variable, this says
    // which way round they belong.
    const { BROADCAST_LIMIT } = jest.requireActual<typeof import('../config/rate-limits')>('../config/rate-limits');
    expect(SETTINGS_WRITE_LIMIT.limit).toBeGreaterThan(BROADCAST_LIMIT.limit);
  });
});
