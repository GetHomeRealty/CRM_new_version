import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { GoogleConnectionService } from './google-connection.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { encryptToken, decryptToken } from '../meta/meta-crypto';
import { GOOGLE_ORIGIN_CREATED_BY } from './google.constants';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Disconnecting ONE calendar must not disconnect anything else the user has connected to Google.
 *
 * THE DEFECT. `disconnect()` ended with `google.revoke(refresh_token)`. That reads like releasing
 * the credential it is about to delete, and it is not: Google's revoke endpoint revokes THE GRANT
 * behind the token — every token ever issued to that (Google account, OAuth client) pair, across
 * every scope in it. One OAuth client currently serves both Calendar and Gmail here, so clicking
 * "Disconnect" on the CRM calendar told Google to withdraw:
 *
 *     the CRM calendar        — which is what the user asked for
 *     that user's Gmail       — which they did not, mid-send, with no warning
 *     their Desk calendar     — which they did not
 *
 * The fallback branch was no gentler: with no refresh token stored it revoked the ACCESS token,
 * and an access token revokes the same grant.
 *
 * WHY THIS SURVIVED THE EXISTING SUITE. `calendar-disconnect.spec.ts` is thorough about which
 * events and rows move, but it stubs `revoke` as an empty function and builds its connections with
 * no tokens at all — so the branch never executed and nothing ever asserted it should not. The
 * tests here close exactly that gap: the spy RECORDS calls, and every connection is built WITH
 * tokens, so the deleted line would have fired on each one. Each test states the control it relies
 * on, because a spy that sees nothing proves nothing unless the code under test could have called it.
 *
 * Every case runs inside a rolled-back transaction, so nothing here touches real data, and no test
 * in this file reaches the network.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

/**
 * A Google client that RECORDS revocations instead of performing them.
 *
 * The point of the file. `calls` must stay empty through every disconnect below, and each test
 * first asserts the connection really did hold a token — otherwise an empty list would only mean
 * the branch was never reachable.
 */
function spyGoogle() {
  const calls: string[] = [];
  return { calls, svc: { revoke: async (token: string) => { calls.push(token); } } as never };
}

const sync = (tx: PrismaService, g: ReturnType<typeof spyGoogle>) =>
  new GoogleCalendarSyncService(tx, g.svc, new GoogleConnectionService(tx, g.svc));

async function makeUser(tx: PrismaService, label = 'Local'): Promise<AuthUserRecord> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: { name: `${label} ${t}`, email: `local-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u as unknown as AuthUserRecord;
}

/**
 * A calendar connection holding REAL encrypted tokens, which is what makes these tests meaningful:
 * the removed `revoke` line was guarded by `if (conn.refresh_token)`, so a tokenless row — what the
 * older spec creates — would have skipped it whether or not the defect was fixed.
 */
async function connectWithTokens(tx: PrismaService, userId: number, scope: 'crm' | 'desk', googleEmail: string) {
  const now = new Date();
  return tx.google_connections.create({
    data: {
      user_id: userId, scope, google_email: googleEmail, calendar_id: 'primary',
      access_token: encryptToken(`access-${scope}-${tag()}`),
      refresh_token: encryptToken(`1//refresh-${scope}-${tag()}`),
      token_expires_at: new Date(now.getTime() + 3600_000),
      is_active: true, created_at: now, updated_at: now,
    },
  });
}

/** The same person's Gmail mailbox, on the SAME Google account the calendars use. */
async function connectGmail(tx: PrismaService, userId: number, googleEmail: string) {
  const now = new Date();
  return tx.mail_accounts.create({
    data: {
      name: 'Gmail', from_email: googleEmail, username: googleEmail,
      host: 'smtp.gmail.com', port: 587, encryption: 'tls',
      // Mailboxes store their credential under the Laravel cipher, not meta-crypto; the exact bytes
      // do not matter here, only that nothing rewrites them.
      password: `laravel-ciphertext-${tag()}`,
      imap_host: 'imap.gmail.com', imap_port: 993, inbound_enabled: true,
      is_active: true, user_id: userId, scope: 'crm', created_at: now, updated_at: now,
    },
  });
}

const googleEvent = (id: string, summary: string) => ({
  id, status: 'confirmed', summary, start: { dateTime: '2026-09-10T14:00:00' },
});

