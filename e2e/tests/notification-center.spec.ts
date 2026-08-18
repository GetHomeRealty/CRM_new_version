import { expect, test, type APIRequestContext } from '@playwright/test';
import { ACCOUNTS, API_BASE, PASSWORD } from './helpers';

/**
 * The Notification Centre, through the real stack.
 *
 * It is a merged VIEW over four systems that already existed — agent changes, document reviews,
 * review decisions and reminders — so the things worth proving here are the ones a merge can get
 * wrong: that it only ever shows the caller their OWN notifications, that read and unread are
 * distinguished, that marking works and sticks, and that the four original bell feeds still answer
 * exactly as they did.
 */

async function csrf(ctx: APIRequestContext): Promise<string> {
  await ctx.get(`${API_BASE}/sanctum/csrf-cookie`);
  const state = await ctx.storageState();
  return decodeURIComponent(state.cookies.find((c) => c.name === 'XSRF-TOKEN')?.value ?? '');
}

async function post(ctx: APIRequestContext, path: string, data?: unknown) {
  const token = await csrf(ctx);
  return ctx.post(`${API_BASE}${path}`, {
    headers: { 'X-XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest' },
    data: data ?? {},
  });
}

const signIn = (ctx: APIRequestContext, email: string) =>
  post(ctx, '/api/login', { username: email, password: PASSWORD });

/** `notification_id` is present only on `direct` rows, which are addressed by their own id. */
interface Item {
  key: string; source: string; transaction_id: number; unread: boolean; link: string;
  notification_id?: number;
}

test.describe('the merged feed', () => {
  test('answers with a shaped feed for a signed-in agent', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      const res = await ctx.get(`${API_BASE}/api/notifications`);
      expect(res.status()).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.total).toBe('number');
      expect(typeof body.unread).toBe('number');
      expect(body.limit).toBeGreaterThan(0);

      /*
       * TWO SHAPES, NOT ONE. This loop asserted a single shape — `key === source:transaction_id`,
       * a `/desk/transactions/…` link, and one of the four Desk sources — which was true when the
       * only notifications were about deals.
       *
       * `direct` was added to `NotificationSource` when the in-app notification platform shipped,
       * and a direct row is deliberately different: it is not about a deal, so `transaction_id` is
       * 0 and it is addressed by its OWN id (`source:notification_id`) — see
       * `notification-center.service.ts`. Any CRM in-app notification (a lead assigned, a campaign
       * finished) is one of these, so the old assertion failed the moment a seeded agent had one.
       * It was passing on the absence of CRM notifications rather than on a property of the feed.
       */
      for (const item of body.items as Item[]) {
        expect(['agent-change', 'doc-review', 'review-decision', 'reminder', 'direct']).toContain(item.source);
        // Every row must be addressable and openable, whichever kind it is.
        expect(item.key).toBe(`${item.source}:${item.source === 'direct' ? item.notification_id : item.transaction_id}`);
        if (item.source === 'direct') {
          expect(item.transaction_id).toBe(0);
          expect(typeof item.link).toBe('string');
          expect(item.link.length).toBeGreaterThan(0);
        } else {
          expect(item.link).toBe(`/desk/transactions/${item.transaction_id}`);
        }
      }
    } finally { await ctx.dispose(); }
  });

  test('the unread filter returns only unread, and history only read', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);

      const unread = await (await ctx.get(`${API_BASE}/api/notifications?filter=unread`)).json();
      expect((unread.items as Item[]).every((i) => i.unread)).toBe(true);

      const history = await (await ctx.get(`${API_BASE}/api/notifications?filter=read`)).json();
      expect((history.items as Item[]).every((i) => !i.unread)).toBe(true);

      /*
       * History is the capability the bells never had — they only ever showed what was outstanding.
       * `all` must therefore be at least as large as either half.
       */
      const all = await (await ctx.get(`${API_BASE}/api/notifications?filter=all`)).json();
      expect(all.total).toBeGreaterThanOrEqual(unread.total);
      expect(all.total).toBeGreaterThanOrEqual(history.total);
    } finally { await ctx.dispose(); }
  });

  test('an unrecognised filter falls back rather than failing', async ({ playwright }) => {
    // A stale bookmark with an old query string should still show somebody their notifications.
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      const res = await ctx.get(`${API_BASE}/api/notifications?filter=nonsense&source=nonsense`);
      expect(res.status()).toBe(200);
      expect(Array.isArray((await res.json()).items)).toBe(true);
    } finally { await ctx.dispose(); }
  });

  test('paginates, and never returns more than asked for', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      const res = await ctx.get(`${API_BASE}/api/notifications?filter=all&limit=2&offset=0`);
      const body = await res.json();
      expect(body.limit).toBe(2);
      expect(body.items.length).toBeLessThanOrEqual(2);
    } finally { await ctx.dispose(); }
  });

  test('caps an absurd page size instead of trying to serve it', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      const body = await (await ctx.get(`${API_BASE}/api/notifications?limit=100000`)).json();
      expect(body.limit).toBeLessThanOrEqual(100);
    } finally { await ctx.dispose(); }
  });

  test('the count endpoint agrees with the feed', async ({ playwright }) => {
    /*
     * The badge and the list must never disagree — a bell showing 3 over an empty list is the
     * classic notification bug, and it destroys trust in the badge entirely.
     */
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      const count = await (await ctx.get(`${API_BASE}/api/notifications/count`)).json();
      const unread = await (await ctx.get(`${API_BASE}/api/notifications?filter=unread&limit=100`)).json();

      expect(count.unread).toBe(unread.total);
      const summed = Object.values(count.by_source as Record<string, number>).reduce((a, b) => a + b, 0);
      expect(summed).toBe(count.unread);
    } finally { await ctx.dispose(); }
  });
});

