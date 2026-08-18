import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService } from './report-data.service';
import { ReportsService } from './reports.service';
import { DOC_CATEGORY_SQL, DOC_ROW_SOURCES } from './report-docs.sql';
import { docCategory } from './report-documents';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * THE GATE ON THE DOCUMENT-ROW FAST PATH — Pending and Invalid Documents.
 *
 * That report emits one row per unvalidated document and splits them into two sections. It used to
 * build all of them in memory: 312,898 rows at 80,000 deals, to display twenty-five. It is now paged
 * in the database, which means TWO new things have to be right, and neither fails loudly:
 *
 *   THE ROW ORDER. The report orders by section, then deal, then document CATEGORY, then title —
 *   and the category is derived from the title by thirteen regular expressions whose ORDER decides
 *   the answer. A category rule transliterated out of sequence puts documents on the wrong page,
 *   which looks like missing data rather than like a bug.
 *
 *   THE COUNTS. The footer and both section headings are counts of the complete set, computed by
 *   SQL while the page is computed separately. If the two disagree the user sees a heading that does
 *   not match what is under it.
 *
 * So: every category rule is compared against `docCategory` for the titles that discriminate it, and
 * the report itself is run both ways — paged in SQL, and through the original enrichment — with the
 * results required to be identical.
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

const admin: AuthUserRecord = { id: 1, name: 'Rows Admin', role: 'admin', user_permissions: [], user_modules: [] } as unknown as AuthUserRecord;

const presented = (r: { rows: Record<string, unknown>[]; totals: unknown; total_count: number; page: number; last_page: number; sections?: unknown }) => ({
  rows: r.rows, totals: r.totals, total_count: r.total_count, page: r.page, last_page: r.last_page, sections: r.sections,
});

/**
 * Titles chosen to hit each category rule AND to prove the precedence between them.
 *
 * "Amendment to Agreement" and "Waiver of Schedule B" both match a later rule as well; they are here
 * because getting the order wrong is the realistic mistake.
 */
const TITLES = [
  'Amendment to Agreement', 'Amendment', 'Waiver of Schedule B', 'Waiver of Conditions',
  'Notice of Fulfilment', 'Mutual Release', 'Deposit Receipt', 'Second Deposit',
  'FINTRAC', 'FINTRACK Individual', 'Client Photo IDs', 'Identification Record', 'Photo ID',
  'RECO Guide', 'Invoice to Brokerage', 'Referral Agreement', 'Commission Trust Agreement',
  'Trade Sheet', 'Agreement of Purchase and Sale', 'Buyer Representation Agreement',
  'Schedule B', 'ORTA', 'Confirmation of CO-OP', 'Confirmation of Coop', 'Offer Summary',
  'MLS', 'Listing Agreement', 'Closing Documents', 'Something Else Entirely', 'Bill of Sale',
  'id card', 'The Grid', 'Rapid Response', 'lowercase amendment', 'UPPERCASE WAIVER',
];

async function fixture(tx: PrismaService) {
  const now = new Date();
  const stamp = Date.now();
  const mk = async (agent: string, docs: { title: string; validation: string; mandatory?: boolean }[]) => {
    const t = await tx.transactions.create({
      data: {
        trade_no: `DOCROW-${stamp}-${String(++seq).padStart(3, '0')}`,
        type: 'Residential Buying', agent, price: 700_000 + seq * 1_000,
        comm_type: '%', comm_value: 0, comm_pct: 2.5, comm_status: 'Pending', comm_paid_status: 'No',
        closing_date: new Date('2025-06-15T00:00:00.000Z'), offer_date: new Date('2025-03-01T00:00:00.000Z'),
        adjustments: '{}', admin_activities: '{}', activity_tracker: '{}', created_at: now, updated_at: now,
      },
    });
    let p = 0;
    for (const d of docs) {
      await tx.documents.create({
        data: {
          transaction_id: t.id, title: d.title, validation: d.validation, status: 'Pending',
          mandatory: d.mandatory ?? false, position: p++, file_path: 'x/y.pdf', file_name: 'y.pdf',
          remarks: `note for ${d.title}`, reminder: p % 2 === 0, created_at: now, updated_at: now,
        },
      });
    }
    return t.id;
  };

  /*
   * Three deals carrying the whole title vocabulary, alternating pending and invalid so both
   * sections are populated from the same deal — which is the case that made the sections per-ROW
   * rather than per-deal in the first place.
   */
  for (let d = 0; d < 3; d++) {
    await mk(`Row Agent ${d}`, TITLES.map((title, i) => ({
      title,
      validation: (i + d) % 3 === 0 ? 'Invalid' : (i + d) % 3 === 1 ? 'Pending' : 'Valid',
      mandatory: i % 4 === 0,
    })));
  }
  // A deal whose documents are all valid: it must appear in neither section.
  await mk('Row Clean', [{ title: 'Agreement of Purchase and Sale', validation: 'Valid', mandatory: true }]);
  // A deal with no documents at all.
  await mk('Row Bare', []);
  // A deleted pending document must not be counted or listed.
  const del = await mk('Row Deleted', [{ title: 'Schedule B', validation: 'Pending' }]);
  await tx.documents.updateMany({ where: { transaction_id: del }, data: { deleted_at: new Date() } });
  // Odd casing and padding on the validation, which decides the section.
  await mk('Row Casing', [
    { title: 'Deposit Receipt', validation: ' INVALID ' },
    { title: 'MLS', validation: 'pending' },
    { title: 'Offer Summary', validation: ' valid ' },
  ]);
}

