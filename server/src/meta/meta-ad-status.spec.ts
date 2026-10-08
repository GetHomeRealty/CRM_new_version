import { MetaAdStatusService, formStatus, formIdsInCreative, describeAd } from './meta-ad-status.service';
import { MetaGraphService, GraphError, type GraphAd, type GraphAdAccount } from './meta-graph.service';
import type { MetaConnectionService } from './meta-connection.service';
import type { MetaApiBudgetService } from './meta-api-budget.service';

/**
 * ADVERTISING STATUS FOR LEAD FORMS — from Meta's ads, matched by form id, never inferred.
 *
 * Meta is faked throughout: no request leaves this process, and no ad can be touched. The Graph
 * service's own calls are checked against a stubbed `fetch` to prove they only ever GET.
 *
 * "Enabled" is Meta's status plus the schedule checks — not proof of delivery — and anything the scan
 * could not fully see turns "No ads found" and "Not enabled" into Unknown with the reason.
 */

const FORM_A = '1111111111';
const FORM_B = '2222222222';
const FORM_C = '3333333333';
const leadCreative = (formId: string) => ({ object_story_spec: { link_data: { call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: formId } } } } });
const ad = (id: string, status: string, formId: string | null, extra: Partial<GraphAd> = {}): GraphAd => ({
  id, name: `Ad ${id}`, effective_status: status,
  adset: { id: `as-${id}`, name: `Ad set ${id}` },
  campaign: { id: `c-${id}`, name: `Campaign ${id}`, objective: 'OUTCOME_LEADS' },
  creative: formId ? leadCreative(formId) : { object_story_spec: { link_data: { link: 'https://example.test' } } },
  ...extra,
});

type Accounts = { accounts: GraphAdAccount[]; truncated?: boolean } | Error;
type AdsAnswer = GraphAd[] | Error | { ads: GraphAd[]; archivedIncluded: boolean };
interface Conn { id: number; token: string; connected_at: Date; scopes: string }

function setup(opts: { scopes?: string; accounts: Accounts; ads: Record<string, AdsAnswer>; budget?: boolean }) {
  const calls: string[] = [];
  const conn: { current: Conn | null } = {
    current: { id: 1, token: 'user-token', connected_at: new Date('2026-10-01T00:00:00Z'), scopes: opts.scopes ?? 'pages_show_list,leads_retrieval,ads_read' },
  };
  const graph = {
    readableAdAccounts: jest.fn(async () => {
      calls.push('accounts');
      if (opts.accounts instanceof Error) throw opts.accounts;
      return { accounts: opts.accounts.accounts, truncated: opts.accounts.truncated ?? false };
    }),
    adsInAccount: jest.fn(async (accountId: string) => {
      calls.push(`ads:${accountId}`);
      const v = opts.ads[accountId];
      if (v instanceof Error) throw v;
      if (v && !Array.isArray(v)) return { ads: v.ads, truncated: false, archivedIncluded: v.archivedIncluded };
      return { ads: v ?? [], truncated: false, archivedIncluded: true };
    }),
  } as unknown as MetaGraphService;
  const connections = {
    find: jest.fn(async () => (conn.current ? { id: conn.current.id, token: conn.current.token, connected_at: conn.current.connected_at, pages: [] } : null)),
    meta: jest.fn(async () => (conn.current ? { granted_scopes: conn.current.scopes } : null)),
  } as unknown as MetaConnectionService;
  const budget = {
    consume: jest.fn(async () => ({ allowed: opts.budget !== false, spent: 1, limit: 600, resetInSeconds: 120 })),
  } as unknown as MetaApiBudgetService;
  return { svc: new MetaAdStatusService(connections, graph, budget), graph, calls, conn, budget };
}
const ACC1: GraphAdAccount = { id: 'act_1', name: 'Main account', account_status: 1 };
const ACC2: GraphAdAccount = { id: 'act_2', name: 'Second account', account_status: 1 };

