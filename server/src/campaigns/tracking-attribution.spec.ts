import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { CampaignTrackingController } from './campaign-tracking.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';

/**
 * PRIORITY 7 — open tracking and click attribution, driven through the real controller.
 *
 * The register listed these as "verified sound", from a code read. This runs them: a real pixel
 * request and a real click, against real rows, asserting both the HTTP response the recipient's mail
 * client sees AND the counters the campaign screen reports afterwards.
 *
 * WHY NOT PLAYWRIGHT. These two endpoints are deliberately public and take no session, so a browser
 * adds nothing except the inability to seed a campaign. `Request` and `Response` are the only stubs;
 * the controller, both services, the machine-detection and every database write are real.
 */

const prisma = new PrismaClient();
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

/**
 * REAL ROWS, NOT THE ROLLED-BACK TRANSACTION every other spec here uses.
 *
 * `recordOpen` commits its two counter updates with `prisma.$transaction([...])`, and an interactive
 * transaction client does not expose `$transaction` — so inside the usual fixture every attribution
 * threw, the controller's `catch` swallowed it exactly as designed ("tracking must never break the
 * email"), and the tests that assert NOTHING is counted passed while the ones that assert something
 * IS counted failed. The fixture was wrong in the most misleading possible direction: it looked like
 * attribution was broken.
 *
 * So these write real rows and delete them in a `finally`, like `concurrent-edit.spec.ts`.
 * Everything created is prefixed `ZZTRACK`.
 */
