import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { CampaignsService, parseBodyMode, SIMPLE_MODE } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';
import { simpleEmailBody } from './simple-email';

/**
 * STANDARD CAMPAIGN AND SIMPLE EMAIL, THROUGH THE REAL SEND PATH.
 *
 * WHAT SIMPLE EMAIL IS. The same message, rendered as something typed rather than designed: the
 * author's words with the banners, buttons, tables and inline styling unwrapped, no open pixel, and
 * no click redirects. `simple-email.spec.ts` asserts the rendering; this file asserts what the SEND
 * does differently, and - far more important - everything it does NOT do differently.
 *
 * WHAT IT IS NOT, AND THESE TESTS ARE WRITTEN TO HOLD THE LINE:
 *
 *   NOT A WAY AROUND GMAIL'S CLASSIFIER. Nothing here is asserted about which tab anything lands
 *   in, because that is decided per recipient from engagement history and no sender controls it.
 *   The claim is readability and weight, which stands on its own.
 *
 *   NOT A PERSONAL REPLY IN DISGUISE. The message still carries its unsubscribe link, its
 *   List-Unsubscribe and One-Click headers, and a footer saying why the reader is receiving it,
 *   because it IS marketing mail. Three tests below exist solely to fail if any of that is ever
 *   dropped from the simple path.
 *
 *   NOT A REDUCTION IN COMPLIANCE. Consent checks and the suppression list are upstream of the
 *   mode and are not reachable from it; the base-URL guard still applies, because a simple send
 *   needs a working opt-out link exactly as much as a designed one.
 *
 * REAL ROWS, not the rolled-back fixture - `prisma.$transaction([...])` is not available on an
 * interactive transaction client, so inside one the delivery paths throw and are swallowed. Same
 * trap as `schedule-and-recovery.spec.ts`. Everything is prefixed `ZZMODE` and removed in a
 * `finally`, and no scheduled rows are left for another suite's sweep to find.
 */

const prisma = new PrismaClient();
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;
const ME = 91_001;

afterAll(async () => { await prisma.$disconnect(); });