const serviceFor = (tx: PrismaService) =>
  new ReportsService(new ReportDataService(tx, new CommissionService(new PersonResolver(tx))), tx);

/**
 * Run a report through the ORIGINAL enrichment path.
 *
 * `runFastDocRows` is entered only for the report types present in `DOC_ROW_SOURCES`, so removing
 * the entry for the duration is what turns it off — the same trick `report-needs.spec.ts` uses on
 * `sqlExact`.
 *
 * IT USED TO DELETE FROM `DOC_ROW_REPORTS`, WHICH WAS THE GATE AT THE TIME AND IS NOT ANY MORE.
 * When the gate moved to the descriptor table, deleting from the Set stopped disabling anything —
 * so `slowly()` would have run the FAST path, this whole file would have compared the fast path
 * against itself, and every assertion in it would have passed while proving nothing. Deleting from
 * the table that is actually consulted is the fix; the type error that would have caught it does
 * not exist, because both are perfectly good objects to call `.delete` on.
 */
async function slowlyFor(svc: ReportsService, type: string, query: Record<string, unknown>) {
  const saved = DOC_ROW_SOURCES[type];
  // Thrown rather than asserted: if the entry is absent there is nothing to disable, this whole file
  // would be comparing the fast path against itself, and a green run would mean nothing. `expect`
  // takes no message in jest, and a bare `toBeDefined()` here would not say why it mattered.
  if (!saved) throw new Error(`${type} is not in DOC_ROW_SOURCES — this comparison would be fast-vs-fast`);
  delete DOC_ROW_SOURCES[type];
  try {
    return await (svc.run(type, admin, query as never) as Promise<never>);
  } finally {
    DOC_ROW_SOURCES[type] = saved;
  }
}

const slowly = (svc: ReportsService, query: Record<string, unknown>) =>
  slowlyFor(svc, 'pending-invalid-documents', query);

describe('the document-row fast path returns exactly what the enrichment path returns', () => {
  jest.setTimeout(180_000);

  it('every category rule agrees with docCategory, in the same precedence order', async () => {
    const rows = await prisma.$queryRawUnsafe<{ title: string; category: string }[]>(
      `SELECT d.title, ${DOC_CATEGORY_SQL} AS category FROM unnest($1::text[]) AS d(title)`, TITLES,
    );
    expect(rows.length).toBe(TITLES.length);
    for (const r of rows) expect([r.title, r.category]).toEqual([r.title, docCategory(r.title)]);
  });

  it('agrees with docCategory for every document title in the database', async () => {
    const titles = (await prisma.documents.findMany({
      where: { deleted_at: null }, select: { title: true }, distinct: ['title'], take: 5000,
    })).map((d) => d.title);
    if (titles.length === 0) return;
    const rows = await prisma.$queryRawUnsafe<{ title: string; category: string }[]>(
      `SELECT d.title, ${DOC_CATEGORY_SQL} AS category FROM unnest($1::text[]) AS d(title)`, titles,
    );
    const wrong = rows.filter((r) => r.category !== docCategory(r.title));
    expect(wrong).toEqual([]);
  });

  it('the whole report, unfiltered', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 500 };
      const fast = await svc.run('pending-invalid-documents', admin, q as never);
      expect(presented(fast)).toEqual(presented(await slowly(svc, q)));
      expect(fast.total_count).toBeGreaterThan(20);
    });
  });

  it('every page, so the ordering and the section boundary have to agree', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const first = await svc.run('pending-invalid-documents', admin, { filters: {}, page: 1, per_page: 7 } as never);
      expect(first.last_page).toBeGreaterThan(2);
      for (let page = 1; page <= first.last_page; page++) {
        const q = { filters: {}, page, per_page: 7 };
        expect(presented(await svc.run('pending-invalid-documents', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  it('one section at a time', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const sections of [['pending'], ['invalid'], ['pending', 'invalid']]) {
        const q = { filters: { sections }, page: 1, per_page: 500 };
        expect(presented(await svc.run('pending-invalid-documents', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  it('with a global filter narrowing the deals as well', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const filters of [
        { deal_type: ['Residential Buying'] },
        { agent: ['Row Agent 1'] },
        { closing_date_from: '2025-01-01', closing_date_to: '2025-12-31' },
      ]) {
        const q = { filters, page: 1, per_page: 500 };
        expect(presented(await svc.run('pending-invalid-documents', admin, q as never)))
          .toEqual(presented(await slowly(svc, q)));
      }
    });
  });

  it('the section counts add up to the report count', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const r = await svc.run('pending-invalid-documents', admin, { filters: {}, page: 1, per_page: 5 } as never);
      const sum = (r.sections ?? []).reduce((a, s) => a + s.count, 0);
      expect(sum).toBe(r.total_count);
    });
  });
});

