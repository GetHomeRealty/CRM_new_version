import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';
import { OffboardingService } from './offboarding.service';
import { MetaConnectionService } from '../meta/meta-connection.service';
import { LeadTransferService } from '../leads/lead-transfer.service';
import { PermissionService } from '../auth/permission.service';
import { ModuleAccessService } from '../core/module-access.service';
import { superAdminRoles as superAdminRolesSync } from '../core/authz';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * The findings of the CRM › Users audit, each pinned by the case that found it.
 *
 * Every test here corresponds to a numbered finding in `docs/audit/CRM-USERS-AUDIT.md`. They are
 * written as the failure rather than the feature — "a namesake is refused", not "validation works" —
 * because the value is in catching the specific regression, and because several of these were
 * defended by comments that turned out to be wrong about the rest of the codebase.
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
const noAudit = { logModule: async () => {}, record: async () => {} } as never;
const noGraph = { fetchPages: async () => [] } as never;
const actor = { id: 1, name: 'Root', role: 'admin' } as unknown as AuthUserRecord;

const svc = (tx: PrismaService) => new UsersService(
  tx,
  new PermissionService(),
  new ModuleAccessService(tx),
  noAudit,
  new OffboardingService(tx, new MetaConnectionService(tx, noGraph), new LeadTransferService(tx, noAudit)),
);

/** A complete, valid create body. Individual tests override the one field under examination. */
const body = (over: Record<string, unknown> = {}) => {
  const t = tag();
  return {
    name: `Probe ${t}`, username: `probe-${t}`, email: `probe-${t}@example.test`,
    password: 'TestPass123!', password_confirmation: 'TestPass123!',
    role: 'agent', status: 'Active',
    profile: { mobile: '416-555-0100', gender: 'Other' },
    ...over,
  };
};

/** The field names a validation failure named, so a test can assert on the cause. */
async function errorsFrom(fn: () => Promise<unknown>): Promise<Record<string, string[]>> {
  try { await fn(); return {}; } catch (e) {
    const res = (e as { getResponse?: () => unknown }).getResponse?.() as { errors?: Record<string, string[]> } | undefined;
    return res?.errors ?? {};
  }
}

describe('U-C1 — a name stays reserved while the row exists', () => {
  it('refuses a name already held by a DEACTIVATED account', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const name = `Namesake ${tag()}`;
      const first = await s.store(actor, body({ name })) as { id: number };
      await s.update(actor, first.id, body({ name, status: 'Inactive', email: `x-${tag()}@example.test` }));

      /*
       * This is the whole finding. The old rule allowed it, and `dashboard.service.ts` then
       * resolved commission profiles with `findFirst({ where: { name } })` and no status filter —
       * measured returning the INACTIVE row, so the new hire's deals paid the departed agent's
       * percentage.
       */
      const errors = await errorsFrom(() => s.store(actor, body({ name })));
      expect(Object.keys(errors)).toContain('name');
      expect(errors.name[0]).toMatch(/already has this name/i);
    });
  });

  it('still refuses a name held by an active account', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const name = `Active namesake ${tag()}`;
      await s.store(actor, body({ name }));
      expect(Object.keys(await errorsFrom(() => s.store(actor, body({ name }))))).toContain('name');
    });
  });
});

describe('U-M1 — identifying fields are trimmed', () => {
  it('stores a trimmed name, so a space cannot smuggle a duplicate past the rule', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const name = `Trimmed ${tag()}`;
      const created = await s.store(actor, body({ name: `   ${name}   ` })) as { name: string };
      expect(created.name).toBe(name);

      // And the padded form is now recognised as the same person.
      expect(Object.keys(await errorsFrom(() => s.store(actor, body({ name: ` ${name} `}))))).toContain('name');
    });
  });

  it('trims the email too', async () => {
    await inRollback(async (tx) => {
      const email = `trim-${tag()}@example.test`;
      const created = await svc(tx).store(actor, body({ email: `  ${email} ` })) as { email: string };
      expect(created.email).toBe(email);
    });
  });
});

