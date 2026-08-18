import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService } from './report-data.service';
import { ReportsService } from './reports.service';
import { DOC_PREDICATES } from './report-docs.sql';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * THE GATE ON THE DOCUMENTATION FAST PATH.
 *
 * `ReportsService.runFastDocs` answers the Deal Documentation Status and RECO Audit Readiness
 * reports from a grouped scan of `documents` instead of loading every document in the brokerage: the
 * counts, the report's predicate, the ordering and the paging all happen in SQL, and only the
 * twenty-five deals on the page are enriched.
 *
 * That means the counting rules now exist TWICE — once in `report-documents.ts` and once as SQL in
 * `report-docs.sql.ts` — and the second copy decides `total_count`, the footer and which deals
 * appear. A disagreement does not raise anything; it prints a different number of pending documents,
 * or silently drops a deal from a compliance report.
 *
 * So every test here runs the report BOTH WAYS over the same fixture and requires the results to be
 * identical: same rows in the same order, same totals, same count, same pagination. The slow side is
 * the original enrichment path, reached by removing the report's SQL predicate.
 *
 * The fixture is built to exercise each branch of the counting rules — a deal with pending and
 * invalid documents, one entirely valid, one with a missing mandatory document, one with no
 * documents at all, and validations written in the odd casings the data actually contains.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx as unknown as PrismaService);
      throw new Error(ROLLBACK);
    }, { timeout: 120000, isolationLevel: 'RepeatableRead' });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const admin: AuthUserRecord = { id: 1, name: 'Docs Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;

/** What the report PRESENTS: the rows a user sees, the footer, the count and the paging. */
const presented = (r: { rows: Record<string, unknown>[]; totals: unknown; total_count: number; page: number; last_page: number }) => ({
  rows: r.rows, totals: r.totals, total_count: r.total_count, page: r.page, last_page: r.last_page,
});

interface DocSpec { title: string; validation: string; mandatory?: boolean; days?: number }

async function fixture(tx: PrismaService) {
  const now = new Date();
  const stamp = Date.now();

  const mk = async (o: { agent: string; docs: DocSpec[]; reco?: unknown; closing?: string; clients?: string[] }) => {
    const t = await tx.transactions.create({
      data: {
        trade_no: `DOCFAST-${stamp}-${String(++seq).padStart(3, '0')}`,
        type: 'Residential Buying', agent: o.agent,
        price: 700_000 + seq * 1_000, comm_type: '%', comm_value: 0, comm_pct: 2.5,
        comm_status: 'Pending', comm_paid_status: 'No',
        reco_audit_ready: (o.reco ?? 'No') as string,
        closing_date: new Date(`${o.closing ?? '2025-06-15'}T00:00:00.000Z`),
        offer_date: new Date('2025-03-01T00:00:00.000Z'),
        adjustments: '{}', admin_activities: '{}', activity_tracker: '{}',
        created_at: now, updated_at: now,
      },
    });
    let p = 0;
    for (const d of o.docs) {
      await tx.documents.create({
        data: {
          transaction_id: t.id, title: d.title, validation: d.validation, status: 'Pending',
          mandatory: d.mandatory ?? false, position: p++, file_path: 'x/y.pdf', file_name: 'y.pdf',
          // Distinct update days, so `last_doc_update` is a real MAX and not a constant.
          created_at: now, updated_at: new Date(`2025-0${1 + (p % 8)}-1${p % 9}T00:00:00.000Z`),
        },
      });
    }
    for (const c of o.clients ?? []) {
      await tx.clients.create({ data: { transaction_id: t.id, name: c, position: 0, created_at: now, updated_at: now } });
    }
    return t.id;
  };

  const APS = 'Agreement of Purchase and Sale';
  // Pending and invalid together, and a mandatory document that is not valid.
  await mk({ agent: 'Docs A', clients: ['Buyer One'], closing: '2025-01-10', docs: [
    { title: APS, validation: 'Pending', mandatory: true },
    { title: 'Amendment to Agreement', validation: 'Invalid' },
    { title: 'Waiver of Conditions', validation: 'Valid' },
  ] });
  // Invalid only.
  await mk({ agent: 'Docs B', closing: '2025-02-10', docs: [{ title: APS, validation: 'Invalid', mandatory: true }] });
  // Pending only, three of them — a bigger count, so ordering by pending_docs has something to do.
  await mk({ agent: 'Docs C', closing: '2025-03-10', docs: [
    { title: APS, validation: 'Pending', mandatory: true },
    { title: 'Schedule B', validation: 'Pending' },
    { title: 'Deposit Receipt', validation: 'Pending' },
  ] });
  // Entirely valid, flagged RECO ready — the only deal that may answer Yes.
  await mk({ agent: 'Docs D', reco: 'Yes', closing: '2025-04-10', docs: [
    { title: APS, validation: 'Valid', mandatory: true },
    { title: 'MLS', validation: 'Valid' },
  ] });
  // Flagged ready but NOT clean, which must still answer No.
  await mk({ agent: 'Docs E', reco: 'Yes', closing: '2025-05-10', docs: [
    { title: APS, validation: 'Invalid', mandatory: true },
  ] });
  // Odd casings and padding, which the data really does contain.
  await mk({ agent: 'Docs F', closing: '2025-06-10', docs: [
    { title: APS, validation: ' VALID ', mandatory: true },
    { title: 'FINTRACK', validation: 'invalid' },
    { title: 'Client Photo IDs', validation: '' },
  ] });
  // A mandatory document with no validation at all — missing_mandatory, not valid.
  await mk({ agent: 'Docs G', closing: '2025-07-10', docs: [{ title: APS, validation: 'Pending', mandatory: true }] });
  // No documents whatsoever: every predicate must exclude it, and its counts are zeros not nulls.
  await mk({ agent: 'Docs H', closing: '2025-08-10', docs: [] });
  // A deleted document must not be counted.
  const del = await mk({ agent: 'Docs I', closing: '2025-09-10', docs: [{ title: APS, validation: 'Pending', mandatory: true }] });
  await tx.documents.updateMany({ where: { transaction_id: del }, data: { deleted_at: new Date() } });
  // Several more pending deals, so paging has more than one page to get wrong.
  for (let i = 0; i < 6; i++) {
    await mk({ agent: `Docs Bulk ${i}`, closing: `2025-1${i % 2}-0${1 + (i % 8)}`, docs: [
      { title: APS, validation: 'Pending', mandatory: true },
      ...(i % 2 === 0 ? [{ title: 'Schedule B', validation: 'Invalid' }] : []),
    ] });
  }
}

const engineFor = (tx: PrismaService) => new CommissionService(new PersonResolver(tx));
const serviceFor = (tx: PrismaService) => new ReportsService(new ReportDataService(tx, engineFor(tx)), tx);

/** Run a report with the documentation fast path REMOVED, i.e. through the original enrichment. */
async function slowly(svc: ReportsService, type: string, query: Record<string, unknown>) {
  const kept = DOC_PREDICATES[type];
  delete DOC_PREDICATES[type];
  try {
    return await (svc.run(type, admin, query as never) as Promise<never>);
  } finally {
    DOC_PREDICATES[type] = kept;
  }
}

const REPORTS_UNDER_TEST = ['deal-documentation-status', 'reco-audit-readiness'] as const;

describe('the documentation fast path returns exactly what the enrichment path returns', () => {
  jest.setTimeout(180_000);

  it.each(REPORTS_UNDER_TEST)('%s, unfiltered', async (type) => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 200 };
      const fast = await svc.run(type, admin, q as never);
      expect(presented(fast)).toEqual(presented(await slowly(svc, type, q)));
      expect(fast.total_count).toBeGreaterThan(0);
    });
  });

  it.each(REPORTS_UNDER_TEST)('%s, paged so the ordering has to agree', async (type) => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const page of [1, 2, 3]) {
        const q = { filters: {}, page, per_page: 2 };
        const fast = await svc.run(type, admin, q as never);
        expect(presented(fast)).toEqual(presented(await slowly(svc, type, q)));
      }
      expect((await svc.run(type, admin, { filters: {}, page: 1, per_page: 2 } as never)).last_page).toBeGreaterThan(1);
    });
  });

  it.each([
    ['', 'no filter'],
    ['Pending Documentation', 'pending only'],
    ['Invalid Documentation', 'invalid only'],
    ['Complete', 'complete'],
    ['No Documents', 'no documents'],
  ])('deal-documentation-status honours the %s filter (%s) identically', async (status) => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: { status }, page: 1, per_page: 200 };
      expect(presented(await svc.run('deal-documentation-status', admin, q as never)))
        .toEqual(presented(await slowly(svc, 'deal-documentation-status', q)));
    });
  });

  it.each(['', 'Yes', 'No'])('reco-audit-readiness honours reco_ready=%s identically', async (reco) => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: { reco_ready: reco }, page: 1, per_page: 200 };
      expect(presented(await svc.run('reco-audit-readiness', admin, q as never)))
        .toEqual(presented(await slowly(svc, 'reco-audit-readiness', q)));
    });
  });

  it('agrees on every sortable column, both directions', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const keys = ['pending_docs', 'invalid_docs', 'valid_docs', 'total_docs', 'missing_mandatory',
        'last_doc_update', 'documentation_status', 'trade_no', 'agent', 'txn_id'];
      for (const sort of keys) {
        for (const dir of ['asc', 'desc'] as const) {
          const q = { filters: {}, page: 1, per_page: 200, sort, dir };
          expect(presented(await svc.run('deal-documentation-status', admin, q as never)))
            .toEqual(presented(await slowly(svc, 'deal-documentation-status', q)));
        }
      }
    });
  });

  it('agrees when a global filter narrows the set as well', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const filters of [
        { deal_type: ['Residential Buying'] },
        { closing_date_from: '2025-03-01', closing_date_to: '2025-08-31' },
        { year: '2025' },
        { agent: ['Docs C'] },
      ]) {
        const q = { filters, page: 1, per_page: 200 };
        expect(presented(await svc.run('deal-documentation-status', admin, q as never)))
          .toEqual(presented(await slowly(svc, 'deal-documentation-status', q)));
      }
    });
  });

  it('DECLINES the fast path for an agent, whose figures are scoped to their own split lines', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const agent = { id: 2, name: 'Docs C', role: 'agent', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;
      const q = { filters: {}, page: 1, per_page: 200 };
      const mine = await svc.run('deal-documentation-status', agent, q as never);
      /*
       * Their own deal only. Restricted to this fixture's rows because the development database this
       * runs against holds other deals, some of them genuinely owned by user 2 — those belong in the
       * result and their presence is not what is being tested here.
       */
      const ours = mine.rows.filter((r) => String(r.trade_no ?? '').startsWith('DOCFAST-'));
      expect(ours.length).toBeGreaterThan(0);
      expect(ours.every((r) => r.agent === 'Docs C')).toBe(true);
    });
  });

  it('a deleted document is counted by neither path', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 200 };
      const fast = await svc.run('deal-documentation-status', admin, q as never);
      expect(fast.rows.some((r) => r.agent === 'Docs I')).toBe(false);
      expect(presented(fast)).toEqual(presented(await slowly(svc, 'deal-documentation-status', q)));
    });
  });
});