/**
 * Amendment Documentation, the report this path was generalised for.
 *
 * It measured 51 s at 80,000 deals, because answering it meant enriching the whole brokerage and
 * building 56,000 rows to show twenty-five. It has the same shape as the report above — one row per
 * document — and now takes the same route, so it earns the same comparison.
 *
 * TWO THINGS HERE ARE NOT TRUE OF THE OTHER REPORT and are the reason this block exists rather than
 * a third entry in a loop:
 *
 *   · It has NO SECTIONS. The SQL gives every row the literal section `'all'` so one builder can
 *     serve both, and the result must still report no sections at all — a client that started
 *     rendering a heading called "all" would be a visible regression.
 *   · ITS FILTER QUALIFIES DEALS, NOT ROWS. Asking for Pending keeps every amendment of a deal that
 *     has at least one Pending amendment, including the Valid ones. Filtering rows instead would
 *     produce a shorter, plausible-looking, wrong report — so the filtered comparison below is the
 *     load-bearing assertion in this block.
 */
describe('the amendment fast path returns exactly what the enrichment path returns', () => {
  jest.setTimeout(180_000);
  const AMEND = 'amendment-documentation';
  const slowAmend = (svc: ReportsService, q: Record<string, unknown>) => slowlyFor(svc, AMEND, q);

  it('the whole report, unfiltered', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: {}, page: 1, per_page: 500 };
      const fast = await svc.run(AMEND, admin, q as never);
      expect(presented(fast)).toEqual(presented(await slowAmend(svc, q)));
      expect(fast.total_count).toBeGreaterThan(0);
    });
  });

  it('reports no sections, rather than the literal one the SQL uses', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const fast = await svc.run(AMEND, admin, { filters: {}, page: 1, per_page: 5 } as never);
      expect(fast.sections).toBeUndefined();
    });
  });

  it('every page, so the ordering has to agree all the way down', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const first = await svc.run(AMEND, admin, { filters: {}, page: 1, per_page: 3 } as never);
      for (let page = 1; page <= first.last_page; page++) {
        const q = { filters: {}, page, per_page: 3 };
        expect(presented(await svc.run(AMEND, admin, q as never)))
          .toEqual(presented(await slowAmend(svc, q)));
      }
    });
  });

  it('keeps a deal’s other amendments when one of them matches the status filter', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const status of ['Pending', 'Invalid', 'Valid']) {
        const q = { filters: { status }, page: 1, per_page: 500 };
        expect(presented(await svc.run(AMEND, admin, q as never)))
          .toEqual(presented(await slowAmend(svc, q)));
      }
    });
  });

  it('with a global filter narrowing the deals as well', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const filters of [
        { deal_type: ['Residential Buying'] },
        { agent: ['Row Agent 1'] },
        { closing_date_from: '2025-01-01', closing_date_to: '2025-12-31' },
      ]) {
        const q = { filters, page: 1, per_page: 500 };
        expect(presented(await svc.run(AMEND, admin, q as never)))
          .toEqual(presented(await slowAmend(svc, q)));
      }
    });
  });

  /**
   * `Missing` selects deals with NO amendment, and emits one synthetic row per deal. There is no
   * document row to page over, so the fast path must DECLINE it rather than answer it wrongly —
   * and the answer must still be right, which is what comparing the two runs proves.
   */
  it('DECLINES the Missing filter rather than guessing, and still answers it correctly', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      const q = { filters: { status: 'Missing' }, page: 1, per_page: 500 };
      expect(presented(await svc.run(AMEND, admin, q as never)))
        .toEqual(presented(await slowAmend(svc, q)));
    });
  });

  /** Any sort other than the default is not expressible by `src.order`, so it must decline too. */
  it('DECLINES a sort it cannot produce', async () => {
    await inRollback(async (tx) => {
      await fixture(tx);
      const svc = serviceFor(tx);
      for (const q of [
        { filters: {}, page: 1, per_page: 500, sort: 'doc_name', dir: 'asc' },
        { filters: {}, page: 1, per_page: 500, sort: 'doc_uploaded_at', dir: 'asc' },
      ]) {
        expect(presented(await svc.run(AMEND, admin, q as never)))
          .toEqual(presented(await slowAmend(svc, q)));
      }
    });
  });
});
