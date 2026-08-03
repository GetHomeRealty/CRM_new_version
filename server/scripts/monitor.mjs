/**
 * The thing that actually runs the checks.
 *
 * Every piece of this already existed — /api/health/ready, /api/health/metrics, the backup
 * heartbeat — and nothing called any of them on a schedule. A check nobody runs is documentation.
 * This runs them, decides whether the answer is worth waking somebody for, and sends it.
 *
 * TWO DESIGN RULES, both learned the hard way by everyone who has built one of these:
 *
 * 1. A MONITOR MUST NOT DEPEND ON WHAT IT MONITORS. The application's SMTP credentials live in the
 *    `mail_accounts` table, encrypted. Reading them would mean an alerter that cannot send mail
 *    precisely when the database is down — the exact moment it is needed. So alert routing comes
 *    from the ENVIRONMENT only. This script never opens the database and imports nothing from src/.
 *
 * 2. ALERT ON TRANSITIONS, NOT ON STATE. A check that fires every five minutes while something is
 *    broken trains people to ignore it, and then it is worth nothing when it matters. This notifies
 *    when a check CHANGES to failing, again on a slow reminder while it stays failing, and once
 *    more when it recovers. Silence means healthy.
 *
 * WHO WATCHES THIS? Nothing on this machine can — if the box is off, so is the watcher. That is
 * what ALERT_HEARTBEAT_URL is for: a successful run pings an external dead-man's-switch, and if the
 * pings stop, that service alerts. It is the only part of the chain that survives the machine
 * dying, so set it.
 *
 * TEN CHECKS: liveness, readiness, 5xx error rate, p95 latency, process CPU/memory/event-loop lag,
 * background schedulers, the export job queue, mailbox synchronisation, backup freshness and free
 * disk. The middle four cover work that happens when nobody is watching and fails silently — the
 * site serves every page perfectly while nobody's mail has synced for three days.
 *
 *   node scripts/monitor.mjs [--url http://localhost:8000] [--backup E:\backups\transactiondesk]
 *                            [--p95 1500] [--error-rate 0.02] [--rss-mb 1500] [--cpu-percent 85]
 *                            [--remind 60] [--once]
 *
 * Exit 0 = everything healthy. Exit 1 = at least one check failing.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);

const URL_BASE   = arg('url', process.env.MONITOR_URL ?? 'http://localhost:8000');
const BACKUP_DIR = arg('backup', process.env.MONITOR_BACKUP_DIR ?? 'D:\\backups\\transactiondesk');
const P95_MS     = Number(arg('p95', 1500));
const ERR_RATE   = Number(arg('error-rate', 0.02));
const RSS_MB     = Number(arg('rss-mb', 1500));
const CPU_PCT    = Number(arg('cpu-percent', 85));
const REMIND_MIN = Number(arg('remind', 60));
const STATE_FILE = arg('state', join(BACKUP_DIR, 'monitor-state.json'));
const TIMEOUT_MS = 10_000;

// ── checks ───────────────────────────────────────────────────────────────────────────────────────
// Each returns { ok, detail }. A check that THROWS is a failing check, not a crashed monitor —
// a monitor that dies on an unexpected error is indistinguishable from one that is not running.

async function get(path) {
  const ctl = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(URL_BASE + path, { signal: ctl });
  const body = await res.text();
  return { status: res.status, body };
}

async function checkLiveness() {
  const { status } = await get('/api/health');
  return { ok: status === 200, detail: status === 200 ? 'process responding' : `HTTP ${status}` };
}

async function checkReadiness() {
  const { status, body } = await get('/api/health/ready');
  // 503 here is the endpoint doing its job, so read the body rather than trusting the code.
  let json; try { json = JSON.parse(body); } catch { return { ok: false, detail: `unparseable: ${body.slice(0, 120)}` }; }
  const bad = Object.entries(json.checks ?? {}).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail ?? 'failed'}`);
  if (bad.length) return { ok: false, detail: bad.join('; ') };
  // Authorization fails CLOSED, so empty permission tables are a total outage with every process
  // reporting healthy. /ready checks this; surface its wording so the alert says what to do.
  return { ok: status === 200, detail: json.checks?.authorization?.detail ?? 'all checks passed' };
}

async function checkErrorRate() {
  const { body } = await get('/api/health/metrics');
  const m = JSON.parse(body);
  // With almost no traffic a single 500 is a 100% error rate. Requiring a floor of requests stops
  // the quiet hours generating alerts nobody can act on.
  if ((m.requests ?? 0) < 20) return { ok: true, detail: `only ${m.requests} requests since start — not enough to judge` };
  const ok = m.error_rate <= ERR_RATE;
  return { ok, detail: `${(m.error_rate * 100).toFixed(2)}% 5xx over ${m.requests} requests (limit ${(ERR_RATE * 100).toFixed(0)}%)`
    + (ok ? '' : ` · recent: ${(m.recent_errors ?? []).slice(0, 3).map((e) => e.route ?? e).join(', ')}`) };
}

async function checkLatency() {
  const { body } = await get('/api/health/metrics');
  const m = JSON.parse(body);
  if ((m.requests ?? 0) < 20) return { ok: true, detail: `only ${m.requests} requests — not enough to judge` };
  const p95 = m.latency_ms?.p95 ?? 0;
  const slow = (m.slowest_routes ?? [])[0];
  return { ok: p95 <= P95_MS, detail: `p95 ${p95}ms (limit ${P95_MS}ms)` + (slow ? ` · slowest ${slow.route} avg ${slow.avg_ms}ms` : '') };
}

async function checkBackup() {
  const hb = join(BACKUP_DIR, 'last-success.json');
  if (!existsSync(hb)) return { ok: false, detail: `no backup has ever succeeded at ${BACKUP_DIR}` };
  const { finished_at, set } = JSON.parse(readFileSync(hb, 'utf8'));
  const hours = (Date.now() - new Date(finished_at).getTime()) / 3.6e6;
  // Staleness, not errors: a nightly job that stops running produces no error to detect. Whether it
  // failed, never fired, or the machine was off, the symptom is the same and so is the fix.
  return { ok: hours <= 25, detail: `last set ${set}, ${hours.toFixed(1)}h ago (limit 25h)` };
}

async function checkDisk() {
  if (process.platform !== 'win32') return { ok: true, detail: 'skipped (not Windows)' };
  const drive = BACKUP_DIR.slice(0, 2);
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-PSDrive ${drive[0]} -ErrorAction Stop | Select-Object -First 1).Free`], { encoding: 'utf8', timeout: TIMEOUT_MS });
  const freeGb = Number(out.trim()) / 1024 ** 3;
  // Backups are the first thing to fail when a disk fills, and they fail by writing a truncated
  // dump rather than by refusing — which is worse than not running at all.
  return { ok: freeGb >= 5, detail: `${freeGb.toFixed(1)} GB free on ${drive} (limit 5 GB)` };
}

// ── background work ──────────────────────────────────────────────────────────────────────────────
// All four read one endpoint, fetched once per sweep. These fail SILENTLY in production — the site
// serves every page perfectly while nobody's mail has synced for three days — which is exactly the
// category that needs a monitor rather than a user to notice.

let workersCache = null;
async function workers() {
  if (!workersCache) workersCache = JSON.parse((await get('/api/health/workers')).body);
  return workersCache;
}

async function checkSchedulers() {
  const w = await workers();
  const list = w.schedulers ?? [];
  if (!list.length) return { ok: true, detail: 'no schedulers armed on this process (RUN_SCHEDULERS off?)' };
  const bad = list.filter((s) => !s.healthy);
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? bad.map((s) => `${s.name} ${s.stale ? `last ran ${s.last_run_age_s ?? 'never'}s ago (every ${s.interval_s}s)` : `failing: ${s.last_error ?? 'unknown'}`}`).join('; ')
      : `${list.length} running: ${list.map((s) => s.name).join(', ')}`,
  };
}

/**
 * Audit writes that failed.
 *
 * Audit writes are best-effort — they never fail the user's action — so a broken compliance trail
 * produces no 5xx, no stuck job and no user complaint. Nothing else here would ever notice, which
 * is exactly why it needs its own check: the point of the audit log is that its silence means
 * "nothing happened", and that stops being true the moment a write fails unseen.
 */
