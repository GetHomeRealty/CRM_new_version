/**
 * Put a CONNECTED Google Calendar in front of the browser suite, and take it away again.
 *
 * WHY A HAND-BUILT ROW IS LEGITIMATE HERE, when `account-google-cards.spec.ts` deliberately refuses
 * to fake one. That file tests the CARD — whether the renderer says the right things about a
 * connection — and a hand-built row would prove the renderer against a state OAuth never produced.
 * This fixture exists for a different test: whether DISCONNECTING takes the synced events off the
 * calendar. What is under test is the data flow from the disconnect endpoint to the calendar query
 * to the screen, and none of that is reached by the OAuth handshake. The tokens are left NULL on
 * purpose, which also means `disconnect` skips the revoke and the suite never calls out to Google.
 *
 *   node scripts/e2e-google-fixture.cjs --setup      # connect both areas, seed events
 *   node scripts/e2e-google-fixture.cjs --teardown   # remove exactly what --setup created
 *   node scripts/e2e-google-fixture.cjs --status     # what is currently seeded
 *
 * Everything it creates is marked, and teardown works from those markers rather than from "recent
 * rows", so it cannot take anything else with it.
 */
const { PrismaClient } = require('@prisma/client');

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const DB = (URL.split('/').pop() || '').split('?')[0];
if (!/test|staging|qa|scratch/i.test(DB) || /prod/i.test(DB)) {
  console.error(`\nRefusing to seed "${DB || '(no database in URL)'}" — the name must identify it as a test database.\n`);
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

/** The account the browser suite signs in as for these tests. */
const EMAIL = process.env.E2E_GOOGLE_ACCOUNT || 'agent@test.local';

/** Markers. Every row this script writes carries one, and teardown matches on them. */
const GID_PREFIX = 'e2e-gcal-';
const TITLE_PREFIX = 'E2E Google ';
const NATIVE_TITLE = 'E2E Native appointment';
const GOOGLE_ORIGIN = 'Google Calendar';

/**
 * A month of its own, away from the one `calendar-more.spec.ts` uses (2026-09).
 * Two suites seeding into one grid would each see the other's rows and neither would be wrong.
 */
const MONTH = process.env.E2E_GOOGLE_MONTH || '2026-11';
const day = (d) => new Date(`${MONTH}-${String(d).padStart(2, '0')}T00:00:00Z`);

async function user() {
  const u = await prisma.users.findFirst({ where: { email: EMAIL }, select: { id: true, name: true } });
  if (!u) throw new Error(`No user ${EMAIL} — run seed-test-env.cjs first.`);
  return u;
}

async function setup() {
  const u = await user();
  const now = new Date();
  await teardown(true);

  for (const scope of ['crm', 'desk']) {
    await prisma.google_connections.create({
      data: {
        user_id: u.id, scope,
        google_email: `e2e-${scope}@example.test`,
        calendar_id: 'primary',
        // Tokens deliberately NULL: `disconnect` only revokes when one is present, so the suite
        // never reaches out to Google, and nothing here pretends to be a real OAuth grant.
        access_token: null, refresh_token: null,
        created_at: now, updated_at: now,
      },
    });
  }

  // Two events per area, written exactly as `applyGoogleEvent` writes one that arrived from Google.
  for (const [scope, d] of [['crm', 3], ['desk', 4]]) {
    for (const n of [1, 2]) {
      await prisma.calendar_events.create({
        data: {
          title: `${TITLE_PREFIX}${scope.toUpperCase()} event ${n}`,
          date: day(d), time: `1${n}:00`,
          type: 'meeting', status: 'scheduled', domain: scope,
          user_id: u.id, created_by: GOOGLE_ORIGIN,
          google_calendar_id: `${GID_PREFIX}${scope}-${n}`,
          created_at: now, updated_at: now,
        },
      });
    }
  }

  // The control: the agent's OWN appointment, which must survive every disconnect. It carries a
  // Google id, because a locally-created event gets one as soon as it is mirrored out — that is
  // precisely the row a naive cleanup would delete.
  await prisma.calendar_events.create({
    data: {
      title: NATIVE_TITLE, date: day(5), time: '09:00',
      type: 'meeting', status: 'scheduled', domain: 'crm',
      user_id: u.id, created_by: u.name,
      google_calendar_id: `${GID_PREFIX}native-pushed`,
      created_at: now, updated_at: now,
    },
  });

  await status();
}

async function teardown(quiet = false) {
  const u = await user();
  const events = await prisma.calendar_events.deleteMany({
    where: { user_id: u.id, google_calendar_id: { startsWith: GID_PREFIX } },
  });
  const conns = await prisma.google_connections.deleteMany({
    where: { user_id: u.id, google_email: { startsWith: 'e2e-' } },
  });
  if (!quiet) console.log(`removed ${events.count} event(s) and ${conns.count} connection(s) for ${EMAIL}`);
}

async function status() {
  const u = await user();
  const conns = await prisma.google_connections.findMany({ where: { user_id: u.id }, select: { scope: true } });
  const evs = await prisma.calendar_events.findMany({
    where: { user_id: u.id, google_calendar_id: { startsWith: GID_PREFIX } },
    select: { title: true, domain: true, created_by: true, deleted_at: true },
    orderBy: { id: 'asc' },
  });
  console.log(`\n${EMAIL} in "${DB}" (${MONTH})`);
  console.log(`  connections: ${conns.map((c) => c.scope).sort().join(', ') || '(none)'}`);
  for (const e of evs) {
    console.log(`  ${e.deleted_at ? 'hidden ' : 'visible'}  ${String(e.domain).padEnd(5)}  ${e.created_by === GOOGLE_ORIGIN ? 'google' : 'native'}  ${e.title}`);
  }
  console.log('');
}

const mode = process.argv.find((a) => ['--setup', '--teardown', '--status'].includes(a)) || '--status';
const run = mode === '--setup' ? setup : mode === '--teardown' ? () => teardown(false) : status;
run()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
