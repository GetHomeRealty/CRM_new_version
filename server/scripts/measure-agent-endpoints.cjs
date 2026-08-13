/**
 * Time the CRM's heaviest read endpoints for a NAMED agent, so book size is a controlled variable.
 *
 * WHY THIS EXISTS ALONGSIDE load-test.cjs. That harness signs in a fixed pool (`load-agent-0..39`)
 * and appends `agent@test.local` as "the heaviest book". At the seed size it was written for that
 * meant ~9,800 leads; at 2.5M the same account holds 300,005, which is sixty times the ~5,000 a
 * real agent is expected to carry. Reporting those numbers as production latency would overstate
 * the cost of every screen. This measures whichever agent you name, so the result can be read
 * against a book size you chose.
 *
 *   node scripts/measure-agent-endpoints.cjs --agent load-agent-71@load.test --rounds 8
 */
const API = process.env.LOAD_API || 'http://localhost:8100';
const PASSWORD = process.env.LOAD_PASSWORD || 'TestPass123!';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const AGENT = arg('agent', 'agent@test.local');
const ROUNDS = Number(arg('rounds', 8));

const collect = (headers, jar) => {
  for (const line of (headers.getSetCookie?.() ?? [])) {
    const [pair] = line.split(';'); const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
};
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function signIn(email) {
  const boot = await fetch(`${API}/sanctum/csrf-cookie`, { redirect: 'manual' });
  let jar = collect(boot.headers, {});
  const token = decodeURIComponent(jar['XSRF-TOKEN'] ?? '');
  const res = await fetch(`${API}/api/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-XSRF-TOKEN': token, Cookie: cookieHeader(jar) },
    body: JSON.stringify({ username: email, password: PASSWORD }),
  });
  if (res.status >= 400) throw new Error(`login failed for ${email}: ${res.status}`);
  jar = collect(res.headers, jar);
  return { cookie: cookieHeader(jar), token: decodeURIComponent(jar['XSRF-TOKEN'] ?? token) };
}

async function timeIt(s, path) {
  const t = process.hrtime.bigint();
  const r = await fetch(`${API}${path}`, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-XSRF-TOKEN': s.token, Cookie: s.cookie } });
  await r.text();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, status: r.status };
}

const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

(async () => {
  const s = await signIn(AGENT);
  const me = await (await fetch(`${API}/api/user`, { headers: { Accept: 'application/json', Cookie: s.cookie } })).json();
  console.log(`\nagent: ${AGENT}  (user #${me?.id ?? me?.user?.id ?? '?'})  ${ROUNDS} rounds, serial\n`);

  const ENDPOINTS = [
    ['leads list page 1 (+stat counters)', '/api/leads?page=1&limit=50'],
    ['leads list page 5',                  '/api/leads?page=5&limit=50'],
    ['leads search "smith"',               '/api/leads?search=smith&limit=50'],
    ['leads filtered (status+source)',     '/api/leads?leadStatus=hot&leadSource=meta&limit=50'],
    ['lead tags',                          '/api/leads/tags'],
    ['lead options',                       '/api/leads/options'],
    ['lead tasks feed',                    '/api/leads/tasks'],
    ['CRM dashboard',                      '/api/dashboard/crm'],
    ['inbox: mail accounts',               '/api/account/mail-accounts?area=crm'],
    ['inbox: message list',                '/api/account/inbox?area=crm&limit=25'],
  ];

  console.log('  endpoint                                 p50     p95     max  status');
  console.log('  ' + '-'.repeat(72));
  for (const [label, path] of ENDPOINTS) {
    const ms = []; let status = 0;
    for (let i = 0; i < ROUNDS; i++) { const r = await timeIt(s, path); ms.push(r.ms); status = r.status; }
    const f = (n) => String(Math.round(n)).padStart(6);
    console.log(`  ${label.padEnd(38)}${f(pct(ms, 0.5))}${f(pct(ms, 0.95))}${f(Math.max(...ms))}    ${status}`);
  }
  console.log('');
})().catch((e) => { console.error(e.message); process.exit(1); });
