/**
 * Builds a brokerage the size of the one this application is for, so the CRM can be measured
 * instead of reasoned about.
 *
 * WHY THIS EXISTS. Every performance finding in the CRM audit was derived from the SHAPE of a query
 * — eleven COUNTs per page of the lead list, an unpaginated task feed, a five-column ILIKE search
 * that no index can serve. Query shape tells you what will hurt; it does not tell you what hurts
 * FIRST, or whether any of it hurts enough to matter. Only data does, and 512 development leads is
 * not data.
 *
 * The target is deliberately the brief: hundreds of agents, tens of thousands of leads, and the
 * activity that accumulates around them.
 *
 *   node scripts/seed-load-test.cjs                     # 40,000 leads / 500 users
 *   LOAD_LEADS=100000 LOAD_USERS=800 node scripts/…     # or bigger
 *   node scripts/seed-load-test.cjs --clean             # remove it all again
 *
 * CLEAN UP AFTERWARDS. This data does not coexist quietly with the browser suite: those tests look
 * for seeded fixtures by name on the first page of a list, and forty thousand synthetic leads push
 * them past it. Three specs failed exactly that way before `--clean` existed — not regressions, but
 * indistinguishable from them at a glance, which is worse than a plain failure.
 *
 * SAFETY: refuses to run unless the database name says test, staging, qa or scratch — the same
 * guard seed-test-env.cjs uses, for the same reason. This writes tens of thousands of fake people;
 * doing that to production would be unrecoverable without a restore.
 */
const { PrismaClient } = require('@prisma/client');

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const DB_NAME = (URL.split('/').pop() || '').split('?')[0];

