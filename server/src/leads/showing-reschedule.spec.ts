import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadActivityService } from './lead-activity.service';

/**
 * CRM-042: rescheduling a showing moves it.
 *
 * WHAT THE BUTTON DID. `Reschedule` sent `{ status: 'scheduled' }` and nothing else, so a completed
 * showing came back as Scheduled at the slot it already had. That is un-completing, not
 * rescheduling - and since it was the only control on a showing that mentioned moving one, an agent
 * needing to shift a viewing had nowhere to go. The date and time boxes above the list belong to
 * the ADD form, so using them creates a SECOND showing; the workaround left is delete and recreate,
 * which throws the original record away.
 *
 * THE SERVER COULD ALREADY DO THIS. `updateShowing` has accepted `showing_date` and `time` all
 * along - the screen simply never sent them. So these tests pin two things: that the endpoint moves
 * a showing when asked, which is what the dialog now relies on, and that the audit entry says what
 * moved rather than only where it ended up.
 *
 * THE UNCHANGED CASE IS DELIBERATE, not an oversight. Confirming the dialog without editing
 * anything sends the current slot back and returns the showing to Scheduled - exactly the old
 * behaviour - so undoing a mis-clicked Complete still works. That case must not produce a "moved"
 * audit entry, because nothing moved.
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

/** The audit entries this service wrote, newest first. */
const recorded: { action: string; detail: string }[] = [];

function svc(tx: PrismaService) {
  const access = { assertLead: async () => undefined } as never;
  const audit = {
    record: async (_u: unknown, action: string, _t: unknown, detail?: string) => {
      recorded.unshift({ action, detail: detail ?? '' });
    },
  } as never;
  return new LeadActivityService(
    access, tx, audit,
    {} as never, {} as never, {} as never, {} as never,
  );
}

const USER = { id: 1, name: 'ZZ Tester', role: 'admin' } as never;

async function makeShowing(tx: PrismaService) {
  const t = tag();
  const lead = await tx.leads.create({
    data: { name: `ZZ Showing Lead ${t}`, email: `zz-showing-${t}@test.local`, created_at: new Date(), updated_at: new Date() },
  });
  const showing = await tx.lead_showings.create({
    data: {
      lead_id: lead.id, showing_date: new Date('2026-09-10T00:00:00Z'), time: '12:00',
      property: `ZZ Property ${t}`, status: 'completed', created_at: new Date(), updated_at: new Date(),
    },
  });
  return { lead, showing };
}

const reload = (tx: PrismaService, id: number) =>
  tx.lead_showings.findUnique({ where: { id }, select: { showing_date: true, time: true, status: true } });

beforeEach(() => { recorded.length = 0; });

describe('rescheduling a showing', () => {
  it('moves it to the new date and time and returns it to scheduled', async () => {
    await inRollback(async (tx) => {
      const { lead, showing } = await makeShowing(tx);

      await svc(tx).updateShowing(lead.id, showing.id, {
        showing_date: '2026-09-17', time: '15:30', status: 'scheduled',
      }, USER);

      // THE DEFECT: this came back 2026-09-10 at 12:00, the slot it already had.
      const after = await reload(tx, showing.id);
      expect(after?.showing_date.toISOString().slice(0, 10)).toBe('2026-09-17');
      expect(after?.time).toBe('15:30');
      expect(after?.status).toBe('scheduled');
    });
  });

  it('records what it moved from, not just where it ended up', async () => {
    await inRollback(async (tx) => {
      const { lead, showing } = await makeShowing(tx);

      await svc(tx).updateShowing(lead.id, showing.id, {
        showing_date: '2026-09-17', time: '15:30', status: 'scheduled',
      }, USER);

      // "Status: scheduled" alone cannot answer "when was this viewing before somebody changed it".
      expect(recorded[0].detail).toContain('2026-09-10 12:00');
      expect(recorded[0].detail).toContain('2026-09-17 15:30');
    });
  });

  it('still reopens a mis-clicked showing when nothing is changed', async () => {
    /*
     * The old behaviour, which the dialog keeps: confirming without editing sends the current slot
     * and the showing returns to Scheduled unmoved. This is the case an agent hits after pressing
     * Complete by accident, and it must not need a delete to undo.
     */
    await inRollback(async (tx) => {
      const { lead, showing } = await makeShowing(tx);

      await svc(tx).updateShowing(lead.id, showing.id, {
        showing_date: '2026-09-10', time: '12:00', status: 'scheduled',
      }, USER);

      const after = await reload(tx, showing.id);
      expect(after?.showing_date.toISOString().slice(0, 10)).toBe('2026-09-10');
      expect(after?.time).toBe('12:00');
      expect(after?.status).toBe('scheduled');
    });
  });

  it('does not claim a move when nothing moved', async () => {
    await inRollback(async (tx) => {
      const { lead, showing } = await makeShowing(tx);

      await svc(tx).updateShowing(lead.id, showing.id, {
        showing_date: '2026-09-10', time: '12:00', status: 'scheduled',
      }, USER);

      expect(recorded[0].detail).toBe('Status: scheduled');
      expect(recorded[0].detail).not.toContain('Moved');
    });
  });

  it('leaves a plain status change alone', async () => {
    // Complete and Cancel send only a status and must keep behaving exactly as they did.
    await inRollback(async (tx) => {
      const { lead, showing } = await makeShowing(tx);

      await svc(tx).updateShowing(lead.id, showing.id, { status: 'cancelled' }, USER);

      const after = await reload(tx, showing.id);
      expect(after?.status).toBe('cancelled');
      expect(after?.showing_date.toISOString().slice(0, 10)).toBe('2026-09-10');
      expect(after?.time).toBe('12:00');
      expect(recorded[0].detail).toBe('Status: cancelled');
    });
  });

  it('refuses a time that is not a real time', async () => {
    await inRollback(async (tx) => {
      const { lead, showing } = await makeShowing(tx);

      await expect(svc(tx).updateShowing(lead.id, showing.id, {
        showing_date: '2026-09-17', time: '25:99', status: 'scheduled',
      }, USER)).rejects.toBeDefined();

      // Nothing half-applied: the date must not move on a request that was refused.
      const after = await reload(tx, showing.id);
      expect(after?.showing_date.toISOString().slice(0, 10)).toBe('2026-09-10');
      expect(after?.status).toBe('completed');
    });
  });
});
