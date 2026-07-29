import { productionConfigProblems } from './validate-config';
import type { AppConfig } from './configuration';

/**
 * Each case here is a real deployment failure that produces no error at boot and no useful error
 * later. The point of the guard is that a wrong value stops the deploy instead of shipping an
 * application that looks fine and does not work, so what matters is that every one is caught.
 */

/** A correct single-origin production configuration — the baseline every case deviates from. */
const good = (): AppConfig => ({
  env: 'production',
  port: 8000,
  appKey: `base64:${Buffer.alloc(32, 7).toString('base64')}`,
  databaseUrl: 'postgresql://user:pw@db:5432/app',
  frontendUrl: 'https://gethomehub.ca',
  corsOrigins: ['https://gethomehub.ca'],
  bcryptRounds: 12,
  runSchedulers: true,
  session: {
    secret: 'x'.repeat(48),
    cookieName: 'laravel_session',
    lifetimeMinutes: 120,
    secure: true,
    sameSite: 'lax',
    domain: undefined,
  },
  idExtraction: { provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5' },
});

const withSession = (over: Partial<AppConfig['session']>): AppConfig => {
  const c = good();
  return { ...c, session: { ...c.session, ...over } };
};

describe('production configuration guard', () => {
  // TZ is read from the real environment, not the config object, so it is pinned for these tests.
  const savedTz = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'America/Toronto'; });
  afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

  it('requires TZ, because several modules derive dates from the server clock', () => {
    delete process.env.TZ;
    expect(productionConfigProblems(good()).join(' ')).toContain('TZ is not set');
  });

  it('passes a correct single-origin production setup', () => {
    expect(productionConfigProblems(good())).toEqual([]);
  });

  describe('APP_KEY — wrong value makes every stored credential unreadable', () => {
    it('rejects an empty key, which silently becomes an all-zero key', () => {
      expect(productionConfigProblems({ ...good(), appKey: '' }).join(' ')).toContain('APP_KEY is empty');
    });

    it('rejects a key that does not decode to 32 bytes for AES-256', () => {
      const short = `base64:${Buffer.alloc(16, 1).toString('base64')}`;
      expect(productionConfigProblems({ ...good(), appKey: short }).join(' ')).toContain('32 bytes');
    });

    it('accepts a bare 32-byte key without the base64: prefix', () => {
      const bare = Buffer.alloc(32, 3).toString('base64');
      expect(productionConfigProblems({ ...good(), appKey: bare })).toEqual([]);
    });
  });

  describe('cookies — wrong values surface as "login bounces straight back"', () => {
    it('rejects a non-secure cookie in production', () => {
      expect(productionConfigProblems(withSession({ secure: false })).join(' ')).toContain('COOKIE_SECURE is false');
    });

    it('rejects SameSite=None without Secure, which browsers refuse to store', () => {
      const problems = productionConfigProblems(withSession({ sameSite: 'none', secure: false })).join(' ');
      expect(problems).toContain('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
    });

    it('rejects a COOKIE_DOMAIN without its leading dot', () => {
      expect(productionConfigProblems(withSession({ domain: 'gethomehub.ca' })).join(' ')).toContain('leading dot');
    });

    it('accepts a correctly dotted COOKIE_DOMAIN, for a subdomain split', () => {
      expect(productionConfigProblems(withSession({ domain: '.gethomehub.ca' }))).toEqual([]);
    });
  });

  describe('session secret', () => {
    it('rejects the built-in development secret, which is public in this repository', () => {
      expect(productionConfigProblems(withSession({ secret: 'insecure-dev-secret' })).join(' ')).toContain('development value');
    });

    it('rejects a short secret', () => {
      expect(productionConfigProblems(withSession({ secret: 'tooshort' })).join(' ')).toContain('at least 32');
    });
  });

  describe('FRONTEND_URL — builds outgoing links, so a dev value escapes the building', () => {
    it('rejects the localhost default even when CORS_ORIGINS is correct', () => {
      // The trap: corsOrigins only falls back to FRONTEND_URL when CORS_ORIGINS is empty, so a
      // correct CORS_ORIGINS hides an unset FRONTEND_URL completely.
      const cfg = { ...good(), frontendUrl: 'http://localhost:5173', corsOrigins: ['https://gethomehub.ca'] };
      expect(productionConfigProblems(cfg).join(' ')).toContain('FRONTEND_URL');
    });

    it('rejects an unset value', () => {
      expect(productionConfigProblems({ ...good(), frontendUrl: '' }).join(' ')).toContain('FRONTEND_URL');
    });

    it('rejects a trailing slash, which would produce "//" in every generated link', () => {
      expect(productionConfigProblems({ ...good(), frontendUrl: 'https://gethomehub.ca/' }).join(' ')).toContain('trailing slash');
    });

    it('accepts a proper https origin', () => {
      expect(productionConfigProblems({ ...good(), frontendUrl: 'https://gethomehub.ca' })).toEqual([]);
    });
  });

  describe('CORS', () => {
    it('rejects a leftover localhost origin', () => {
      expect(productionConfigProblems({ ...good(), corsOrigins: ['http://localhost:5173'] }).join(' ')).toContain('development origin');
    });

    it('rejects a non-https origin', () => {
      expect(productionConfigProblems({ ...good(), corsOrigins: ['http://gethomehub.ca'] }).join(' ')).toContain('not https');
    });

    it('rejects a trailing slash, which can never match the Origin header', () => {
      expect(productionConfigProblems({ ...good(), corsOrigins: ['https://gethomehub.ca/'] }).join(' ')).toContain('trailing slash');
    });

    it('rejects an empty origin list', () => {
      expect(productionConfigProblems({ ...good(), corsOrigins: [] }).join(' ')).toContain('no allowed origin');
    });
  });

  it('reports every problem at once rather than one restart at a time', () => {
    const bad: AppConfig = {
      ...good(), appKey: '', databaseUrl: '', corsOrigins: ['http://localhost:5173'],
      session: { ...good().session, secure: false, secret: 'insecure-dev-secret' },
    };
    expect(productionConfigProblems(bad).length).toBeGreaterThanOrEqual(5);
  });

  it('never fires outside production, so development is untouched', () => {
    const dev: AppConfig = {
      ...good(), env: 'development', appKey: '', databaseUrl: '',
      corsOrigins: ['http://localhost:5173'],
      session: { ...good().session, secure: false, secret: 'insecure-dev-secret' },
    };
    // assertProductionConfig short-circuits on env; the collector itself still reports.
    expect(() => require('./validate-config').assertProductionConfig(dev)).not.toThrow();
  });
});