async function checkAudit() {
  const { audit } = await workers();
  if (!audit) return { ok: true, detail: 'not reported (older server build)' };
  if (!audit.failures) return { ok: true, detail: 'no failed audit writes' };
  return {
    ok: false,
    detail: `${audit.failures} audit write(s) FAILED since start — the trail is incomplete. `
      + `Last: ${audit.last_action ?? 'unknown action'} at ${audit.last_failed_at} — ${audit.last_error ?? 'no detail'}`,
  };
}

async function checkJobs() {
  const { jobs } = await workers();
  if (!jobs) return { ok: true, detail: 'not reported' };
  if (jobs.ok === false && jobs.detail) return { ok: false, detail: jobs.detail };
  // A job stuck in Processing is neither progressing nor failing, so nothing else will ever notice.
  return {
    ok: jobs.stuck_over_1h === 0,
    detail: `${jobs.queued} queued, ${jobs.processing} processing, ${jobs.failed_last_24h} failed in 24h`
      + (jobs.stuck_over_1h ? ` · ${jobs.stuck_over_1h} STUCK over an hour` : ''),
  };
}

async function checkMailSync() {
  const m = (await workers()).mail_sync;
  if (!m) return { ok: true, detail: 'not reported' };
  if (m.ok === false && m.detail) return { ok: false, detail: m.detail };
  return {
    ok: m.stale === 0,
    detail: m.stale === 0
      ? `${m.accounts} mailbox(es) syncing`
      : `${m.stale} of ${m.accounts} not synced in 30 min: ${m.stale_accounts.map((a) => `${a.name} (${a.last_sync_age_s ?? 'never'}s)`).join(', ')}`,
  };
}

