import { Body, Controller, Get, HttpCode, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CampaignsService } from './campaigns.service';
import { SkipThrottle } from '@nestjs/throttler';

/** 1×1 transparent GIF. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** User agents that are unambiguously automated fetchers, never a reading human. */
const SCANNER_AGENTS = [
  'barracuda', 'proofpoint', 'mimecast', 'symantec', 'forcepoint',
  'microsoft office existence discovery', 'bingpreview', 'slackbot', 'whatsapp',
  'facebookexternalhit', 'twitterbot', 'curl/', 'wget/', 'python-requests',
  'go-http-client', 'okhttp', 'headlesschrome',
];

const looksAutomated = (userAgent: string): boolean => {
  const ua = userAgent.toLowerCase();
  if (!ua) return true; // no UA at all — not a real mail client
  return SCANNER_AGENTS.some((s) => ua.includes(s));
};

/**
 * PUBLIC campaign endpoints — reached from inside a recipient's email, so they carry no
 * session and must not be guarded. Both are GETs, which the global CSRF guard already
 * exempts. Neither exposes data: the pixel returns an image whatever happens, and the
 * unsubscribe page reveals nothing beyond whether the link was valid.
 */
/**
 * Exempt from rate limiting.
 *
 * Open-tracking pixel and unsubscribe, fetched by recipients' mail clients. One corporate mail
 * gateway can prefetch many at once, and a throttled unsubscribe link is a compliance problem.
 */
@SkipThrottle()
@Controller('campaigns')
export class CampaignTrackingController {
  private readonly log = new Logger(CampaignTrackingController.name);

  constructor(private readonly campaigns: CampaignsService) {}

  /** Open-tracking pixel. Always returns the image so the email renders normally. */
  @Get('track/open')
  async trackOpen(@Query('c') c: string, @Query('t') t: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const campaignId = Number(c);
      if (Number.isInteger(campaignId) && campaignId > 0 && t) {
        // Mail servers, scanners and image proxies fetch every image the moment a message
        // lands; a hit that soon after sending is a machine, not a person.
        const automated = looksAutomated(String(req.headers['user-agent'] ?? ''));
        if (!automated && !(await this.campaigns.isMachinePrefetch(campaignId))) {
          await this.campaigns.recordOpen(campaignId, String(t));
        }
      }
    } catch {
      /* tracking must never break the email */
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Length', String(PIXEL.length));
    // Never cache — every load should reach the server so re-opens are seen.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.end(PIXEL);
  }

  /**
   * Click tracking. Records the click, then sends the reader on to the real destination.
   *
   * THE SECURITY POINT: the destination is looked up by id from a row this server wrote at send
   * time. It is never taken from the request. The obvious shape — `?u=https://…` — would make this
   * an open redirect, so anyone could circulate a link on the brokerage's own domain that lands on
   * a site of their choosing, borrowing the brokerage's reputation to do it. Phishing that arrives
   * from a familiar domain is the kind that works.
   *
   * A click that cannot be resolved sends the reader to the site root rather than showing an
   * error. A broken tracking link is our problem, not the recipient's.
   */
  @Get('track/click')
  async trackClick(
    @Query('c') c: string,
    @Query('t') t: string,
    @Query('l') l: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const fallback = (process.env.FRONTEND_URL ?? '/').trim() || '/';
    try {
      const campaignId = Number(c);
      const linkId = Number(l);
      if (Number.isInteger(campaignId) && campaignId > 0 && Number.isInteger(linkId) && linkId > 0 && t) {
        // A scanner following the link is not a reader. Same judgement as the open pixel — but
        // here it only suppresses the ATTRIBUTION; the redirect still happens, because if the
        // detection is ever wrong a real person must still reach the property they clicked.
        const automated = looksAutomated(String(req.headers['user-agent'] ?? ''));
        const url = automated
          ? await this.campaigns.linkDestination(campaignId, linkId)
          : await this.campaigns.recordClick(campaignId, String(t), linkId);
        if (url) {
          res.setHeader('Cache-Control', 'no-store');
          // 302, not 301: a permanent redirect would be cached by the browser and the second click
          // would never reach us, so the counts would quietly stop rising.
          return res.redirect(302, url);
        }
      }
    } catch {
      /* tracking must never cost the reader their destination */
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, fallback);
  }