// =================================================================================================

describe('1. Calendar disconnect never calls Google revoke', () => {
  it('does not revoke, even though the connection holds a refresh token', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      const conn = await connectWithTokens(tx, user.id, 'crm', 'shared@gethomerealty.test');

      // The control: the old code's `if (conn.refresh_token)` was satisfied, so it WOULD have fired.
      expect(conn.refresh_token).toBeTruthy();

      await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');

      expect(g.calls).toEqual([]);
    });
  });

  it('does not fall back to revoking the ACCESS token when no refresh token is stored', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      const now = new Date();
      // The `else if (conn.access_token)` branch. An access token revokes the same whole grant, so
      // this path was just as destructive as the other and needs its own assertion.
      const conn = await tx.google_connections.create({
        data: {
          user_id: user.id, scope: 'crm', google_email: 'shared@gethomerealty.test', calendar_id: 'primary',
          access_token: encryptToken('access-only'), refresh_token: null,
          is_active: true, created_at: now, updated_at: now,
        },
      });
      expect(conn.access_token).toBeTruthy();
      expect(conn.refresh_token).toBeNull();

      await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');

      expect(g.calls).toEqual([]);
    });
  });

  it('the method body contains no revoke call at all', () => {
    /*
     * A guard against re-introduction rather than a behavioural test. The two cases above prove the
     * line is gone for the inputs they use; this one is what fails if somebody adds it back behind
     * a condition those inputs happen not to reach.
     */
    const body = GoogleConnectionService.prototype.disconnect.toString();
    expect(body).not.toMatch(/\.revoke\s*\(/);
  });
});

describe('2. Gmail is untouched by a Calendar disconnect', () => {
  it('leaves the mailbox row byte-for-byte identical', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      const email = 'shared@gethomerealty.test';
      // Gmail and Calendar on the SAME Google account — the arrangement that made revoke dangerous.
      const before = await connectGmail(tx, user.id, email);
      await connectWithTokens(tx, user.id, 'crm', email);

      await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');

      const after = await tx.mail_accounts.findUnique({ where: { id: before.id } });
      expect(after).toEqual(before);              // nothing rewritten, including updated_at
      expect(after!.password).toBe(before.password);
      expect(after!.is_active).toBe(true);
      expect(after!.inbound_enabled).toBe(true);
      expect(g.calls).toEqual([]);
    });
  });

  it('does not delete the mailbox, and leaves the user\'s other mailboxes alone', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      await connectGmail(tx, user.id, 'shared@gethomerealty.test');
      await connectGmail(tx, user.id, 'second@gethomerealty.test');
      await connectWithTokens(tx, user.id, 'crm', 'shared@gethomerealty.test');

      await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');

      const mailboxes = await tx.mail_accounts.findMany({ where: { user_id: user.id } });
      expect(mailboxes).toHaveLength(2);
      expect(mailboxes.every((m) => m.is_active)).toBe(true);
      /*
       * Asserted here too, and the reason is worth stating: revoke does its damage AT GOOGLE, not
       * in this database. Row counts and flags look identical either way — this was the one test in
       * the file that still passed against the buggy code. Only the spy can see the difference.
       */
      expect(g.calls).toEqual([]);
    });
  });
});

