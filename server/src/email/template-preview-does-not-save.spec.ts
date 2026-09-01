import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EmailTemplateService } from './email-template.service';

/**
 * CRM-040: Preview shows a template. It must not save one.
 *
 * WHAT IT DID. The editor's Preview button called save first — deliberately, with a comment saying
 * "save first so the preview reflects the current edits" — and then asked the server to render the
 * stored row. So pressing Preview committed unsaved edits to one of fourteen LIVE customer-facing
 * automatic templates: the welcome email, the birthday and anniversary greetings, seasonal wishes
 * and the rest. No confirmation, no toast, and the Save button still sitting there unpressed, which
 * is itself a statement that nothing was written.
 *
 * WORSE THAN A STRAY WRITE: the save it performed skipped the "subject and body are required" check
 * that the Save button applies, so clearing the body and pressing Preview stored an EMPTY template.
 * And because a template edit leaves no audit trail, there was no way afterwards to find what
 * changed or who did it.
 *
 * THE AUDIT SUSPECTED THIS AND NEVER CONFIRMED IT — it adopted a standing rule that no template be
 * previewed at all, and recorded nine acceptance criteria as BLOCKED rather than risk it. The
 * suspicion was right.
 *
 * THE PREVIEW IS STILL RENDERED BY THE SERVER, using the same renderer the real email uses. A
 * client-side preview would be a second implementation, free to drift from what actually goes out.
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

function svc(tx: PrismaService) {
  // Company settings supply the brokerage name used in the sample values; the mail-account service
  // is not reached by `preview` at all.
  const settings = { current: async () => ({ name: 'ZZ Brokerage' }) } as never;
  return new EmailTemplateService(tx, settings, null as never);
}

async function makeTemplate(tx: PrismaService) {
  const t = tag();
  const now = new Date();
  return tx.email_templates.create({
    data: {
      event_key: `zz.preview.${t}`, module: 'crm', name: `ZZ Preview ${t}`,
      subject: 'Original subject', body_html: '<p>Original body</p>',
      is_active: false, created_at: now, updated_at: now,
    },
  });
}

const stored = (tx: PrismaService, id: number) =>
  tx.email_templates.findUnique({ where: { id }, select: { subject: true, body_html: true } });

describe('previewing a template changes nothing', () => {
  it('renders the draft that was handed to it', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      const out = await svc(tx).preview(t.id, {
        subject: 'Edited subject', body_html: '<p>Edited body</p>',
      });
      expect(out.subject).toContain('Edited subject');
      expect(out.html).toContain('Edited body');
    });
  });

  it('leaves the stored template exactly as it was', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      await svc(tx).preview(t.id, { subject: 'Edited subject', body_html: '<p>Edited body</p>' });

      // THE DEFECT: this came back holding the edit, on a live customer-facing template.
      expect(await stored(tx, t.id)).toEqual({
        subject: 'Original subject', body_html: '<p>Original body</p>',
      });
    });
  });

  it('does not store an emptied body', async () => {
    /*
     * The compounding case. `doSave` skipped the validation the Save button applies, so clearing
     * the message and pressing Preview to see what was left stored the empty version — and the
     * preview pane rendered it without complaint.
     */
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      await svc(tx).preview(t.id, { subject: '', body_html: '' });
      expect(await stored(tx, t.id)).toEqual({
        subject: 'Original subject', body_html: '<p>Original body</p>',
      });
    });
  });

  it('previews what is stored when no draft is supplied', async () => {
    // The list screens preview by id alone and must keep working.
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      const out = await svc(tx).preview(t.id);
      expect(out.subject).toContain('Original subject');
      expect(out.html).toContain('Original body');
    });
  });

  it('falls back per field, so a partial draft is not half blank', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      const out = await svc(tx).preview(t.id, { subject: 'Only the subject changed' });
      expect(out.subject).toContain('Only the subject changed');
      expect(out.html).toContain('Original body');
    });
  });

  it('still refuses a template that does not exist', async () => {
    await inRollback(async (tx) => {
      await expect(svc(tx).preview(-1, { subject: 'x' })).rejects.toThrow();
    });
  });
});
