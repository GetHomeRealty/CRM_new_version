/**
 * Ask Google which calendar an old, unlabelled event actually came from.
 *
 * THE ROWS THIS IS FOR, and nothing else. `calendar_events.domain` says whether an event belongs to
 * the CRM or the Transaction Desk. Events pulled from Google before that column existed have
 * `domain IS NULL` and, by `areaWhere`, show on BOTH calendars. A pull stamps `domain` on anything
 * it touches, so the ones still inside Google's sync window (30 days back, 120 forward) fix
 * themselves. The ones outside it never will: 99 of the 99 in development, 107 of 266 in QA.
 *
 * `classify-legacy-google-events.cjs` resolves every case that local data can answer — an owner with
 * one connection, or none. What it cannot answer is an owner with BOTH calendars connected, which is
 * the entire remaining population. Only Google knows, and `events.get` has no time bound, so asking
 * each connected calendar for the id settles it.
 *
 * WHAT IT DOES WITH EACH ANSWER:
 *
 *   in exactly one calendar   stamp that area. This is the case the script exists for.
 *   in both calendars         left alone. The event genuinely exists in both, one local row cannot
 *                             belong to two areas, and picking one would be a guess dressed as a
 *                             fact. Showing on both calendars is already correct for these.
 *   in neither                left alone, and reported. It is a local remnant of an event since
 *                             deleted in Google. Hiding it is a defensible cleanup and a different
 *                             decision from relabelling, so it is not made here.
 *   lookup failed            left alone. A 401/403/500 says nothing about where the event lives,
 *                             and treating an auth error as absence would relabel on noise.
 *
 * COST. One Google API call per event per connected calendar, paced. For the volumes above that is
 * a few hundred calls against a per-user quota measured in thousands, and every one is a read.
 *
 *   node scripts/relabel-legacy-google-events.cjs                 # report only, no writes
 *   node scripts/relabel-legacy-google-events.cjs --apply         # stamp the unambiguous ones
 *   node scripts/relabel-legacy-google-events.cjs --user 42       # one agent only
 *   node scripts/relabel-legacy-google-events.cjs --limit 50      # cap the API calls
 */
const { PrismaClient } = require('@prisma/client');
const path = require('node:path');

const APPLY = process.argv.includes('--apply');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ONLY_USER = arg('user', null);
const LIMIT = Number(arg('limit', 1000));
/** Paced so a few hundred reads never look like a burst to Google. */
const DELAY_MS = Number(arg('delay', 120));

const URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || '';
const DB = (URL.split('/').pop() || '').split('?')[0];
const prisma = new PrismaClient(URL ? { datasources: { db: { url: URL } } } : undefined);

const GOOGLE_ORIGIN = 'Google Calendar';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const row = (a, b) => console.log(`  ${String(a).padEnd(46)} ${b}`);

/**
 * The compiled server is used for the Google client and token decryption, so this script cannot
 * drift from what the application actually does. Requires `npm run build` first.
 */
function serverBits() {
  const dist = path.join(__dirname, '..', 'dist');
  try {
    const { GoogleService } = require(path.join(dist, 'google', 'google.service.js'));
    const { decryptToken } = require(path.join(dist, 'meta', 'meta-crypto.js'));
    return { google: new GoogleService(), decryptToken };
  } catch (e) {
    console.error(`\n  Could not load the compiled server from dist/ (${e.message}).`);
    console.error('  Run `npm run build` in server/ first — this script reuses the application\'s own');
    console.error('  Google client and token decryption rather than reimplementing either.\n');
    process.exit(1);
  }
}

/** A usable access token for one connection, refreshing it when it has expired. */
async function tokenFor(google, decryptToken, conn) {
  const fresh = conn.token_expires_at && conn.token_expires_at.getTime() > Date.now() + 60_000;
  if (fresh && conn.access_token) return decryptToken(conn.access_token);
  if (!conn.refresh_token) return conn.access_token ? decryptToken(conn.access_token) : null;
  const t = await google.refresh(decryptToken(conn.refresh_token));
  return t?.access_token ?? null;
}

