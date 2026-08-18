import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService, REPORT_TXN_SELECT } from './report-data.service';
import { commissionInclude, normalizeCommissionTxn } from '../transactions/commission.loader';

/**
 * THE GATE ON THE COLUMN LIST THE REPORTS LOADER READS.
 *
 * `report-data.service.ts` fetches a named list of columns rather than whole rows — eighty-six
 * columns hydrated per deal, eighty thousand deals, was 7.7 s of every slow-path report run against
 * 2.5 s for the forty it reads.
 *
 * THE FAILURE MODE IS SILENT. A column dropped from that list does not raise anything: Prisma simply
 * does not return it, `enrich` reads `undefined`, and the value it derives comes out null, zero or
 * 'No'. A commission computed without its adjustment, a compliance report showing no RECO remark, a
 * lead report with no source — all of them look like data, not like a bug.
 *
 * SO THE TEST DOES NOT READ THE LIST. It builds a transaction with EVERY scalar column of
 * `transactions` set to a distinctive non-default value, enriches it twice — once through the
 * loader's select, once from a row fetched whole — and requires the two enriched results to be
 * identical. A column that is read but not selected differs in the first and not the second, so the
 * comparison fails on the value the user would have seen.
 *
 * The "every column" part is reflected out of the Prisma schema, not typed out here, so a column
 * added to `transactions` next year is populated by this test without anyone remembering to.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';

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

/** Every scalar field of `transactions`, straight out of the schema. */
const scalarFields = () => {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'transactions');
  if (!model) throw new Error('transactions model not found in the Prisma schema');
  return model.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum');
};

/**
 * Columns this test does NOT overwrite, and why each one is exempt.
 *
 * Every other column gets a value. These four would change what row is being tested rather than what
 * is read off it.
 */
const LEAVE_ALONE = new Set([
  'id',            // the key
  'deleted_at',    // the loader filters on it; setting it makes the row invisible
  'trade_no',      // unique, and set by the fixture
  'agent_user_id', // a foreign key — pointed at a real account below
]);

/** A distinctive value for a column, by declared type. */
function valueFor(f: { name: string; type: string; isList: boolean }): unknown {
  if (f.isList) return undefined;
  switch (f.type) {
    // Deliberately not round: a value that survives one rounding step and not another shows up.
    case 'Decimal': return new Prisma.Decimal('1234.57');
    case 'Int': case 'BigInt': return 3;
    case 'Float': return 1234.57;
    case 'Boolean': return true;
    case 'DateTime': return new Date('2025-04-17T00:00:00.000Z');
    case 'Json': return { probe: f.name };
    default: return `probe-${f.name}`;
  }
}

/**
 * The three JSON blobs get REAL shapes rather than a probe string.
 *
 * They are stored as text and parsed by the enrichment, so `probe-adjustments` parses to nothing and
 * would exercise none of the paths that read them — the advance rows, the client cashback, the
 * external referral, the agent payments and the CTA flag are all inside these three.
 */
const JSON_COLUMNS: Record<string, unknown> = {
  adjustments: {
    agent_adjust: 'Yes',
    adjustment_rows: [{ agent: 'Select Probe Agent', amount: 300, is_loan: true }],
    advance_payment: 'Yes',
    advance_rows: [{ agent: 'Select Probe Agent', amount: 2_500.55, paid_date: '2025-04-01' }],
    client_referral: 'Yes',
    client_rows: [{ client_name: 'Probe Client', amount: 901.23, paid_status: 'Paid', paid_date: '2025-04-02' }],
    ext_referral: 'Yes',
    ext: { amount: 1_200.45, brokerage: 'Probe Brokerage', pct: 25, paid_date: '2025-04-03', paid_status: 'Paid' },
  },
  admin_activities: {
    agents: {
      'Select Probe Agent': {
        payments: [{ paid_status: 'Paid', amount: 5_000.99, paid_date: '2025-05-01', paid_type: 'Cheque' }],
        cta: [{ cta: 'Yes' }],
      },
    },
  },
  activity_tracker: { probe: true },
};

