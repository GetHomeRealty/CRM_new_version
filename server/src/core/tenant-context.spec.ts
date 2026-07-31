import { currentCompanyId, enter, requireCompanyId, run, setCompanyId } from './tenant-context';

/**
 * The tenant context.
 *
 * The property worth testing is the one a plain module-level variable would get wrong: two requests
 * in flight at once, interleaved by the event loop, must not see each other's tenant. Everything
 * else here is a guard rail; that is the reason `AsyncLocalStorage` is being used at all.
 */

const tick = () => new Promise((r) => setImmediate(r));

describe('the tenant context follows the call, not the process', () => {
  it('has no tenant outside a context', () => {
    expect(currentCompanyId()).toBeNull();
  });

  it('carries the tenant through awaits', async () => {
    await run(7, async () => {
      expect(currentCompanyId()).toBe(7);
      await tick();
      await tick();
      expect(currentCompanyId()).toBe(7); // still 7 after yielding to the event loop
    });
    expect(currentCompanyId()).toBeNull(); // and gone again afterwards
  });

  it('keeps two interleaved requests apart', async () => {
    // The whole point. Each of these yields repeatedly, so the event loop runs them intertwined;
    // a module-level `let currentCompany` would have them overwrite each other and this would fail.
    const seen: string[] = [];
    const request = (id: number) =>
      run(id, async () => {
        for (let i = 0; i < 5; i++) {
          await tick();
          seen.push(`${id}:${currentCompanyId()}`);
        }
        return currentCompanyId();
      });

    const [a, b, c] = await Promise.all([request(1), request(2), request(3)]);
    expect([a, b, c]).toEqual([1, 2, 3]);
    // Nobody ever observed a tenant other than their own.
    expect(seen.filter((s) => s.split(':')[0] !== s.split(':')[1])).toEqual([]);
  });

  it('nests without leaking outward', async () => {
    await run(1, async () => {
      expect(currentCompanyId()).toBe(1);
      await run(2, async () => {
        expect(currentCompanyId()).toBe(2);
      });
      expect(currentCompanyId()).toBe(1);
    });
  });
});

describe('a request names its tenant only once it knows it', () => {
  it('starts empty and is filled in by the guard', async () => {
    // This is the middleware/guard sequence: the context opens before authentication, so there is a
    // window where the tenant is genuinely unknown, and it is filled in afterwards by reference.
    await new Promise<void>((resolve) => {
      enter(async () => {
        expect(currentCompanyId()).toBeNull(); // middleware has run, AuthGuard has not
        setCompanyId(4); // AuthGuard, having loaded the user
        expect(currentCompanyId()).toBe(4);
        await tick();
        expect(currentCompanyId()).toBe(4); // and it survives into the handler
        resolve();
      });
    });
  });

  it('ignores an attempt to name a tenant with no context to name', () => {
    // A script or a test that authenticates outside a request. Not an error, just nothing to set.
    expect(() => setCompanyId(9)).not.toThrow();
    expect(currentCompanyId()).toBeNull();
  });
});

describe('requiring a tenant fails closed', () => {
  it('throws rather than guessing when nothing is in context', () => {
    // Module access fails OPEN — the cost of a missing subscription row is someone seeing a screen.
    // This fails CLOSED, because the cost of guessing is one brokerage reading another's data.
    expect(() => requireCompanyId()).toThrow(/No tenant in context/);
  });

  it('returns the tenant when there is one', async () => {
    await run(3, async () => {
      expect(requireCompanyId()).toBe(3);
    });
  });
});

/**
 * The guard actually sets it.
 *
 * Wiring that is never exercised is wiring that might be reading the wrong property — `AreaGuard`
 * spent a day passing every request because it read `req.user` where this application puts
 * `req.authUser`, and nothing failed loudly enough to notice. So this drives the real guard.
 */
describe('AuthGuard names the tenant for the request', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AuthGuard } = require('../auth/guards/auth.guard');

  const contextFor = (req: unknown) => ({ switchToHttp: () => ({ getRequest: () => req }) });

  it('takes the company from the user it loaded', async () => {
    const guard = new AuthGuard({ loadUser: async () => ({ id: 5, company_id: 42, user_permissions: [] }) });
    const req: Record<string, unknown> = { session: { userId: 5 } };

    await new Promise<void>((resolve, reject) => {
      enter(async () => {
        try {
          expect(currentCompanyId()).toBeNull();
          await guard.canActivate(contextFor(req));
          expect(currentCompanyId()).toBe(42); // not a hard-coded 1, and not still null
          expect((req.authUser as { id: number }).id).toBe(5);
          resolve();
        } catch (e) { reject(e); }
      });
    });
  });

  it('leaves no tenant behind when authentication fails', async () => {
    const guard = new AuthGuard({ loadUser: async () => null });
    await new Promise<void>((resolve, reject) => {
      enter(async () => {
        try {
          await expect(guard.canActivate(contextFor({ session: { userId: 9 } }))).rejects.toThrow(/Unauthenticated/);
          expect(currentCompanyId()).toBeNull();
          resolve();
        } catch (e) { reject(e); }
      });
    });
  });
});

/**
 * Every deliberate escape from tenant isolation, pinned.
 *
 * `runAsSystem` reads across every brokerage. There are legitimate reasons for that and they are
 * all infrastructure — but the list must be short, and it must be a decision to add to it rather
 * than something that happens while nobody is looking. This test is the review gate: a new use
 * fails the build until someone writes down why it belongs.
 */
describe('unscoped access stays deliberate and rare', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync, readdirSync, statSync } = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join, sep } = require('path');

  function sources(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) sources(p, out);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
    }
    return out;
  }

  /** file -> why it may read across tenants. Adding a row is the point at which someone thinks. */
  const ALLOWED: Record<string, string> = {
    'tenant-context.ts': 'defines the escape hatch itself, and forEachTenant uses it',
    'auth.service.ts': 'resolving which user a session belongs to is how the tenant is discovered',
    'role-permission.store.ts': 'loads the permission tables at start-up, before any request exists',
    'export-job.service.ts': 'reclaims interrupted jobs and finds each job owner after a restart',
    'health.controller.ts': 'the readiness probe asks whether the SERVER can serve, not about any tenant data',
    'mail-retention.service.ts': 'the nightly retention sweep applies one policy to every brokerage mailbox, on a timer, with no request and so no tenant in context',
    'lead-import-job.service.ts': 'a queued import outlives the request that created it, so the tenant comes from the job row rather than from a request that has already returned',
  };

  it('is used only where it has been justified', () => {
    const root = join(__dirname, '..');
    const users: string[] = [];
    for (const f of sources(root)) {
      const s = readFileSync(f, 'utf8');
      // The import itself does not count — only a call.
      if (/runAsSystem\s*\(/.test(s.replace(/import[^;]*;/g, ''))) users.push(String(f).split(sep).pop() as string);
    }
    expect([...new Set(users)].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('keeps every justification non-empty', () => {
    for (const [file, why] of Object.entries(ALLOWED)) {
      expect(why.length).toBeGreaterThan(20);
      expect(file).toMatch(/\.ts$/);
    }
  });
});