describe('matching ads to forms', () => {
  it('finds the form id wherever the creative nests it, and nothing else', () => {
    expect(formIdsInCreative(leadCreative(FORM_A))).toEqual([FORM_A]);
    expect(formIdsInCreative({ asset_feed_spec: { call_to_actions: [{ value: { lead_gen_form_id: FORM_B } }] } })).toEqual([FORM_B]);
    expect(formIdsInCreative({ object_story_spec: { video_data: { call_to_action: { value: { lead_gen_form_id: 3333333333 } } } } })).toEqual([FORM_C]);
    expect(formIdsInCreative({ object_story_spec: { link_data: { name: FORM_A, message: 'lead_gen_form_id' } } })).toEqual([]);
    expect(formIdsInCreative(undefined)).toEqual([]);
  });

  it('never matches by name — a campaign named after the form is not its ad', async () => {
    const { svc } = setup({
      accounts: { accounts: [ACC1] },
      ads: { act_1: [ad('9', 'ACTIVE', FORM_B, { name: 'USA Vishnu Maheshwaram Leads', campaign: { id: 'c9', name: 'USA Vishnu Maheshwaram Leads', objective: 'OUTCOME_LEADS' } })] },
    });
    const scan = await svc.scanFor(1, true);
    expect(formStatus(scan, FORM_A).state).toBe('no_ads');
    expect(formStatus(scan, FORM_B).state).toBe('enabled');
  });
});

describe('"Enabled": Meta status and schedule, including paused parents', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  it.each([
    ['CAMPAIGN_PAUSED', {}, 'Paused (campaign)', false],
    ['ADSET_PAUSED', {}, 'Paused (ad set)', false],
    ['PAUSED', {}, 'Paused', false],
    ['DISAPPROVED', {}, 'Disapproved', false],
    ['ARCHIVED', {}, 'Archived', false],
    ['ACTIVE', { adset: { id: 'x', end_time: '2026-10-01T00:00:00Z' } }, 'Ended (ad set schedule)', false],
    ['ACTIVE', { campaign: { id: 'x', stop_time: '2026-10-01T00:00:00Z' } }, 'Ended (campaign schedule)', false],
    ['ACTIVE', { adset: { id: 'x', start_time: '2026-11-01T00:00:00Z' } }, 'Scheduled, not started', false],
    ['ACTIVE', {}, 'Enabled', true],
  ])('%s %j reads as "%s"', (status, extra, label, enabled) => {
    expect(describeAd({ id: '1', effective_status: status, ...(extra as Partial<GraphAd>) }, ACC1, now)).toEqual({ label, enabled });
  });

  it('never says "Running" — the word claims delivery, which these fields cannot show', () => {
    expect(describeAd({ id: '1', effective_status: 'ACTIVE' }, ACC1, now).label).not.toMatch(/running|deliver/i);
  });

  it('an active ad in an ad account that is not active is not enabled', () => {
    expect(describeAd({ id: '1', effective_status: 'ACTIVE' }, { id: 'act_9', account_status: 2 }, now))
      .toEqual({ label: 'Ad account not active (Meta status 2)', enabled: false });
  });

  it('a form whose only ad sits in a paused campaign is not enabled, and says why', async () => {
    const { svc } = setup({ accounts: { accounts: [ACC1] }, ads: { act_1: [ad('1', 'CAMPAIGN_PAUSED', FORM_A)] } });
    const s = formStatus(await svc.scanFor(1, true), FORM_A);
    expect(s).toMatchObject({ state: 'not_enabled', summary: 'Not enabled · 1 ad: Paused (campaign)' });
    expect(s.ads[0]).toMatchObject({ effective_status: 'CAMPAIGN_PAUSED', enabled: false, campaign_name: 'Campaign 1' });
  });
});

describe('forms used by several ads', () => {
  it('summarises, and lists every ad with its own status', async () => {
    const { svc } = setup({
      accounts: { accounts: [ACC1, ACC2] },
      ads: {
        act_1: [ad('1', 'ACTIVE', FORM_A), ad('2', 'ADSET_PAUSED', FORM_A)],
        act_2: [ad('3', 'CAMPAIGN_PAUSED', FORM_A), ad('4', 'ADSET_PAUSED', FORM_B), ad('5', 'CAMPAIGN_PAUSED', FORM_B)],
      },
    });
    const scan = await svc.scanFor(1, true);
    const a = formStatus(scan, FORM_A);
    expect(a).toMatchObject({ state: 'enabled', summary: 'Enabled · 1 of 3 ads' });
    expect(a.ads.map((x) => [x.ad_id, x.label, x.account_name])).toEqual([
      ['1', 'Enabled', 'Main account'], ['2', 'Paused (ad set)', 'Main account'], ['3', 'Paused (campaign)', 'Second account'],
    ]);
    expect(formStatus(scan, FORM_B)).toMatchObject({ state: 'not_enabled', summary: 'Not enabled · 2 ads: Paused (ad set), Paused (campaign)' });
  });

  it('one ad naming two forms counts for both', async () => {
    const both = { asset_feed_spec: { call_to_actions: [{ value: { lead_gen_form_id: FORM_A } }, { value: { lead_gen_form_id: FORM_B } }] } };
    const { svc } = setup({ accounts: { accounts: [ACC1] }, ads: { act_1: [ad('1', 'ACTIVE', null, { creative: both })] } });
    const scan = await svc.scanFor(1, true);
    expect(formStatus(scan, FORM_A).state).toBe('enabled');
    expect(formStatus(scan, FORM_B).state).toBe('enabled');
  });
});

