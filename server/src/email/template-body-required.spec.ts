import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EmailTemplateService, hasVisibleContent } from './email-template.service';

/**
 * CRM-041: an automatic customer email cannot be saved with nothing in it.
 *
 * WHY THE OLD CHECK PASSED. The validator asked whether `body_html` was the empty string. Clearing
 * the message in the editor leaves `<br>` behind — what a rich-text field yields when emptied — and
 * `'<br>' !== ''`, so the save went through with no refusal and no message. These fourteen
 * templates send on their own initiative to real clients; an empty one is a message from the
 * brokerage with a subject line and nothing under it.
 *
 * THE RULE IS "WOULD A READER SEE ANYTHING", not "does the string have characters". That is the
 * only version of the rule that catches `<br>`, `<p>&nbsp;</p>` and an empty `<div>` — which are
 * all identical to the person receiving them.
 *
 * AN IMAGE COUNTS, and this is the case most likely to be got wrong by a stricter rule. A template
 * that is one banner and nothing else is legitimate, and refusing it would turn a fix for empty
 * emails into a refusal of real ones — the worse failure of the two, because it stops somebody
 * doing their job rather than merely letting a mistake through.
 */

describe('what counts as an empty email body', () => {
  it('accepts ordinary content', () => {
    expect(hasVisibleContent('<p>Dear {{LEAD_NAME}}, welcome aboard.</p>')).toBe(true);
    expect(hasVisibleContent('Plain text with no markup at all')).toBe(true);
  });

  it('refuses what a cleared editor leaves behind', () => {
    // THE DEFECT: every one of these was stored as a live template body.
    for (const blank of ['', '   ', '<br>', '<br/>', '<br />', '<p></p>', '<div></div>', '<p>&nbsp;</p>', '<p> </p><br>']) {
      expect({ blank, visible: hasVisibleContent(blank) }).toEqual({ blank, visible: false });
    }
  });

  it('accepts a body that is only an image', () => {
    expect(hasVisibleContent('<img src="https://example.test/banner.png" alt="">')).toBe(true);
    expect(hasVisibleContent('<div><img src="cid:banner"></div>')).toBe(true);
  });

  it('does not count markup or invisible content as content', () => {
    // A style block is not a message, however many characters it holds.
    expect(hasVisibleContent('<style>p { color: red; }</style>')).toBe(false);
    expect(hasVisibleContent('<script>var x = 1;</script>')).toBe(false);
  });

  it('accepts an escaped entity, which is a real character to the reader', () => {
    // `&amp;` renders as "&" — one visible character, and the body is not empty.
    expect(hasVisibleContent('<p>&amp;</p>')).toBe(true);
  });

  it('handles nothing at all without throwing', () => {
    expect(hasVisibleContent(null)).toBe(false);
    expect(hasVisibleContent(undefined)).toBe(false);
  });
});

// --------------------------------------------------------------------- the save path
/*
 * The helper above is the rule. This is the rule actually being enforced where it matters: the
 * screen's check is a courtesy, and CRM-040 showed a save arriving through a path that skipped the
 * screen entirely. A template that reaches the database empty is the failure being prevented.
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
  const settings = { current: async () => ({ name: 'ZZ Brokerage' }) } as never;
  return new EmailTemplateService(tx, settings, null as never);
}

async function makeTemplate(tx: PrismaService) {
  const t = tag();
  const now = new Date();
  return tx.email_templates.create({
    data: {
      event_key: `zz.body.${t}`, module: 'crm', name: `ZZ Body ${t}`,
      subject: 'Original subject', body_html: '<p>Original body</p>',
      is_active: false, created_at: now, updated_at: now,
    },
  });
}

const storedBody = async (tx: PrismaService, id: number) =>
  (await tx.email_templates.findUnique({ where: { id }, select: { body_html: true } }))?.body_html;

describe('saving an automatic customer template', () => {
  it('refuses a body the editor only appears to have filled', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      // THE DEFECT: `<br>` is what the rich-text field leaves when you clear it, and the old check
      // asked only whether the string was empty — so this saved.
      await expect(svc(tx).update(t.id, { subject: 'Still here', body_html: '<br>' }))
        .rejects.toBeDefined();
      expect(await storedBody(tx, t.id)).toBe('<p>Original body</p>');
    });
  });

  it('names the body as the field at fault', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      // A refusal that does not say which field is wrong sends the author hunting.
      const err = await svc(tx).update(t.id, { subject: 'Still here', body_html: '<p>&nbsp;</p>' })
        .then(() => null, (e: unknown) => e);
      expect(JSON.stringify(err)).toContain('body_html');
    });
  });

  it('still saves an ordinary edit', async () => {
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      await svc(tx).update(t.id, { subject: 'New subject', body_html: '<p>New body</p>' });
      expect(await storedBody(tx, t.id)).toBe('<p>New body</p>');
    });
  });

  it('saves a template whose whole body is a banner', async () => {
    // The case a stricter "must contain words" rule would have broken.
    await inRollback(async (tx) => {
      const t = await makeTemplate(tx);
      const banner = '<img src="https://example.test/banner.png" alt="Season greetings">';
      await svc(tx).update(t.id, { subject: 'Seasonal', body_html: banner });
      expect(await storedBody(tx, t.id)).toBe(banner);
    });
  });
});