async function checkResources() {
  const p = (await workers()).process;
  if (!p) return { ok: true, detail: 'not reported' };
  const problems = [];
  // Thresholds are deliberately loose: this is for a trend that has become a problem, not for a
  // busy minute. Node's default heap ceiling is around 1.5-4 GB depending on build.
  if (p.rss_mb > RSS_MB) problems.push(`memory ${p.rss_mb} MB (limit ${RSS_MB})`);
  if (p.cpu_percent_avg > CPU_PCT) problems.push(`sustained CPU ${p.cpu_percent_avg}% of one core (limit ${CPU_PCT})`);
  // Lag is measured on a single sample, so only a large value is meaningful — but a large value
  // means the event loop is blocked, which is every user seeing the whole app freeze at once.
  if (p.event_loop_lag_ms > 250) problems.push(`event loop blocked ${p.event_loop_lag_ms} ms`);
  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ')
      : `${p.rss_mb} MB rss, ${p.cpu_percent_avg}% cpu avg, loop lag ${p.event_loop_lag_ms} ms, up ${Math.round(p.uptime_s / 3600)}h`,
  };
}

const CHECKS = {
  liveness:   checkLiveness,
  readiness:  checkReadiness,
  error_rate: checkErrorRate,
  latency:    checkLatency,
  resources:  checkResources,
  schedulers: checkSchedulers,
  jobs:       checkJobs,
  audit:      checkAudit,
  mail_sync:  checkMailSync,
  backup:     checkBackup,
  disk:       checkDisk,
};

// ── alert routing ────────────────────────────────────────────────────────────────────────────────
// Environment only. See rule 1 at the top of this file.

async function notifyWebhook(subject, text) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return null;
  // `text` is what both Slack and Teams read, so one payload covers the common cases.
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `*${subject}*\n${text}` }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res.ok ? 'webhook sent' : `webhook failed HTTP ${res.status}`;
}

async function notifyEmail(subject, text) {
  const { ALERT_SMTP_HOST, ALERT_SMTP_PORT, ALERT_SMTP_USER, ALERT_SMTP_PASS, ALERT_EMAIL_TO, ALERT_EMAIL_FROM } = process.env;
  if (!ALERT_SMTP_HOST || !ALERT_EMAIL_TO) return null;
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(ALERT_SMTP_PORT ?? 587);
  const t = nodemailer.createTransport({
    host: ALERT_SMTP_HOST, port, secure: port === 465,
    auth: ALERT_SMTP_USER ? { user: ALERT_SMTP_USER, pass: ALERT_SMTP_PASS ?? '' } : undefined,
    connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS,
  });
  await t.sendMail({ from: ALERT_EMAIL_FROM ?? ALERT_SMTP_USER, to: ALERT_EMAIL_TO, subject, text });
  return `emailed ${ALERT_EMAIL_TO}`;
}