describe('U-H5 — email and username are case-insensitive', () => {
  it('refuses the same address in a different case', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const email = `case-${tag()}@example.test`;
      await s.store(actor, body({ email }));
      const errors = await errorsFrom(() => s.store(actor, body({ email: email.toUpperCase() })));
      expect(Object.keys(errors)).toContain('email');
    });
  });

  it('refuses the same username in a different case', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const username = `case-user-${tag()}`;
      await s.store(actor, body({ username }));
      expect(Object.keys(await errorsFrom(() => s.store(actor, body({ username: username.toUpperCase() }))))).toContain('username');
    });
  });

  it('has the functional indexes that make it true even without the service', async () => {
    // The pre-check is a SELECT before an INSERT; these indexes are what actually decides.
    const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      "select indexname from pg_indexes where tablename='users' and indexname in ('users_email_lower_key','users_username_lower_key')",
    );
    expect(idx.map((i) => i.indexname).sort()).toEqual(['users_email_lower_key', 'users_username_lower_key']);
  });
});

describe('U-H1 / U-M6 — department and designation', () => {
  it('actually stores them', async () => {
    await inRollback(async (tx) => {
      const created = await svc(tx).store(actor, body({ department: 'Sales', designation: 'Broker of Record' })) as Record<string, unknown>;
      // They were collected by the form, sent by the client, and silently dropped: the validated
      // subset did not carry them, so create always wrote null.
      expect(created.department).toBe('Sales');
      expect(created.designation).toBe('Broker of Record');
    });
  });

  it('changes them on update', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body({ department: 'Sales' })) as { id: number; name: string; email: string };
      const updated = await s.update(actor, made.id, body({
        name: made.name, email: made.email, department: 'Accounts', designation: 'Controller',
      })) as Record<string, unknown>;
      expect(updated.department).toBe('Accounts');
      expect(updated.designation).toBe('Controller');
    });
  });

  it('refuses more than the column holds, rather than failing in the driver', async () => {
    await inRollback(async (tx) => {
      const errors = await errorsFrom(() => svc(tx).store(actor, body({ department: 'd'.repeat(121) })));
      expect(Object.keys(errors)).toContain('department');
    });
  });
});

describe('U-M4 — the password has a ceiling', () => {
  it('refuses more than bcrypt can use', async () => {
    await inRollback(async (tx) => {
      const long = 'a'.repeat(200);
      const errors = await errorsFrom(() => svc(tx).store(actor, body({ password: long, password_confirmation: long })));
      expect(Object.keys(errors)).toContain('password');
      expect(errors.password[0]).toMatch(/ignored by the password hash/i);
    });
  });

  it('accepts a long-but-usable passphrase', async () => {
    await inRollback(async (tx) => {
      const ok = 'correct horse battery staple 12';   // 31 bytes
      const made = await svc(tx).store(actor, body({ password: ok, password_confirmation: ok })) as { id: number };
      expect(made.id).toBeGreaterThan(0);
    });
  });
});

describe('U-M2 — the profile blob is bounded', () => {
  it('refuses a profile large enough to degrade the list for everybody', async () => {
    await inRollback(async (tx) => {
      const fat = { mobile: '1', gender: 'Other', junk: 'z'.repeat(200_000) };
      const errors = await errorsFrom(() => svc(tx).store(actor, body({ profile: fat })));
      expect(Object.keys(errors)).toContain('profile');
    });
  });
});

describe('U-M7 — mobile and gender are required by the API, not only the form', () => {
  it('refuses a create without them', async () => {
    await inRollback(async (tx) => {
      const errors = await errorsFrom(() => svc(tx).store(actor, body({ profile: {} })));
      expect(Object.keys(errors)).toEqual(expect.arrayContaining(['profile.mobile', 'profile.gender']));
    });
  });

  it('does not force them onto an existing account that predates the rule', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number; name: string; email: string };
      const updated = await s.update(actor, made.id, {
        name: made.name, email: made.email, role: 'agent', status: 'Active',
      }) as { id: number };
      expect(updated.id).toBe(made.id);
    });
  });
});

