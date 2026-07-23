import { decryptToken, encryptToken, tokenHint, tokenStorageIsSecure } from './meta-crypto';
import { MetaStateService } from './meta-state.service';
import { MetaSyncService } from './meta-sync.service';
import { FIELD_MAP, oauthStrategy, publicBaseUrl, redirectUri } from './meta.constants';

/**
 * The parts of the Meta integration that can be proven without a Meta app: token encryption,
 * OAuth state signing, and lead-form field mapping. Everything that talks to Graph is covered by
 * scripts/verify-meta.cjs against the running API.
 */

describe('meta token encryption', () => {
  const original = process.env.APP_KEY;
  afterEach(() => { process.env.APP_KEY = original; });

  it('round-trips a token', () => {
    process.env.APP_KEY = 'base64:0123456789abcdef0123456789abcdef';
    const token = 'EAABsb1234|secret-token-value';
    const sealed = encryptToken(token);
    expect(sealed).not.toContain(token);
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    expect(decryptToken(sealed)).toBe(token);
  });

  it('produces a different ciphertext each time (fresh IV)', () => {
    process.env.APP_KEY = 'key-material';
    expect(encryptToken('same')).not.toBe(encryptToken('same'));
  });

  it('marks storage insecure and stores a readable marker when APP_KEY is missing', () => {
    delete process.env.APP_KEY;
    expect(tokenStorageIsSecure()).toBe(false);
    const stored = encryptToken('abc');
    // Explicitly marked, so an unencrypted value can never be mistaken for an encrypted one.
    expect(stored).toBe('plain:abc');
    expect(decryptToken(stored)).toBe('abc');
  });

  it('returns empty rather than throwing when the key no longer matches', () => {
    process.env.APP_KEY = 'first-key';
    const sealed = encryptToken('token');
    process.env.APP_KEY = 'rotated-key';
    // A rotated key must surface as "reconnect", not a 500.
    expect(decryptToken(sealed)).toBe('');
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    process.env.APP_KEY = 'key-material';
    const sealed = encryptToken('token');
    const parts = sealed.slice('enc:v1:'.length).split('.');
    const tampered = `enc:v1:${parts[0]}.${parts[1]}.${Buffer.from('evil').toString('base64')}`;
    expect(decryptToken(tampered)).toBe('');
  });

  it('only ever hints at the last four characters', () => {
    expect(tokenHint('abcdefghij')).toBe('…ghij');
    expect(tokenHint('')).toBe('');
  });
});

describe('meta OAuth state', () => {
  const state = new MetaStateService();
  beforeAll(() => { process.env.APP_KEY = 'state-signing-key'; });

  it('round-trips the user id', () => {
    expect(state.verify(state.issue(42))).toBe(42);
  });

  it('rejects a forged state (someone else\'s user id spliced in)', () => {
    const issued = state.issue(42);
    const [, ts, nonce, sig] = issued.split('.');
    expect(state.verify(`99.${ts}.${nonce}.${sig}`)).toBeNull();
  });

  it('rejects a replay of a state already used', () => {
    const issued = state.issue(7);
    expect(state.verify(issued)).toBe(7);
    expect(state.verify(issued)).toBeNull();
  });

  it('rejects an expired state', () => {
    const old = Date.now() - MetaStateService.TTL_MS - 1000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(old);
    const issued = state.issue(5);
    spy.mockRestore();
    expect(state.verify(issued)).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'x', 'a.b.c', 'a.b.c.d.e']) expect(state.verify(bad)).toBeNull();
  });
});

describe('meta lead field mapping', () => {
  // Only mapLead is exercised, so the collaborators are never touched.
  const sync = new MetaSyncService(null as never, null as never, null as never, null as never);

  it('maps the standard lead-form fields', () => {
    const m = sync.mapLead([
      { name: 'full_name', values: ['Jane Doe'] },
      { name: 'email', values: ['jane@example.com'] },
      { name: 'phone_number', values: ['416-555-0100'] },
      { name: 'city', values: ['Toronto'] },
      { name: 'budget', values: ['$800k'] },
      { name: 'when_are_you_looking', values: ['3 months'] },
      { name: 'home_type', values: ['Detached'] },
    ]);
    expect(m).toMatchObject({
      name: 'Jane Doe', email: 'jane@example.com', phone: '416-555-0100',
      location: 'Toronto', budget: '$800k', timeline: '3 months', property_type: 'Detached',
    });
  });

  it('keeps unmapped answers instead of dropping them', () => {
    const m = sync.mapLead([
      { name: 'email', values: ['a@b.co'] },
      { name: 'do_you_have_an_agent', values: ['No'] },
      { name: 'preferred_school_district', values: ['TDSB'] },
    ]);
    expect(m.custom_fields).toEqual({ do_you_have_an_agent: 'No', preferred_school_district: 'TDSB' });
  });

  it('does not let a later name field overwrite an earlier one', () => {
    const m = sync.mapLead([
      { name: 'first_name', values: ['Ada'] },
      { name: 'full_name', values: ['Ada Lovelace'] },
    ]);
    expect(m.name).toBe('Ada');
  });

  it('falls back to email, then phone, then a placeholder when no name was collected', () => {
    expect(sync.mapLead([{ name: 'email', values: ['x@y.co'] }]).name).toBe('x@y.co');
    expect(sync.mapLead([{ name: 'phone', values: ['555'] }]).name).toBe('555');
    expect(sync.mapLead([]).name).toBe('Meta lead');
  });

  it('ignores blank answers and unknown shapes', () => {
    const m = sync.mapLead([
      { name: 'email', values: [''] },
      { name: '', values: ['orphan'] },
      { values: ['no name'] },
    ]);
    expect(m.email).toBeNull();
    expect(m.custom_fields).toEqual({});
  });

  it('copies property_type into property when the form had no property field', () => {
    expect(sync.mapLead([{ name: 'home_type', values: ['Condo'] }]).property).toBe('Condo');
  });

  it('maps every documented field name to a real lead column', () => {
    const columns = new Set(['name', 'email', 'phone', 'message', 'property_type', 'budget', 'timeline', 'location', 'property']);
    for (const target of Object.values(FIELD_MAP)) expect(columns.has(target)).toBe(true);
  });
});

describe('meta configuration helpers', () => {
  it('defaults to the config_id strategy that Business apps require', () => {
    delete process.env.META_OAUTH_STRATEGY;
    expect(oauthStrategy()).toBe('config');
  });

  it('builds the redirect URI Meta must have on its allow-list', () => {
    process.env.META_PUBLIC_URL = 'https://desk.example.com/';
    expect(publicBaseUrl()).toBe('https://desk.example.com');
    expect(redirectUri()).toBe('https://desk.example.com/api/meta/callback');
    delete process.env.META_PUBLIC_URL;
  });
});
