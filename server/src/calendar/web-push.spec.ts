import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { WebPushService } from './web-push.service';
import { NotificationPreferenceService } from '../notifications/notification-preference.service';
import webpush from 'web-push';

/**
 * Browser push subscriptions.
 *
 * Nothing here talks to a real push service — the interesting behaviour is what happens to the rows
 * when one answers, and every answer worth handling is a failure. A browser that has been wiped must
 * stop being pushed to for ever after; a browser that is merely off must not be dropped on the first
 * bad evening; and none of it may throw, because the reminder email has already gone out by then.
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

const tag = (): string => { seq += 1; return `${Date.now()}-${seq}`; };

async function makeUser(tx: PrismaService) {
  const now = new Date();
  const t = tag();
  return tx.users.create({
    data: { name: `Push User ${t}`, email: `push-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
}

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-secret' } });

/** The push service's answer, as web-push reports it: a status code on the thrown error. */
const httpFail = (statusCode: number) => Object.assign(new Error(`push failed ${statusCode}`), { statusCode });

let sendSpy: jest.SpyInstance;

beforeAll(() => {
  process.env.VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BATSRRYY5HBAVnLwFOLdaD1Uc8582C9j36aGkwFRY5G56SVqk-iR_2yzPGcByaRgvxqnfiVenxnrdJdeb4MWwGA';
  process.env.VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '9RdM0KBKiZYOrpyGIzwOsXyVrlNoWSB6a7xRAnuwCHI';
  process.env.VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:test@example.test';
});

beforeEach(() => { sendSpy = jest.spyOn(webpush, 'sendNotification'); });
afterEach(() => { sendSpy.mockRestore(); });

// The real preference service, on the same rolled-back transaction, so these tests exercise the
// production path rather than a stub: with no preference rows written, every category is enabled
// and sending behaves exactly as it did before preferences existed. The suppression case has its
// own coverage in notification-preference.spec.ts.
const svc = (tx: PrismaService) => new WebPushService(tx, new NotificationPreferenceService(tx));
const rows = (tx: PrismaService, userId: number) => tx.push_subscriptions.findMany({ where: { user_id: userId } });

describe('subscribing a browser', () => {
  it('records the endpoint and its keys', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/${tag()}`), 'crm', 'Chrome on Windows');

      const [row] = await rows(tx, u.id);
      expect(row).toMatchObject({ p256dh: 'p256dh-key', auth: 'auth-secret', scope: 'crm', failures: 0 });
    });
  });

  it('subscribing the same browser again updates it rather than doubling the reminders', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const endpoint = `https://push.test/${tag()}`;
      await svc(tx).subscribe(u.id, sub(endpoint), 'crm', 'Chrome');
      await svc(tx).subscribe(u.id, { endpoint, keys: { p256dh: 'new-key', auth: 'new-auth' } }, 'desk', 'Chrome');

      const all = await rows(tx, u.id);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ p256dh: 'new-key', scope: 'desk' });
    });
  });

  it('re-subscribing clears the failure count, because the browser is plainly reachable again', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const endpoint = `https://push.test/${tag()}`;
      const s = await svc(tx).subscribe(u.id, sub(endpoint), 'crm', null);
      await tx.push_subscriptions.update({ where: { id: s.id }, data: { failures: 3 } });

      await svc(tx).subscribe(u.id, sub(endpoint), 'crm', null);
      expect((await rows(tx, u.id))[0].failures).toBe(0);
    });
  });

  it('hands a shared device to whoever subscribes on it now', async () => {
    await inRollback(async (tx) => {
      const first = await makeUser(tx);
      const second = await makeUser(tx);
      const endpoint = `https://push.test/${tag()}`;
      await svc(tx).subscribe(first.id, sub(endpoint), 'crm', null);
      await svc(tx).subscribe(second.id, sub(endpoint), 'crm', null);

      expect(await rows(tx, first.id)).toHaveLength(0);
      expect(await rows(tx, second.id)).toHaveLength(1);
    });
  });

  it('forgets a browser on request, and does not complain the second time', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const endpoint = `https://push.test/${tag()}`;
      await svc(tx).subscribe(u.id, sub(endpoint), 'crm', null);

      expect(await svc(tx).unsubscribe(u.id, endpoint)).toEqual({ removed: 1 });
      expect(await svc(tx).unsubscribe(u.id, endpoint)).toEqual({ removed: 0 });
    });
  });

  it('will not let one person unsubscribe another\'s device', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const endpoint = `https://push.test/${tag()}`;
      await svc(tx).subscribe(theirs.id, sub(endpoint), 'crm', null);

      expect(await svc(tx).unsubscribe(mine.id, endpoint)).toEqual({ removed: 0 });
      expect(await rows(tx, theirs.id)).toHaveLength(1);
    });
  });
});

