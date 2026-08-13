import { GoogleService, AUTH_PROMPT } from './google.service';
import { GooglePublicController } from './google-public.controller';
import { GoogleStateService } from './google-state.service';
import { AUTH_URL, MAIL_OAUTH_SCOPES, OAUTH_SCOPES, isMailConfigured } from './google.constants';

/**
 * The Google account picker, for both the Calendar connect and the Gmail connect.
 *
 * WHAT WAS WRONG. Both flows sent `prompt=consent` and nothing else. `consent` forces the
 * permissions screen; it does not ask for the CHOOSER. Google therefore skipped straight to
 * whichever account the browser was already signed in as, and an agent with a personal Gmail and a
 * brokerage Workspace account had no way to say which one they meant — the picker, and the "Use
 * another account" entry underneath it, never appeared. Adding `select_account` is the whole fix.
 *
 * This was NOT a regression. Every commit in this repository's history sends `prompt=consent`
 * alone, so the picker had never been requested; the belief that it was lost in a later change does
 * not survive `git log -S select_account`, which finds nothing.
 *
 * WHY THERE WAS NO TEST TO CATCH IT. There was no coverage of the authorization URL at all — not
 * one assertion on the string this application sends people to. Everything below the handshake was
 * well covered (`crm-desk-isolation.spec.ts` alone pins the two-area rules), which is exactly why
 * the gap survived: the parts with tests were right.
 *
 * Nothing here reaches Google. The URL is a pure function of configuration, and the callback is
 * driven with hand-built fakes.
 */

const ENV = { ...process.env };
beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://crm.example.com/api/google/callback';
  process.env.FRONTEND_URL = 'https://crm.example.com';
  process.env.APP_KEY = 'state-signing-key-for-tests';
});
afterEach(() => { process.env = { ...ENV }; });

const svc = () => new GoogleService();
const REDIRECT = 'https://crm.example.com/api/google/callback';

/** Both flows, so nothing below can be fixed for one and left broken for the other. */
const FLOWS: ReadonlyArray<{ name: string; url: () => string; scopes: readonly string[] }> = [
  { name: 'Google Calendar', url: () => svc().authUrl('state-abc', REDIRECT), scopes: OAUTH_SCOPES },
  { name: 'Google Mail', url: () => svc().mailAuthUrl('state-abc', REDIRECT), scopes: MAIL_OAUTH_SCOPES },
];