describe('U-M3 — the users list honours page and limit', () => {
  it('returns everything by default and a slice when asked', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      for (let i = 0; i < 3; i += 1) await s.store(actor, body());
      const all = await s.index();
      expect(all.length).toBeGreaterThanOrEqual(3);

      // `page`/`limit` used to be accepted and ignored — a caller could believe it was paging.
      const first = await s.index({ page: 1, limit: 2 });
      const second = await s.index({ page: 2, limit: 2 });
      expect(first).toHaveLength(2);
      expect(second.length).toBeGreaterThan(0);
      expect((first[0] as { id: number }).id).not.toBe((second[0] as { id: number }).id);
    });
  });
});

describe('U-L4 — the email rule catches what people actually mistype', () => {
  /*
   * The point of the tighter rule is that it refuses only undeliverable addresses. The accepted
   * list is the one that matters: every entry is a shape a real brokerage address takes, and any of
   * them being refused would lock somebody out of their own account.
   */
  const accepted = [
    'priya@brokerage.ca',
    'first.last@brokerage.ca',
    'agent+listings@brokerage.ca',
    'dana@mail.brokerage.co.uk',
    "o'brien@brokerage.ca",
    'a_b-c@sub.domain.brokerage.ca',
    'x@xn--mgbh0fb.museum',          // punycode IDN, long TLD
  ];
  const refused = [
    '.leading@brokerage.ca',
    'trailing.@brokerage.ca',
    'double..dot@brokerage.ca',
    'nodomain@brokerage',            // no dot at all
    'a@b.c',                         // one-character TLD
    'user@host.1',                   // numeric TLD
    'user@-leadinghyphen.ca',
    'user@trailinghyphen-.ca',
    'user@double..dot.ca',
    'spaces in@brokerage.ca',
    'two@at@brokerage.ca',
  ];

  it.each(accepted)('accepts %s', async (email) => {
    await inRollback(async (tx) => {
      const made = await svc(tx).store(actor, body({ email })) as { email: string };
      expect(made.email).toBe(email);
    });
  });

  it.each(refused)('refuses %s', async (email) => {
    await inRollback(async (tx) => {
      expect(Object.keys(await errorsFrom(() => svc(tx).store(actor, body({ email }))))).toContain('email');
    });
  });
});

describe('U-L3 — the last administrator cannot be deleted', () => {
  it('asks the authorization engine which roles are top tier, not the literal string', () => {
    // The guard counted `role: 'admin'` itself. If a second top-tier role is ever added, a literal
    // count under-counts and the last usable administrator becomes deletable.
    expect(superAdminRolesSync()).toContain('admin');
    expect(superAdminRolesSync()).not.toContain('agent');
    expect(superAdminRolesSync()).not.toContain('manager');
  });

  it('counts only accounts that can actually sign in', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const top = { role: { in: superAdminRolesSync() } };

      /*
       * The seed data already contains administrators, so the situation has to be constructed:
       * deactivate every existing top-tier account, then create exactly one live one. The whole
       * thing is inside a rolled-back transaction, so nothing here survives the test.
       */
      await tx.users.updateMany({ where: { ...top, status: 'Active' }, data: { status: 'Inactive' } });
      const live = await s.store(actor, body({ role: 'admin' })) as { id: number };
      expect(await tx.users.count({ where: { ...top, status: 'Active' } })).toBe(1);

      // Deactivated administrators cannot sign in, so they do not count as cover. Before the fix the
      // guard counted every row with the role regardless of status, and this deletion succeeded —
      // leaving a brokerage with no account able to administer it.
      await expect(s.destroy(actor, live.id)).rejects.toThrow(/last administrator/i);

      // With a second live one, the same deletion is legitimately allowed.
      await s.store(actor, body({ role: 'admin' }));
      await expect(s.destroy(actor, live.id)).resolves.toBeDefined();
    });
  });
});

