#!/usr/bin/env node
/**
 * Builds a Transaction Desk the size of the one this application is for, so the REPORTING module
 * can be measured instead of reasoned about.
 *
 * WHY THIS EXISTS, BESIDE `seed-load-test.cjs`. That script seeds the CRM — leads, users, calls,
 * showings, tasks — and creates no transactions, no documents and no deal financials at all. Every
 * remaining slow path is on the other side of the product: the Documentation reports scan
 * `documents`, the Sales Statement derives payment state from the `admin_activities` text blob on
 * `transactions`, and the brokerage totals hydrate whole deals. None of them can be measured
 * against a development database holding nine transactions and sixty-four documents.
 *
 *   node scripts/seed-load-deals.cjs                          # 80,000 deals / ~10 docs each
 *   LOAD_DEALS=20000 LOAD_DOCS_PER_DEAL=6 node scripts/…      # or smaller, for a quick loop
 *   node scripts/seed-load-deals.cjs --clean                  # remove it all again
 *
 * EVERYTHING IT WRITES IS TAGGED. Trade numbers begin `ZZLOAD-`, and `--clean` deletes exactly the
 * transactions carrying that prefix; documents, conditions, statuses and members go with them by
 * cascade. Nothing else in the database is touched, so this can be layered onto a QA database that
 * already has real fixtures without disturbing them.
 *
 * THE DATA IS SHAPED, NOT RANDOM, and that is what makes it useful:
 *
 *   · Deal COUNT per agent is skewed. One agent carries thousands and most carry a handful, because
 *     an even spread hides the slow path behind small per-agent numbers — the agent report is fast
 *     precisely because one agent has few deals, and a uniform seed would make the brokerage report
 *     look like ninety fast agent reports rather than one slow scan.
 *   · Document status is skewed toward Valid, with a real minority Pending and a small slice
 *     Invalid, so the `FILTER (WHERE …)` counters in `report-docs.sql.ts` have all three branches
 *     populated and a status filter cannot accidentally select everything or nothing.
 *   · `admin_activities` is written in the exact shape the parsers expect — `agents[name].payments[]`
 *     carrying `paid_status`/`paid_date`/`paid_type` — including deals with NO payment row, with a
 *     Pending one, and with several. The Sales Statement's cost is in walking that structure, so a
 *     blob that is merely present but empty would measure nothing.
 *   · Some deals are deliberately given malformed JSON. The parsers have a fallback for it, that
 *     fallback is on the hot path, and a corpus where every blob parses cleanly never exercises it.
 *
 * SAFETY: refuses to run unless the database name says test, staging, qa, scratch or loadtest —
 * the same guard `seed-load-test.cjs` uses, for the same reason. This writes hundreds of thousands
 * of rows; doing that to production would need a restore to undo.
 */
const { PrismaClient } = require('@prisma/client');

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const DB_NAME = (URL.split('/').pop() || '').split('?')[0];