describe('3. one Calendar area does not disconnect the other', () => {
  it('CRM disconnect leaves the Desk connection and its token intact', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      const email = 'shared@gethomerealty.test';
      await connectWithTokens(tx, user.id, 'crm', email);
      // Same Google account, same OAuth client, different area — the case revoke could not survive.
      const desk = await connectWithTokens(tx, user.id, 'desk', email);

      await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');

      expect(await tx.google_connections.findUnique({ where: { user_id_scope: { user_id: user.id, scope: 'crm' } } })).toBeNull();
      const after = await tx.google_connections.findUnique({ where: { user_id_scope: { user_id: user.id, scope: 'desk' } } });
      expect(after).toEqual(desk);
      expect(after!.is_active).toBe(true);
      // The stored credential still decrypts to what it was — not merely present, unchanged.
      expect(decryptToken(after!.refresh_token!)).toBe(decryptToken(desk.refresh_token!));
      expect(g.calls).toEqual([]);
    });
  });

  it('Desk disconnect leaves the CRM connection and its token intact', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      const email = 'shared@gethomerealty.test';
      const crm = await connectWithTokens(tx, user.id, 'crm', email);
      await connectWithTokens(tx, user.id, 'desk', email);

      await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'desk');

      expect(await tx.google_connections.findUnique({ where: { user_id_scope: { user_id: user.id, scope: 'desk' } } })).toBeNull();
      const after = await tx.google_connections.findUnique({ where: { user_id_scope: { user_id: user.id, scope: 'crm' } } });
      expect(after).toEqual(crm);
      expect(decryptToken(after!.refresh_token!)).toBe(decryptToken(crm.refresh_token!));
      expect(g.calls).toEqual([]);
    });
  });

  it('the whole arrangement survives: Gmail + CRM + Desk, disconnect CRM, two remain', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      const email = 'shared@gethomerealty.test';
      const gmail = await connectGmail(tx, user.id, email);
      await connectWithTokens(tx, user.id, 'crm', email);
      const desk = await connectWithTokens(tx, user.id, 'desk', email);

      await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');

      // Exactly the outcome the brief asks for, asserted as one statement.
      expect(await tx.google_connections.findUnique({ where: { user_id_scope: { user_id: user.id, scope: 'crm' } } })).toBeNull();
      expect(await tx.google_connections.findUnique({ where: { user_id_scope: { user_id: user.id, scope: 'desk' } } })).toEqual(desk);
      expect(await tx.mail_accounts.findUnique({ where: { id: gmail.id } })).toEqual(gmail);
      expect(g.calls).toEqual([]);
    });
  });
});

describe('4. one user does not disconnect another', () => {
  it('leaves a second agent on the SAME Google account fully connected', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const email = 'shared@gethomerealty.test';
      const a = await makeUser(tx, 'AgentA');
      const b = await makeUser(tx, 'AgentB');
      await connectWithTokens(tx, a.id, 'crm', email);
      // Same Google account as A. Revoking A's grant would have taken B's with it.
      const bConn = await connectWithTokens(tx, b.id, 'crm', email);
      const bMail = await connectGmail(tx, b.id, email);

      await new GoogleConnectionService(tx, g.svc).disconnect(a.id, 'crm');

      expect(await tx.google_connections.findUnique({ where: { user_id_scope: { user_id: b.id, scope: 'crm' } } })).toEqual(bConn);
      expect(await tx.mail_accounts.findUnique({ where: { id: bMail.id } })).toEqual(bMail);
      expect(g.calls).toEqual([]);
    });
  });
});

describe('5. the local disconnect still does its job', () => {
  it('removes only that row, hides only that area\'s Google events, keeps native ones', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      await connectWithTokens(tx, user.id, 'crm', 'shared@gethomerealty.test');
      const gid = `g-${tag()}`;
      await sync(tx, g)['applyGoogleEvent'](user.id, googleEvent(gid, 'Google showing'), 'crm');

      const now = new Date();
      const own = await tx.calendar_events.create({
        data: {
          title: 'My own appointment', date: new Date('2026-09-11T00:00:00Z'), time: '10:00',
          type: 'meeting', status: 'scheduled', domain: 'crm', user_id: user.id,
          created_by: user.name,                       // the agent's, not Google's
          google_calendar_id: `pushed-${tag()}`,       // mirrored out, so it HAS a Google id
          created_at: now, updated_at: now,
        },
      });

      const { hidden } = await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');

      expect(hidden).toBe(1);
      const pulled = await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } });
      expect(pulled!.deleted_at).not.toBeNull();
      expect(pulled!.google_disconnected_at).not.toBeNull();   // the marker a reconnect restores by
      expect(pulled!.created_by).toBe(GOOGLE_ORIGIN_CREATED_BY);

      const mine = await tx.calendar_events.findUnique({ where: { id: own.id } });
      expect(mine!.deleted_at).toBeNull();                     // the agent's own work, untouched
      expect(g.calls).toEqual([]);
    });
  });

  it('is idempotent — disconnecting again is a no-op, not an error', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      await connectWithTokens(tx, user.id, 'crm', 'shared@gethomerealty.test');
      await sync(tx, g)['applyGoogleEvent'](user.id, googleEvent(`g-${tag()}`, 'Google showing'), 'crm');

      const first = await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');
      const second = await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');
      const third = await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');

      expect(first.hidden).toBe(1);
      expect(second).toEqual({ hidden: 0 });   // returns early: there is no row to disconnect
      expect(third).toEqual({ hidden: 0 });
      expect(g.calls).toEqual([]);
    });
  });
});