describe('U-M5 — a new password ends the sessions that account already had', () => {
  it('deletes their stored sessions and nobody else\'s', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const mine = await s.store(actor, body()) as { id: number; name: string; email: string };
      const theirs = await s.store(actor, body()) as { id: number };

      const expire = new Date(Date.now() + 86_400_000);
      await tx.user_sessions.create({ data: { sid: `sid-mine-${tag()}`, sess: { userId: mine.id } as never, expire } });
      await tx.user_sessions.create({ data: { sid: `sid-mine2-${tag()}`, sess: { userId: mine.id } as never, expire } });
      await tx.user_sessions.create({ data: { sid: `sid-theirs-${tag()}`, sess: { userId: theirs.id } as never, expire } });

      await s.update(actor, mine.id, {
        name: mine.name, email: mine.email, role: 'agent', status: 'Active',
        password: 'BrandNewPass1!', password_confirmation: 'BrandNewPass1!',
      });

      const left = await tx.$queryRawUnsafe<{ sid: string }[]>('select sid from user_sessions');
      // Both of theirs are gone; the colleague's is untouched.
      expect(left.filter((r) => r.sid.startsWith('sid-mine'))).toHaveLength(0);
      expect(left.filter((r) => r.sid.startsWith('sid-theirs'))).toHaveLength(1);
    });
  });

  it('leaves sessions alone when the password was not changed', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number; name: string; email: string };
      const sid = `sid-keep-${tag()}`;
      await tx.user_sessions.create({ data: { sid, sess: { userId: made.id } as never, expire: new Date(Date.now() + 86_400_000) } });

      await s.update(actor, made.id, { name: made.name, email: made.email, role: 'agent', status: 'Active' });

      const left = await tx.$queryRawUnsafe<{ sid: string }[]>('select sid from user_sessions');
      expect(left.some((r) => r.sid === sid)).toBe(true);
    });
  });
});

describe('U-H3 — a unique violation reads as validation, not as a crash', () => {
  it('translates the index violation the pre-check cannot prevent', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const email = `race-${tag()}@example.test`;
      await s.store(actor, body({ email }));

      /*
       * Reaching the index directly, because the pre-check would otherwise answer first. The race
       * this stands in for is real: three simultaneous creates on one email returned 201, 500, 500
       * before this, because nothing caught P2002.
       */
      const err = await errorsFrom(async () => {
        const svcAny = s as unknown as { rethrowUniqueViolation: (e: unknown) => never };
        try {
          await tx.users.create({
            data: {
              name: `Race ${tag()}`, username: `race-${tag()}`, email, password: 'x',
              role: 'agent', status: 'Active', company_id: 1, created_at: new Date(), updated_at: new Date(),
            },
          });
        } catch (e) { svcAny.rethrowUniqueViolation(e); }
      });
      expect(Object.keys(err)).toContain('email');
      expect(err.email[0]).toMatch(/already been taken/i);
    });
  });
});