async function withCleanup(fn: (db: PrismaService) => Promise<void>) {
  try {
    await fn(prisma as unknown as PrismaService);
  } finally {
    const rows = await prisma.campaigns.findMany({ where: { name: { startsWith: 'ZZMODE' } }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await prisma.campaign_recipients.deleteMany({ where: { campaign_id: { in: ids } } }).catch(() => undefined);
      await prisma.campaign_links.deleteMany({ where: { campaign_id: { in: ids } } }).catch(() => undefined);
      await prisma.campaigns.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
  }
}

interface Sent { to: string; subject: string; html: string; text?: string | null; headers?: Record<string, string> }

function services(db: PrismaService, sent: Sent[]) {
  const audience = new CampaignAudienceService(db);
  const campaigns = new CampaignsService(
    db, audience, new CampaignTemplatesService(db, audience),
    { domainCanReceiveMail: async () => true } as never,
    {
      resolveSenderInArea: async () => ({ id: 1, from_email: 'crm@test.local' }),
      sendFromAccount: async (_a: unknown, o: { to: string[]; subject: string; html: string; text?: string | null; headers?: Record<string, string> }) => {
        sent.push({ to: o.to[0], subject: o.subject, html: o.html, text: o.text, headers: o.headers });
        return { messageId: 'x' };
      },
      sendDirect: async () => undefined,
    } as never,
  );
  return campaigns;
}

/** A template body with every piece of newsletter furniture the simple mode is meant to drop. */
const DESIGNED = `
  <table width="600" bgcolor="#f3f4f6" cellpadding="24">
    <tr><td style="background:#0a4;color:#fff;font-size:30px;">GET HOME REALTY</td></tr>
    <tr><td><img src="https://cdn.test/banner.png" width="600" alt="Spring market" /></td></tr>
    <tr><td style="font-family:Georgia,serif;">Hi {{LEAD_NAME}}, prices in Brampton rose 3% last month.</td></tr>
    <tr><td><a href="https://gethomerealty.ca/listings" style="background:#0a4;padding:14px 28px;color:#fff;border-radius:6px;">BROWSE LISTINGS</a></td></tr>
  </table>`;

async function campaignWith(db: PrismaService, mode: string | null, content = DESIGNED) {
  const now = new Date();
  const t = tag();
  const campaign = await db.campaigns.create({
    data: {
      name: `ZZMODE ${t}`, subject: 'Hi {{LEAD_NAME}}, your market update', content,
      created_by: 'ZZ Prober', created_by_id: ME, tracking_base_url: 'https://crm.test',
      /*
       * 'draft', NOT 'sending', and that is about other spec files rather than this one.
       * `CampaignResumeService.resumeAll` adopts EVERY campaign in the database whose status is
       * 'sending' — it is the restart-recovery sweep — so a fixture left in that state while this
       * test runs can be picked up and delivered by a parallel worker running
       * `schedule-and-recovery.spec.ts`, which then spends this campaign's send delay inside its
       * own 60-second timeout. `deliver` writes the final status unconditionally when it finishes,
       * so starting as a draft changes nothing this file asserts and makes the fixture invisible
       * to that sweep.
       */
      status: 'draft', total: 1, sent: 0, failed: 0, body_mode: mode,
      created_at: now, updated_at: now,
    },
  });
  const row = await db.campaign_recipients.create({
    data: {
      campaign_id: campaign.id, email: `zz-mode-${t}@probe.test`, name: 'Dana',
      token: `tok-mode-${t}`, status: 'pending', created_at: now, updated_at: now,
    },
  });
  return { campaign, row };
}

async function deliver(
  svc: CampaignsService,
  campaign: { id: number; name: string; subject: string; content: string },
  row: { id: number; email: string; name: string | null; token: string },
  bodyMode: string | null,
) {
  await (svc as unknown as { deliver: (j: unknown) => Promise<void> }).deliver({
    campaignId: campaign.id, name: campaign.name,
    recipients: [{ leadId: null, name: row.name ?? '', email: row.email, vars: {} }],
    rows: [{ id: row.id, retry_count: 0 }], tokens: [row.token],
    template: { subject: campaign.subject, content: campaign.content },
    agentVars: {}, attachments: [], baseUrl: 'https://crm.test', userId: ME, bodyMode,
  });
}

const me = { id: ME, name: 'ZZ Prober', role: 'agent' } as unknown as AuthUserRecord;

// =====================================================================================
describe('the mode is a named choice, and anything unrecognised is the standard campaign', () => {
  it('parses only "simple", and treats everything else as standard', () => {
    expect(parseBodyMode('simple')).toBe(SIMPLE_MODE);
    expect(parseBodyMode('SIMPLE')).toBe(SIMPLE_MODE);
    expect(parseBodyMode(' simple ')).toBe(SIMPLE_MODE);
    /*
     * A TYPO FALLS BACK RATHER THAN FAILING. The mode is a presentation choice; refusing a send
     * over a misspelled one would be a worse outcome than sending the campaign the way it has
     * always been sent. Absent is the overwhelmingly common case - every existing client.
     */
    for (const v of [undefined, null, '', 'standard', 'plain', 'text', 'SiMpLeX', 0, {}]) {
      expect(parseBodyMode(v)).toBeNull();
    }
  });
});

// =====================================================================================
describe('a standard campaign is completely unchanged', () => {
  it('STILL CARRIES ITS DESIGN, its open pixel and its rewritten links', async () => {
    /*
     * The regression that would matter most: the simple mode leaking into the standard path. Every
     * campaign the brokerage has ever sent is this one, so this asserts the furniture is all still
     * there rather than merely that nothing threw.
     */
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, null);
      await deliver(services(db, sent), campaign, row, null);

      expect(sent).toHaveLength(1);
      const html = sent[0].html;
      expect(html).toContain('<table');
      expect(html).toContain('bgcolor');
      expect(html).toContain('border-radius');
      expect(html).toContain('cdn.test/banner.png');
      // The open pixel.
      expect(html).toContain('/api/campaigns/track/open');
      // And the click redirect, which means the link was registered and rewritten.
      expect(html).toContain('/api/campaigns/track/click');
      expect(html).not.toContain('href="https://gethomerealty.ca/listings"');
    });
  }, 60000);

  it('registers its links for click reporting', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, null);
      await deliver(services(db, sent), campaign, row, null);

      const links = await db.campaign_links.findMany({ where: { campaign_id: campaign.id } });
      expect(links.map((l) => l.url)).toContain('https://gethomerealty.ca/listings');
    });
  }, 60000);
});