describe('coverage: archived ads, and what happens when it is incomplete', () => {
  it('an archived ad is reported as archived, not as "no ads"', async () => {
    const { svc } = setup({ accounts: { accounts: [ACC1] }, ads: { act_1: [ad('1', 'ARCHIVED', FORM_A)] } });
    expect(formStatus(await svc.scanFor(1, true), FORM_A)).toMatchObject({ state: 'not_enabled', summary: 'Not enabled · 1 ad: Archived' });
  });

  it('archived ads refused by Meta: "No ads found" and "Not enabled" become Unknown, "Enabled" stays', async () => {
    const { svc } = setup({
      accounts: { accounts: [ACC1] },
      ads: { act_1: { ads: [ad('1', 'ACTIVE', FORM_A), ad('2', 'PAUSED', FORM_B)], archivedIncluded: false } },
    });
    const scan = await svc.scanFor(1, true);
    expect(formStatus(scan, FORM_A).state).toBe('enabled');
    const b = formStatus(scan, FORM_B);
    expect(b.state).toBe('unknown');
    expect(b.reason).toMatch(/refused the request for archived ads in Main account/);
    const c = formStatus(scan, FORM_C);
    expect(c.state).toBe('unknown');
    expect(c.reason).toMatch(/archived ads/);
  });

  it('a list cut short at the cap is incomplete too', async () => {
    const { svc } = setup({ accounts: { accounts: [ACC1], truncated: true }, ads: { act_1: [] } });
    const s = formStatus(await svc.scanFor(1, true), FORM_A);
    expect(s.state).toBe('unknown');
    expect(s.reason).toMatch(/only the first 25 ad accounts/);
  });
});