async function main() {
  console.log(`\nRelabelling legacy Google events in "${DB}"`);
  console.log(APPLY ? '  MODE: --apply — unambiguous matches will be stamped.'
                    : '  MODE: report only. Nothing is written. Add --apply to act.');

  const where = {
    created_by: GOOGLE_ORIGIN, deleted_at: null, domain: null,
    ...(ONLY_USER ? { user_id: Number(ONLY_USER) } : {}),
  };
  const events = await prisma.calendar_events.findMany({
    where, select: { id: true, user_id: true, title: true, google_calendar_id: true, date: true },
    orderBy: { id: 'asc' }, take: LIMIT,
  });

  if (!events.length) {
    console.log('\n  No unlabelled Google events. Nothing to do.\n');
    return;
  }

  const { google, decryptToken } = serverBits();
  const userIds = [...new Set(events.map((e) => e.user_id))];
  const conns = await prisma.google_connections.findMany({ where: { user_id: { in: userIds } } });

  head('Scope');
  row('unlabelled Google events', events.length);
  row('agents involved', userIds.length);
  row('connected calendars to ask', conns.length);

  const tokens = new Map();                       // `${userId}:${scope}` -> access token
  for (const c of conns) {
    try { tokens.set(`${c.user_id}:${c.scope}`, await tokenFor(google, decryptToken, c)); }
    catch (e) { console.log(`  could not get a token for user ${c.user_id}/${c.scope}: ${e.message}`); }
  }

  const verdicts = { one: [], both: 0, neither: 0, failed: 0, noConnections: 0 };

  head('Asking Google');
  for (const ev of events) {
    const scopes = conns.filter((c) => c.user_id === ev.user_id).map((c) => c.scope);
    if (!scopes.length) { verdicts.noConnections++; continue; }

    const found = [];
    let failed = false;
    for (const scope of scopes) {
      const token = tokens.get(`${ev.user_id}:${scope}`);
      if (!token) { failed = true; continue; }
      const calendarId = conns.find((c) => c.user_id === ev.user_id && c.scope === scope)?.calendar_id ?? 'primary';
      try {
        const hit = await google.getEvent(token, calendarId, ev.google_calendar_id);
        if (hit) found.push(scope);
      } catch (e) {
        // An error is not an absence. Say so and take this event out of consideration.
        failed = true;
        console.log(`  lookup failed for event ${ev.id} in ${scope}: ${e.message}`);
      }
      await sleep(DELAY_MS);
    }

    if (failed) { verdicts.failed++; continue; }
    if (found.length === 1) verdicts.one.push({ ...ev, scope: found[0] });
    else if (found.length > 1) verdicts.both++;
    else verdicts.neither++;
  }

  head('What Google said');
  row('in exactly one calendar — can be stamped', verdicts.one.length);
  row('in both calendars — genuinely shared, left', verdicts.both);
  row('in neither — gone from Google, left', verdicts.neither);
  row('lookup failed — left, nothing concluded', verdicts.failed);
  if (verdicts.noConnections) row('owner has no connection (use the classifier)', verdicts.noConnections);

  if (!APPLY) {
    if (verdicts.one.length) {
      head('What --apply would stamp');
      for (const e of verdicts.one.slice(0, 10)) console.log(`  ${String(e.scope).padEnd(5)}  ${e.date.toISOString().slice(0, 10)}  ${e.title}`);
      if (verdicts.one.length > 10) console.log(`  … and ${verdicts.one.length - 10} more`);
    }
    console.log('\n  Nothing was written.\n');
    return;
  }

  head('Applying');
  let stamped = 0;
  for (const scope of ['crm', 'desk']) {
    const ids = verdicts.one.filter((e) => e.scope === scope).map((e) => e.id);
    if (!ids.length) continue;
    const { count } = await prisma.calendar_events.updateMany({
      where: { id: { in: ids } }, data: { domain: scope, updated_at: new Date() },
    });
    stamped += count;
    row(`stamped "${scope}"`, count);
  }
  if (!stamped) row('stamped', 0);
  console.log('\n  A stamp is not final: the next pull that sees the event rewrites `domain` from the');
  console.log('  connection it arrived on, so a wrong one corrects itself rather than sticking.\n');
}

main()
  .catch((e) => { console.error(`\n${e.message}\n`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
