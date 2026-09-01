import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CrmCommunicationsService } from './crm-communications.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Removing a template from the CRM Template Library.
 *
 * TWO PROPERTIES CARRY THIS, and neither is obvious from the button.
 *
 * IT MUST NOT REACH THE OTHER PRODUCTS. `email_templates` is one table holding CRM templates,
 * Transaction Desk templates and campaign templates. They are managed on separate screens and were
 * deliberately never merged. A delete route on the CRM screen that accepts any id would let a
 * campaign template be removed by naming its number.
 *
 * DELETING A CONNECTED TEMPLATE DOES NOT SILENCE THE EMAIL. `CrmAdvancedEmailService.render`
 * re-creates a missing template from the built-in default on the next send, so removing a mapped one
 * RESETS ITS WORDING rather than stopping it. That is checked here rather than assumed, because the
 * screen's confirm text depends on it being true — and "deleted" reading as "this will stop going
 * out" is the wrong thing for somebody to believe about their brokerage's outgoing mail.
 *
 * Every case runs inside a rolled-back transaction, so nothing here touches real data.
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
const user = { id: 1, name: 'Aswini', role: 'admin' } as unknown as AuthUserRecord;

/** Only `prisma` is exercised by this method; the rest are inert. */
const svc = (tx: PrismaService) => new CrmCommunicationsService(tx, {} as never, {} as never, {} as never, {} as never);

async function makeTemplate(tx: PrismaService, over: { module?: string; event_key?: string; name?: string } = {}) {
  const now = new Date();
  const t = tag();
  return tx.email_templates.create({
    data: {
      event_key: over.event_key ?? `crm.draft.${Date.now()}.${seq}`,
      module: over.module ?? 'CRM',
      name: over.name ?? `Template ${t}`,
      subject: `Subject ${t}`, body_html: '<p>Body</p>',
      is_active: false, created_at: now, updated_at: now,
    },
  });
}

const auditCount = (tx: PrismaService, action: string) =>
  tx.audit_logs.count({ where: { action, section: 'CRM Communications' } });

// =================================================================================================

describe('deleting an unconnected draft', () => {
  it('removes it and reports that it was not connected', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);

      const res = await svc(tx).deleteTemplate(user, t.id);

      expect(res).toMatchObject({ deleted: true, was_connected: false, name: t.name });
      expect(await tx.email_templates.findUnique({ where: { id: t.id } })).toBeNull();
    });
  });

  it('records the deletion in the audit trail', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx, { name: 'Happy Closing' });
      const before = await auditCount(tx, 'CRM template deleted');

      await svc(tx).deleteTemplate(user, t.id);

      expect(await auditCount(tx, 'CRM template deleted')).toBe(before + 1);
      const entry = await tx.audit_logs.findFirst({
        where: { action: 'CRM template deleted', field: t.event_key },
        orderBy: { id: 'desc' },
      });
      // Which template went, and what it was called — the questions asked afterwards.
      expect(entry!.details).toContain('Happy Closing');
      expect(entry!.new_value).toBe('removed');
    });
  });

  it('takes its attachments with it', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      const att = await tx.email_template_attachments.create({
        data: {
          template_id: t.id, filename: 'brochure.pdf', content_type: 'application/pdf',
          size: 3, data: Buffer.from('pdf'), created_at: new Date(),
        },
      });

      await svc(tx).deleteTemplate(user, t.id);

      // `onDelete: Cascade`, and the bytes live in the database — so nothing is orphaned on disk.
      expect(await tx.email_template_attachments.findUnique({ where: { id: att.id } })).toBeNull();
    });
  });
});

describe('deleting a CONNECTED template', () => {
  it('reports that it was connected, so the screen can say the wording was reset', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx, { event_key: `crm.lead_welcome.${tag()}`, name: 'Welcome lead' });

      const res = await svc(tx).deleteTemplate(user, t.id);

      /*
       * The event keeps sending — the next send re-creates the row from the built-in default. The
       * caller needs to know which case this was, because "deleted" and "reset to the default
       * wording" are different things to have just done to the brokerage's outgoing mail.
       */
      expect(res.was_connected).toBe(true);
      expect(await tx.email_templates.findUnique({ where: { id: t.id } })).toBeNull();
    });
  });

  it('says in the audit trail that the default text now sends', async () => {
    await inRollback(async (tx) => {
      const key = `crm.lead_welcome.${tag()}`;
      const t = await makeTemplate(tx, { event_key: key });

      await svc(tx).deleteTemplate(user, t.id);

      const entry = await tx.audit_logs.findFirst({ where: { action: 'CRM template deleted', field: key }, orderBy: { id: 'desc' } });
      expect(entry!.new_value).toBe('reset to the built-in default');
      expect(entry!.details).toContain('built-in default');
    });
  });
});

describe('the other products are out of reach', () => {
  for (const module of ['Desk', 'Campaign']) {
    it(`refuses a ${module} template, which this screen does not manage`, async () => {
      await inRollback(async (tx) => {
        const other = await makeTemplate(tx, { module });

        /*
         * One table, three products. Without the `module: 'CRM'` narrowing, a Transaction Desk or
         * campaign template could be deleted from the CRM screen by naming its id — they were
         * deliberately never merged, and this is where that separation is enforced.
         */
        await expect(svc(tx).deleteTemplate(user, other.id)).rejects.toThrow(/no longer exists/i);
        expect(await tx.email_templates.findUnique({ where: { id: other.id } })).not.toBeNull();
      });
    });
  }

  it('refuses an id that does not exist', async () => {
    await inRollback(async (tx) => {
      await expect(svc(tx).deleteTemplate(user, 999_999_999)).rejects.toThrow(/no longer exists/i);
    });
  });

  it('leaves the other CRM templates alone', async () => {
    await inRollback(async (tx) => {
      const doomed = await makeTemplate(tx);
      const keep = await makeTemplate(tx);

      await svc(tx).deleteTemplate(user, doomed.id);

      expect(await tx.email_templates.findUnique({ where: { id: keep.id } })).not.toBeNull();
    });
  });
});