// =====================================================================================
describe('a simple email is lighter, and still says everything it must', () => {
  it('DROPS THE FURNITURE AND KEEPS THE WORDS', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      // The body is rendered at create time; a campaign row carrying the simple mode carries the
      // already-simplified content, which is what `createAndSend` stores.
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE, DESIGNED);
      await deliver(services(db, sent), campaign, row, SIMPLE_MODE);

      const html = sent[0].html;
      // The message survives, personalised.
      expect(html).toContain('prices in Brampton rose 3% last month');
      expect(html).toContain('Dana');
      // The furniture does not reach the recipient, because the send does not rewrite or beacon it.
      expect(html).not.toContain('/api/campaigns/track/open');
      expect(html).not.toContain('/api/campaigns/track/click');
      // The author's own link is left exactly as written - not removed, not redirected.
      expect(html).toContain('https://gethomerealty.ca/listings');
    });
  }, 60000);

  it('REGISTERS NO LINKS, so its click report says "not measured" rather than "none"', async () => {
    /*
     * Rows that nothing ever resolves would make the click report for this campaign look as though
     * it had been measured and found nothing. That is a different claim from not measuring.
     */
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      await deliver(services(db, sent), campaign, row, SIMPLE_MODE);

      expect(await db.campaign_links.count({ where: { campaign_id: campaign.id } })).toBe(0);
    });
  }, 60000);

  it('STILL CARRIES THE UNSUBSCRIBE LINK — the one thing that is never optional', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      await deliver(services(db, sent), campaign, row, SIMPLE_MODE);

      const html = sent[0].html;
      expect(html).toContain('/api/campaigns/unsubscribe');
      expect(html.toLowerCase()).toContain('unsubscribe');
      // Direct, never through the click redirect: opting out must not depend on the tracking
      // endpoint being healthy.
      expect(html).not.toMatch(/track\/click[^"]*unsubscribe/);
    });
  }, 60000);

  it('STILL CARRIES List-Unsubscribe AND One-Click headers', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      await deliver(services(db, sent), campaign, row, SIMPLE_MODE);

      const h = sent[0].headers ?? {};
      expect(h['List-Unsubscribe']).toContain('/api/campaigns/unsubscribe');
      expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    });
  }, 60000);

  it('SAYS WHY THE READER IS RECEIVING IT — not disguised as a personal message', async () => {
    // The restriction stated in the request, as an assertion: a simple email is still bulk
    // marketing mail and must identify itself as such.
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      await deliver(services(db, sent), campaign, row, SIMPLE_MODE);

      expect(sent[0].html).toMatch(/receiving this because/i);
    });
  }, 60000);

  it('still sends a text/plain alternative, and a meaningful one', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      await deliver(services(db, sent), campaign, row, SIMPLE_MODE);

      const text = String(sent[0].text ?? '');
      expect(text.trim()).not.toBe('');
      expect(text).toContain('Brampton');
      expect(text).not.toContain('<');
    });
  }, 60000);

  it('personalises the subject exactly as a standard campaign does', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      await deliver(services(db, sent), campaign, row, SIMPLE_MODE);

      expect(sent[0].subject).toBe('Hi Dana, your market update');
      expect(sent[0].subject).not.toContain('{{');
    });
  }, 60000);

  it('REFUSES TO SEND WITH NO PUBLIC URL, exactly as a standard campaign does', async () => {
    /*
     * The compliance guard is upstream of the mode and must stay that way. A simple email needs a
     * working unsubscribe link every bit as much as a designed one, so "simpler" must not have
     * become a route around the check.
     */
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      const svc = services(db, sent);
      await expect(
        (svc as unknown as { deliver: (j: unknown) => Promise<void> }).deliver({
          campaignId: campaign.id, name: campaign.name,
          recipients: [{ leadId: null, name: 'Dana', email: row.email, vars: {} }],
          rows: [{ id: row.id, retry_count: 0 }], tokens: [row.token],
          template: { subject: campaign.subject, content: campaign.content },
          agentVars: {}, attachments: [], baseUrl: '', userId: ME, bodyMode: SIMPLE_MODE,
        }),
      ).rejects.toThrow(/cannot be sent/i);
      expect(sent).toHaveLength(0);
    });
  }, 60000);

  it('records deliveries the same way, so reporting is unaffected', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      await deliver(services(db, sent), campaign, row, SIMPLE_MODE);

      const after = await db.campaigns.findUnique({
        where: { id: campaign.id }, select: { sent: true, failed: true, body_mode: true },
      });
      expect(after?.sent).toBe(1);
      expect(after?.failed).toBe(0);
      expect(after?.body_mode).toBe(SIMPLE_MODE);
      const r = await db.campaign_recipients.findUnique({ where: { id: row.id }, select: { status: true } });
      expect(r?.status).toBe('sent');
    });
  }, 60000);

  it('REPORTS THE MODE, so the results screen can say opens were not measured', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      const svc = services(db, sent);
      await deliver(svc, campaign, row, SIMPLE_MODE);

      const detail = await svc.get(campaign.id, me);
      expect(detail.body_mode).toBe(SIMPLE_MODE);
      // And a standard campaign reports null rather than a mode nobody chose.
      const std = await campaignWith(db, null);
      expect((await svc.get(std.campaign.id, me)).body_mode).toBeNull();
    });
  }, 60000);
});