  /**
   * The unsubscribe link from an email. This GET only ASKS; the POST below acts.
   *
   * It used to unsubscribe on the GET, which meant anything that merely fetched the URL opted the
   * recipient out. Corporate mail gateways — Proofpoint, Barracuda, Mimecast, the very list
   * `looksAutomated` above already enumerates — follow every link in a message to scan it for
   * malware, so recipients at those organisations were unsubscribed without ever opening the
   * email. The list eroded invisibly, and because the opt-out also flags the lead row it was
   * awkward to undo.
   *
   * A confirmation step fixes it properly rather than by sniffing user agents: a scanner fetches
   * this page and stops, because nothing has happened yet, while a person clicks the button. It
   * also matches RFC 8058, which specifies POST for one-click unsubscribe for the same reason.
   */
  @Get('unsubscribe')
  unsubscribePrompt(@Query('c') c: string, @Query('t') t: string, @Res() res: Response): void {
    const campaignId = Number(c);
    if (!Number.isInteger(campaignId) || campaignId <= 0 || !t) {
      return this.page(res, 'Invalid link', 'This unsubscribe link is not valid.', false);
    }
    return this.confirmPage(res, campaignId, String(t));
  }

  /** The button on the confirmation page — and what a One-Click mail client POSTs to. */
  @Post('unsubscribe')
  // 200, not Nest's default 201: nothing is created, and a mail client acting on
  // List-Unsubscribe=One-Click expects a plain success.
  @HttpCode(200)
  async unsubscribe(
    @Body() body: Record<string, unknown>,
    @Query('c') c: string,
    @Query('t') t: string,
    @Res() res: Response,
  ): Promise<void> {
    // Ids from the query string, falling back to the form body, so this one handler serves both
    // the confirmation page and a List-Unsubscribe=One-Click POST.
    const campaignId = Number(c ?? body?.c);
    const token = String(t ?? body?.t ?? '');
    if (!Number.isInteger(campaignId) || campaignId <= 0 || !token) {
      return this.page(res, 'Invalid link', 'This unsubscribe link is not valid.', false);
    }
    try {
      const result = await this.campaigns.unsubscribe(campaignId, token);
      if (!result.ok) {
        return this.page(res, 'Link not found', 'We could not find your subscription for this email.', false);
      }
      return this.page(
        res,
        'You have been unsubscribed',
        'You will no longer receive marketing emails from us. If this was a mistake, contact your agent.',
        true,
      );
    } catch (err) {
      /*
       * Logged, loudly, before the friendly page goes out.
       *
       * This catch swallowed the error entirely — no log line anywhere — so an unsubscribe
       * endpoint that had stopped working was indistinguishable from one refusing a bad link, and
       * both read as "please try again later" to the recipient. CASL requires this mechanism to
       * work; noticing that it had not been working should not depend on a complaint to the CRTC.
       */
      this.log.error(
        `Unsubscribe FAILED for campaign #${campaignId} — a recipient could not opt out: `
        + `${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return this.page(res, 'Something went wrong', 'We could not process your request. Please try again later.', false);
    }
  }

  /** "Are you sure?" — one button, which POSTs. Nothing has changed at this point. */
  private confirmPage(res: Response, campaignId: number, token: string): void {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(`<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Unsubscribe</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f6f7f9;color:#111827;">
  <div style="max-width:460px;margin:12vh auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 28px;text-align:center;box-shadow:0 10px 30px -12px rgba(0,0,0,.15);">
    <div style="font-size:22px;font-weight:700;color:#4f46e5;margin-bottom:6px;">Get Home Realty</div>
    <h1 style="font-size:18px;margin:14px 0 8px;">Unsubscribe from marketing emails?</h1>
    <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 20px;">You will no longer receive marketing emails from us. This does not affect emails your agent sends you directly.</p>
    <form method="POST" action="/api/campaigns/unsubscribe?c=${campaignId}&amp;t=${esc(token)}">
      <button type="submit" style="background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:12px 26px;font-size:15px;cursor:pointer;">Yes, unsubscribe me</button>
    </form>
  </div>
</body></html>`);
  }

  private page(res: Response, title: string, message: string, ok: boolean): void {
    const color = ok ? '#4f46e5' : '#6b7280';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(`<!doctype html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f6f7f9;color:#111827;">
  <div style="max-width:460px;margin:12vh auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 28px;text-align:center;box-shadow:0 10px 30px -12px rgba(0,0,0,.15);">
    <div style="font-size:22px;font-weight:700;color:${color};margin-bottom:6px;">Get Home Realty</div>
    <h1 style="font-size:18px;margin:14px 0 8px;">${esc(title)}</h1>
    <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0;">${esc(message)}</p>
  </div>
</body></html>`);
  }
}