describe('U-H4 — deletion refuses to strand records', () => {
  it('refuses while the person still holds a calendar appointment', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number };
      const now = new Date();
      await tx.calendar_events.create({
        data: {
          title: `Ev ${tag()}`, date: new Date('2026-09-01T00:00:00.000Z'), time: '10:00',
          type: 'meeting', status: 'scheduled', user_id: made.id, domain: 'crm', company_id: 1,
          created_at: now, updated_at: now,
        },
      });

      // Nothing has a foreign key to stop this, and their calendar would become reachable by nobody.
      await expect(s.destroy(actor, made.id)).rejects.toThrow(/calendar appointment/i);
      expect(await tx.users.count({ where: { id: made.id } })).toBe(1);
    });
  });

  /**
   * A correction, not a new feature.
   *
   * The guard originally skipped campaigns, on the stated grounds that `campaigns.created_by` is a
   * varchar name with no id to match. `campaigns.created_by_id` exists beside it and is written on
   * every create — so the guard answered "nothing would be stranded" while a person's campaigns
   * would have been, and the comment made the gap look deliberate.
   */
  it('refuses while the person still owns a campaign', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number; name: string };
      const now = new Date();
      await tx.campaigns.create({
        data: {
          name: `Camp ${tag()}`, subject: 'Subject', content: 'Body',
          created_by: made.name, created_by_id: made.id, company_id: 1, created_at: now, updated_at: now,
        },
      });

      await expect(s.destroy(actor, made.id)).rejects.toThrow(/campaign/i);
      expect(await tx.users.count({ where: { id: made.id } })).toBe(1);
    });
  });

  it('refuses while the person still owns an email template', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number };
      const now = new Date();
      await tx.campaign_templates.create({
        data: {
          name: `Tpl ${tag()}`, subject: 'Subject', content: 'Body',
          user_id: made.id, company_id: 1, created_at: now, updated_at: now,
        },
      });

      await expect(s.destroy(actor, made.id)).rejects.toThrow(/template/i);
    });
  });

  it('is not confused by a shipped template, which belongs to everybody', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number };
      const now = new Date();
      // user_id NULL is one of the six the application ships with — nobody's to strand.
      await tx.campaign_templates.create({
        data: { name: `Shipped ${tag()}`, subject: 'S', content: 'B', user_id: null, company_id: 1, created_at: now, updated_at: now },
      });

      await expect(s.destroy(actor, made.id)).resolves.toMatchObject({ message: 'User deleted' });
    });
  });

  /*
   * A row the owner already deleted is not a row that would be stranded.
   *
   * Four of the eight tables the guard counts are soft-deleted, and two of them — invoices and
   * campaign_templates — were counted without a `deleted_at` filter. The effect is a deletion
   * refused to protect records that nothing displays and nothing reads, with no way for the
   * administrator to clear the block, because the rows holding it are invisible everywhere else in
   * the application.
   */
  it('ignores an email template the person had already deleted', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number };
      const now = new Date();
      await tx.campaign_templates.create({
        data: {
          name: `Gone ${tag()}`, subject: 'S', content: 'B',
          user_id: made.id, company_id: 1, created_at: now, updated_at: now, deleted_at: now,
        },
      });

      await expect(s.destroy(actor, made.id)).resolves.toMatchObject({ message: 'User deleted' });
    });
  });

  it('ignores an invoice the person had already deleted', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number };
      const now = new Date();
      await tx.invoices.create({
        data: {
          invoice_no: `PROBE-${tag()}`, invoice_date: now, created_by: made.id,
          company_id: 1, created_at: now, updated_at: now, deleted_at: now,
        },
      });

      await expect(s.destroy(actor, made.id)).resolves.toMatchObject({ message: 'User deleted' });
    });
  });

  it('still refuses while a LIVE invoice names them', async () => {
    // The counterpart, so the filter above cannot pass by counting nothing at all.
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number };
      const now = new Date();
      await tx.invoices.create({
        data: {
          invoice_no: `PROBE-${tag()}`, invoice_date: now, created_by: made.id,
          company_id: 1, created_at: now, updated_at: now,
        },
      });

      await expect(s.destroy(actor, made.id)).rejects.toThrow(/invoice/i);
    });
  });

  it('still allows deleting an account that never did anything', async () => {
    await inRollback(async (tx) => {
      const s = svc(tx);
      const made = await s.store(actor, body()) as { id: number };
      await expect(s.destroy(actor, made.id)).resolves.toMatchObject({ message: 'User deleted' });
      expect(await tx.users.count({ where: { id: made.id } })).toBe(0);
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