describe('unknown, with the reason — never a guess', () => {
  it('ads_read not granted: unknown, and Meta is not asked at all', async () => {
    const { svc, calls } = setup({ scopes: 'pages_show_list,pages_read_engagement,leads_retrieval', accounts: { accounts: [ACC1] }, ads: {} });
    const s = formStatus(await svc.scanFor(1, true), FORM_A);
    expect(s.state).toBe('unknown');
    expect(s.reason).toMatch(/ads_read/);
    expect(s.reason).toMatch(/reconnect/i);
    expect(calls).toEqual([]);
  });

  it('Meta refuses the ad accounts (permission error): unknown with Meta\'s message', async () => {
    const { svc } = setup({ accounts: new GraphError('(#200) Requires ads_read permission', 403, 200), ads: {} });
    const s = formStatus(await svc.scanFor(1, true), FORM_A);
    expect(s.state).toBe('unknown');
    expect(s.reason).toContain('Requires ads_read permission');
  });

  it('an expired login: unknown, telling them to reconnect', async () => {
    const { svc } = setup({ accounts: new GraphError('Session has expired', 401, 190), ads: {} });
    expect(formStatus(await svc.scanFor(1, true), FORM_A).reason).toMatch(/Reconnect Meta/);
  });

  it('no readable ad accounts: unknown, not "no ads"', async () => {
    const { svc } = setup({ accounts: { accounts: [] }, ads: {} });
    const s = formStatus(await svc.scanFor(1, true), FORM_A);
    expect(s.state).toBe('unknown');
    expect(s.reason).toMatch(/cannot see any ad accounts/);
  });

  it('one account fails: an enabled ad elsewhere still counts; an otherwise-quiet form becomes unknown', async () => {
    const { svc } = setup({
      accounts: { accounts: [ACC1, ACC2] },
      ads: { act_1: [ad('1', 'ACTIVE', FORM_A), ad('2', 'PAUSED', FORM_B)], act_2: new GraphError('An unknown error occurred', 500, 1) },
    });
    const scan = await svc.scanFor(1, true);
    expect(formStatus(scan, FORM_A).state).toBe('enabled');
    const b = formStatus(scan, FORM_B);
    expect(b.state).toBe('unknown');
    expect(b.reason).toMatch(/Second account could not be read/);
    expect(b.reason).toMatch(/Paused/);
    expect(formStatus(scan, FORM_C).state).toBe('unknown');
  });

  it('a lead ad whose creative names no form keeps "no ads found" from being claimed', async () => {
    const { svc } = setup({ accounts: { accounts: [ACC1] }, ads: { act_1: [ad('1', 'ACTIVE', null)] } });
    const s = formStatus(await svc.scanFor(1, true), FORM_A);
    expect(s.state).toBe('unknown');
    expect(s.reason).toMatch(/did not name a form/);
  });

  it('a non-lead ad without a form does not make anything unknown', async () => {
    const { svc } = setup({
      accounts: { accounts: [ACC1] },
      ads: { act_1: [ad('1', 'ACTIVE', null, { campaign: { id: 'c', name: 'Traffic', objective: 'OUTCOME_TRAFFIC' } })] },
    });
    expect(formStatus(await svc.scanFor(1, true), FORM_A).state).toBe('no_ads');
  });

  it('the shared request allowance is spent: unknown, and not remembered', async () => {
    const { svc, calls } = setup({ accounts: { accounts: [ACC1] }, ads: {}, budget: false });
    expect(formStatus(await svc.scanFor(1, false), FORM_A).reason).toMatch(/allowance/);
    expect(calls).toEqual([]);
  });

  it('charges the allowance for both reads of every account', async () => {
    const { svc, budget } = setup({ accounts: { accounts: [ACC1, ACC2] }, ads: {} });
    await svc.scanFor(1, true);
    expect((budget.consume as jest.Mock).mock.calls.map((c) => c[0])).toEqual([1, 4]);
  });
});

describe('last checked, refresh, and a connection that changes', () => {
  it('serves the last check until refreshed, then reads again', async () => {
    const { svc, graph } = setup({ accounts: { accounts: [ACC1] }, ads: { act_1: [ad('1', 'ACTIVE', FORM_A)] } });
    const first = await svc.scanFor(7, false);
    const again = await svc.scanFor(7, false);
    expect(again.checked_at).toBe(first.checked_at);
    expect(graph.readableAdAccounts).toHaveBeenCalledTimes(1);
    await svc.scanFor(7, true);
    expect(graph.readableAdAccounts).toHaveBeenCalledTimes(2);
  });

  it('disconnecting drops the cached answer at once — nothing from the old login is served', async () => {
    const { svc, conn, graph } = setup({ accounts: { accounts: [ACC1] }, ads: { act_1: [ad('1', 'ACTIVE', FORM_A)] } });
    expect(formStatus(await svc.scanFor(7, false), FORM_A).state).toBe('enabled');
    conn.current = null;
    const after = formStatus(await svc.scanFor(7, false), FORM_A);
    expect(after).toMatchObject({ state: 'unknown', reason: 'Meta is not connected.' });
    expect(graph.readableAdAccounts).toHaveBeenCalledTimes(1);
  });

  it('reconnecting (a new token) reads again instead of serving the old login\'s answer', async () => {
    const { svc, conn, graph } = setup({ accounts: { accounts: [ACC1] }, ads: { act_1: [ad('1', 'ACTIVE', FORM_A)] } });
    await svc.scanFor(7, false);
    conn.current = { ...conn.current!, token: 'new-token', connected_at: conn.current!.connected_at };
    await svc.scanFor(7, false);
    expect(graph.readableAdAccounts).toHaveBeenCalledTimes(2);
  });

  it('disconnect then reconnect — even with the same row — reads again', async () => {
    const { svc, conn, graph } = setup({ accounts: { accounts: [ACC1] }, ads: {} });
    const before = conn.current!;
    await svc.scanFor(7, false);
    conn.current = null;
    await svc.scanFor(7, false);
    conn.current = before;
    await svc.scanFor(7, false);
    expect(graph.readableAdAccounts).toHaveBeenCalledTimes(2);
  });

  it('a permission change (granted scopes rewritten) reads again: "missing permission" does not linger', async () => {
    const { svc, conn, graph } = setup({ scopes: 'pages_show_list,leads_retrieval', accounts: { accounts: [ACC1] }, ads: { act_1: [ad('1', 'ACTIVE', FORM_A)] } });
    expect(formStatus(await svc.scanFor(7, false), FORM_A).reason).toMatch(/not granted ads_read/);
    expect(graph.readableAdAccounts).not.toHaveBeenCalled();
    conn.current = { ...conn.current!, scopes: 'pages_show_list,leads_retrieval,ads_read' };
    expect(formStatus(await svc.scanFor(7, false), FORM_A).state).toBe('enabled');
    // …and the other way: ads_read withdrawn
    conn.current = { ...conn.current!, scopes: 'pages_show_list,leads_retrieval' };
    expect(formStatus(await svc.scanFor(7, false), FORM_A).state).toBe('unknown');
  });

  it('one person\'s cached answer is never served to another', async () => {
    const { svc, graph } = setup({ accounts: { accounts: [ACC1] }, ads: {} });
    await svc.scanFor(7, false);
    await svc.scanFor(8, false);
    expect(graph.readableAdAccounts).toHaveBeenCalledTimes(2);
  });
});

