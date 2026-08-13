/**
 * Concurrent sign-in throughput — the 9 a.m. rush.
 *
 * Login is the one endpoint whose cost is CPU rather than a query: `bcryptjs` is pure JavaScript
 * with no native addon and no threadpool, so every verification runs on the Node event loop and
 * more cores do not help a single process. `ecosystem.config.cjs` records the topology this
 * implies. That measurement predates the tenancy removal, so this re-takes it against the current
 * build to confirm nothing about authentication got slower when the tenant lookup came out of it.
 *
 *   node scripts/measure-login-throughput.cjs --users 60 --concurrency 20
 */
const API = process.env.LOAD_API || 'http://localhost:8100';
const PASSWORD = process.env.LOAD_PASSWORD || 'TestPass123!';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const USERS = Number(arg('users', 60));
const CONC = Number(arg('concurrency', 20));

const collect = (headers, jar) => {
  for (const line of (headers.getSetCookie?.() ?? [])) {
    const [pair] = line.split(';'); const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
};
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function login(email) {
  const t = process.hrtime.bigint();
  const boot = await fetch(`${API}/sanctum/csrf-cookie`, { redirect: 'manual' });
  const jar = collect(boot.headers, {});
  const token = decodeURIComponent(jar['XSRF-TOKEN'] ?? '');
  const res = await fetch(`${API}/api/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-XSRF-TOKEN': token, Cookie: cookieHeader(jar) },
    body: JSON.stringify({ username: email, password: PASSWORD }),
  });
  await res.text();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, status: res.status };
}

const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

(async () => {
  const emails = Array.from({ length: USERS }, (_, i) => `load-agent-${i}@load.test`);
  console.log(`\n  ${USERS} sign-ins, ${CONC} at a time, against ${API}\n`);

  const ms = []; let ok = 0, failed = 0; const codes = {};
  const started = Date.now();
  for (let i = 0; i < emails.length; i += CONC) {
    const batch = emails.slice(i, i + CONC);
    const rs = await Promise.all(batch.map((e) => login(e).catch(() => ({ ms: 0, status: 0 }))));
    for (const r of rs) {
      codes[r.status] = (codes[r.status] ?? 0) + 1;
      if (r.status === 200) { ok++; ms.push(r.ms); } else failed++;
    }
  }
  const elapsed = (Date.now() - started) / 1000;

  console.log(`  succeeded ......... ${ok}`);
  console.log(`  failed ............ ${failed}   ${JSON.stringify(codes)}`);
  console.log(`  wall clock ........ ${elapsed.toFixed(1)}s`);
  console.log(`  throughput ........ ${(ok / elapsed).toFixed(1)} logins/s (single process)`);
  if (ms.length) {
    console.log(`  latency p50/p95/p99 ${Math.round(pct(ms, 0.5))} / ${Math.round(pct(ms, 0.95))} / ${Math.round(pct(ms, 0.99))} ms  max ${Math.round(Math.max(...ms))} ms`);
    console.log(`\n  500 agents at this rate: ${(500 / (ok / elapsed)).toFixed(0)}s on one process, `
      + `${(500 / (ok / elapsed) / 4).toFixed(0)}s across the four crm-web instances in ecosystem.config.cjs.`);
  }
  console.log('');
})().catch((e) => { console.error(e.message); process.exit(1); });