function notifyEventLog(subject, text, failing) {
  if (process.platform !== 'win32') return null;
  try {
    // Always written, even when a webhook succeeds: this is the record that survives on the machine
    // when the network is the thing that broke.
    execFileSync('powershell', ['-NoProfile', '-Command',
      `$s='TransactionDesk';if(-not [Diagnostics.EventLog]::SourceExists($s)){New-EventLog -LogName Application -Source $s};` +
      `Write-EventLog -LogName Application -Source $s -EventId 9001 -EntryType ${failing ? 'Error' : 'Information'} ` +
      `-Message ${JSON.stringify(`${subject}\n\n${text}`)}`], { timeout: TIMEOUT_MS, stdio: 'pipe' });
    return 'event log written';
  } catch (e) {
    // Creating an event source needs elevation the first time. Not fatal — say so and carry on.
    return `event log unavailable (${String(e.message).split('\n')[0].slice(0, 60)})`;
  }
}

async function pingHeartbeat(allOk) {
  const url = process.env.ALERT_HEARTBEAT_URL;
  if (!url || !allOk) return null;
  // Only on a fully healthy run: the external service alerts when pings STOP, which is what covers
  // this machine being switched off, and is the only check that survives that.
  try {
    await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return 'heartbeat pinged';
  } catch (e) { return `heartbeat ping failed (${e.name})`; }
}

async function dispatch(subject, text, failing, allOk) {
  const results = await Promise.allSettled([notifyWebhook(subject, text), notifyEmail(subject, text)]);
  const sent = results.map((r) => r.status === 'fulfilled' ? r.value : `send failed: ${r.reason?.message ?? r.reason}`).filter(Boolean);
  const ev = notifyEventLog(subject, text, failing);
  if (ev) sent.push(ev);
  const hb = await pingHeartbeat(allOk);
  if (hb) sent.push(hb);
  if (!sent.some((s) => /sent|emailed/.test(s))) {
    // This script deliberately does not load .env — it must keep working when the application does
    // not — so ALERT_* settings put there are silently ignored. That is an easy afternoon to lose,
    // so name it specifically rather than repeating the generic advice.
    let inDotEnv = false;
    try { inDotEnv = /^ALERT_/m.test(readFileSync(join(dirname(process.argv[1]), '..', '.env'), 'utf8')); } catch { /* no .env */ }
    sent.push(inDotEnv
      ? 'NO CHANNEL: ALERT_* found in server/.env, which this script does not read — it must keep '
        + 'working when the application cannot. Set them as machine environment variables instead.'
      : 'NO EXTERNAL CHANNEL CONFIGURED — set ALERT_WEBHOOK_URL or ALERT_SMTP_HOST/ALERT_EMAIL_TO');
  }
  return sent;
}

// ── state ────────────────────────────────────────────────────────────────────────────────────────

const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); };

// ── run ──────────────────────────────────────────────────────────────────────────────────────────

// ── --test-alert ─────────────────────────────────────────────────────────────────────────────────
// Sends one alert through every configured channel and exits. The point is to answer "is delivery
// actually wired up" without waiting for something to break — otherwise the first time anyone finds
// out the webhook URL had a typo is during the incident it was supposed to report.
if (has('test-alert')) {
  const subject = 'Transaction Desk: TEST ALERT (nothing is wrong)';
  const text = [
    'This is a test of alert delivery. No check has failed.',
    '',
    `Host ${process.env.COMPUTERNAME ?? 'unknown'} · checked ${URL_BASE} · ${new Date().toISOString()}`,
    'If you are reading this, alerts are reaching you and the monitor is wired up correctly.',
  ].join('\n');

  const sent = await dispatch(subject, text, false, false);
  console.log('  test alert dispatched:');
  for (const s of sent) console.log(`    ${s}`);
  const delivered = sent.some((s) => /sent|emailed/.test(s));
  console.log(delivered ? '\n  DELIVERED — check the destination.' : '\n  NOT DELIVERED — no external channel is configured.');
  process.exit(delivered ? 0 : 1);
}

const now = Date.now();
const prev = loadState();
const next = {};
const results = {};