describe('6. reconnecting after a local-only disconnect', () => {
  it('restores the hidden events in place and creates no duplicate connection row', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      const email = 'shared@gethomerealty.test';
      await connectWithTokens(tx, user.id, 'crm', email);
      const gid = `g-${tag()}`;
      await sync(tx, g)['applyGoogleEvent'](user.id, googleEvent(gid, 'Google showing'), 'crm');
      const idBefore = (await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } }))!.id;

      await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');

      // Reconnect through the real consent path. Google still holds the grant — nothing revoked it
      // — so this is a consent the user clicks through rather than a fresh authorisation.
      await new GoogleConnectionService(tx, g.svc).save(
        user.id, { access_token: 'fresh-access', refresh_token: '1//fresh-refresh', expires_in: 3600 }, email, 'crm',
      );
      await sync(tx, g)['applyGoogleEvent'](user.id, googleEvent(gid, 'Google showing'), 'crm');

      const rows = await tx.google_connections.findMany({ where: { user_id: user.id, scope: 'crm' } });
      expect(rows).toHaveLength(1);            // upserted, not a second connection
      expect(rows[0].is_active).toBe(true);
      expect(rows[0].connect_error).toBeNull();

      const events = await tx.calendar_events.findMany({ where: { google_calendar_id: gid } });
      expect(events).toHaveLength(1);          // the same row reused, not a copy beside it
      expect(events[0].id).toBe(idBefore);
      expect(events[0].deleted_at).toBeNull();
      expect(events[0].google_disconnected_at).toBeNull();
      expect(g.calls).toEqual([]);
    });
  });

  it('repeated reconnects do not accumulate rows or lose the refresh token', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      const email = 'shared@gethomerealty.test';
      const svc = new GoogleConnectionService(tx, g.svc);

      await svc.save(user.id, { access_token: 'a1', refresh_token: '1//keep-me', expires_in: 3600 }, email, 'crm');
      await svc.disconnect(user.id, 'crm');
      await svc.save(user.id, { access_token: 'a2', refresh_token: '1//keep-me', expires_in: 3600 }, email, 'crm');
      // Google omits the refresh token on a repeat consent; `save` must preserve the stored one.
      await svc.save(user.id, { access_token: 'a3', expires_in: 3600 }, email, 'crm');

      const rows = await tx.google_connections.findMany({ where: { user_id: user.id } });
      expect(rows).toHaveLength(1);
      expect(decryptToken(rows[0].refresh_token!)).toBe('1//keep-me');
      expect(decryptToken(rows[0].access_token!)).toBe('a3');
      expect(g.calls).toEqual([]);
    });
  });

  it('does not resurrect an event the agent deleted themselves', async () => {
    await inRollback(async (tx) => {
      const g = spyGoogle();
      const user = await makeUser(tx);
      const email = 'shared@gethomerealty.test';
      await connectWithTokens(tx, user.id, 'crm', email);
      const gid = `g-${tag()}`;
      await sync(tx, g)['applyGoogleEvent'](user.id, googleEvent(gid, 'Google showing'), 'crm');

      // Deleted by the agent: `deleted_at` set, but NO `google_disconnected_at` marker. That
      // distinction is the whole restore rule, and a disconnect must not blur it.
      const row = (await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } }))!;
      await tx.calendar_events.update({ where: { id: row.id }, data: { deleted_at: new Date() } });

      await new GoogleConnectionService(tx, g.svc).disconnect(user.id, 'crm');
      await new GoogleConnectionService(tx, g.svc).save(
        user.id, { access_token: 'fresh', refresh_token: '1//fresh', expires_in: 3600 }, email, 'crm',
      );
      await sync(tx, g)['applyGoogleEvent'](user.id, googleEvent(gid, 'Google showing'), 'crm');

      const after = await tx.calendar_events.findUnique({ where: { id: row.id } });
      expect(after!.deleted_at).not.toBeNull();     // still gone, as the agent intended
      expect(g.calls).toEqual([]);
    });
  });
});
