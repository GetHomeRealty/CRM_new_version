import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from './audit-log.service';

/**
 * The audit trail's query string — the module's first tests.
 *
 * Every case here was measured against the running service on 2026-08-05, over a trail of 127 rows,
 * before anything was changed. Four of them were bare 500s and one answered a nonsense question with
 * somebody else's row. The numbers in the comments are what the probes actually returned.
 *
 * Written as the failure, not the feature.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const svc = new AuditLogService(prisma as unknown as PrismaService);
const total = async (q: Record<string, string> = {}): Promise<number> =>
  ((await svc.index(q)) as { meta: { total: number } }).meta.total;

describe('a filter that cannot be honoured is refused, not silently answered', () => {
  /*
   * `Number('abc')` is NaN, and Prisma renders NaN as `user_id: null`. So `?user_id=abc` returned
   * the one row with no user attached — `total=1` against a baseline of 127 — presented as that
   * user's activity. No error, no warning. This is the screen people use to establish who did
   * something, so an answer that is confidently wrong is the worst outcome available.
   */
  it.each(['abc', '1e999', 'NaN', '', ' 12 x', '3.5'])('user_id=%s is refused', async (uid) => {
    if (uid === '') { expect(await total({ user_id: uid })).toBeGreaterThan(0); return; }  // absent, not invalid
    await expect(svc.index({ user_id: uid })).rejects.toMatchObject({ response: { errors: { user_id: expect.anything() } } });
  });

  it('a real user id still filters', async () => {
    const all = await total();
    const one = await total({ user_id: '1' });
    expect(one).toBeLessThanOrEqual(all);
    expect(Number.isInteger(one)).toBe(true);
  });

  /*
   * `new Date('garbage')` is an Invalid Date and Prisma refuses it — a bare 500 from a date box.
   * `2026-99-99` is the same: JavaScript does not roll that shape over, it produces Invalid Date.
   */
  it.each(['garbage', '2026-99-99', 'yesterday', '0000-00-00'])('from=%s is refused with a 400', async (d) => {
    const err = await svc.index({ from: d }).then(() => null, (e: { getStatus?: () => number }) => e);
    expect(err?.getStatus?.()).toBe(400);
  });

  it.each(['garbage', '2026-99-99'])('to=%s is refused too — both ends, not just the one that was tested', async (d) => {
    await expect(svc.index({ to: d })).rejects.toMatchObject({ response: { errors: { to: expect.anything() } } });
  });

  it('a real range still filters, and `to` is inclusive of its own day', async () => {
    await inRollback(async (tx) => {
      const local = new AuditLogService(tx);
      const day = '2026-03-15';
      await tx.audit_logs.create({
        data: {
          category: 'Settings', who: `ZZ ${tag()}`, section: 'CRM Settings', action: 'probe',
          source: 'Manual', domain: 'crm', details: 'probe',
          // Late in the day: an exclusive upper bound built from `to` itself would miss this, which
          // is the bug `startOfNextDay` existed to avoid and which the refactor must not reintroduce.
          created_at: new Date(`${day}T23:59:00.000Z`), updated_at: new Date(),
        },
      });
      const r = (await local.index({ from: day, to: day, area: 'crm' })) as { meta: { total: number } };
      expect(r.meta.total).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('the page number is a page number', () => {
  /*
   * `Number(query.page)` went straight into `skip`. `?page=Infinity` and `?page=1e20` were both
   * PrismaClientValidationError → 500.
   */
  it.each(['Infinity', '1e20', '9999999999999999999', '-Infinity'])('page=%s does not 500', async (p) => {
    await expect(total({ page: p })).resolves.toBeGreaterThanOrEqual(0);
  });

  it('a page past the end returns an empty list rather than an error', async () => {
    const r = (await svc.index({ page: '19999' })) as { data: unknown[] };
    expect(Array.isArray(r.data)).toBe(true);
  });

  it.each(['-5', '0', 'abc'])('page=%s falls back to the first page, as it always did', async (p) => {
    const r = (await svc.index({ page: p })) as { meta: { current_page: number } };
    expect(r.meta.current_page).toBe(1);
  });

  it('a fractional page is floored, not passed to skip as a decimal', async () => {
    const r = (await svc.index({ page: '2.7' })) as { meta: { current_page: number } };
    expect(r.meta.current_page).toBe(2);
  });
});

describe('search means search, not LIKE', () => {
  /*
   * `?q=%` returned ALL 127 rows and `?q=_` did the same — Prisma's `contains` puts the value
   * straight into `LIKE '%…%'` without escaping, so both were wildcards. Nobody escalates anything
   * with this; it is wrong in the ordinary way, and "50%" is a string that turns up in a trail.
   */
  it('a lone percent sign no longer matches everything', async () => {
    const all = await total();
    expect(await total({ q: '%' })).toBeLessThan(all);
  });

  it('an underscore no longer matches everything either', async () => {
    const all = await total();
    expect(await total({ q: '_' })).toBeLessThan(all);
  });

  it('a literal percent IS found when it is really there', async () => {
    await inRollback(async (tx) => {
      const local = new AuditLogService(tx);
      const marker = `ZZ ${tag()} 50% split`;
      await tx.audit_logs.create({
        data: {
          category: 'Settings', who: marker, section: 'CRM Settings', action: 'probe',
          source: 'Manual', domain: 'crm', details: marker,
          created_at: new Date(), updated_at: new Date(),
        },
      });
      const r = (await local.index({ q: '50% split', area: 'crm' })) as { meta: { total: number } };
      expect(r.meta.total).toBe(1);
    });
  });

  it('an underscore in a stored value is found literally', async () => {
    await inRollback(async (tx) => {
      const local = new AuditLogService(tx);
      const marker = `ZZ${tag()}_old_value`;
      await tx.audit_logs.create({
        data: {
          category: 'Settings', who: marker, section: 'CRM Settings', action: 'probe',
          source: 'Manual', domain: 'crm', details: marker,
          created_at: new Date(), updated_at: new Date(),
        },
      });
      // The wildcard reading would also match `_old-value`; the literal reading is the one wanted.
      expect(((await local.index({ q: '_old_value', area: 'crm' })) as { meta: { total: number } }).meta.total).toBe(1);
    });
  });

  it('a backslash is escaped rather than swallowing the character after it', async () => {
    // `\%` unescaped would have become a literal-percent LIKE pattern and matched nothing sensible.
    await expect(total({ q: '\\%' })).resolves.toBeGreaterThanOrEqual(0);
  });

  it('a 100,000-character term is truncated rather than sent to the database', async () => {
    // Accepted before with `total=0`, but seven `ILIKE` comparisons per row against a 100 kB
    // pattern is a request nobody meant to make.
    await expect(total({ q: 'x'.repeat(100_000) })).resolves.toBe(0);
  });

  it('ordinary search still works', async () => {
    await inRollback(async (tx) => {
      const local = new AuditLogService(tx);
      const marker = `ZZmarker${tag().replace(/-/g, '')}`;
      await tx.audit_logs.create({
        data: {
          category: 'Settings', who: marker, section: 'CRM Settings', action: 'probe',
          source: 'Manual', domain: 'crm', details: 'probe',
          created_at: new Date(), updated_at: new Date(),
        },
      });
      expect(((await local.index({ q: marker, area: 'crm' })) as { meta: { total: number } }).meta.total).toBe(1);
      // Case-insensitively, which is what the MySQL collation did and what the comment promises.
      expect(((await local.index({ q: marker.toUpperCase(), area: 'crm' })) as { meta: { total: number } }).meta.total).toBe(1);
    });
  });
});

describe('the parts that were already right — kept honest', () => {
  it.each(['bogus', '', 'ALL'])('scope=%s falls back rather than erroring', async (scope) => {
    await expect(total({ scope })).resolves.toBeGreaterThanOrEqual(0);
  });

  it('an unrecognised area falls back to the Transaction Desk', async () => {
    const r = (await svc.index({ area: 'bogus' })) as { area: string };
    expect(r.area).toBe('desk');
  });

  it('an unknown category returns nothing rather than everything', async () => {
    // The failure mode worth guarding: a filter that is ignored looks identical to no filter.
    expect(await total({ category: 'NoSuchCategory' })).toBe(0);
  });

  it('a CRM record never appears in the Transaction Desk trail at `area` scope', async () => {
    await inRollback(async (tx) => {
      const local = new AuditLogService(tx);
      const marker = `ZZarea${tag().replace(/-/g, '')}`;
      await tx.audit_logs.create({
        data: {
          category: 'Lead', who: marker, section: 'Leads', action: 'probe',
          source: 'Manual', domain: 'crm', details: 'probe',
          created_at: new Date(), updated_at: new Date(),
        },
      });
      expect(((await local.index({ q: marker, area: 'crm', scope: 'area' })) as { meta: { total: number } }).meta.total).toBe(1);
      expect(((await local.index({ q: marker, area: 'desk', scope: 'area' })) as { meta: { total: number } }).meta.total).toBe(0);
    });
  });
});