describe('the reports loader reads every column the enrichment depends on', () => {
  jest.setTimeout(120_000);

  it('a transaction with every column populated enriches identically from a narrow select and a whole row', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const user = await tx.users.create({
        data: {
          name: 'Select Probe Agent', email: `select-probe-${Date.now()}@test.local`, password: 'x',
          role: 'agent', status: 'Active',
          profile: JSON.stringify({ agent_comm_pct: 88, brok_comm_pct: 12, lease_comm_pct: 93 }),
          created_at: now, updated_at: now,
        },
      });

      const t = await tx.transactions.create({
        data: {
          trade_no: `SELECT-PROBE-${Date.now()}`,
          type: 'Residential Buying', agent: user.name, agent_user_id: user.id,
          price: 812_345.67, comm_type: '%', comm_value: 0, comm_pct: 2.5,
          created_at: now, updated_at: now,
        },
      });

      /*
       * Now set EVERY remaining scalar column. Written as one raw UPDATE rather than through Prisma
       * because several of these columns are ones the client would refuse or coerce, and the point is
       * to store a value in each so that reading it — or failing to — is visible.
       */
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const f of scalarFields()) {
        if (LEAVE_ALONE.has(f.name)) continue;
        const v = f.name in JSON_COLUMNS ? JSON.stringify(JSON_COLUMNS[f.name]) : valueFor(f);
        if (v === undefined) continue;
        // Types the column cannot hold are skipped rather than forced: a probe string in an integer
        // column would fail the statement and test nothing.
        params.push(v);
        sets.push(`"${f.name}" = $${params.length}`);
      }
      params.push(t.id);
      // One column at a time: a single statement stops at the first type mismatch and would leave
      // every later column unset, which is precisely the blind spot this test exists to close.
      let populated = 0;
      for (let i = 0; i < sets.length; i++) {
        try {
          await tx.$executeRawUnsafe(
            `UPDATE transactions SET ${sets[i].replace(/\$\d+/, '$1')} WHERE id = $2`, params[i], t.id,
          );
          populated += 1;
        } catch {
          // A column that will not take this probe value (a constrained enum, say) keeps whatever it
          // had. It is still selected-or-not by the same list, so the comparison below still covers it.
        }
      }
      expect(populated).toBeGreaterThan(40);

      // The deal needs the relations too, or the enrichment paths that read them are not exercised.
      await tx.transaction_statuses.create({ data: { transaction_id: t.id, status: 'Closed', created_at: now, updated_at: now } });
      await tx.team_members.create({
        data: {
          transaction_id: t.id, name: user.name, user_id: user.id, split: 100, agent_pct: 88, brok_pct: 12,
          scope: 'Entire', position: 0, created_at: now, updated_at: now,
        },
      });
      await tx.documents.create({
        data: {
          transaction_id: t.id, title: 'Agreement of Purchase and Sale', validation: 'Pending', status: 'Pending',
          mandatory: true, position: 0, file_path: 'x/y.pdf', file_name: 'y.pdf', remarks: 'probe remark',
          created_at: now, updated_at: now,
        },
      });
      await tx.conditions.create({
        data: { transaction_id: t.id, type: 'Financing', custom_name: 'Probe Condition', status: 'Pending', deadline: new Date('2025-05-01T00:00:00.000Z'), position: 0, created_at: now, updated_at: now },
      });
      await tx.clients.create({ data: { transaction_id: t.id, name: 'Probe Client', position: 0, created_at: now, updated_at: now } });

      const people = new PersonResolver(tx as unknown as PrismaService);
      const commission = new CommissionService(people);
      const data = new ReportDataService(tx as unknown as PrismaService, commission);

      // What the loader produces, through its column list.
      const [actual] = await data.load({}, { where: { id: t.id }, needs: { documents: true, conditions: true, clients: true } });
      expect(actual).toBeDefined();

      // What it produces from a WHOLE row — every column present, nothing selected away.
      const full = await tx.transactions.findFirst({
        where: { id: t.id },
        include: {
          ...commissionInclude,
          transaction_statuses: { select: { status: true } },
          documents: { where: { deleted_at: null }, orderBy: { position: 'asc' } },
          conditions: { orderBy: { position: 'asc' } },
          clients: { orderBy: { position: 'asc' }, select: { name: true } },
        },
      });
      const svc = data as unknown as {
        profileCache(): Promise<Map<string, Record<string, unknown>>>;
        enrich(t: unknown, bd: unknown, s: unknown, locked: string | null): unknown;
      };
      const cache = await svc.profileCache();
      const cinput = normalizeCommissionTxn(full as never);
      const expected = svc.enrich(full, await commission.breakdown(cinput, cache), commission.summarize(cinput), null);

      expect(actual).toEqual(expected);
    });
  });

  it('the column list names only columns that exist', () => {
    const known = new Set(scalarFields().map((f) => f.name));
    const missing = Object.keys(REPORT_TXN_SELECT).filter((k) => !known.has(k));
    expect(missing).toEqual([]);
  });

  it('the column list is a real narrowing, not a copy of the table', () => {
    // If it ever grows back to every column the optimisation is gone and this should say so.
    expect(Object.keys(REPORT_TXN_SELECT).length).toBeLessThan(scalarFields().length);
  });
});
