import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import type { PrismaService } from '../prisma/prisma.service';
import { MetaPublicController } from './meta-public.controller';
import { MetaConnectionService } from './meta-connection.service';

/**
 * Meta's data-deletion callback.
 *
 * WHY THIS EXISTS. It is a publicly reachable endpoint that ERASES a user's stored Meta tokens on
 * request, and it had no coverage of any kind — not a runtime probe during the audit, not a spec.
 * Meta calls it when somebody removes the app from their Facebook account, and App Review commonly
 * exercises it before granting the permissions this integration needs.
 *
 * The property that matters is not that a valid request works; it is that an INVALID one cannot
 * disconnect anybody. The only thing standing between a stranger and "erase that agent's Meta
 * connection" is an HMAC over the payload, so every test below that forges or mangles the request
 * also asserts the connection survived.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

function withNestedTransaction(tx: object): PrismaService {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return async (ops: unknown) => {
          if (typeof ops === 'function') return (ops as (c: unknown) => unknown)(receiver);
          const done: unknown[] = [];
          for (const op of ops as Promise<unknown>[]) done.push(await op);
          return done;
        };
      }
      return Reflect.get(target, prop, target);
    },
  }) as unknown as PrismaService;
}

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(withNestedTransaction(tx)); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };
const SECRET = 'app-secret-for-signing';

/** A `signed_request` exactly as Meta builds one: base64url(HMAC) + '.' + base64url(payload). */
function signedRequest(payload: Record<string, unknown>, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${sig}.${body}`;
}

const request = (signed: string): Request => ({ body: { signed_request: signed } } as unknown as Request);

// Only the data-deletion path is exercised here, and it never reaches the OAuth callback's
// collaborators — hence the nulls, AuthService among them.
const controllerFor = (tx: PrismaService) => new MetaPublicController(
  new MetaConnectionService(tx, { fetchPages: async () => [] } as never),
  null as never,
  null as never,
  null as never,
  null as never,
);

async function connect(tx: PrismaService, facebookUserId: string): Promise<number> {
  const now = new Date();
  const t = tag();
  const user = await tx.users.create({
    data: {
      name: `Del ${t}`, email: `del-${t}@example.test`, role: 'agent', status: 'Active',
      password: 'x', company_id: 1, created_at: now, updated_at: now,
    },
  });
  await tx.meta_connections.create({
    data: {
      user_id: user.id, access_token: 'enc:v1:stub', facebook_user_id: facebookUserId,
      is_active: true, connected_at: now, created_at: now, updated_at: now,
    },
  });
  await tx.meta_lead_forms.create({
    data: {
      company_id: 1, user_id: user.id, page_id: `page-${t}`, form_id: `form-${t}`,
      form_name: 'Campaign', is_active: true, created_at: now, updated_at: now,
    },
  });
  return user.id;
}

const active = (tx: PrismaService, userId: number) =>
  tx.meta_connections.findFirst({ where: { user_id: userId, is_active: true } });

describe('the Meta data-deletion callback', () => {
  const original = process.env.META_WEBHOOK_SECRET;
  beforeAll(() => { process.env.META_WEBHOOK_SECRET = SECRET; });
  afterAll(() => {
    if (original === undefined) delete process.env.META_WEBHOOK_SECRET;
    else process.env.META_WEBHOOK_SECRET = original;
  });

  it('erases the connection named by a correctly signed request', async () => {
    await inRollback(async (tx) => {
      const fbId = `fb-${tag()}`;
      const userId = await connect(tx, fbId);

      const res = await controllerFor(tx).dataDeletion(request(signedRequest({ user_id: fbId })));

      expect(res.confirmation_code).not.toBe('invalid-request');
      expect(String(res.url)).toContain(String(res.confirmation_code));

      const conn = await tx.meta_connections.findFirst({ where: { user_id: userId } });
      expect(conn?.is_active).toBe(false);
      expect(conn?.access_token).toBe('');
      // The same disconnect an agent gets, so their forms are released too.
      expect(await tx.meta_lead_forms.count({ where: { user_id: userId, is_active: true } })).toBe(0);
    });
  });

  it('refuses a forged signature and leaves the connection alone', async () => {
    await inRollback(async (tx) => {
      const fbId = `fb-${tag()}`;
      const userId = await connect(tx, fbId);

      // Correct shape, wrong secret — the whole defence in one case.
      const forged = signedRequest({ user_id: fbId }, 'not-the-app-secret');
      const res = await controllerFor(tx).dataDeletion(request(forged));

      expect(res.confirmation_code).toBe('invalid-request');
      expect(await active(tx, userId)).not.toBeNull();
    });
  });

  it('refuses a payload whose signature was copied from a different payload', async () => {
    await inRollback(async (tx) => {
      const victimFb = `fb-victim-${tag()}`;
      const victim = await connect(tx, victimFb);

      // Sign one payload, then swap in another — the classic mistake is verifying the decoded
      // object rather than the exact bytes the signature covers.
      const signedOther = signedRequest({ user_id: `fb-other-${tag()}` });
      const [sig] = signedOther.split('.');
      const swapped = `${sig}.${Buffer.from(JSON.stringify({ user_id: victimFb })).toString('base64url')}`;

      const res = await controllerFor(tx).dataDeletion(request(swapped));

      expect(res.confirmation_code).toBe('invalid-request');
      expect(await active(tx, victim)).not.toBeNull();
    });
  });

  it('answers malformed input without throwing, because Meta expects a 200', async () => {
    await inRollback(async (tx) => {
      const c = controllerFor(tx);
      for (const bad of ['', 'no-dot', '.', 'a.', '.b', 'not.base64!!', 'a.b.c']) {
        const res = await c.dataDeletion(request(bad));
        expect(res.confirmation_code).toBe('invalid-request');
        expect(typeof res.url).toBe('string');
      }
      // And a body with no signed_request at all.
      const res = await c.dataDeletion({ body: {} } as unknown as Request);
      expect(res.confirmation_code).toBe('invalid-request');
    });
  });

  it('still answers for a Facebook user nobody here has connected', async () => {
    await inRollback(async (tx) => {
      // Meta needs a confirmation code regardless; there is simply nothing to erase.
      const res = await controllerFor(tx).dataDeletion(request(signedRequest({ user_id: `fb-unknown-${tag()}` })));
      expect(res.confirmation_code).not.toBe('invalid-request');
      expect(String(res.confirmation_code)).toHaveLength(16);
    });
  });

  it('gives the same person the same code every time, so a status page can be checked twice', async () => {
    await inRollback(async (tx) => {
      const fbId = `fb-${tag()}`;
      await connect(tx, fbId);
      const c = controllerFor(tx);
      const first = await c.dataDeletion(request(signedRequest({ user_id: fbId })));
      const second = await c.dataDeletion(request(signedRequest({ user_id: fbId })));
      expect(second.confirmation_code).toBe(first.confirmation_code);
    });
  });

  it('does not touch a different agent who happens to be connected', async () => {
    await inRollback(async (tx) => {
      const goingFb = `fb-going-${tag()}`;
      const going = await connect(tx, goingFb);
      const staying = await connect(tx, `fb-staying-${tag()}`);

      await controllerFor(tx).dataDeletion(request(signedRequest({ user_id: goingFb })));

      expect(await active(tx, going)).toBeNull();
      expect(await active(tx, staying)).not.toBeNull();
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