describe('the Graph calls are read-only and cover live and archived ads', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  type Seen = { url: URL; method: string; auth: string };
  const stub = (answer: (u: URL) => { status?: number; body: unknown }): Seen[] => {
    const seen: Seen[] = [];
    global.fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ url, method: init?.method ?? 'GET', auth: String((init?.headers as Record<string, string>)?.Authorization ?? '') });
      const { status = 200, body } = answer(url);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return seen;
  };

  it('live ads unfiltered (following the cursor), then archived ads by the one documented value — GET only', async () => {
    const seen = stub((u) => {
      if (u.pathname.endsWith('/me/adaccounts')) return { body: { data: [{ id: 'act_1', name: 'A', account_status: 1 }] } };
      if (u.searchParams.get('effective_status') === '["ARCHIVED"]') return { body: { data: [{ id: '3', effective_status: 'ARCHIVED' }, { id: '1', effective_status: 'ACTIVE' }] } };
      if (u.searchParams.get('after') === 'p2') return { body: { data: [{ id: '2', effective_status: 'CAMPAIGN_PAUSED' }] } };
      return { body: { data: [{ id: '1', effective_status: 'ACTIVE' }], paging: { next: 'https://graph.facebook.com/v21.0/act_1/ads?after=p2' } } };
    });
    const g = new MetaGraphService();
    expect((await g.readableAdAccounts('tok', 25)).accounts).toHaveLength(1);
    const res = await g.adsInAccount('act_1', 'tok', 1000);
    expect(res.ads.map((a) => a.id)).toEqual(['1', '2', '3']);   // de-duplicated
    expect(res.archivedIncluded).toBe(true);
    const adCalls = seen.filter((s) => s.url.pathname.endsWith('/ads'));
    expect(adCalls[0].url.searchParams.has('effective_status')).toBe(false);
    expect(adCalls.at(-1)!.url.searchParams.get('effective_status')).toBe('["ARCHIVED"]');
    expect(seen.every((s) => s.method === 'GET')).toBe(true);
    expect(seen.every((s) => s.auth === 'Bearer tok' && !s.url.search.includes('access_token'))).toBe(true);
  });

  it('archived filter refused (code 100): live ads kept, archivedIncluded false', async () => {
    stub((u) => (u.searchParams.has('effective_status')
      ? { status: 400, body: { error: { message: '(#100) Param effective_status[0] must be one of {ACTIVE, PAUSED}', code: 100 } } }
      : { body: { data: [{ id: '1', effective_status: 'ACTIVE' }] } }));
    expect(await new MetaGraphService().adsInAccount('act_1', 'tok', 1000)).toMatchObject({ archivedIncluded: false, ads: [{ id: '1' }] });
  });

  it('any other failure of the archived read is not swallowed', async () => {
    stub((u) => (u.searchParams.has('effective_status')
      ? { status: 500, body: { error: { message: 'An unknown error occurred', code: 1 } } }
      : { body: { data: [] } }));
    await expect(new MetaGraphService().adsInAccount('act_1', 'tok', 1000)).rejects.toThrow('An unknown error occurred');
  });
});