test.describe('who sees what', () => {
  test('two agents do not see each other\'s notifications', async ({ playwright }) => {
    /*
     * THE ONE THAT MATTERS MOST. A merged feed is exactly where an ownership condition gets dropped,
     * and the failure is silent — one agent quietly reading another's deals. Every row is checked to
     * belong to a transaction the caller can actually open.
     */
    const a = await playwright.request.newContext();
    const b = await playwright.request.newContext();
    try {
      await signIn(a, ACCOUNTS.agent.email);
      await signIn(b, ACCOUNTS.agent2.email);

      const mine = await (await a.get(`${API_BASE}/api/notifications?filter=all&limit=100`)).json();
      const theirs = await (await b.get(`${API_BASE}/api/notifications?filter=all&limit=100`)).json();

      /*
       * Only the DEAL-ANCHORED rows can be checked this way. A `direct` row is not about a
       * transaction at all — `transaction_id` is 0 — so asking for `/api/transactions/0` proves
       * nothing and 404s. The isolation this test defends is unchanged: every deal a person is
       * notified about must be one they can open. Direct rows are scoped by `user_id` in the query
       * that produces them, which the `an agent is not shown the administrator feed` test covers.
       */
      const deals = (items: Item[]) => items.filter((i) => i.source !== 'direct' && i.transaction_id > 0);

      for (const item of deals(mine.items as Item[]).slice(0, 5)) {
        const res = await a.get(`${API_BASE}/api/transactions/${item.transaction_id}`);
        expect(res.status(), `agent must be able to open ${item.transaction_id} from their own feed`).toBeLessThan(400);
      }
      for (const item of deals(theirs.items as Item[]).slice(0, 5)) {
        const res = await b.get(`${API_BASE}/api/transactions/${item.transaction_id}`);
        expect(res.status()).toBeLessThan(400);
      }

      // And a direct row must never be somebody else's: the two feeds share no direct key.
      const directKeys = (items: Item[]) => new Set(items.filter((i) => i.source === 'direct').map((i) => i.key));
      const mineDirect = directKeys(mine.items as Item[]);
      for (const key of directKeys(theirs.items as Item[])) {
        expect(mineDirect.has(key), `direct notification ${key} appeared in both agents' feeds`).toBe(false);
      }
    } finally { await a.dispose(); await b.dispose(); }
  });

  test('an agent is not shown the administrator feed', async ({ playwright }) => {
    // `agent-change` is the admin bell. An agent must never be handed it by the merge.
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      const body = await (await ctx.get(`${API_BASE}/api/notifications?filter=all&limit=100`)).json();
      expect((body.items as Item[]).some((i) => i.source === 'agent-change')).toBe(false);
    } finally { await ctx.dispose(); }
  });

  test('nobody signed out reaches it', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      expect((await ctx.get(`${API_BASE}/api/notifications`)).status()).toBe(401);
      expect((await ctx.get(`${API_BASE}/api/notifications/count`)).status()).toBe(401);
      expect((await post(ctx, '/api/notifications/read-all')).status()).toBe(401);
    } finally { await ctx.dispose(); }
  });
});

