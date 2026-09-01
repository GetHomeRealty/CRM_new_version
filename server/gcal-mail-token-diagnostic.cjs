/**
 * PRODUCTION DIAGNOSTIC — Google mail / calendar token health.
 *
 * Read-only and safe on a live server: sends NO email, writes NOTHING to the database, prints NO
 * secret, refresh token, access token or client secret.
 *
 * ---------------------------------------------------------------------------------------------
 * v3 — CORRECTS A SECOND BUG THAT ALSO PRODUCED FALSE "DEAD invalid_grant" ON CALENDAR ROWS.
 *
 * THE TWO STORES USE DIFFERENT CIPHERS, and v2 used one cipher for both:
 *
 *     mail_accounts.password       Laravel encrypted (LaravelCryptService)
 *     google_connections.*_token   AES-256-GCM       (meta-crypto, prefix "enc:v1:")
 *
 * v2 decrypted everything with the Laravel cipher. On a Calendar row that produced nothing, and
 * a `?? raw` fallback then sent Google the RAW CIPHERTEXT as though it were a refresh token.
 * Google answered `invalid_grant` — correctly, about a base64 blob — and the tool reported a
 * perfectly healthy connection as dead. Every conclusion drawn from that was wrong.
 *
 * So each store is now read with its own cipher, and THERE IS NO RAW FALLBACK. A credential that
 * cannot be decrypted is reported as untested and never sent anywhere: a decode failure is not
 * evidence about a token, and must never be presented as if it were.
 *
 * v2 — CORRECTS A BUG IN v1 THAT PRODUCED FALSE "DEAD invalid_grant" ON CALENDAR CONNECTIONS.
 *
 * This application uses TWO Google OAuth clients:
 *
 *     calendar  ->  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *     mail      ->  GOOGLE_MAIL_CLIENT_ID / GOOGLE_MAIL_CLIENT_SECRET, falling back to the above
 *
 * `google.service.ts` says why that matters: "a refresh token is not portable between Google
 * clients, and presenting one to the wrong client fails permanently." v1 of this script applied the
 * MAIL precedence to every token, so wherever a separate mail client is configured it tested
 * CALENDAR refresh tokens against the MAIL client — and Google correctly answered `invalid_grant`.
 * The connection was healthy; the question was wrong.
 *
 * It went unnoticed locally because GOOGLE_MAIL_CLIENT_ID is unset there, so both pairs resolve to
 * the same client and the bug is invisible.
 * ---------------------------------------------------------------------------------------------
 *
 * USAGE — copy to the production server's `server/` directory (beside .env), then:
 *
 *     node gcal-mail-token-diagnostic.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  console.error(`No .env found in ${ROOT}. Run this from the server/ directory that holds .env.`);
  process.exit(1);
}
// dotenv semantics: the LAST definition of a key wins.
const fromFile = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
for (const [k, v] of Object.entries(fromFile)) if (process.env[k] === undefined) process.env[k] = v;

let PrismaClient, LaravelCryptService, decryptGoogleToken;
try {
  ({ PrismaClient } = require(path.join(ROOT, 'node_modules', '@prisma', 'client')));
  ({ LaravelCryptService } = require(path.join(ROOT, 'dist', 'common', 'laravel-crypt.service')));
  // The cipher the application itself uses for Google tokens — imported rather than
  // reimplemented, so this tool cannot drift from it the way v2 did.
  ({ decryptToken: decryptGoogleToken } = require(path.join(ROOT, 'dist', 'meta', 'meta-crypto')));
} catch (e) {
  console.error('Could not load the app modules. Run from server/ after a build (dist/ must exist).');
  console.error(e.message);
  process.exit(1);
}

const crypt = new LaravelCryptService({ get: () => process.env.APP_KEY });

/** Mirrors `credentials(kind)` in google.service.ts exactly. */
const CLIENTS = {
  calendar: { id: process.env.GOOGLE_CLIENT_ID || '', secret: process.env.GOOGLE_CLIENT_SECRET || '' },
  mail: {
    id: process.env.GOOGLE_MAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    secret: process.env.GOOGLE_MAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
  },
};
const projectOf = (id) => (id.split('-')[0] || '(unknown)');
const days = (d) => (d ? ((Date.now() - new Date(d).getTime()) / 86400000).toFixed(1) : '?');

/**
 * Read a MAILBOX credential (Laravel-encrypted).
 *
 * Returns null when it cannot be decrypted, and NEVER returns the stored value. Handing
 * ciphertext to Google yields `invalid_grant` about the ciphertext, which reads exactly like a
 * revoked token — the bug this version exists to remove.
 */
