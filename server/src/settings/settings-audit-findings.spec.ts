import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmSettingsService } from '../crm-settings/crm-settings.service';
import { can } from '../core/authz';
import { TENANT_ID } from '../core/tenant';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The High-band findings of the CRM › Settings audit, each pinned by the case that found it.
 *
 * Written as the failure rather than the feature — "the CRM role does not get the account number",
 * not "banking is protected" — because the value is in catching the specific regression. Every one
 * of these was demonstrated against the running application before it was fixed; the numbers in the
 * comments are what the probes actually returned.
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

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const noMailer = { send: async () => ({ ok: true }) } as never;
const noAccounts = { defaultSender: async () => null } as never;
const asUser = (role: string, id: number, name: string) => ({ id, name, role } as unknown as AuthUserRecord);

afterAll(async () => { await prisma.$disconnect(); });

describe('S-H1 — the brokerage bank account is a capability, not a role check', () => {
  /*
   * Measured before the fix, one request per role: `crm` received bank_beneficiary, bank_name,
   * transit_no, account_no, institution_no and hst_number — while its own permission map is
   * `transactions: 'none'`, `invoice: 'none'`, so it cannot open one screen that displays them.
   * The guard asked `isAgent(user)`, which answers a different question.
   */
  it.each(['admin', 'manager', 'accounting', 'documentation'])('%s may read it — they produce the documents that print it', (role) => {
    expect(can({ role }, 'company.read-banking')).toBe(true);
  });

  it.each(['crm', 'agent'])('%s may not', (role) => {
    expect(can({ role }, 'company.read-banking')).toBe(false);
  });

  it('an unrecognised role is refused, not admitted by default', () => {
    // The failure mode of a role check is that every role invented later inherits access.
    expect(can({ role: 'marketing_intern' }, 'company.read-banking')).toBe(false);
    expect(can(null, 'company.read-banking')).toBe(false);
  });
});

describe('S-H4 — the CRM profile form refuses a name another account holds', () => {
  const svc = (tx: PrismaService) => new CrmSettingsService(tx, noMailer, noAccounts);

  const makeUser = async (tx: PrismaService, over: Record<string, unknown> = {}) => {
    const t = tag();
    const now = new Date();
    return tx.users.create({
      data: {
        name: `Settings Probe ${t}`, email: `sp-${t}@probe.test`, role: 'agent', status: 'Active',
        password: 'x', company_id: TENANT_ID, created_at: now, updated_at: now, ...over,
      },
    });
  };

  it('refuses a name held by an ACTIVE account', async () => {
    await inRollback(async (tx) => {
      const victim = await makeUser(tx);
      const actor = await makeUser(tx, { role: 'manager' });

      /*
       * This is the whole finding. Before the fix an Admin renamed themselves to a working agent's
       * name and got a 200 with "Personal information updated successfully" — reopening U-C1, where
       * `findFirst({ where: { name } })` resolves a commission profile to whichever row the planner
       * reaches first. The Users module refuses this; this second entry point did not.
       */
      await expect(
        svc(tx).saveProfile(asUser('manager', actor.id, actor.name), { name: victim.name, email: actor.email }),
      ).rejects.toThrow(/already has this name/i);
    });
  });

  it('refuses a name held by a DEACTIVATED account', async () => {
    await inRollback(async (tx) => {
      // The departed row keeps its name AND its commission split, so it is precisely the row that
      // gets resolved by mistake. Skipping deactivated accounts would leave the finding open.
      const departed = await makeUser(tx, { status: 'Inactive' });
      const actor = await makeUser(tx, { role: 'manager' });

      await expect(
        svc(tx).saveProfile(asUser('manager', actor.id, actor.name), { name: departed.name, email: actor.email }),
      ).rejects.toThrow(/already has this name/i);
    });
  });

  it('still lets a person save their own profile without renaming', async () => {
    await inRollback(async (tx) => {
      // The guard must not match the caller against themselves, or nobody could change their phone.
      const me = await makeUser(tx, { role: 'manager' });
      const out = await svc(tx).saveProfile(
        asUser('manager', me.id, me.name), { name: me.name, email: me.email, phone: '416-555-0199' },
      ) as Record<string, unknown>;
      expect(out.phone).toBe('416-555-0199');
      expect(out.name).toBe(me.name);
    });
  });

  it('still allows a genuinely new name', async () => {
    await inRollback(async (tx) => {
      const me = await makeUser(tx, { role: 'manager' });
      const fresh = `Renamed Probe ${tag()}`;
      const out = await svc(tx).saveProfile(
        asUser('manager', me.id, me.name), { name: fresh, email: me.email },
      ) as Record<string, unknown>;
      expect(out.name).toBe(fresh);
    });
  });
});

describe('S-H5 — the CRM email settings are read for one brokerage, not for whichever row is first', () => {
  const svc = (tx: PrismaService) => new CrmSettingsService(tx, noMailer, noAccounts);

  it('ignores a row belonging to another brokerage', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      // A second brokerage, which the schema already supports — company_settings IS the tenant.
      const other = await tx.company_settings.create({ data: { name: `Other Brokerage ${tag()}` } });

      // Its settings row is created FIRST in id order for this probe's purposes, which is exactly
      // what `findFirst({ orderBy: { id: 'asc' } })` with no tenant filter would have latched onto
      // had the other brokerage been seeded first.
      await tx.crm_email_settings.create({
        data: { smtp_host: 'other-brokerage.invalid', auto_send_enabled: false, company_id: other.id, created_at: now, updated_at: now },
      });

      const read = await svc(tx).getEmailSettings() as Record<string, unknown>;
      expect(read.smtpHost).not.toBe('other-brokerage.invalid');
    });
  });

  it('writes against this brokerage, leaving the other one alone', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const other = await tx.company_settings.create({ data: { name: `Other Brokerage ${tag()}` } });
      const foreign = await tx.crm_email_settings.create({
        data: { smtp_host: 'untouched.invalid', company_id: other.id, created_at: now, updated_at: now },
      });

      await svc(tx).saveEmailSettings(asUser('admin', 1, 'Root'), { smtpHost: 'ours.invalid' });

      const after = await tx.crm_email_settings.findUnique({ where: { id: foreign.id } });
      expect(after?.smtp_host).toBe('untouched.invalid');
      const ours = await tx.crm_email_settings.findFirst({ where: { company_id: TENANT_ID }, orderBy: { id: 'asc' } });
      expect(ours?.smtp_host).toBe('ours.invalid');
    });
  });
});
