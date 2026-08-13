import { expect, test, type APIRequestContext } from '@playwright/test';
import { ACCOUNTS, API_BASE, PASSWORD } from './helpers';

/**
 * Audit Trail export, through the real HTTP stack.
 *
 * The file contents, filters, redaction and escaping are proved against real rows in
 * `server/src/audit-log/audit-export.spec.ts`. What only a request can show is the part that
 * matters operationally: that the endpoint is behind exactly the same authorization as the listing,
 * that it returns a real downloadable file with the right headers, and that a caller who cannot read
 * the trail cannot export it either.
 */

async function csrf(ctx: APIRequestContext): Promise<string> {
  await ctx.get(`${API_BASE}/sanctum/csrf-cookie`);
  const state = await ctx.storageState();
  return decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
}

async function signIn(ctx: APIRequestContext, email: string) {
  const token = await csrf(ctx);
  return ctx.post(`${API_BASE}/api/login`, {
    headers: { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' },
    data: { username: email, password: PASSWORD },
  });
}

test.describe('downloading the audit trail', () => {
  test('an administrator gets a CSV with download headers', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      const res = await ctx.get(`${API_BASE}/api/audit-logs/export?area=crm&format=csv`);

      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/csv');
      // Without this the browser renders the file instead of saving it.
      expect(res.headers()['content-disposition']).toContain('attachment');
      expect(res.headers()['content-disposition']).toMatch(/filename="crm-audit-.*\.csv"/);

      const text = (await res.body()).toString('utf8');
      expect(text).toContain('Date');
      expect(text).toContain('Action');
    } finally { await ctx.dispose(); }
  });

  test('and an Excel workbook', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      const res = await ctx.get(`${API_BASE}/api/audit-logs/export?area=crm&format=xlsx`);

      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('spreadsheetml');
      expect(res.headers()['content-disposition']).toMatch(/filename="crm-audit-.*\.xlsx"/);

      // A real .xlsx is a zip: it begins with the local file header signature "PK\x03\x04".
      const body = await res.body();
      expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(body.length).toBeGreaterThan(1000);
    } finally { await ctx.dispose(); }
  });

  test('reports how many rows it wrote', async ({ playwright }) => {
    // Read by the client so somebody can be told their export was cut short rather than handed a
    // file that looks complete.
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      const res = await ctx.get(`${API_BASE}/api/audit-logs/export?area=crm&format=csv`);

      expect(res.headers()['x-export-rows']).toBeDefined();
      expect(Number(res.headers()['x-export-rows'])).toBeGreaterThanOrEqual(0);
      expect(res.headers()['x-export-truncated']).toBe('0');
      // Custom headers are unreadable from JS unless exposed.
      expect(res.headers()['access-control-expose-headers']).toContain('Content-Disposition');
    } finally { await ctx.dispose(); }
  });

  test('an unrecognised format falls back to CSV rather than failing', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      const res = await ctx.get(`${API_BASE}/api/audit-logs/export?area=crm&format=pdf`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/csv');
    } finally { await ctx.dispose(); }
  });

  test('an invalid filter is refused, not silently ignored', async ({ playwright }) => {
    /*
     * The dangerous failure mode: falling back to "no filter" would hand somebody the whole trail
     * while they believed they had asked for one user's day.
     */
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      expect((await ctx.get(`${API_BASE}/api/audit-logs/export?area=crm&user_id=abc`)).status()).toBe(400);
      expect((await ctx.get(`${API_BASE}/api/audit-logs/export?area=crm&from=garbage`)).status()).toBe(400);
    } finally { await ctx.dispose(); }
  });
});

test.describe('who may export', () => {
  test('the export is guarded exactly like the listing', async ({ playwright }) => {
    /*
     * THE ASSERTION THAT MATTERS. Whoever is refused the trail must be refused the file — hiding the
     * button would not be enough, and the button is not what stops anybody.
     */
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);

      const listing = await ctx.get(`${API_BASE}/api/audit-logs?area=crm`);
      const exporting = await ctx.get(`${API_BASE}/api/audit-logs/export?area=crm&format=csv`);

      // Whatever the listing answers, the export must answer the same way.
      expect(exporting.status()).toBe(listing.status());
      if (listing.status() !== 200) {
        expect([401, 403]).toContain(exporting.status());
      }
    } finally { await ctx.dispose(); }
  });

  test('nobody signed out can export', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      expect((await ctx.get(`${API_BASE}/api/audit-logs/export?area=crm&format=csv`)).status()).toBe(401);
    } finally { await ctx.dispose(); }
  });
});