function revealMail(v) {
  if (!v) return null;
  try { const d = crypt.decryptString(v); return d || null; } catch { return null; }
}

/** Does this look like a Laravel-encrypted blob — base64 of {"iv":..,"value":..,"mac":..}? */
function looksLaravelEncrypted(v) {
  try {
    const j = JSON.parse(Buffer.from(String(v), 'base64').toString('utf8'));
    return !!(j && j.iv && j.value && j.mac);
  } catch { return false; }
}

/**
 * Read a CALENDAR credential, using the application's own meta-crypto so this tool cannot drift
 * from it.
 *
 * `decryptToken` RETURNS UNPREFIXED INPUT UNCHANGED (meta-crypto.ts:49) — right for the
 * application, where such rows are genuine plaintext written before encryption existed, but in a
 * tool that forwards the result to Google it quietly restores the very bug this version removes:
 * a Laravel blob carries no `enc:v1:` prefix, so it would pass straight through and be sent as a
 * refresh token. So the passthrough is accepted only for a value that actually looks like a Google
 * refresh token; anything else is reported untested rather than guessed at.
 */
function revealCalendar(v) {
  if (!v) return null;
  const raw = String(v);
  const managed = raw.startsWith('enc:v1:') || raw.startsWith('plain:v1:');
  let d;
  try { d = decryptGoogleToken(raw); } catch { return null; }
  if (!d) return null;
  if (managed) return d;
  // Unprefixed: decryptToken handed back exactly what was stored, so vet it before sending.
  if (looksLaravelEncrypted(raw)) return null;   // a MAIL credential in the calendar column
  return d.startsWith('1//') ? d : null;         // real legacy plaintext, or unrecognised
}

async function probe(refresh, kind) {
  const { id, secret } = CLIENTS[kind];
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) return { ok: true };
    const body = await res.text();
    return {
      ok: false,
      error: (/"error"\s*:\s*"([^"]+)"/.exec(body) || [])[1] ?? `HTTP ${res.status}`,
      detail: (/"error_description"\s*:\s*"([^"]+)"/.exec(body) || [])[1] ?? '',
    };
  } catch (e) { return { ok: false, error: 'network', detail: e.message }; }
}