if (!/test|staging|qa|scratch|loadtest/i.test(DB_NAME) || /prod/i.test(DB_NAME)) {
  console.error(`\nRefusing to seed "${DB_NAME || '(no database in URL)'}" — the name must identify it as a test database.\n`);
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

const DEALS = Number(process.env.LOAD_DEALS || 80_000);
const DOCS_PER_DEAL = Number(process.env.LOAD_DOCS_PER_DEAL || 10);
const AGENTS = Number(process.env.LOAD_AGENTS || 300);
const AUDIT_ROWS = Number(process.env.LOAD_AUDIT || 200_000);
const BATCH = 2_000;
const TAG = 'ZZLOAD-';
const CLEAN = process.argv.includes('--clean');

/*
 * A deterministic PRNG, seeded once.
 *
 * `Math.random()` would make every run a different corpus, and a timing you cannot reproduce is not
 * a measurement — comparing 41s before against 3s after means nothing if the two ran over different
 * data. Same seed, same rows, every time, on any machine.
 */
let seed = 0x5eed1234;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5;  seed >>>= 0;
  return seed / 0xffffffff;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/**
 * THE CANONICAL DEAL TYPES, copied from `src/reference/transaction.constants.ts`.
 *
 * They are not decorative. The Deal Type filter is populated from that same list, so a corpus using
 * invented names ("Sale", "Lease") produces a report nobody can filter — the dropdown offers twelve
 * values and the data contains six others. Worse, the commission variant partition keys off these
 * exact strings: `LISTING_TYPES` and `'Preconstruction'` decide which of the three formulas a deal
 * is priced by, so a made-up type silently classifies every deal as `standard` and the brokerage
 * totals measure one code path instead of three.
 *
 * Found by trying to reproduce a genuinely narrowed brokerage report and getting 80,004 rows back.
 *
 * Copied rather than imported because this is a `.cjs` script and the constants are TypeScript; the
 * spread below is what keeps the copy honest — a type added there and not here shows up as a gap in
 * the seeded distribution rather than silently never being generated.
 */
const TYPES = [
  'Residential Buying',
  'Residential Lease',
  'Residential Sale Listing',
  'Residential Lease Listing',
  'Preconstruction',
  'Referral',
  'Commercial Property Buying',
  'Commercial Property Lease',
  'Commercial Property Sale Listing',
  'Commercial Property Lease Listing',
  'Business Buying',
  'Business Sale',
];
const STATUSES = ['Secured Conditional', 'Secured Firm', 'Sold', 'Closed', 'Mutual Release', 'Expired'];
const DOC_TITLES = [
  'Agreement of Purchase and Sale', 'Confirmation of Co-operation', 'FINTRAC Individual Identification',
  'Working With a Realtor', 'Amendment to Agreement', 'Waiver of Conditions', 'Notice of Fulfilment',
  'MLS Data Sheet', 'Seller Property Information Statement', 'Deposit Receipt', 'Trade Record Sheet',
  'RECO Insurance Certificate', 'Commission Trust Agreement', 'Schedule B', 'Buyer Representation Agreement',
];
const COND_TYPES = ['Financing', 'Home Inspection', 'Sale of Property', 'Status Certificate', 'Lawyer Review'];
const PAID_TYPES = ['TDB-EFT', 'Cheque', 'Direct Deposit', 'Wire'];

/** A calendar date `n` days from a fixed epoch, so the corpus does not drift with the clock. */
const EPOCH = Date.UTC(2024, 0, 1);
const dayOf = (n) => new Date(EPOCH + n * 86_400_000);

/**
 * The agent roster, skewed.
 *
 * `weight` is how many deals this agent gets relative to the others, and the curve is deliberately
 * brutal: agent 0 carries roughly a thousand times what the tail carries. Real books look like this,
 * and it is the only distribution under which "the agent report is fast but the brokerage report is
 * slow" is reproducible rather than an artefact of dataset size.
 */
function roster() {
  const out = [];
  for (let i = 0; i < AGENTS; i += 1) {
    out.push({ name: `ZZ Load Agent ${String(i).padStart(4, '0')}`, weight: Math.max(1, Math.round(1000 / (i + 1))) });
  }
  return out;
}

/** Pick an agent by weight — the skew above, sampled. */
function weightedAgent(people, totalWeight) {
  let r = rnd() * totalWeight;
  for (const p of people) { r -= p.weight; if (r <= 0) return p.name; }
  return people[people.length - 1].name;
}

/**
 * `admin_activities`, in the shape `report-financials.ts` actually parses.
 *
 * Four populations, because the Sales Statement's cost and its correctness both depend on which one
 * a deal falls into:
 *
 *   no agent entry at all   — the parser must not invent a payment
 *   an entry, no payments   — "not paid", distinct from "no record"
 *   one Paid payment        — the common case
 *   several, mixed status   — partial payment, which drives the "Partially Paid" ladder
 *
 * One deal in fifty gets deliberately malformed JSON. The parser falls back for it; that fallback
 * runs on the hot path and is never exercised by a corpus where every blob is clean.
 */
function adminActivities(agentName, i) {
  if (i % 50 === 0) return '{"agents": {"' + agentName + '": {"payments": [';   // truncated on purpose

  const bucket = i % 4;
  const payments = [];
  if (bucket === 2) {
    payments.push({ paid_type: pick(PAID_TYPES), paid_status: 'Paid', paid_date: dayOf(int(300, 900)).toISOString().slice(0, 10), batch_no: `W${int(1, 52)}-2026`, t4a_year: '2026' });
  } else if (bucket === 3) {
    const n = int(2, 4);
    for (let k = 0; k < n; k += 1) {
      payments.push({
        paid_type: pick(PAID_TYPES),
        paid_status: k === 0 ? 'Paid' : pick(['Paid', 'Pending']),
        paid_date: dayOf(int(300, 900)).toISOString().slice(0, 10),
        batch_no: `W${int(1, 52)}-2026`, t4a_year: '2026',
      });
    }
  }

  const agents = {};
  if (bucket !== 0) {
    agents[agentName] = {
      invoice_received: pick(['N/A', 'Yes', 'No']),
      payments,
      cta: [{ cta: pick(['Yes', 'No']), date: '' }],
    };
  }

  return JSON.stringify({
    invoice_sent_status: pick(['', 'Sent']), invoice_number: '', commission_received_date: '',
    commission_received_via: '', deposits: [], void_cheque_received: '', lawyer_statement_sent: '',
    recv_lawyer: { enabled: '', via: '', date: '' },
    paid_lawyer: { enabled: '', via: '', date: '', batch: '', paid_status: 'Pending', amount: '', payments: [] },
    paid_client: { enabled: '', via: '', date: '', batch: '' },
    coop_invoice: { enabled: '', gst_hst: '', via: '', date: '', batch: '' },
    ta_cta: { enabled: '', date: '', batch: '' },
    agents,
  });
}

function adjustments(i) {
  return JSON.stringify({
    agent_adjust: i % 7 === 0 ? 'Yes' : 'No',
    adjustment_rows: i % 7 === 0 ? [{ agent: '', amount: String(int(100, 5000)), status: 'Approved', remarks: 'load', is_loan: false }] : [],
    advance_payment: i % 11 === 0 ? 'Yes' : 'No',
    advance_rows: i % 11 === 0 ? [{ amount: String(int(500, 3000)), date: dayOf(int(300, 900)).toISOString().slice(0, 10) }] : [],
    client_referral: 'No', client_rows: [], ext_referral: 'No',
  });
}

async function clean() {
  console.log(`Removing every transaction whose trade_no starts with "${TAG}" …`);
  // Documents, conditions, statuses and members cascade from `transactions`, so one delete is the
  // whole cleanup. Counted first so the log says what actually went.
  const doomed = await prisma.transactions.findMany({ where: { trade_no: { startsWith: TAG } }, select: { id: true } });
  console.log(`  ${doomed.length} transaction(s) to remove (documents and conditions cascade)`);
  let removed = 0;
  for (let i = 0; i < doomed.length; i += BATCH) {
    const ids = doomed.slice(i, i + BATCH).map((d) => d.id);
    const r = await prisma.transactions.deleteMany({ where: { id: { in: ids } } });
    removed += r.count;
    process.stdout.write(`\r  removed ${removed}/${doomed.length}`);
  }
  process.stdout.write('\n');
  const aud = await prisma.audit_logs.deleteMany({ where: { who: { startsWith: 'ZZ Load' } } });
  console.log(`  ${aud.count} audit row(s) removed`);
  console.log('Done.');
}

async function main() {
  console.log('');
  console.log('==========================================================');
  console.log(`  Transaction Desk load seed — ${CLEAN ? 'CLEAN' : 'BUILD'}`);
  console.log(`  database: ${DB_NAME}`);
  console.log('==========================================================');

  if (CLEAN) { await clean(); await prisma.$disconnect(); return; }

  console.log(`  deals            : ${DEALS.toLocaleString()}`);
  console.log(`  documents/deal   : ~${DOCS_PER_DEAL}`);
  console.log(`  agents           : ${AGENTS} (weighted, heavily skewed)`);
  console.log(`  audit rows       : ${AUDIT_ROWS.toLocaleString()}`);
  console.log('');

  const started = Date.now();
  const people = roster();
  const totalWeight = people.reduce((s, p) => s + p.weight, 0);

  /*
   * Deals are inserted in batches and their ids read back, because documents, conditions, statuses
   * and members all need the transaction id and `createMany` does not return one. `skipDuplicates`
   * makes a re-run additive rather than an error, so a seed interrupted halfway can simply be run
   * again — which matters when the full corpus takes minutes.
   */
  let madeDeals = 0; let madeDocs = 0; let madeConds = 0; let madeStatuses = 0; let madeMembers = 0;

  for (let start = 0; start < DEALS; start += BATCH) {
    const n = Math.min(BATCH, DEALS - start);
    const rows = [];
    for (let k = 0; k < n; k += 1) {
      const i = start + k;
      const agent = weightedAgent(people, totalWeight);
      const type = pick(TYPES);
      const price = int(250_000, 2_500_000);
      const offer = dayOf(int(0, 700));
      rows.push({
        trade_no: `${TAG}${String(i).padStart(7, '0')}`,
        type,
        property: `${int(1, 9999)} Load Street, Unit ${int(1, 400)}`,
        agent,
        price,
        deposit: Math.round(price * 0.05),
        offer_date: offer,
        closing_date: dayOf(int(0, 700) + int(30, 120)),
        comm_type: '%',
        comm_value: 5,
        comm_pct: 2.5,
        comm_amt: Math.round(price * 0.025),
        mls_num: `X${int(1000000, 9999999)}`,
        admin_activities: adminActivities(agent, i),
        adjustments: adjustments(i),
        activity_tracker: JSON.stringify({ lawyer_reminder: { parties: 'buyer,seller', at: offer.toISOString() }, docs_cleared: i % 3 === 0 ? 'Yes' : 'No' }),
        comm_status: i % 3 === 0 ? 'Received' : 'Pending',
        reco_audit_ready: i % 5 === 0 ? 'Yes' : 'No',
        created_at: offer,
        updated_at: offer,
      });
    }
    await prisma.transactions.createMany({ data: rows, skipDuplicates: true });

    const made = await prisma.transactions.findMany({
      where: { trade_no: { in: rows.map((r) => r.trade_no) } },
      select: { id: true, agent: true, trade_no: true },
    });
    madeDeals += made.length;

    // ---- documents, the table the Documentation reports scan ----
    const docs = [];
    const conds = [];
    const sts = [];
    const mems = [];
    for (const t of made) {
      const i = Number(t.trade_no.slice(TAG.length));
      const count = Math.max(1, DOCS_PER_DEAL + int(-3, 4));
      for (let d = 0; d < count; d += 1) {
        /*
         * Skewed toward Valid with a real Pending minority and a thin Invalid slice — roughly what a
         * managed brokerage looks like, and enough of each that all three `FILTER (WHERE …)`
         * counters and every status filter select a non-trivial, non-total subset.
         */
        const roll = rnd();
        const validation = roll < 0.62 ? 'Valid' : roll < 0.92 ? 'Pending' : 'Invalid';
        const received = validation !== 'Pending' || rnd() < 0.5;
        docs.push({
          transaction_id: t.id,
          title: DOC_TITLES[(i + d) % DOC_TITLES.length],
          mandatory: d < 6,
          is_condition: false,
          status: received ? 'Received' : 'Pending',
          validation,
          reminder: rnd() < 0.15,
          file_name: received ? `load-${t.id}-${d}.pdf` : null,
          remarks: validation === 'Invalid' ? 'Load-test invalid reason' : null,
          position: d,
          created_at: dayOf(int(0, 700)),
          updated_at: dayOf(int(0, 700)),
        });
      }

      if (i % 3 === 0) {
        conds.push({
          transaction_id: t.id, type: pick(COND_TYPES),
          deadline: dayOf(int(0, 700) + int(5, 60)),
          status: pick(['Pending', 'Fulfilled', 'Waived']),
          position: 0, created_at: dayOf(int(0, 700)), updated_at: dayOf(int(0, 700)),
        });
      }

      // One or two statuses per deal. `Closed` on a third, because closed-ness gates several reports.
      const primary = i % 3 === 0 ? 'Closed' : pick(STATUSES);
      sts.push({ transaction_id: t.id, status: primary, created_at: dayOf(int(0, 700)), updated_at: dayOf(int(0, 700)) });

      mems.push({
        transaction_id: t.id, name: t.agent, split: 100, agent_pct: 90, brok_pct: 10,
        is_primary: true, access: 'docs', scope: 'Entire', position: 0,
        created_at: dayOf(int(0, 700)), updated_at: dayOf(int(0, 700)),
      });
    }

    if (docs.length) { await prisma.documents.createMany({ data: docs, skipDuplicates: true }); madeDocs += docs.length; }
    if (conds.length) { await prisma.conditions.createMany({ data: conds, skipDuplicates: true }); madeConds += conds.length; }
    if (sts.length) { await prisma.transaction_statuses.createMany({ data: sts, skipDuplicates: true }); madeStatuses += sts.length; }
    if (mems.length) { await prisma.team_members.createMany({ data: mems, skipDuplicates: true }); madeMembers += mems.length; }

    process.stdout.write(`\r  deals ${madeDeals.toLocaleString()}/${DEALS.toLocaleString()}  docs ${madeDocs.toLocaleString()}`);
  }
  process.stdout.write('\n');

  // ---- audit rows, for the search measurement ----
  /*
   * Free text in the columns the search actually scans. The needle `NEEDLEXYZ` is planted in one row
   * per thousand so a search has something real to find near the end of a large table — a term that
   * matches nothing measures the scan but not the fetch, and one that matches everything measures
   * neither.
   */
  console.log(`  audit rows …`);
  let madeAudit = 0;
  for (let start = 0; start < AUDIT_ROWS; start += BATCH) {
    const n = Math.min(BATCH, AUDIT_ROWS - start);
    const rows = [];
    for (let k = 0; k < n; k += 1) {
      const i = start + k;
      const when = dayOf(int(0, 700));
      rows.push({
        category: pick(['Settings', 'Transaction', 'Document', 'Invoice', 'User']),
        transaction_id: null,
        who: `ZZ Load User ${int(1, AGENTS)}`,
        section: pick(['CRM Communications', 'Trade Record', 'Documents', 'Invoicing', 'Roles']),
        action: pick(['created', 'updated', 'deleted', 'sent', 'approved']),
        source: 'Manual',
        domain: 'desk',
        field: pick(['price', 'status', 'agent', 'closing_date', 'comm_pct']),
        old_value: String(int(1, 999999)),
        new_value: i % 1000 === 0 ? 'NEEDLEXYZ marker row' : String(int(1, 999999)),
        details: i % 1000 === 0
          ? 'ZZ Load details containing NEEDLEXYZ for the search measurement'
          : `ZZ Load details row ${i} with assorted words for the scan to walk through`,
        created_at: when, updated_at: when,
      });
    }
    await prisma.audit_logs.createMany({ data: rows, skipDuplicates: true });
    madeAudit += rows.length;
    process.stdout.write(`\r  audit ${madeAudit.toLocaleString()}/${AUDIT_ROWS.toLocaleString()}`);
  }
  process.stdout.write('\n');

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log('-- built ----------------------------------------------------');
  console.log(`  transactions      : ${madeDeals.toLocaleString()}`);
  console.log(`  documents         : ${madeDocs.toLocaleString()}`);
  console.log(`  conditions        : ${madeConds.toLocaleString()}`);
  console.log(`  statuses          : ${madeStatuses.toLocaleString()}`);
  console.log(`  team_members      : ${madeMembers.toLocaleString()}`);
  console.log(`  audit_logs        : ${madeAudit.toLocaleString()}`);
  console.log(`  elapsed           : ${secs}s`);
  console.log('');
  console.log('  ANALYZE is worth running before measuring — a fresh bulk load leaves the planner');
  console.log('  with stale statistics, and the first timing you take will be of the wrong plan.');
  console.log('');
  await prisma.$executeRawUnsafe('ANALYZE transactions, documents, conditions, transaction_statuses, team_members, audit_logs');
  console.log('  ANALYZE done.');
  console.log('');
}

main()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