// =====================================================================================
describe('a scheduled simple email is still a simple email when it goes', () => {
  it('KEEPS ITS MODE THROUGH DISPATCH, read from the row rather than resolved again', async () => {
    /*
     * The mode has to survive the gap between building a campaign and sending it. A scheduled send
     * runs days later in a background sweep with no user session and no memory of the composer, so
     * if the mode were not persisted the campaign would silently go out as a standard one - with
     * the open pixel and click redirects the author chose not to have.
     *
     * FUTURE-DATED AND CLAIMED BY ID. `dispatchScheduled` claims one campaign by id and does not
     * consult the date, so this fixture is invisible to `schedule-and-recovery`'s global sweep
     * running in a parallel worker. Same reasoning as `campaign-sender-selection.spec.ts`.
     */
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign } = await campaignWith(db, SIMPLE_MODE, simpleEmailBody(DESIGNED));
      await db.campaigns.update({
        where: { id: campaign.id },
        data: { status: 'scheduled', scheduled_for: new Date(Date.now() + 60 * 60 * 1000) },
      });

      const dispatched = await services(db, sent).dispatchScheduled(campaign.id);

      expect(dispatched).toBe(true);
      expect(sent).toHaveLength(1);
      const html = sent[0].html;
      // Sent as a SIMPLE email: no beacon, no redirects, no furniture.
      expect(html).not.toContain('/api/campaigns/track/open');
      expect(html).not.toContain('/api/campaigns/track/click');
      expect(html).not.toContain('<table');
      // And still compliant.
      expect(html).toContain('/api/campaigns/unsubscribe');
      expect(sent[0].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    });
  }, 60000);

  it('a scheduled STANDARD campaign is unaffected and keeps its tracking', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign } = await campaignWith(db, null);
      await db.campaigns.update({
        where: { id: campaign.id },
        data: { status: 'scheduled', scheduled_for: new Date(Date.now() + 60 * 60 * 1000) },
      });

      await services(db, sent).dispatchScheduled(campaign.id);

      expect(sent[0].html).toContain('/api/campaigns/track/open');
      expect(sent[0].html).toContain('<table');
    });
  }, 60000);
});