if (!/test|staging|qa|scratch/i.test(DB_NAME) || /prod/i.test(DB_NAME)) {
  console.error(`\nRefusing to seed "${DB_NAME || '(no database in URL)'}" — the name must identify it as a test database.\n`);
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

const LEADS = Number(process.env.LOAD_LEADS || 40_000);
const USERS = Number(process.env.LOAD_USERS || 500);
const BATCH = 2_000;

// Deliberately skewed, because real books are. One agent with 4,000 leads and ninety with forty is
// the distribution that finds the slow path; an even spread hides it behind small numbers.
const STATUS = ['hot', 'warm', 'cold', 'mild', 'closed'];
const SOURCE = ['google ads', 'meta', 'refferal', 'linkedin', 'youtube', 'website'];
const TYPE = ['buyer', 'seller', 'tenant', 'landlord', 'lease', 'resale'];
const CLIENT = ['Investor', 'custom buyer', 'first home buyer', 'seasonal investor', 'commercial buyer'];
const TAGS = ['VIP', 'Spring-2026', 'Downtown', 'Condo', 'Waterfront', 'First-Time', 'Referral', 'Cold-List'];

const pick = (list, i) => list[i % list.length];
const chunk = (n) => Array.from({ length: n }, (_, i) => i);

/**
 * Remove everything this script created, and nothing else.
 *
 * Identified by the markers the seed writes — the `@load.test` address domain and the
 * `Load Seed` author — rather than by "delete recent rows", so a database that also holds the
 * browser suite's fixtures keeps them. Activity is deleted before the leads it hangs off, because
 * the cascade would take it anyway but the counts printed afterwards should be honest.
 */
async function clean() {
  console.log(`Removing load-test data from "${DB_NAME}"…\n`);

  const tasks = await prisma.lead_tasks.deleteMany({ where: { created_by: 'Load Seed' } });
  const showings = await prisma.lead_showings.deleteMany({ where: { created_by: 'Load Seed' } });
  const calls = await prisma.lead_calls.deleteMany({ where: { created_by: 'Load Seed' } });
  console.log(`  lead_tasks    … ${tasks.count.toLocaleString()} removed`);
  console.log(`  lead_showings … ${showings.count.toLocaleString()} removed`);
  console.log(`  lead_calls    … ${calls.count.toLocaleString()} removed`);

  const leads = await prisma.leads.deleteMany({ where: { email: { endsWith: '@load.test' } } });
  console.log(`  leads         … ${leads.count.toLocaleString()} removed`);

  const users = await prisma.users.deleteMany({ where: { email: { startsWith: 'load-agent-' } } });
  console.log(`  users         … ${users.count.toLocaleString()} removed`);

  await prisma.$executeRawUnsafe('ANALYZE leads');
  console.log(`\n  ${(await prisma.leads.count()).toLocaleString()} lead(s) remain — the fixtures the browser suite expects.\n`);
}

async function main() {
  if (process.argv.includes('--clean')) return clean();

  const started = Date.now();
  console.log(`Seeding "${DB_NAME}" with ${USERS.toLocaleString()} users and ${LEADS.toLocaleString()} leads…\n`);

  await prisma.company_settings.upsert({
    where: { id: 1 }, update: {},
    create: { id: 1, name: 'Get Home Realty (LOAD)', email: 'load@test.local' },
  });

  // ---- agents ---------------------------------------------------------------
  /*
   * One shared bcrypt hash of the standard test password, computed once rather than per user.
   *
   * 500 hashes at cost 12 is about ninety seconds of pure setup, and every account here is
   * disposable and identical by design. It has to be a REAL hash, not a placeholder: the load test
   * signs in as these agents, because the only honest way to measure "hundreds of agents" is to
   * make the requests as hundreds of agents. Driving the whole run from one account measures the
   * per-identity rate limiter instead of the application — which is what the first attempt did.
   */
  const HASH = '$2a$10$qrwyufzGymLaiEFtU6lnR.lMCx8GyamZZ7/DM7h4/lZGaJvkNnOUa';   // TestPass123!
  const existing = await prisma.users.count({ where: { email: { startsWith: 'load-agent-' } } });
  if (existing < USERS) {
    for (let i = existing; i < USERS; i += BATCH) {
      await prisma.users.createMany({
        skipDuplicates: true,
        data: chunk(Math.min(BATCH, USERS - i)).map((k) => ({
          name: `Load Agent ${i + k}`,
          email: `load-agent-${i + k}@load.test`,
          role: 'agent', status: 'Active', password: HASH, company_id: 1,
          created_at: new Date(), updated_at: new Date(),
        })),
      });
    }
  }
  const agents = await prisma.users.findMany({
    where: { email: { startsWith: 'load-agent-' } }, select: { id: true }, orderBy: { id: 'asc' }, take: USERS,
  });
  console.log(`  users        … ${agents.length.toLocaleString()}`);

  // The account the load test signs in as, so its book is the one being measured. Seeded by
  // seed-test-env.cjs; everything below hangs a realistic share of the data off it.
  const probe = await prisma.users.findUnique({ where: { email: 'agent@test.local' }, select: { id: true } });
  const superAdmin = await prisma.users.findUnique({ where: { email: 'superadmin@test.local' }, select: { id: true } });
  if (!probe || !superAdmin) {
    console.error('\n  seed-test-env.cjs has not been run against this database — the probe accounts are missing.\n');
    process.exit(1);
  }

  /*
   * Ownership distribution, weighted the way a brokerage actually looks:
   *   - 10% unattributed intake (owner NULL) — the Meta/import firehose, visible to the top tier
   *   - 12% on the probe agent, so "one agent's book" is a realistic 4,800 rather than a handful
   *   - the rest spread across the 500 agents, skewed so a few carry far more than the median
   */
  const ownerFor = (i) => {
    const r = i % 100;
    if (r < 10) return null;
    if (r < 22) return probe.id;
    // Square the index so early agents get disproportionately more — a power-law-ish skew.
    const spread = Math.floor(((i * 2654435761) % agents.length) ** 0.85) % agents.length;
    return agents[spread].id;
  };

  const already = await prisma.leads.count({ where: { email: { endsWith: '@load.test' } } });
  console.log(`  leads        … ${already.toLocaleString()} already present`);

  const now = new Date();
  for (let i = already; i < LEADS; i += BATCH) {
    const size = Math.min(BATCH, LEADS - i);
    await prisma.leads.createMany({
      skipDuplicates: true,
      data: chunk(size).map((k) => {
        const n = i + k;
        const owner = ownerFor(n);
        return {
          name: `Load Lead ${n} ${pick(['Smith', 'Okafor', 'Nguyen', 'Moreau', 'Iversen', 'Raman'], n)}`,
          // Unique per owner, which is what the constraint now requires. The address also encodes
          // the owner so a collision cannot arise from the skew above.
          email: `lead-${n}-${owner ?? 'house'}@load.test`,
          phone: `416555${String(1000 + (n % 9000))}`,
          lead_status: pick(STATUS, n),
          lead_type: pick(TYPE, n),
          lead_source: pick(SOURCE, n),
          client_type: pick(CLIENT, n),
          location: pick(['Toronto', 'Mississauga', 'Brampton', 'Vaughan', 'Markham', 'Oakville'], n),
          property: `${100 + (n % 900)} ${pick(['King', 'Queen', 'Bay', 'Yonge', 'Dundas'], n)} St`,
          age: 24 + (n % 50),
          // Two tags on a third of rows: enough that the tag aggregation has real work to do.
          tags: n % 3 === 0 ? JSON.stringify([pick(TAGS, n), pick(TAGS, n + 3)]) : '[]',
          owner_user_id: owner,
          assigned_to: n % 7 === 0 ? probe.id : owner,
          created_by: 'Load Seed',
          company_id: 1,
          // Spread over two years so the "recent" (30-day) counter is a real filter, not all-or-nothing.
          created_at: new Date(now.getTime() - (n % 730) * 24 * 3600 * 1000),
          updated_at: now,
        };
      }),
    });
    if ((i / BATCH) % 5 === 0) process.stdout.write(`\r  leads        … ${Math.min(i + size, LEADS).toLocaleString()} / ${LEADS.toLocaleString()}`);
  }
  console.log(`\r  leads        … ${LEADS.toLocaleString()} ✓                    `);

  // ---- activity on the probe agent's book -----------------------------------
  // Tasks and showings are what the dashboard feeds read, and both are unpaginated — so they need
  // volume on the account the load test actually signs in as.
  const mine = await prisma.leads.findMany({
    where: { OR: [{ owner_user_id: probe.id }, { assigned_to: probe.id }], deleted_at: null },
    select: { id: true }, take: 6_000, orderBy: { id: 'asc' },
  });
  console.log(`  probe book   … ${mine.length.toLocaleString()} leads`);

  const taskCount = await prisma.lead_tasks.count({ where: { created_by: 'Load Seed' } });
  if (taskCount < mine.length) {
    for (let i = 0; i < mine.length; i += BATCH) {
      const slice = mine.slice(i, i + BATCH);
      await prisma.lead_tasks.createMany({
        data: slice.map((l, k) => ({
          lead_id: l.id,
          title: `Follow up ${i + k}`,
          due_date: new Date(now.getTime() + ((i + k) % 60 - 30) * 24 * 3600 * 1000),
          status: (i + k) % 3 === 0 ? 'pending' : 'completed',
          priority: pick(['low', 'medium', 'high'], i + k),
          assigned_to: probe.id, created_by: 'Load Seed', user_id: probe.id,
          company_id: 1, created_at: now, updated_at: now,
        })),
      });
    }
  }
  console.log(`  lead_tasks   … ${(await prisma.lead_tasks.count()).toLocaleString()}`);

  const showingCount = await prisma.lead_showings.count({ where: { created_by: 'Load Seed' } });
  if (showingCount < 3_000) {
    const slice = mine.slice(0, 3_000);
    for (let i = 0; i < slice.length; i += BATCH) {
      await prisma.lead_showings.createMany({
        data: slice.slice(i, i + BATCH).map((l, k) => ({
          lead_id: l.id,
          showing_date: new Date(now.getTime() + ((i + k) % 45) * 24 * 3600 * 1000),
          time: `${String(9 + ((i + k) % 9)).padStart(2, '0')}:00`,
          property: `${100 + ((i + k) % 900)} King St`,
          status: 'scheduled', created_by: 'Load Seed', user_id: probe.id,
          company_id: 1, created_at: now, updated_at: now,
        })),
      });
    }
  }
  console.log(`  lead_showings… ${(await prisma.lead_showings.count()).toLocaleString()}`);

  // Calls, because `stats()` counts leads with none via a relation subquery — the most expensive
  // of its eleven counters.
  const callCount = await prisma.lead_calls.count({ where: { created_by: 'Load Seed' } });
  if (callCount < 5_000) {
    const slice = mine.slice(0, 5_000);
    for (let i = 0; i < slice.length; i += BATCH) {
      await prisma.lead_calls.createMany({
        data: slice.slice(i, i + BATCH).map((l, k) => ({
          lead_id: l.id, called_at: now, duration: 60 + ((i + k) % 600),
          outcome: pick(['connected', 'voicemail', 'no answer'], i + k),
          created_by: 'Load Seed', user_id: probe.id, company_id: 1, created_at: now,
        })),
      });
    }
  }
  console.log(`  lead_calls   … ${(await prisma.lead_calls.count()).toLocaleString()}`);

  for (const name of TAGS) {
    await prisma.lead_tags.upsert({
      where: { name }, update: {},
      create: { name, created_by: 'Load Seed', created_at: now, company_id: 1 },
    });
  }

  await prisma.$executeRawUnsafe('ANALYZE leads');
  await prisma.$executeRawUnsafe('ANALYZE lead_tasks');
  await prisma.$executeRawUnsafe('ANALYZE lead_showings');
  await prisma.$executeRawUnsafe('ANALYZE lead_calls');

  const probeBook = await prisma.leads.count({
    where: { deleted_at: null, OR: [{ owner_user_id: probe.id }, { assigned_to: probe.id }] },
  });
  const houseBook = await prisma.leads.count({
    where: { deleted_at: null, OR: [{ owner_user_id: superAdmin.id }, { assigned_to: superAdmin.id }, { owner_user_id: null }] },
  });

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  total leads              ${(await prisma.leads.count()).toLocaleString()}`);
  console.log(`  agent@test.local book    ${probeBook.toLocaleString()}`);
  console.log(`  superadmin book (+house) ${houseBook.toLocaleString()}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
