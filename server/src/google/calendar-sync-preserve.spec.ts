import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';

/**
 * A Google pull must not undo the agent's work.
 *
 * The upsert wrote `type: 'meeting', status: 'scheduled'` on the update branch as well as the
 * create branch, so a showing marked Open House and Completed came back Meeting and Scheduled a few
 * minutes later, silently, on a schedule. Nearly every event in this database arrives from Google,
 * so that reverted almost the whole calendar's status history — proven at runtime before this test
 * existed, which is why it exists.
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
const sync = (tx: PrismaService) => new GoogleCalendarSyncService(tx, {} as never, {} as never);

const googleEvent = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'confirmed',
  summary: 'Property showing — 12 Elm St',
  location: '12 Elm St',
  description: 'Buyer viewing',
  start: { dateTime: '2026-09-10T14:00:00' },
  ...over,
});

async function makeUser(tx: PrismaService): Promise<number> {
  const now = new Date();
  const t = tag();
  const u = await tx.users.create({
    data: { name: `Sync User ${t}`, email: `sync-${t}@example.test`, role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now },
  });
  return u.id;
}

describe('pulling a Google event that already exists locally', () => {
  it('keeps the type and status the agent set', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const gid = `g-${tag()}`;
      const svc = sync(tx);

      await svc['applyGoogleEvent'](userId, googleEvent(gid), 'crm');
      const created = await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } });
      expect(created?.type).toBe('meeting');
      expect(created?.status).toBe('scheduled');

      // The agent works it: this is an open house, and it is done.
      await tx.calendar_events.update({
        where: { id: created!.id },
        data: { type: 'open-house', status: 'completed' },
      });

      // The next pull runs. Google still reports the same event.
      await svc['applyGoogleEvent'](userId, googleEvent(gid), 'crm');

      const after = await tx.calendar_events.findFirst({ where: { id: created!.id } });
      expect(after?.type).toBe('open-house');
      expect(after?.status).toBe('completed');
    });
  });

  it('still takes Google\'s word for the fields Google owns', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const gid = `g-${tag()}`;
      const svc = sync(tx);

      await svc['applyGoogleEvent'](userId, googleEvent(gid), 'crm');
      const created = await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } });

      // Moved and renamed in Google — that is what a sync is for.
      await svc['applyGoogleEvent'](userId, googleEvent(gid, {
        summary: 'Moved: showing at 14 Elm St', location: '14 Elm St', start: { dateTime: '2026-09-11T16:30:00' },
      }), 'crm');

      const after = await tx.calendar_events.findFirst({ where: { id: created!.id } });
      expect(after?.title).toBe('Moved: showing at 14 Elm St');
      expect(after?.location).toBe('14 Elm St');
      expect(after?.time).toBe('16:30');
      expect(after?.date.toISOString().slice(0, 10)).toBe('2026-09-11');
    });
  });

  it('sets the defaults on first arrival, when there is nothing to preserve', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const gid = `g-${tag()}`;
      await sync(tx)['applyGoogleEvent'](userId, googleEvent(gid), 'crm');

      const row = await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } });
      expect(row?.type).toBe('meeting');
      expect(row?.status).toBe('scheduled');
      expect(row?.created_by).toBe('Google Calendar');
    });
  });

  it('removes the local copy when Google cancels the event', async () => {
    await inRollback(async (tx) => {
      const userId = await makeUser(tx);
      const gid = `g-${tag()}`;
      const svc = sync(tx);
      await svc['applyGoogleEvent'](userId, googleEvent(gid), 'crm');
      await svc['applyGoogleEvent'](userId, googleEvent(gid, { status: 'cancelled' }), 'crm');

      const row = await tx.calendar_events.findFirst({ where: { google_calendar_id: gid } });
      expect(row?.deleted_at).toBeTruthy();
    });
  });
});

afterAll(async () => { await prisma.$disconnect(); });