(async () => {
  const split = CLIENTS.calendar.id !== CLIENTS.mail.id;
  console.log('='.repeat(78));
  console.log('GOOGLE TOKEN DIAGNOSTIC  (v3 — per-client AND per-cipher)');
  console.log('='.repeat(78));
  console.log(`Calendar OAuth client : project ${projectOf(CLIENTS.calendar.id)}  (GOOGLE_CLIENT_ID)`);
  console.log(`Mail OAuth client     : project ${projectOf(CLIENTS.mail.id)}  (${process.env.GOOGLE_MAIL_CLIENT_ID ? 'GOOGLE_MAIL_CLIENT_ID' : 'falls back to GOOGLE_CLIENT_ID'})`);
  console.log(`Two separate clients? : ${split ? 'YES — each token is tested against its own client' : 'no — one client serves both'}`);
  console.log(`NODE_ENV              : ${process.env.NODE_ENV ?? '(unset)'}`);
  console.log(`Database              : ${(process.env.DATABASE_URL || '').split('/').pop()?.split('?')[0] ?? '(unknown)'}`);
  console.log('');

  const prisma = new PrismaClient();
  const ages = [];
  /** Rows whose credential could not be read. Never counted as alive OR dead. */
  const untested = [];
  /** Rows with no credential stored at all — a different fact again, and not a token failure. */
  const missing = [];

  const accounts = await prisma.mail_accounts.findMany({
    where: { is_active: true, encryption: 'oauth' },
    select: {
      id: true, from_email: true, scope: true, user_id: true, is_default: true, password: true, updated_at: true,
      inbound_enabled: true, imap_host: true, imap_port: true, last_synced_at: true, sync_error: true,
    },
    orderBy: { id: 'asc' },
  });
  console.log(`MAILBOXES (${accounts.length} active OAuth) — tested against the MAIL client`);
  for (const a of accounts) {
    const refresh = revealMail(a.password);
    const age = days(a.updated_at);
    if (!a.password) {
      missing.push({ label: a.from_email, kind: 'mail' });
      console.log(`  #${String(a.id).padEnd(7)} ${String(a.from_email).padEnd(30)} user=${String(a.user_id).padEnd(6)} age=${age.padStart(5)}d  NO CREDENTIAL STORED`);
    } else if (!refresh) {
      untested.push({ label: a.from_email, kind: 'mail' });
      console.log(`  #${String(a.id).padEnd(7)} ${String(a.from_email).padEnd(30)} user=${String(a.user_id).padEnd(6)} age=${age.padStart(5)}d  DECRYPTION FAILED — token not tested`);
    } else {
      const r = await probe(refresh, 'mail');
      ages.push({ label: a.from_email, age: Number(age), ok: r.ok, kind: 'mail', error: r.error, active: true });
      console.log(`  #${String(a.id).padEnd(7)} ${String(a.from_email).padEnd(30)} user=${String(a.user_id).padEnd(6)} age=${age.padStart(5)}d  ${r.ok ? 'ALIVE' : `DEAD  ${r.error}${r.detail ? ' — ' + r.detail : ''}`}`);
    }
    console.log(`           inbox=${a.inbound_enabled ? 'on' : 'off'}  ${a.imap_host ?? '(no imap host)'}:${a.imap_port ?? '-'}  last synced ${a.last_synced_at ? new Date(a.last_synced_at).toISOString().replace('T', ' ').slice(0, 16) : 'never'}`);
    console.log(`           STORED SYNC ERROR: ${a.sync_error ? String(a.sync_error) : '(none — last sync succeeded)'}`);
  }

  let conns = [];
  try {
    conns = await prisma.google_connections.findMany({
      select: { user_id: true, google_email: true, is_active: true, scope: true, refresh_token: true, updated_at: true, connect_error: true, calendar_id: true, scopes: true },
      orderBy: [{ user_id: 'asc' }, { scope: 'asc' }],
    });
  } catch { /* table absent in this deployment */ }
  if (conns.length) {
    console.log(`\nCALENDAR CONNECTIONS (${conns.length}) — tested against the CALENDAR client`);
    for (const c of conns) {
      const refresh = revealCalendar(c.refresh_token);
      const age = days(c.updated_at);
      const head = `  user=${String(c.user_id).padEnd(6)} ${String(c.google_email).padEnd(30)} scope=${String(c.scope).padEnd(5)} active=${String(c.is_active).padEnd(5)} age=${age.padStart(5)}d`;
      if (!c.refresh_token) {
        missing.push({ label: `${c.google_email} (user ${c.user_id}, ${c.scope})`, kind: 'calendar' });
        console.log(`${head}  NO REFRESH TOKEN STORED`);
      } else if (!refresh) {
        untested.push({ label: `${c.google_email} (user ${c.user_id}, ${c.scope})`, kind: 'calendar' });
        console.log(`${head}  DECRYPTION FAILED — token not tested`);
      } else {
        // An INACTIVE row is still probed: that is how you tell "we deactivated it" from
        // "Google rejected it".
        const r = await probe(refresh, 'calendar');
        ages.push({ label: `${c.google_email} (user ${c.user_id}, ${c.scope})`, age: Number(age), ok: r.ok, kind: 'calendar', error: r.error, active: !!c.is_active });
        console.log(`${head}  ${r.ok ? 'ALIVE' : `DEAD  ${r.error}`}`);
      }
      console.log(`           calendar=${c.calendar_id ?? '(none)'}  connect_error: ${c.connect_error ? String(c.connect_error).slice(0, 90) : '(none)'}`);
    }
  }

  /*
   * ============================================================================================
   * THE REPORT.
   *
   * An earlier version ended with a single VERDICT that pooled mailboxes and calendar connections,
   * inferred a root cause from token ages, and concluded "so it is account-specific" merely because
   * something else was still alive. None of that followed from the data. This version reports what
   * was observed, per surface, and stops there.
   *
   * FOUR OUTCOMES, KEPT APART. Google accepted it; Google rejected it; the stored value could not
   * be decrypted so nothing was asked; there was nothing stored to ask about. Only the first two
   * are evidence about a token. Collapsing the third into "dead" is the exact mistake that made
   * v2's output wrong, and it must not reappear in the summary after being fixed in the probe.
   * ============================================================================================
   */
  const live = (kind) => ages.filter((a) => a.kind === kind && a.active);
  const pad = (n) => String(n).padStart(2);

  function surface(kind, title) {
    const rows = live(kind);
    const idle = ages.filter((a) => a.kind === kind && !a.active);
    const unread = untested.filter((u) => u.kind === kind);
    const absent = missing.filter((m) => m.kind === kind);
    console.log(`\n${title}`);
    if (!rows.length && !idle.length && !unread.length && !absent.length) {
      console.log('  no connections of this kind exist.');
      return;
    }
    const alive = rows.filter((r) => r.ok);
    const dead = rows.filter((r) => !r.ok);
    // Suppressed when nothing was testable: a row of zeroes reads like a result, and here it is not one.
    if (rows.length) console.log(`  ${pad(rows.length)} tested   ${pad(alive.length)} accepted by Google   ${pad(dead.length)} rejected by Google`);
    for (const a of alive) console.log(`     ACCEPTED    ${a.label}  (stored ${a.age}d ago)`);
    for (const d of dead) console.log(`     REJECTED    ${d.label}  (stored ${d.age}d ago) — ${d.error}`);
    if (unread.length) {
      console.log(`  ${pad(unread.length)} NOT TESTED — the stored value could not be decrypted, so no request was`);
      console.log('              made. That is a fact about this tool or about APP_KEY, not about the');
      console.log('              token: it is neither alive nor dead, and is excluded from the counts.');
      for (const u of unread) console.log(`     NOT TESTED  ${u.label}`);
    }
    if (absent.length) {
      console.log(`  ${pad(absent.length)} with no credential stored — nothing to test.`);
      for (const m of absent) console.log(`     NO TOKEN    ${m.label}`);
    }
    if (idle.length) {
      console.log('  disabled in the CRM, probed for information only and excluded from the counts:');
      for (const i of idle) console.log(`     ${i.ok ? 'ACCEPTED' : 'REJECTED'}    ${i.label}${i.ok ? ' — still valid, though switched off here' : ` — ${i.error}`}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('RESULTS');
  surface('mail', 'MAIL');
  surface('calendar', 'CALENDAR');

  console.log('\n' + '-'.repeat(78));
  console.log('WHAT THIS RUN ESTABLISHES');

  function finding(kind, title) {
    const rows = live(kind);
    const unread = untested.filter((u) => u.kind === kind).length;
    const dead = rows.filter((r) => !r.ok);
    if (!rows.length) {
      console.log(`  ${title}: nothing was tested${unread ? `; ${unread} could not be decrypted` : ''} — no finding.`);
      return;
    }
    if (!dead.length) {
      console.log(`  ${title}: all ${rows.length === 1 ? 'one tested credential was' : `${rows.length} tested credentials were`} accepted. No token problem here.`);
    } else {
      console.log(`  ${title}: Google rejected ${dead.length} of ${rows.length} tested — ${[...new Set(dead.map((d) => d.error))].join(', ')}.`);
      console.log('        That is the finding in full: the stored refresh token is no longer accepted.');
      console.log('        It does not say why, and one run of this tool cannot determine why.');
    }
    if (unread) console.log(`        ${unread} further ${unread === 1 ? 'credential was' : 'credentials were'} unreadable, so they support no conclusion either way.`);
    // Stated explicitly, because the temptation to read one from the other is what went wrong before.
    if (rows.some((r) => r.ok) && dead.length) {
      console.log('        Mixed results here do NOT make the cause account-specific. These credentials');
      console.log('        were authorised at different times, by different people, and can be revoked');
      console.log('        individually — a surviving token is not a control for a rejected one.');
    }
  }

  finding('mail', 'MAIL');
  finding('calendar', 'CALENDAR');

  console.log('\n  Mail and calendar are separate grants, held in different tables under different');
  console.log(`  ciphers${split ? ', and issued by two different OAuth clients.' : ' (one OAuth client currently serves both).'}`);
  console.log('  A result on one surface is not evidence about the other.');

  if (ages.some((a) => a.active && !a.ok)) {
    console.log('\nWHAT WOULD ESTABLISH A CAUSE (not attempted here)');
    console.log('  Each of these produces the same invalid_grant, so the rejection alone cannot');
    console.log('  distinguish them. Ages are printed above; compare them yourself.');
    console.log('    - OAuth app publishing status: Testing expires refresh tokens after 7 days,');
    console.log('      which would show as rejections clustered just past that mark');
    console.log('    - Admin console -> Security -> Access and data control -> API controls');
    console.log('      -> App access control: is this client Trusted for the organisation?');
    console.log('    - a password reset or "sign out of all devices" on the affected account');
    console.log('    - myaccount.google.com -> Security -> third-party apps, as the affected user');
    console.log('  A reconnect followed by a later re-run distinguishes an expiry pattern from a');
    console.log('  one-off revocation; a single run cannot.');
  }
  console.log('='.repeat(78));
  await prisma.$disconnect();
})().catch((e) => { console.error('DIAGNOSTIC ERROR:', e.message); process.exit(1); });
