import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmSettingsService } from './crm-settings.service';
import { TENANT_ID } from '../core/tenant';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The CRM › Triggers findings that were still open after the per-user rewrite.
 *
 * T-H1..T-H4, T-M1, T-M2, T-M7 and T-M8 were closed by `CrmTriggersService` and its migration, and
 * are covered where they live. What is pinned here is the remainder — the server half of T-L6.
 * T-M3, T-M5 and T-M9 are client-side and are pinned in the browser suite.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const noMailer = { send: async () => ({ ok: true }) } as never;
const noAccounts = { defaultSender: async () => null } as never;
const admin = { id: 1, name: 'Root', role: 'admin' } as unknown as AuthUserRecord;
const svc = (tx: PrismaService) => new CrmSettingsService(tx, noMailer, noAccounts);

afterAll(async () => { await prisma.$disconnect(); });

describe('T-L6 — the SMTP host has to look like a host', () => {
  /*
   * `<img src=x onerror=alert(1)>` round-tripped through this field intact. Not exploitable — React
   * escapes it and nothing dials the value, since sending goes through `mail_accounts` — but the
   * field exists to hold a hostname, and the day something reads it to open a connection is the
   * wrong time to discover it holds markup.
   */
  const refused = [
    '<img src=x onerror=alert(1)>',
    'smtp.example.com; rm -rf /',
    'has spaces.example.com',
    '-leading-hyphen.example.com',
    'trailing-hyphen-.example.com',
    "smtp.example.com'--",
  ];

  it.each(refused)('refuses %s', async (smtpHost) => {
    await inRollback(async (tx) => {
      await expect(svc(tx).saveEmailSettings(admin, { smtpHost }))
        .rejects.toThrow(/hostname or IP address/i);
    });
  });

  const accepted = [
    'smtp.gmail.com',
    'mail.brokerage.example',
    '192.168.1.50',
    'localhost',
    'xn--mgbh0fb.example',
    'smtp-relay.internal-host.example',
    '',                                   // clearing the field is how you unset it
  ];

  it.each(accepted)('accepts %s', async (smtpHost) => {
    await inRollback(async (tx) => {
      const out = await svc(tx).saveEmailSettings(admin, { smtpHost }) as Record<string, unknown>;
      expect(out.smtpHost).toBe(smtpHost);
    });
  });

  it('still refuses an over-long host, and says which limit', async () => {
    // The length cap predates this and must survive it — the two checks are independent.
    await inRollback(async (tx) => {
      await expect(svc(tx).saveEmailSettings(admin, { smtpHost: `${'a'.repeat(300)}.example.com` }))
        .rejects.toThrow(/255 characters or fewer/i);
    });
  });
});

describe('T-M8 — one brokerage cannot end up with two settings rows', () => {
  it('has the unique index that makes findFirst deterministic', async () => {
    // Two concurrent first-saves on an empty table could otherwise create two rows, after which
    // `findFirst({ orderBy: id asc })` governs from one while the other accumulates writes.
    const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      "select indexname from pg_indexes where tablename='crm_email_settings' and indexdef like '%UNIQUE%'",
    );
    expect(idx.map((i) => i.indexname)).toContain('crm_email_settings_company_id_key');
  });

  it('refuses a second row for the same brokerage', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      // The seeded database may or may not already hold a row for this tenant, and a test that
      // passes only when it happens to is not a test. Guarantee the first one exists, then collide.
      const existing = await tx.crm_email_settings.findFirst({ where: { company_id: TENANT_ID } });
      if (!existing) {
        await tx.crm_email_settings.create({ data: { company_id: TENANT_ID, created_at: now, updated_at: now } });
      }

      await expect(
        tx.crm_email_settings.create({ data: { company_id: TENANT_ID, created_at: now, updated_at: now } }),
      ).rejects.toThrow();
    });
  });
});