describe('sending', () => {
  it('sends to every browser one person has subscribed', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/a-${tag()}`), 'crm', 'Laptop');
      await svc(tx).subscribe(u.id, sub(`https://push.test/b-${tag()}`), 'crm', 'Phone');
      sendSpy.mockResolvedValue({} as never);

      const r = await svc(tx).sendToUser(u.id, { title: 'Showing at 4', body: '12 Elm St' });
      expect(r).toEqual({ sent: 2, failed: 0, removed: 0 });
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('never sends to somebody else\'s browser', async () => {
    await inRollback(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      await svc(tx).subscribe(theirs.id, sub(`https://push.test/${tag()}`), 'crm', null);
      sendSpy.mockResolvedValue({} as never);

      expect(await svc(tx).sendToUser(mine.id, { title: 'x', body: 'y' })).toEqual({ sent: 0, failed: 0, removed: 0 });
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  it('sends the payload the service worker expects, and lets it expire', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/${tag()}`), 'crm', null);
      sendSpy.mockResolvedValue({} as never);

      await svc(tx).sendToUser(u.id, { title: 'In 1 hour: Showing', body: '16:00', tag: 'event-9', url: '/crm/calendar' });
      const [, body, opts] = sendSpy.mock.calls[0];
      expect(JSON.parse(body as string)).toEqual({ title: 'In 1 hour: Showing', body: '16:00', tag: 'event-9', url: '/crm/calendar' });
      // A reminder is worthless after the appointment — it must not sit in a queue overnight.
      expect((opts as { TTL: number }).TTL).toBe(6 * 60 * 60);
    });
  });

  it('marks a browser as used when a push lands', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const s = await svc(tx).subscribe(u.id, sub(`https://push.test/${tag()}`), 'crm', null);
      await tx.push_subscriptions.update({ where: { id: s.id }, data: { failures: 2 } });
      sendSpy.mockResolvedValue({} as never);

      await svc(tx).sendToUser(u.id, { title: 'x', body: 'y' });
      const [row] = await rows(tx, u.id);
      expect(row.failures).toBe(0);
      expect(row.last_used_at).toBeTruthy();
    });
  });

  it('sends nothing at all when push is not configured', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/${tag()}`), 'crm', null);
      const key = process.env.VAPID_PRIVATE_KEY;
      process.env.VAPID_PRIVATE_KEY = '';
      try {
        expect(await svc(tx).sendToUser(u.id, { title: 'x', body: 'y' })).toEqual({ sent: 0, failed: 0, removed: 0 });
        expect(sendSpy).not.toHaveBeenCalled();
      } finally {
        process.env.VAPID_PRIVATE_KEY = key;
      }
    });
  });
});

describe('choosing which browsers to send to', () => {
  it('sends CRM reminders to the browsers subscribed from the CRM', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/crm-${tag()}`), 'crm', null);
      await svc(tx).subscribe(u.id, sub(`https://push.test/desk-${tag()}`), 'desk', null);
      sendSpy.mockResolvedValue({} as never);

      expect((await svc(tx).sendToUser(u.id, { title: 'x', body: 'y' }, 'crm')).sent).toBe(1);
    });
  });

  it('sends everything to a browser that predates the choice', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/${tag()}`), null, null);
      sendSpy.mockResolvedValue({} as never);

      expect((await svc(tx).sendToUser(u.id, { title: 'x', body: 'y' }, 'desk')).sent).toBe(1);
    });
  });
});

describe('when the push service refuses', () => {
  it.each([404, 410])('drops a browser the push service has forgotten (%i)', async (status) => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/${tag()}`), 'crm', null);
      sendSpy.mockRejectedValue(httpFail(status));

      const r = await svc(tx).sendToUser(u.id, { title: 'x', body: 'y' });
      expect(r).toEqual({ sent: 0, failed: 0, removed: 1 });
      // Gone for good — keeping the row would mean a failure logged every hour for ever.
      expect(await rows(tx, u.id)).toHaveLength(0);
    });
  });

  it('keeps a browser that is merely unreachable, and counts the failure', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/${tag()}`), 'crm', null);
      sendSpy.mockRejectedValue(httpFail(503));

      const r = await svc(tx).sendToUser(u.id, { title: 'x', body: 'y' });
      expect(r).toEqual({ sent: 0, failed: 1, removed: 0 });
      expect((await rows(tx, u.id))[0].failures).toBe(1);
    });
  });

  it('gives up on a browser that has failed five times running', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/${tag()}`), 'crm', null);
      sendSpy.mockRejectedValue(httpFail(500));

      const s = svc(tx);
      for (let i = 0; i < 4; i += 1) await s.sendToUser(u.id, { title: 'x', body: 'y' });
      expect((await rows(tx, u.id))[0].failures).toBe(4);

      const fifth = await s.sendToUser(u.id, { title: 'x', body: 'y' });
      expect(fifth.removed).toBe(1);
      expect(await rows(tx, u.id)).toHaveLength(0);
    });
  });

  it('one unreachable browser does not stop the others being told', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      const dead = `https://push.test/dead-${tag()}`;
      await svc(tx).subscribe(u.id, sub(dead), 'crm', null);
      await svc(tx).subscribe(u.id, sub(`https://push.test/live-${tag()}`), 'crm', null);
      sendSpy.mockImplementation((s: { endpoint: string }) =>
        s.endpoint === dead ? Promise.reject(httpFail(410)) : Promise.resolve({} as never));

      const r = await svc(tx).sendToUser(u.id, { title: 'x', body: 'y' });
      expect(r).toEqual({ sent: 1, failed: 0, removed: 1 });
    });
  });

  it('never throws — the reminder email has already gone by the time push runs', async () => {
    await inRollback(async (tx) => {
      const u = await makeUser(tx);
      await svc(tx).subscribe(u.id, sub(`https://push.test/${tag()}`), 'crm', null);
      // Not an HTTP answer at all: the network went away mid-send.
      sendSpy.mockRejectedValue(new Error('ECONNRESET'));

      await expect(svc(tx).sendToUser(u.id, { title: 'x', body: 'y' })).resolves.toEqual({ sent: 0, failed: 1, removed: 0 });
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
