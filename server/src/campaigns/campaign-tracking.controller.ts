import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CampaignsService } from './campaigns.service';

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
@Controller('campaigns')
export class CampaignTrackingController {
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

  /** One-click unsubscribe from an email link. */
  @Get('unsubscribe')
  async unsubscribe(@Query('c') c: string, @Query('t') t: string, @Res() res: Response): Promise<void> {
    const campaignId = Number(c);
    if (!Number.isInteger(campaignId) || campaignId <= 0 || !t) {
      return this.page(res, 'Invalid link', 'This unsubscribe link is not valid.', false);
    }
    try {
      const result = await this.campaigns.unsubscribe(campaignId, String(t));
      if (!result.ok) {
        return this.page(res, 'Link not found', 'We could not find your subscription for this email.', false);
      }
      return this.page(
        res,
        'You have been unsubscribed',
        'You will no longer receive marketing emails from us. If this was a mistake, contact your agent.',
        true,
      );
    } catch {
      return this.page(res, 'Something went wrong', 'We could not process your request. Please try again later.', false);
    }
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