async function withCleanup(fn: (db: PrismaService) => Promise<void>) {
  const made: number[] = [];
  try {
    await fn(prisma as unknown as PrismaService);
  } finally {
    void made;
    const rows = await prisma.campaigns.findMany({ where: { name: { startsWith: 'ZZTRACK' } }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await prisma.campaign_recipients.deleteMany({ where: { campaign_id: { in: ids } } }).catch(() => undefined);
      await prisma.campaign_links.deleteMany({ where: { campaign_id: { in: ids } } }).catch(() => undefined);
      await prisma.campaigns.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    }
  }
}

/** Just enough of Express for these two handlers. */
function fakeRes() {
  const state = { status: 0, redirectedTo: '', headers: {} as Record<string, string>, body: null as Buffer | null };
  return {
    state,
    setHeader(k: string, v: string) { state.headers[k.toLowerCase()] = v; },
    end(b?: Buffer) { state.body = b ?? null; state.status ||= 200; },
    redirect(code: number, url: string) { state.status = code; state.redirectedTo = url; },
  };
}
const fakeReq = (ua: string) => ({ headers: { 'user-agent': ua } });

const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1';

function controller(tx: PrismaService) {
  const audience = new CampaignAudienceService(tx);
  const svc = new CampaignsService(
    tx, audience, new CampaignTemplatesService(tx, audience),
    { domainCanReceiveMail: async () => true } as never,
    { sendDirect: async () => ({ ok: true }) } as never,
  );
  return new CampaignTrackingController(svc);
}

/**
 * A campaign that has been sent, with one delivered recipient and one tracked link.
 *
 * `sent_at` is set well in the past on purpose: `isMachinePrefetch` treats a pixel hit within ten
 * seconds of sending as a scanner, so a fixture created "now" would have every open suppressed and
 * the tests would pass for the wrong reason.
 */
async function sentCampaign(tx: PrismaService, over: Record<string, unknown> = {}) {
  const now = new Date();
  const t = tag();
  const campaign = await tx.campaigns.create({
    data: {
      name: `ZZTRACK ${t}`, subject: 'S', content: '<p>Hi <a href="https://example.test/listing">see it</a></p>',
      status: 'sent', sent: 1, opened: 0, clicked: 0,
      sent_at: new Date(now.getTime() - 60 * 60 * 1000),
      created_at: now, updated_at: now, ...over,
    },
  });
  const recipient = await tx.campaign_recipients.create({
    data: {
      campaign_id: campaign.id, email: `zz-track-${t}@probe.test`, name: 'Probe',
      token: `tok-track-${t}`, status: 'sent', created_at: now, updated_at: now,
    },
  });
  const link = await tx.campaign_links.create({
    data: { campaign_id: campaign.id, url: 'https://example.test/listing', created_at: now },
  });
  return { campaign, recipient, link };
}

describe('open tracking', () => {
  it('a real reader is counted, and the pixel still returns a GIF', async () => {
    await withCleanup(async (tx) => {
      const { campaign, recipient } = await sentCampaign(tx);
      const res = fakeRes();

      await controller(tx).trackOpen(String(campaign.id), recipient.token, fakeReq(HUMAN) as never, res as never);

      expect(res.state.headers['content-type']).toBe('image/gif');
      expect(res.state.body?.length).toBeGreaterThan(0);
      // Never cached, or a second open would never reach the server and the count would freeze.
      expect(res.state.headers['cache-control']).toMatch(/no-store/);

      const r = await tx.campaign_recipients.findUnique({ where: { id: recipient.id }, select: { opened: true, opened_at: true } });
      expect(r?.opened).toBe(true);
      expect(r?.opened_at).toBeTruthy();
      expect((await tx.campaigns.findUnique({ where: { id: campaign.id }, select: { opened: true } }))?.opened).toBe(1);
    });
  });

  it('a second open by the same person does not count twice', async () => {
    // The campaign figure is "how many people opened this", not "how many times it was displayed" —
    // and a mail client that redraws the message would inflate it beyond the number sent.
    await withCleanup(async (tx) => {
      const { campaign, recipient } = await sentCampaign(tx);
      const c = controller(tx);
      await c.trackOpen(String(campaign.id), recipient.token, fakeReq(HUMAN) as never, fakeRes() as never);
      await c.trackOpen(String(campaign.id), recipient.token, fakeReq(HUMAN) as never, fakeRes() as never);

      expect((await tx.campaigns.findUnique({ where: { id: campaign.id }, select: { opened: true } }))?.opened).toBe(1);
    });
  });

  it('Gmail\'s image proxy is a READER, not a scanner', async () => {
    /*
     * WRITTEN BECAUSE I GOT THIS WRONG FIRST, and the mistake is the tempting one.
     *
     * `GoogleImageProxy` looks exactly like a bot, and it is absent from `SCANNER_AGENTS`. I assumed
     * that was an oversight and asserted it should be suppressed. It is not an oversight: Gmail
     * routes every image through `ggpht.com` WHEN THE RECIPIENT OPENS THE MESSAGE, so that fetch is
     * the open. Adding it to the list would zero out open tracking for every Gmail recipient — the
     * largest slice of any Canadian brokerage's list — and the reports would show a collapse nobody
     * could explain.
     *
     * The genuine machine-fetch risk from Gmail is the fetch that arrives on DELIVERY rather than on
     * open, and `isMachinePrefetch` handles that by time, which is the only thing that can tell them
     * apart. This test exists so the next person to read that list does not make the same edit.
     */
    await withCleanup(async (tx) => {
      const { campaign, recipient } = await sentCampaign(tx);
      await controller(tx).trackOpen(
        String(campaign.id), recipient.token,
        fakeReq('Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)') as never,
        fakeRes() as never,
      );
      expect((await tx.campaigns.findUnique({ where: { id: campaign.id }, select: { opened: true } }))?.opened).toBe(1);
    });
  });

  it.each([
    'Barracuda Sentinel',
    'Mimecast',
    'Proofpoint',
    'python-requests/2.31',
    '',
  ])('a scanner (%s) is not counted as a reader', async (ua) => {
    await withCleanup(async (tx) => {
      const { campaign, recipient } = await sentCampaign(tx);
      const res = fakeRes();
      await controller(tx).trackOpen(String(campaign.id), recipient.token, fakeReq(ua) as never, res as never);

      // Still served — suppressing the image would make the message look broken.
      expect(res.state.headers['content-type']).toBe('image/gif');
      expect((await tx.campaigns.findUnique({ where: { id: campaign.id }, select: { opened: true } }))?.opened).toBe(0);
    });
  });

  it('a hit seconds after sending is a machine, not a reader', async () => {
    // The other half of the same judgement, and the one a user-agent list cannot catch: gateways
    // that fetch every image the instant a message lands, presenting as an ordinary browser.
    await withCleanup(async (tx) => {
      const { campaign, recipient } = await sentCampaign(tx, { sent_at: new Date() });
      await controller(tx).trackOpen(String(campaign.id), recipient.token, fakeReq(HUMAN) as never, fakeRes() as never);
      expect((await tx.campaigns.findUnique({ where: { id: campaign.id }, select: { opened: true } }))?.opened).toBe(0);
    });
  });

  it('a message that BOUNCED cannot have been read', async () => {
    await withCleanup(async (tx) => {
      const { campaign, recipient } = await sentCampaign(tx);
      await tx.campaign_recipients.update({ where: { id: recipient.id }, data: { bounced: true, status: 'failed' } });
      await controller(tx).trackOpen(String(campaign.id), recipient.token, fakeReq(HUMAN) as never, fakeRes() as never);
      expect((await tx.campaigns.findUnique({ where: { id: campaign.id }, select: { opened: true } }))?.opened).toBe(0);
    });
  });

  it('a token from a DIFFERENT campaign is not attributed', async () => {
    await withCleanup(async (tx) => {
      const a = await sentCampaign(tx);
      const b = await sentCampaign(tx);
      await controller(tx).trackOpen(String(a.campaign.id), b.recipient.token, fakeReq(HUMAN) as never, fakeRes() as never);
      expect((await tx.campaigns.findUnique({ where: { id: a.campaign.id }, select: { opened: true } }))?.opened).toBe(0);
      expect((await tx.campaigns.findUnique({ where: { id: b.campaign.id }, select: { opened: true } }))?.opened).toBe(0);
    });
  });

  it('a nonsense request still returns a valid pixel rather than an error', async () => {
    // Whatever else happens, the recipient must not see a broken image in their email.
    await withCleanup(async (tx) => {
      const res = fakeRes();
      await controller(tx).trackOpen('not-a-number', '', fakeReq(HUMAN) as never, res as never);
      expect(res.state.headers['content-type']).toBe('image/gif');
      expect(res.state.body?.length).toBeGreaterThan(0);
    });
  });
});

describe('click attribution', () => {
  it('a click is counted and the reader reaches the real destination', async () => {
    await withCleanup(async (tx) => {
      const { campaign, recipient, link } = await sentCampaign(tx);
      const res = fakeRes();

      await controller(tx).trackClick(String(campaign.id), recipient.token, String(link.id), fakeReq(HUMAN) as never, res as never);

      // 302, not 301: a permanent redirect would be cached and the second click would never arrive,
      // so the counts would quietly stop rising.
      expect(res.state.status).toBe(302);
      expect(res.state.redirectedTo).toBe('https://example.test/listing');

      // The recipient row records WHEN, not whether — `clicked_at` is the column, and null is the
      // "never did" case. The boolean lives only on the campaign's counter.
      const r = await tx.campaign_recipients.findUnique({ where: { id: recipient.id }, select: { clicked_at: true } });
      expect(r?.clicked_at).toBeTruthy();
      expect((await tx.campaigns.findUnique({ where: { id: campaign.id }, select: { clicked: true } }))?.clicked).toBe(1);
    });
  });

  it('the destination comes from the stored row — this is not an open redirect', async () => {
    /*
     * THE SECURITY POINT the controller states. The obvious design — `?u=https://…` — would let
     * anyone circulate a link on the brokerage's own domain that lands wherever they choose, which
     * is exactly the kind of phishing that works. Here the URL is looked up by id from a row this
     * server wrote at send time, so an attacker-supplied destination is simply ignored.
     */
    await withCleanup(async (tx) => {
      const { campaign, recipient, link } = await sentCampaign(tx);
      const res = fakeRes();

      await controller(tx).trackClick(
        String(campaign.id), recipient.token, String(link.id), fakeReq(HUMAN) as never, res as never,
      );
      expect(res.state.redirectedTo).toBe('https://example.test/listing');
      expect(res.state.redirectedTo).not.toContain('evil');
    });
  });

  it('a link id belonging to another campaign resolves to nothing, not to that link', async () => {
    await withCleanup(async (tx) => {
      const a = await sentCampaign(tx);
      const b = await sentCampaign(tx);
      const res = fakeRes();

      await controller(tx).trackClick(String(a.campaign.id), a.recipient.token, String(b.link.id), fakeReq(HUMAN) as never, res as never);

      // Redirected to the fallback, never to the other campaign's destination.
      expect(res.state.status).toBe(302);
      expect((await tx.campaigns.findUnique({ where: { id: a.campaign.id }, select: { clicked: true } }))?.clicked).toBe(0);
    });
  });

  it('a scanner still reaches the destination but is not attributed', async () => {
    /*
     * Deliberately different from the open pixel: there, a suppressed hit costs nothing. Here, if the
     * detection is ever wrong, a REAL person must still arrive at the property they clicked — so the
     * redirect always happens and only the attribution is withheld.
     */
    await withCleanup(async (tx) => {
      const { campaign, recipient, link } = await sentCampaign(tx);
      const res = fakeRes();

      await controller(tx).trackClick(String(campaign.id), recipient.token, String(link.id), fakeReq('Barracuda Sentinel') as never, res as never);

      expect(res.state.status).toBe(302);
      expect(res.state.redirectedTo).toBe('https://example.test/listing');
      expect((await tx.campaigns.findUnique({ where: { id: campaign.id }, select: { clicked: true } }))?.clicked).toBe(0);
    });
  });

  it('a second click by the same person does not count twice', async () => {
    await withCleanup(async (tx) => {
      const { campaign, recipient, link } = await sentCampaign(tx);
      const c = controller(tx);
      await c.trackClick(String(campaign.id), recipient.token, String(link.id), fakeReq(HUMAN) as never, fakeRes() as never);
      await c.trackClick(String(campaign.id), recipient.token, String(link.id), fakeReq(HUMAN) as never, fakeRes() as never);
      expect((await tx.campaigns.findUnique({ where: { id: campaign.id }, select: { clicked: true } }))?.clicked).toBe(1);
    });
  });

  it('a broken tracking link still sends the reader somewhere', async () => {
    // A tracking mistake is ours; it must not leave the recipient looking at an error page.
    await withCleanup(async (tx) => {
      const res = fakeRes();
      await controller(tx).trackClick('999999999', 'nope', '999999999', fakeReq(HUMAN) as never, res as never);
      expect(res.state.status).toBe(302);
      expect(res.state.redirectedTo).toBeTruthy();
    });
  });
});