for (const [name, fn] of Object.entries(CHECKS)) {
  try { results[name] = await fn(); }
  catch (e) { results[name] = { ok: false, detail: `check threw: ${e.message?.slice(0, 160) ?? e}` }; }
}

// One cause, one alert. If the process is not answering then readiness, error rate and latency
// cannot answer either — reporting four failures for one dead application buries the one line that
// says what to do. These are consequences of `liveness`, so they are folded into it rather than
// raised alongside it. Their real state is unknown, not healthy, so they are not marked ok: they
// are held at their previous state so that recovery still reports correctly.
if (!results.liveness.ok) {
  for (const dependent of ['readiness', 'error_rate', 'latency', 'resources', 'schedulers', 'jobs', 'mail_sync']) {
    results[dependent] = prev[dependent]?.ok === false
      ? { ...results[dependent], detail: `${results[dependent].detail} (application is down)` }
      : { ok: true, detail: 'not checked — application is down', suppressed: true };
  }
}

const newlyFailing = [], recovered = [], stillFailing = [];

for (const [name, r] of Object.entries(results)) {
  const was = prev[name];
  const wasOk = was?.ok !== false;
  next[name] = { ok: r.ok, detail: r.detail, since: r.ok === wasOk && was?.since ? was.since : new Date(now).toISOString(),
                 last_notified: was?.last_notified };

  if (!r.ok && wasOk) newlyFailing.push([name, r]);
  else if (r.ok && !wasOk) recovered.push([name, r]);
  else if (!r.ok) {
    const mins = was?.last_notified ? (now - new Date(was.last_notified).getTime()) / 60_000 : Infinity;
    if (mins >= REMIND_MIN) stillFailing.push([name, r]);
  }
}

const allOk = Object.values(results).every((r) => r.ok);
const line = ([n, r]) => `  ${r.suppressed ? '--  ' : r.ok ? 'OK  ' : 'FAIL'} ${n.padEnd(11)} ${r.detail}`;

for (const [n, r] of Object.entries(results)) console.log(line([n, r]));

let sent = [];
if (newlyFailing.length || stillFailing.length || recovered.length) {
  const failing = [...newlyFailing, ...stillFailing];
  // Everything still down, including checks whose slow reminder is not due. A message that says
  // "recovered (backup)" while the disk is still full reads as all-clear and is worse than silence,
  // so any outstanding failure is always restated whenever we are sending anything at all.
  const outstanding = Object.entries(results).filter(([n, r]) => !r.ok && !failing.some(([f]) => f === n));
  const down = [...failing, ...outstanding].map(([n]) => n);

  const subject = down.length
    ? `Transaction Desk: ${down.join(', ')} ${newlyFailing.length ? 'FAILING' : 'still failing'}`
      + (recovered.length ? ` (${recovered.map(([n]) => n).join(', ')} recovered)` : '')
    : `Transaction Desk: all clear (${recovered.map(([n]) => n).join(', ')} recovered)`;

  const text = [
    ...failing.map(([n, r]) => `FAILING  ${n}: ${r.detail}  (since ${next[n].since})`),
    ...recovered.map(([n, r]) => `RECOVERED  ${n}: ${r.detail}`),
    ...outstanding.map(([n, r]) => `STILL FAILING  ${n}: ${r.detail}  (since ${next[n].since})`),
    '',
    `Host ${process.env.COMPUTERNAME ?? 'unknown'} · checked ${URL_BASE} · ${new Date(now).toISOString()}`,
    down.length ? 'Runbook: docs/OPERATIONS.md' : '',
  ].filter(Boolean).join('\n');

  sent = await dispatch(subject, text, down.length > 0, allOk);
  // `outstanding` too: it was named in the message just sent, so its reminder clock restarts with
  // the others rather than firing again minutes later.
  for (const [n] of [...failing, ...outstanding]) next[n].last_notified = new Date(now).toISOString();
  for (const [n] of recovered) next[n].last_notified = undefined;
  console.log(`\n  ALERT: ${subject}`);
  for (const s of sent) console.log(`    ${s}`);
} else {
  const hb = await pingHeartbeat(allOk);
  if (hb) console.log(`\n  ${hb}`);
  if (!allOk) console.log('\n  still failing, reminder not yet due — no alert sent');
}

if (!has('once')) saveState(next);
process.exit(allOk ? 0 : 1);
