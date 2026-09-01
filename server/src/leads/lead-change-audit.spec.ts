import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';
import { LeadAuditService } from './lead-audit.service';
import { LeadNotificationService } from './lead-notification.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * CRM-006: a change to a lead has to say what it changed FROM.
 *
 * WHAT WAS ALREADY TRUE, and why this is not a duplicate. Lead edits have been written to the
 * audit trail for some time - who, when, and which field. That is most of the way there, and it is
 * why the original "no trace at all" finding does not describe this code.
 *
 * WHAT WAS MISSING is the part a dispute actually turns on. A row reading `Changed: lead_status`
 * cannot answer whether a live client was quietly marked cold, or whether a phone number was
 * corrected or replaced. `audit_logs` has carried `field`, `old_value` and `new_value` all along
 * and the Audit Trail screen renders each as its own column; the lead writer left them empty and
 * put the lead's NAME in `new_value`, so the New value column showed a person rather than a value.
 *
 * THE ROWS ARE READ BACK FROM THE DATABASE rather than captured from a stubbed audit service. A
 * stub would assert what this code MEANT to write; the columns are the evidence a broker is
 * actually shown, and the previous shape passed every test that only checked a call was made.
 *
 * Everything runs inside a rolled-back transaction, so no real record or audit row is touched.
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

const USER = { id: 1, name: 'Audit Tester', role: 'admin' } as unknown as AuthUserRecord;

function leadsFor(tx: PrismaService) {
  return new LeadsService(tx, new LeadAuditService(tx), new LeadNotificationService(tx, null as never));
}

async function makeLead(tx: PrismaService, over: Record<string, unknown> = {}) {
  const t = tag();
  const now = new Date();
  return tx.leads.create({
    data: {
      name: `ZZ Audit ${t}`, email: `zz-audit-${t}@probe.test`, phone: '4165550000',
      lead_status: 'warm', owner_user_id: USER.id, assigned_to: USER.id,
      created_at: now, updated_at: now, ...over,
    },
  });
}

/** The audit rows this lead produced, newest last. */
async function rowsFor(tx: PrismaService, name: string) {
  return tx.audit_logs.findMany({
    where: { category: 'Lead', new_value: { not: null }, details: { contains: name } },
    orderBy: { id: 'asc' },
    select: { action: true, field: true, old_value: true, new_value: true, details: true, who: true },
  });
}

describe('a changed lead field records what it changed from', () => {
  it('writes the field, the old value and the new one', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      await leadsFor(tx).update(lead.id, { lead_status: 'cold' }, USER);

      const rows = (await rowsFor(tx, lead.name)).filter((r) => r.action === 'Lead updated');
      expect(rows).toHaveLength(1);
      expect(rows[0].field).toBe('lead_status');
      // THE DEFECT: old_value was null and new_value held the lead's NAME.
      expect(rows[0].old_value).toBe('warm');
      expect(rows[0].new_value).toBe('cold');
      expect(rows[0].who).toBe('Audit Tester');
      expect(rows[0].details).toMatch(/warm to cold/);
    });
  });

  it('writes one row per field when several move at once', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      await leadsFor(tx).update(lead.id, { lead_status: 'hot', phone: '4165551111' }, USER);

      const rows = (await rowsFor(tx, lead.name)).filter((r) => r.action === 'Lead updated');
      const byField = Object.fromEntries(rows.map((r) => [r.field, r]));
      expect(Object.keys(byField).sort()).toEqual(['lead_status', 'phone']);
      expect(byField.lead_status.old_value).toBe('warm');
      expect(byField.phone.old_value).toBe('4165550000');
      expect(byField.phone.new_value).toBe('4165551111');
    });
  });

  it('records an empty value as empty rather than losing the row', async () => {
    // Clearing a phone number is exactly the change somebody would later deny making.
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      await leadsFor(tx).update(lead.id, { phone: '' }, USER);

      const row = (await rowsFor(tx, lead.name)).find((r) => r.field === 'phone');
      expect(row).toBeTruthy();
      expect(row!.old_value).toBe('4165550000');
      expect(row!.details).toMatch(/to \(empty\)/);
    });
  });

  it('still records a save that changed nothing', async () => {
    await inRollback(async (tx) => {
      const lead = await makeLead(tx);
      await leadsFor(tx).update(lead.id, { lead_status: 'warm' }, USER);

      const rows = (await rowsFor(tx, lead.name)).filter((r) => r.action === 'Lead updated');
      expect(rows).toHaveLength(1);
      expect(rows[0].details).toMatch(/No field values changed/);
      expect(rows[0].field).toBeNull();
    });
  });

  it('leaves create and delete rows in the shape they already had', async () => {
    // Nothing changed FROM anything on those, so old_value stays null and the subject stays in
    // new_value. Asserted so the fix cannot quietly reshape rows it was not meant to touch.
    await inRollback(async (tx) => {
      const svc = leadsFor(tx);
      const t = tag();
      const created = await svc.create({
        name: `ZZ Audit ${t}`, email: `zz-audit-${t}@probe.test`, phone: '4165550000',
      } as never, USER);

      const rows = await rowsFor(tx, `ZZ Audit ${t}`);
      const createRow = rows.find((r) => r.action === 'Lead created');
      expect(createRow).toBeTruthy();
      expect(createRow!.old_value).toBeNull();
      expect(createRow!.new_value).toBe(`ZZ Audit ${t}`);

      await svc.remove((created as { id: number }).id, USER);
      const del = (await rowsFor(tx, `ZZ Audit ${t}`)).find((r) => r.action === 'Lead deleted');
      expect(del).toBeTruthy();
      expect(del!.old_value).toBeNull();
    });
  });
});