// =====================================================================================
describe('consent and suppression are untouched by the mode', () => {
  it('DOES NOT SEND A SIMPLE EMAIL TO A SUPPRESSED ADDRESS', async () => {
    /*
     * The suppression check lives in `resume`, upstream of any mode decision, and this proves the
     * simple path did not become a way around it. Driven through `resume` rather than `deliver`
     * because that is where consent is re-checked at the moment of sending - the CASL requirement
     * being that the violation is sending AFTER consent is withdrawn.
     */
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign, row } = await campaignWith(db, SIMPLE_MODE);
      await db.email_suppressions.upsert({
        where: { email: row.email },
        create: { email: row.email, reason: 'unsubscribe', created_at: new Date(), updated_at: new Date() },
        update: {},
      });

      try {
        await services(db, sent).resume(campaign.id);

        expect(sent).toHaveLength(0);
        // Marked rather than silently skipped, so the campaign's own results explain the gap.
        const after = await db.campaign_recipients.findUnique({
          where: { id: row.id }, select: { status: true, unsubscribed: true, error: true },
        });
        expect(after?.status).toBe('failed');
        expect(after?.unsubscribed).toBe(true);
        expect(after?.error).toMatch(/opted out/i);
      } finally {
        await db.email_suppressions.deleteMany({ where: { email: row.email } }).catch(() => undefined);
      }
    });
  }, 60000);

  it('sends a simple email to an address that is NOT suppressed, so the guard is the thing being tested', async () => {
    // The negative control, in the suite: without it the test above would pass against a simple
    // path that never sends anything at all.
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const { campaign } = await campaignWith(db, SIMPLE_MODE);
      await services(db, sent).resume(campaign.id);
      expect(sent).toHaveLength(1);
    });
  }, 60000);
});