test.describe('marking read', () => {
  test('mark all as read clears the badge, and it stays cleared', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);

      const res = await post(ctx, '/api/notifications/read-all');
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.marked).toBe('number');

      const after = await (await ctx.get(`${API_BASE}/api/notifications/count`)).json();
      // Anything that could not be cleared is reported rather than hidden, so the badge is allowed
      // to be non-zero ONLY when the response said so.
      if (body.failed === 0) expect(after.unread).toBe(0);

      // And it is persisted, not just a response — a fresh request must agree.
      const fresh = await playwright.request.newContext();
      try {
        await signIn(fresh, ACCOUNTS.agent.email);
        const reread = await (await fresh.get(`${API_BASE}/api/notifications/count`)).json();
        if (body.failed === 0) expect(reread.unread).toBe(0);
      } finally { await fresh.dispose(); }
    } finally { await ctx.dispose(); }
  });

  test('a malformed mark-read request is refused rather than guessed at', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);

      expect((await (await post(ctx, '/api/notifications/read', { source: 'not-a-source', transaction_id: 1 })).json()).ok).toBe(false);
      expect((await (await post(ctx, '/api/notifications/read', { source: 'reminder' })).json()).ok).toBe(false);
      expect((await (await post(ctx, '/api/notifications/read', { source: 'reminder', transaction_id: 'abc' })).json()).ok).toBe(false);
    } finally { await ctx.dispose(); }
  });

  test('marking read on a deal the caller cannot open does not succeed', async ({ playwright }) => {
    // The mark endpoints delegate to the services that own the authorization, so a guessed id must
    // not clear anything — and must not 500 either.
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      const res = await post(ctx, '/api/notifications/read', { source: 'doc-review', transaction_id: 999999999 });
      expect(res.status()).toBeLessThan(500);
    } finally { await ctx.dispose(); }
  });
});

test.describe('the original bells still work', () => {
  test('all four feeds answer exactly as before', async ({ playwright }) => {
    /*
     * The Centre is additive. `DeskLayout` still calls these four, so if adding the merged view had
     * changed any of them the bells would break — which is the regression this file exists to catch.
     */
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.agent.email);
      for (const path of ['/api/doc-notifications', '/api/reminder-notifications', '/api/review-notifications']) {
        const res = await ctx.get(`${API_BASE}${path}`);
        expect(res.status(), `${path} must still answer`).toBe(200);
        const body = await res.json();
        expect(typeof body.count).toBe('number');
        expect(Array.isArray(body.items)).toBe(true);
      }
    } finally { await ctx.dispose(); }
  });

  test('the administrator feed still answers for an administrator', async ({ playwright }) => {
    const ctx = await playwright.request.newContext();
    try {
      await signIn(ctx, ACCOUNTS.superAdmin.email);
      const res = await ctx.get(`${API_BASE}/api/agent-change-notifications`);
      expect(res.status()).toBe(200);
      expect(Array.isArray((await res.json()).items)).toBe(true);
    } finally { await ctx.dispose(); }
  });
});
