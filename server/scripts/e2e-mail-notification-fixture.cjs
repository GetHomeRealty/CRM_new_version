/**
 * Put new-mail notifications from SEVERAL mailboxes in front of the browser suite.
 *
 * WHY A HAND-BUILT ROW IS LEGITIMATE HERE. What is under test is not how a notification is created
 * — `server/src/inbox/imap-batch.spec.ts` covers that decision directly — but what the Notification
 * Centre SHOWS once rows exist: only the primary mailbox's, and with an open button that says
 * "Open mail" rather than "Open deal". Producing those rows the honest way would mean standing up
 * an IMAP server and delivering mail to it, none of which the screen under test touches. The rows
 * below are written exactly as `imap-sync.service.ts` writes one, dedupe key and all, because the
 * dedupe key is precisely what the read-side filter reads.
 *
 *   node scripts/e2e-mail-notification-fixture.cjs --setup      # two mailboxes, one primary, a line from each
 *   node scripts/e2e-mail-notification-fixture.cjs --swap       # hand the primary to the other mailbox
 *   node scripts/e2e-mail-notification-fixture.cjs --teardown   # remove exactly what --setup created
 *   node scripts/e2e-mail-notification-fixture.cjs --status     # what is currently seeded
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
const EMAIL = process.env.E2E_MAIL_ACCOUNT || 'agent@test.local';

/** Markers. Every row this script writes carries one, and teardown matches on them. */
const BOX_PREFIX = 'E2E Mailbox ';
const ADDRESS_PREFIX = 'e2e-mailbox-';

/**
 * Titles the spec asserts on, and the marker teardown works from.
 *
 * The TITLE is the marker rather than the dedupe key, because the dedupe key is not free to
 * decorate: the Centre parses `inbox-<account id>-<uid>` out of it to decide which mailbox a line
 * came from, so a fixture-flavoured prefix would make every row here unattributable and the whole
 * file would pass by hiding everything for the wrong reason.
 */
const PRIMARY_TITLE = 'E2E new mail from the primary box';
const OTHER_TITLE = 'E2E new mail from the other box';
const TITLE_PREFIX = 'E2E new mail from ';

/** Exactly what `imap-sync.service.ts` writes: account, then the highest UID in the batch. */
const dedupeKey = (accountId) => `inbox-${accountId}-1`;

async function user() {
  const u = await prisma.users.findFirst({ where: { email: EMAIL }, select: { id: true, name: true } });
  if (!u) throw new Error(`No user ${EMAIL} — run seed-test-env.cjs first.`);
  return u;
}

/** The two mailboxes this fixture owns, oldest first, whatever their current primary flag is. */
async function boxes(userId) {
  return prisma.mail_accounts.findMany({
    where: { user_id: userId, from_email: { startsWith: ADDRESS_PREFIX } },
    orderBy: { id: 'asc' },
    select: { id: true, from_email: true, is_default: true },
  });
}

async function setup() {
  const u = await user();
  const now = new Date();
  await teardown(true);

  /*
   * The suite's own primary mailbox, if it has one, is stood down for the duration and restored by
   * teardown. Two primaries in one area is a state the application never produces, and leaving the
   * real one in place would mean the filter legitimately showed its notifications too.
   */
  await prisma.mail_accounts.updateMany({
    where: { user_id: u.id, scope: 'crm', is_default: true },
    data: { is_default: false },
  });

  const made = [];
  for (const [n, primary] of [[0, true], [1, false]]) {
    made.push(await prisma.mail_accounts.create({
      data: {
        name: `${BOX_PREFIX}${n}`, from_email: `${ADDRESS_PREFIX}${n}@example.test`,
        host: 'smtp.example.test', port: 587, encryption: 'tls',
        user_id: u.id, scope: 'crm', is_active: true, is_default: primary,
        created_at: now, updated_at: now,
      },
      select: { id: true },
    }));
  }

  // One line per mailbox, shaped as the sync writes them: category, link and dedupe key included,
  // because all three are what the Centre reads to decide what to show and what the button says.
  for (const [n, title] of [[0, PRIMARY_TITLE], [1, OTHER_TITLE]]) {
    await prisma.notifications.create({
      data: {
        user_id: u.id, category: 'inbox_new_mail', title,
        body: `${ADDRESS_PREFIX}${n}@example.test`, link: '/crm/inbox',
        dedupe_key: dedupeKey(made[n].id),
        read_at: null, created_at: now,
      },
    });
  }

  await status();
}

/**
 * Hand the primary to the other mailbox, exactly as Settings does.
 *
 * This is the state change the spec is really about: nothing is created or deleted, and the Centre
 * must nonetheless swap which line it shows on the very next read.
 */
async function swap() {
  const u = await user();
  const rows = await boxes(u.id);
  if (rows.length !== 2) throw new Error(`Expected 2 fixture mailboxes, found ${rows.length} — run --setup first.`);

  for (const b of rows) {
    await prisma.mail_accounts.update({ where: { id: b.id }, data: { is_default: !b.is_default } });
  }
  await status();
}

async function teardown(quiet = false) {
  const u = await user();

  const notes = await prisma.notifications.deleteMany({
    where: { user_id: u.id, category: 'inbox_new_mail', title: { startsWith: TITLE_PREFIX } },
  });
  const accounts = await prisma.mail_accounts.deleteMany({
    where: { user_id: u.id, from_email: { startsWith: ADDRESS_PREFIX } },
  });

  /*
   * Give the suite's own mailbox its primary flag back. Chosen by lowest id rather than "the one we
   * cleared", so a teardown after a partial setup still leaves exactly one primary rather than
   * none — which is a state the rest of the suite would notice.
   */
  const remaining = await prisma.mail_accounts.findMany({
    where: { user_id: u.id, scope: 'crm' }, orderBy: { id: 'asc' }, select: { id: true, is_default: true },
  });
  if (remaining.length && !remaining.some((a) => a.is_default)) {
    await prisma.mail_accounts.update({ where: { id: remaining[0].id }, data: { is_default: true } });
  }

  if (!quiet) console.log(`removed ${notes.count} notification(s) and ${accounts.count} mailbox(es) for ${EMAIL}`);
}

async function status() {
  const u = await user();
  const rows = await boxes(u.id);
  const notes = await prisma.notifications.findMany({
    where: { user_id: u.id, category: 'inbox_new_mail', title: { startsWith: TITLE_PREFIX } },
    orderBy: { id: 'asc' },
    select: { title: true, dedupe_key: true, read_at: true },
  });

  console.log(`\n${EMAIL} in "${DB}"`);
  for (const b of rows) console.log(`  ${b.is_default ? 'PRIMARY' : '       '}  #${b.id}  ${b.from_email}`);
  for (const n of notes) console.log(`  ${n.read_at ? 'read  ' : 'unread'}  ${n.dedupe_key}  ${n.title}`);
  console.log('');
}

const mode = process.argv.find((a) => ['--setup', '--swap', '--teardown', '--status'].includes(a)) || '--status';
const run = mode === '--setup' ? setup
  : mode === '--swap' ? swap
    : mode === '--teardown' ? () => teardown(false) : status;
run()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