describe.each(FLOWS)('$name — the authorization URL', ({ url, scopes }) => {
  const params = () => new URL(url()).searchParams;

  it('asks Google for the account picker', () => {
    // The requirement in one assertion: `select_account` is what renders the list of accounts
    // already signed in on this browser, with "Use another account" beneath it.
    expect(params().get('prompt')?.split(' ')).toContain('select_account');
  });

  it('still asks for consent, so a refresh token is issued', () => {
    /*
     * Not cosmetic, and the reason `select_account` was ADDED rather than substituted. With
     * `access_type=offline` Google returns a refresh token only on an authorization that actually
     * shows the consent screen. Both `GoogleConnectionService.save` and `GmailConnectService.upsert`
     * keep an existing refresh token when Google omits one, so dropping `consent` would look fine
     * on a reconnect and fail where there is no prior row to inherit from — the same Google account
     * being connected to the OTHER area, which would then have no way to refresh after an hour.
     */
    expect(params().get('prompt')?.split(' ')).toContain('consent');
    expect(params().get('access_type')).toBe('offline');
  });

  it('does not force a signed-in account back through a login screen', () => {
    // `prompt=login` would make Google re-authenticate — a password prompt for somebody already
    // signed in, which is the specific experience being complained about.
    expect(params().get('prompt')?.split(' ')).not.toContain('login');
  });

  it('does not pin the flow to one account', () => {
    // `login_hint` pre-selects an address and suppresses the chooser; `hd` restricts it to a single
    // hosted domain, which would hide an agent's personal Gmail. Neither has any business here.
    expect(params().get('login_hint')).toBeNull();
    expect(params().get('hd')).toBeNull();
  });

  it('sends the user to Google itself, not to a screen of ours', () => {
    const u = new URL(url());
    expect(`${u.origin}${u.pathname}`).toBe(AUTH_URL);
    expect(u.origin).toBe('https://accounts.google.com');
  });

  it('carries the signed state and asks for an authorization code', () => {
    expect(params().get('state')).toBe('state-abc');
    expect(params().get('response_type')).toBe('code');
    expect(params().get('redirect_uri')).toBe(REDIRECT);
    expect(params().get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
  });

  it('requests exactly its own scopes', () => {
    expect(params().get('scope')?.split(' ').sort()).toEqual([...scopes].sort());
  });
});

describe('the two flows ask for different things', () => {
  it('Calendar does not request mailbox access, and Mail does not request the calendar', () => {
    // They share `GoogleService`, so a change to one is a change to both unless the scopes keep
    // them apart. This is the assertion that would fail if someone unified the two URL builders.
    const cal = new URL(svc().authUrl('s', REDIRECT)).searchParams.get('scope') ?? '';
    const mail = new URL(svc().mailAuthUrl('s', REDIRECT)).searchParams.get('scope') ?? '';

    expect(cal).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(cal).not.toContain('https://mail.google.com/');
    expect(mail).toContain('https://mail.google.com/');
    expect(mail).not.toContain('calendar.events');
  });

  it('both use the one shared prompt, so neither can drift from the other', () => {
    const promptOf = (u: string) => new URL(u).searchParams.get('prompt');
    expect(promptOf(svc().authUrl('s', REDIRECT))).toBe(AUTH_PROMPT);
    expect(promptOf(svc().mailAuthUrl('s', REDIRECT))).toBe(AUTH_PROMPT);
  });
});

/**
 * The Gmail connect on its own Google Cloud project.
 *
 * WHY. The name on every Google screen — "Choose an account to continue to X", "X wants to access
 * your Google Account" — is the consent screen's App name, which belongs to the PROJECT. It is not
 * a request parameter, so no code can set it per flow. With one project, an agent connecting a
 * mailbox was asked to let "Calendar-integration" read, compose, send and permanently delete all
 * their email. A second project is the only way to name that screen for mail.
 *
 * WHAT MAKES IT DANGEROUS, and what these tests are really for: a token belongs to the client that
 * issued it. Authorize with the mail client and refresh with the calendar client and the mailbox
 * connects, works for an hour, then fails permanently. So the choice has to be identical at all
 * four points in a mailbox's life — authorize, exchange, IMAP refresh, SMTP refresh.
 */
describe('the Gmail connect can run on its own Google project', () => {
  const MAIL_ID = 'mail-project-client.apps.googleusercontent.com';

  it('unset — mail uses the calendar credentials, exactly as before', () => {
    // The fallback is what makes this deployable without touching anything on Google first.
    expect(new URL(svc().mailAuthUrl('s', REDIRECT)).searchParams.get('client_id'))
      .toBe('test-client-id.apps.googleusercontent.com');
    expect(isMailConfigured()).toBe(true);
  });

  it('set — the mail flow uses its own client and the calendar keeps the original', () => {
    process.env.GOOGLE_MAIL_CLIENT_ID = MAIL_ID;
    process.env.GOOGLE_MAIL_CLIENT_SECRET = 'mail-secret';

    expect(new URL(svc().mailAuthUrl('s', REDIRECT)).searchParams.get('client_id')).toBe(MAIL_ID);
    // The calendar is untouched — the whole point is that only the mail screens are renamed.
    expect(new URL(svc().authUrl('s', REDIRECT)).searchParams.get('client_id'))
      .toBe('test-client-id.apps.googleusercontent.com');
  });

  it('the picker and the refresh-token guarantee survive the split', () => {
    process.env.GOOGLE_MAIL_CLIENT_ID = MAIL_ID;
    process.env.GOOGLE_MAIL_CLIENT_SECRET = 'mail-secret';
    const p = new URL(svc().mailAuthUrl('s', REDIRECT)).searchParams;
    expect(p.get('prompt')).toBe(AUTH_PROMPT);
    expect(p.get('access_type')).toBe('offline');
  });

  it('refuses a half-configured pair instead of failing after the user consents', () => {
    /*
     * The expensive failure: with an id from the new project and no matching secret, the flow
     * starts, the person picks an account and hands over their whole mailbox, and only THEN does
     * the exchange answer `invalid_client`. Refusing on the button says the same thing honestly.
     */
    process.env.GOOGLE_MAIL_CLIENT_ID = MAIL_ID;
    delete process.env.GOOGLE_MAIL_CLIENT_SECRET;
    expect(isMailConfigured()).toBe(false);

    delete process.env.GOOGLE_MAIL_CLIENT_ID;
    process.env.GOOGLE_MAIL_CLIENT_SECRET = 'mail-secret';
    expect(isMailConfigured()).toBe(false);
  });

  it('a token is exchanged and refreshed against the client that issued it', async () => {
    process.env.GOOGLE_MAIL_CLIENT_ID = MAIL_ID;
    process.env.GOOGLE_MAIL_CLIENT_SECRET = 'mail-secret';

    const sent: Array<Record<string, string>> = [];
    const realFetch = global.fetch;
    global.fetch = (async (_u: string, init: { body: string }) => {
      sent.push(Object.fromEntries(new URLSearchParams(init.body)));
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }) as unknown as typeof fetch;

    try {
      const s = svc();
      await s.exchangeCode('code', REDIRECT, 'mail');
      await s.refresh('rt', 'mail');
      await s.exchangeCode('code', REDIRECT);   // default: calendar
      await s.refresh('rt');

      expect(sent[0].client_id).toBe(MAIL_ID);
      expect(sent[0].client_secret).toBe('mail-secret');
      // The refresh is the one that matters most: it runs for the life of the mailbox, from IMAP
      // and from SMTP, long after anyone remembers which project the account was connected on.
      expect(sent[1].client_id).toBe(MAIL_ID);
      expect(sent[1].client_secret).toBe('mail-secret');
      expect(sent[2].client_id).toBe('test-client-id.apps.googleusercontent.com');
      expect(sent[3].client_id).toBe('test-client-id.apps.googleusercontent.com');
    } finally {
      global.fetch = realFetch;
    }
  });
});

/**
 * The callback, driven directly.
 *
 * The subject is which of the two connect paths runs and what it is told — not the network. Every
 * dependency is a fake that records its calls, so "the correct account was connected" is checked as
 * an argument rather than inferred from a database.
 */
describe('the OAuth callback', () => {
  const TOKENS = { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid' };

  const build = () => {
    const calls: { calendar: unknown[]; mail: unknown[]; pulled: unknown[] } = { calendar: [], mail: [], pulled: [] };
    const redirects: string[] = [];

    const connections = { save: async (...a: unknown[]) => { calls.calendar.push(a); } };
    const gmail = { upsert: async (...a: unknown[]) => { calls.mail.push(a); } };
    const sync = { pull: async (...a: unknown[]) => { calls.pulled.push(a); return {}; } };
    const google = {
      exchangeCode: async () => TOKENS,
      email: async () => 'agent@gethomerealty.ca',
    };
    const prisma = { users: { findUnique: async () => ({ id: 7 }) } };
    const state = new GoogleStateService();

    const controller = new GooglePublicController(
      connections as never, google as never, state as never,
      sync as never, gmail as never, prisma as never,
    );
    const res = { redirect: (u: string) => { redirects.push(u); } };
    return { controller, state, calls, redirects, res };
  };

  const REQ = { headers: { host: 'crm.example.com', 'x-forwarded-proto': 'https' }, protocol: 'https' };

  it('connects the calendar account against the area that started the flow', async () => {
    const { controller, state, calls, redirects, res } = build();
    await controller.callback(
      { code: 'auth-code', state: state.issue(7, 'calendar', 'desk') } as never, REQ as never, res as never,
    );

    expect(calls.mail).toHaveLength(0);
    const [userId, , email, scope] = calls.calendar[0] as unknown[];
    expect(userId).toBe(7);
    expect(email).toBe('agent@gethomerealty.ca');
    // `desk`, because that is what the signed state said — the area cannot be chosen by the caller.
    expect(scope).toBe('desk');
    expect(redirects[0]).toContain('google_connected=1');
  });

  it('connects the mailbox against the area that started the flow, and syncs no calendar', async () => {
    const { controller, state, calls, redirects, res } = build();
    await controller.callback(
      { code: 'auth-code', state: state.issue(7, 'mail', 'crm') } as never, REQ as never, res as never,
    );

    expect(calls.calendar).toHaveLength(0);
    // A mail connect must not trigger a calendar pull; the two integrations share this callback and
    // nothing else.
    expect(calls.pulled).toHaveLength(0);
    const [userId, , email, scope] = calls.mail[0] as unknown[];
    expect(userId).toBe(7);
    expect(email).toBe('agent@gethomerealty.ca');
    expect(scope).toBe('crm');
    expect(redirects[0]).toContain('mail_connected=1');
  });

  it('treats the user pressing Cancel on Google as a cancellation, not a connection', async () => {
    // Google sends `error=access_denied` and no code. Nothing may be stored, and the person must
    // land back in the application rather than on a JSON error.
    const { controller, calls, redirects, res } = build();
    await controller.callback({ error: 'access_denied' } as never, REQ as never, res as never);

    expect(calls.calendar).toHaveLength(0);
    expect(calls.mail).toHaveLength(0);
    expect(redirects[0]).toContain('google_error=access_denied');
    expect(redirects[0]).toContain('https://crm.example.com');
  });

  it('refuses a forged state without connecting anything', async () => {
    const { controller, calls, redirects, res } = build();
    await controller.callback(
      { code: 'auth-code', state: '7.calendar.desk.1.nonce.not-a-signature' } as never, REQ as never, res as never,
    );

    expect(calls.calendar).toHaveLength(0);
    expect(calls.mail).toHaveLength(0);
    expect(redirects[0]).toContain('google_error=invalid_state');
  });

  it('refuses a state that has already been used', async () => {
    // Single-use is what stops a callback URL being replayed out of a browser history.
    const { controller, state, calls, redirects, res } = build();
    const once = state.issue(7, 'calendar', 'crm');

    await controller.callback({ code: 'c', state: once } as never, REQ as never, res as never);
    await controller.callback({ code: 'c', state: once } as never, REQ as never, res as never);

    expect(calls.calendar).toHaveLength(1);
    expect(redirects[1]).toContain('google_error=invalid_state');
  });
});
