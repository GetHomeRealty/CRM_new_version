/**
 * Classify — and where it is safe, repair — the Google calendar events that predate the CRM/Desk
 * split, plus any left behind by a disconnect that happened before that bug was fixed.
 *
 * WHAT "LEGACY" MEANS HERE. `calendar_events.domain` says which area an event belongs to. Events
 * pulled from Google before that column existed have `domain IS NULL`, and `areaWhere` shows those
 * on BOTH calendars because nothing records which connection they came from. There are 99 of them
 * in development and 266 in QA, so this is real data rather than a hypothetical.
 *
 * WHAT RESOLVES ITSELF, AND WHAT DOES NOT. A pull stamps `domain` on every event it touches, so a
 * null-domain event still inside Google's sync window (30 days back, 120 forward) is classified by
 * the next sync of whichever calendar still lists it. Anything OUTSIDE that window is never seen by
 * a pull again and will stay null for ever. In development every one of the 99 is outside it. That
 * is the residue this script exists to name.
 *
 * WHAT IT WILL AND WILL NOT DECIDE. It only ever acts where the answer is unambiguous from local
 * data:
 *
 *   ORPHANED    the event's owner has no Google connection at all. Nothing will ever sync it again
 *               and "no connection means no Google events" is the rule the disconnect fix enforces
 *               — but only from the moment it shipped. These are the rows an earlier disconnect
 *               left visible. They are hidden the same way a disconnect hides them, so a later
 *               reconnect restores them.
 *   ONE SCOPE   the owner has exactly one Google connection, so a null-domain event of theirs can
 *               only have come from it. Stamped with that scope.
 *   AMBIGUOUS   the owner has BOTH connections. Nothing local can say which calendar an event came
 *               from, so nothing is changed. Reported, with whether a future pull can still reach
 *               it. Resolving these needs Google itself — an events.get per id per scope — which is
 *               deliberately not done here: it spends API quota against a live integration to
 *               relabel events that are already visible to their owner.
 *
 *   node scripts/classify-legacy-google-events.cjs            # report only, changes nothing
 *   node scripts/classify-legacy-google-events.cjs --apply    # perform the two safe repairs
 */
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || '';
const DB = (URL.split('/').pop() || '').split('?')[0];
const prisma = new PrismaClient(URL ? { datasources: { db: { url: URL } } } : undefined);

const GOOGLE_ORIGIN = 'Google Calendar';
/** Mirrors SYNC_WINDOW_PAST_DAYS / SYNC_WINDOW_FUTURE_DAYS in google.constants.ts. */
const PAST_DAYS = 30;
const FUTURE_DAYS = 120;

const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const row = (a, b) => console.log(`  ${String(a).padEnd(52)} ${b}`);

async function main() {
  console.log(`\nLegacy Google calendar events in "${DB}"`);
  console.log(APPLY ? '  MODE: --apply — the two safe repairs will be written.'
                    : '  MODE: report only. Nothing is changed. Add --apply to act.');

  const now = new Date();
  const from = new Date(now.getTime() - PAST_DAYS * 86400000);
  const to = new Date(now.getTime() + FUTURE_DAYS * 86400000);

  // Every visible Google-origin event, with its owner's connections alongside.
  const events = await prisma.calendar_events.findMany({
    where: { created_by: GOOGLE_ORIGIN, deleted_at: null },
    select: { id: true, user_id: true, domain: true, date: true },
  });
  const conns = await prisma.google_connections.findMany({ select: { user_id: true, scope: true } });

  const byUser = new Map();
  for (const c of conns) {
    const set = byUser.get(c.user_id) ?? new Set();
    set.add(c.scope);
    byUser.set(c.user_id, set);
  }

  const orphaned = [];      // owner has no connection at all
  const stampable = [];     // null domain, owner has exactly one connection
  const ambiguous = [];     // null domain, owner has both
  let healthy = 0;

  for (const e of events) {
    const scopes = byUser.get(e.user_id) ?? new Set();
    if (scopes.size === 0) { orphaned.push(e); continue; }
    if (e.domain === null) {
      if (scopes.size === 1) stampable.push({ ...e, scope: [...scopes][0] });
      else ambiguous.push(e);
      continue;
    }
    healthy++;
  }

  head('What is there');
  row('visible Google-origin events', events.length);
  row('already classified, owner still connected', healthy);
  row('ORPHANED — owner has no Google connection', orphaned.length);
  row('null domain, owner has ONE connection (stampable)', stampable.length);
  row('null domain, owner has BOTH (ambiguous)', ambiguous.length);

  if (ambiguous.length) {
    const reachable = ambiguous.filter((e) => e.date >= from && e.date <= to).length;
    head('The ambiguous ones');
    row('inside the sync window — a future pull will stamp these', reachable);
    row('outside it — no pull will ever see them again', ambiguous.length - reachable);
    if (ambiguous.length - reachable > 0) {
      console.log('\n  Those are the permanent residue. They stay visible on BOTH calendars, which is');
      console.log('  what they have always done, and they disappear correctly once their owner has no');
      console.log('  Google connection left. Relabelling them would require asking Google for each id');
      console.log('  under each scope; nothing local can tell them apart.');
    }
  }

  if (!APPLY) {
    head('What --apply would do');
    row('hide orphaned events', orphaned.length);
    row('stamp a domain on single-connection events', stampable.length);
    console.log('\n  Both are reversible: hidden events carry `google_disconnected_at` and a reconnect');
    console.log('  restores them; a stamped domain is corrected by the next pull if it is ever wrong.\n');
    return;
  }

  head('Applying');
  if (orphaned.length) {
    const stamp = new Date();
    const { count } = await prisma.calendar_events.updateMany({
      where: { id: { in: orphaned.map((e) => e.id) } },
      // Exactly what a disconnect does, so a reconnect brings them back the same way.
      data: { deleted_at: stamp, google_disconnected_at: stamp, updated_at: stamp },
    });
    row('orphaned events hidden', count);
  } else row('orphaned events hidden', 0);

  let stamped = 0;
  for (const scope of ['crm', 'desk']) {
    const ids = stampable.filter((e) => e.scope === scope).map((e) => e.id);
    if (!ids.length) continue;
    const { count } = await prisma.calendar_events.updateMany({
      where: { id: { in: ids } },
      data: { domain: scope, updated_at: new Date() },
    });
    stamped += count;
    row(`events stamped "${scope}"`, count);
  }
  if (!stamped) row('events stamped', 0);

  row('left alone (ambiguous)', ambiguous.length);
  console.log('');
}

main()
  .catch((e) => { console.error(`\n${e.message}\n`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