// =====================================================================================
describe('the preview is rendered by the code that sends', () => {
  async function template(db: PrismaService, content: string) {
    return db.campaign_templates.create({
      data: {
        name: `ZZMODE TPL ${tag()}`, subject: 'Hi {{LEAD_NAME}}, your update',
        content, category: 'custom', is_active: true, user_id: ME,
        created_at: new Date(), updated_at: new Date(),
      },
    });
  }

  async function cleanTemplates() {
    await prisma.campaign_templates.deleteMany({ where: { name: { startsWith: 'ZZMODE TPL' } } }).catch(() => undefined);
  }

  afterEach(async () => { await cleanTemplates(); });

  it('SHOWS THE SIMPLE BODY, the footer, and that opens are not measured', async () => {
    await withCleanup(async (db) => {
      const t = await template(db, DESIGNED);
      const out = await services(db, []).previewEmail(
        { template_id: t.id, body_mode: SIMPLE_MODE }, me, 'https://crm.test',
      );

      const html = String(out.html);
      expect(html).toContain('prices in Brampton rose 3% last month');
      expect(html).not.toContain('<table');
      expect(html).not.toContain('/api/campaigns/track/open');
      // The footer IS previewed, because it is part of the email.
      expect(html).toContain('/api/campaigns/unsubscribe');
      expect((out.tracking as { opens: boolean }).opens).toBe(false);
      expect((out.tracking as { unsubscribe: boolean }).unsubscribe).toBe(true);
      expect(out.subject).not.toContain('{{');
    });
  }, 60000);

  it('shows the standard body untouched, and that opens ARE measured', async () => {
    await withCleanup(async (db) => {
      const t = await template(db, DESIGNED);
      const out = await services(db, []).previewEmail({ template_id: t.id }, me, 'https://crm.test');

      expect(String(out.html)).toContain('<table');
      expect(String(out.html)).toContain('/api/campaigns/track/open');
      expect((out.tracking as { opens: boolean }).opens).toBe(true);
      expect(out.body_mode).toBeNull();
    });
  }, 60000);

  it('CREATES NOTHING AND SENDS NOTHING', async () => {
    await withCleanup(async (db) => {
      const sent: Sent[] = [];
      const t = await template(db, DESIGNED);
      const before = await db.campaigns.count();

      await services(db, sent).previewEmail({ template_id: t.id, body_mode: SIMPLE_MODE }, me, 'https://crm.test');

      expect(sent).toHaveLength(0);
      expect(await db.campaigns.count()).toBe(before);
    });
  }, 60000);

  it('REFUSES A TEMPLATE THIS USER COULD NOT SEND, rather than rendering its body', async () => {
    /*
     * The preview returns the whole message, so an unscoped lookup here would be a way to read a
     * colleague's private draft by guessing its id. `authoredWhere` is the same rule the send uses.
     */
    await withCleanup(async (db) => {
      const t = await template(db, DESIGNED);
      const other = { id: 91_002, name: 'ZZ Other', role: 'admin' } as unknown as AuthUserRecord;
      await expect(services(db, []).previewEmail({ template_id: t.id }, other, 'https://crm.test'))
        .rejects.toThrow(/not found/i);
    });
  }, 60000);

  it('reports the content signals, on the body as it will really be sent', async () => {
    await withCleanup(async (db) => {
      // An image-only body: the clearest signal `analyseContent` recognises.
      const t = await template(db, '<p><img src="https://cdn.test/a.png" alt="" /></p>');
      const out = await services(db, []).previewEmail({ template_id: t.id }, me, 'https://crm.test');
      expect((out.signals as string[]).join(' ')).toMatch(/image/i);
    });
  }, 60000);

  it('refuses a missing template id rather than previewing nothing', async () => {
    await withCleanup(async (db) => {
      await expect(services(db, []).previewEmail({}, me, 'https://crm.test')).rejects.toThrow(/template/i);
    });
  }, 60000);

  /*
   * ========================================================================================
   * THE PREVIEW AND THE DELIVERED MESSAGE ARE THE SAME EMAIL.
   *
   * Everything above tests the two halves separately, which is exactly how they would be allowed
   * to drift: each suite passes while the preview quietly stops describing the send. The only
   * assertion that catches that is comparing the two outputs, so these do.
   *
   * ONE NORMALISATION, AND IT IS THE HONEST ONE. The unsubscribe URL carries the campaign id and
   * the recipient's token, and a preview has neither - there is no campaign and no recipient yet.
   * Those two query parameters are therefore masked on both sides; everything else, including the
   * footer, the greeting, the personalised subject and every byte of the body, is compared as-is.
   * ========================================================================================
   */
  const maskIds = (html: string) =>
    html.replace(/c=\d+&t=[^"&]*/g, 'c=MASKED&t=MASKED');

  /**
   * Put the author's own URLs back where click tracking replaced them.
   *
   * THE ONE DIFFERENCE BETWEEN THE TWO, AND IT IS DELIBERATE. A standard send rewrites every
   * registered link to a redirect; the preview shows the destinations, because an author has to be
   * able to proofread WHERE a link goes and `/track/click?c=0&t=preview&l=1` tells them nothing.
   *
   * Resolved through `campaign_links` rather than masked, so this still proves the destination
   * survived the rewrite intact - masking would have hidden a redirect pointing somewhere else
   * entirely. What the comparison then asserts is exact: the delivered email IS the preview, with
   * tracked links swapped for their redirects and nothing else changed.
   */
  async function resolveTrackedLinks(db: PrismaService, campaignId: number, html: string) {
    const links = await db.campaign_links.findMany({ where: { campaign_id: campaignId } });
    let out = html;
    for (const l of links) {
      out = out.replace(
        new RegExp(`https?://[^"]*?/api/campaigns/track/click\?[^"]*l=${l.id}(?![0-9])`, 'g'),
        l.url,
      );
    }
    return out;
  }

  for (const [label, mode] of [['a simple email', SIMPLE_MODE], ['a standard campaign', null]] as const) {
    it(`MATCHES WHAT IS ACTUALLY DELIVERED — ${label}`, async () => {
      await withCleanup(async (db) => {
        const t = await template(db, DESIGNED);
        const svc = services(db, []);

        // 1. What the composer shows.
        const preview = await svc.previewEmail(
          { template_id: t.id, body_mode: mode ?? undefined }, me, 'https://crm.test',
        );

        /*
         * 2. What the send produces, built the way `createAndSend` builds it: the body is rendered
         * for the mode at create time and stored, and `deliver` personalises that stored body.
         * The recipient is named to match the lead the preview greeted, so the two are the same
         * message to the same person rather than two different ones.
         */
        const sent: Sent[] = [];
        const stored = mode === SIMPLE_MODE ? simpleEmailBody(t.content) : t.content;
        const { campaign, row } = await campaignWith(db, mode, stored);
        await db.campaign_recipients.update({
          where: { id: row.id }, data: { name: preview.sample_name as string | null },
        });
        await deliver(
          services(db, sent),
          { ...campaign, subject: t.subject, content: stored },
          { ...row, name: (preview.sample_name as string | null) ?? '' },
          mode,
        );

        expect(sent).toHaveLength(1);

        // THE SUBJECT, personalised identically.
        expect(sent[0].subject).toBe(preview.subject);
        expect(sent[0].subject).not.toContain('{{');

        // THE BODY, byte for byte once the per-recipient ids are masked and any click redirect is
        // resolved back to the destination the author wrote.
        const delivered = await resolveTrackedLinks(db, campaign.id, sent[0].html);
        expect(maskIds(delivered)).toBe(maskIds(String(preview.html)));

        // And the footer the requirement names is present in BOTH, not merely in one.
        for (const html of [String(preview.html), sent[0].html]) {
          expect(html).toContain('/api/campaigns/unsubscribe');
          expect(html.toLowerCase()).toContain('unsubscribe');
        }
      });
    }, 60000);
  }

  it('the preview shows the SAME tracking decision the send makes', async () => {
    // Not just the same words - the same behaviour. A preview that said "not measured" over a
    // message that still carried a beacon would be worse than no preview at all.
    await withCleanup(async (db) => {
      const t = await template(db, DESIGNED);
      for (const mode of [SIMPLE_MODE, null]) {
        const preview = await services(db, []).previewEmail(
          { template_id: t.id, body_mode: mode ?? undefined }, me, 'https://crm.test',
        );
        const sent: Sent[] = [];
        const stored = mode === SIMPLE_MODE ? simpleEmailBody(t.content) : t.content;
        const { campaign, row } = await campaignWith(db, mode, stored);
        await deliver(services(db, sent), { ...campaign, subject: t.subject, content: stored }, row, mode);

        const previewHasPixel = String(preview.html).includes('/api/campaigns/track/open');
        const sentHasPixel = sent[0].html.includes('/api/campaigns/track/open');
        expect(previewHasPixel).toBe(sentHasPixel);
        expect((preview.tracking as { opens: boolean }).opens).toBe(sentHasPixel);
      }
    });
  }, 60000);
});
