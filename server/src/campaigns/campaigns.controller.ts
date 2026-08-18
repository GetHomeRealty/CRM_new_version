import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { CampaignsService } from './campaigns.service';
import { CampaignAudienceService, type AudienceFilter } from './campaign-audience.service';
import { CampaignTemplatesService } from './campaign-templates.service';
import { LeadImportJobService } from '../leads/lead-import-job.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  LEAD_STATUS, LEAD_TYPE, LEAD_SOURCE, CLIENT_TYPE, TAG_OPTIONS,
  CAMPAIGN_CATEGORIES, FILLABLE_TOKENS, LEAD_SOURCED_TOKENS, MAX_RECIPIENTS,
} from './campaign.constants';

const str = (v: unknown): string => String(v ?? '').trim();

/** Campaigns — viewing needs `campaigns` view; sending and lead edits need `campaigns` edit. */
@Controller('campaigns')
@UseGuards(AuthGuard, ScreenGuard)
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly audience: CampaignAudienceService,
    private readonly imports: LeadImportJobService,
    private readonly prisma: PrismaService,
  ) {}

  /** Vocabularies + templates for the campaign builder. */
  @Get('options')
  @Screen('campaigns', 'view')
  async options(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    /*
     * The Campaigns module's own template library — not Email Settings' transactional templates.
     *
     * SCOPED THE SAME WAY THE LIBRARY IS. This listed every active row regardless of owner, so the
     * picker offered two things the Templates screen does not: the shipped built-ins, which the
     * brokerage has decided are not campaign templates, and OTHER AGENTS' private drafts, which
     * `visibleWhere` has always treated as theirs alone. Either way a campaign could be built from
     * something its author could not find, edit or preview. `authoredWhere` is the one definition
     * both now use.
     */
    const templates = await this.prisma.campaign_templates.findMany({
      where: { is_active: true, deleted_at: null, ...CampaignTemplatesService.authoredWhere(user) },
      select: { id: true, name: true, subject: true, category: true, content: true, _count: { select: { attachments: true } } },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return {
      lead_status: LEAD_STATUS,
      lead_type: LEAD_TYPE,
      lead_source: LEAD_SOURCE,
      client_type: CLIENT_TYPE,
      tag_options: TAG_OPTIONS,
      categories: CAMPAIGN_CATEGORIES,
      fillable_tokens: FILLABLE_TOKENS,
      lead_sourced_tokens: LEAD_SOURCED_TOKENS,
      max_recipients: MAX_RECIPIENTS,
      tags: await this.campaigns.leadTags(user),
      // Each template's tokens, so the builder can warn about ones that can't be filled.
      templates: templates.map((t) => ({
        id: t.id, name: t.name, subject: t.subject, category: t.category,
        attachment_count: t._count.attachments,
        variables: this.audience.extractTokens(t.subject, t.content),
      })),
    };
  }

  @Get()
  @Screen('campaigns', 'view')
  list(@CurrentUser() user: AuthUserRecord, @Query('limit') limit?: string): Promise<unknown> {
    return this.campaigns.list(user, Number(limit) || 100);
  }

  /**
   * Whether the address baked into tracking pixels is reachable from the internet.
   * Open tracking fails silently when it isn't, so this makes that visible before a send.
   */
  @Get('tracking-health')
  @Screen('campaigns', 'view')
  async trackingHealth(@Req() req: Request): Promise<Record<string, unknown>> {
    const configured = str(process.env.CAMPAIGN_PUBLIC_URL);
    const checked_at = new Date().toISOString();

    if (!configured) {
      const host = str(req.headers.host);
      const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
      return {
        ok: false,
        url: null,
        ephemeral: false,
        reachable: false,
        checked_at,
        reason: isLocal
          ? 'CAMPAIGN_PUBLIC_URL is not set and the app is running on localhost, which a recipient\'s mail client cannot reach, so the open count will stay at zero. Everything else — delivery, bounces, failures and unsubscribes — is recorded normally. Set CAMPAIGN_PUBLIC_URL once the API is reachable from the internet.'
          : `CAMPAIGN_PUBLIC_URL is not set, so tracking links will use the request host (${host}). Set it explicitly to the address recipients can reach.`,
      };
    }

    const base = configured.replace(/\/+$/, '');
    // Quick tunnels get a new hostname on every restart, so a URL that works today is
    // usually dead tomorrow.
    const ephemeral = /trycloudflare\.com|ngrok(-free)?\.(io|app|dev)|loca\.lt/i.test(base);
    const insecure = /^http:\/\//i.test(base);

    // A loopback or LAN address answers perfectly from this machine and is unreachable from a
    // recipient's inbox. Without this check the probe would succeed and the banner would turn
    // green while every open silently went unrecorded — the exact failure this is meant to catch.
    if (isPrivateHost(base)) {
      return {
        ok: false,
        url: base,
        ephemeral,
        insecure,
        reachable: false,
        status: null,
        checked_at,
        reason: `CAMPAIGN_PUBLIC_URL points at ${base}, which is only reachable from this machine or local network. A recipient's mail client cannot load the pixel from there, so opens will not be recorded.`,
      };
    }

    // Actually fetch the pixel through the configured address rather than trusting that the
    // variable is set. This catches a typo, a wrong port, a dead tunnel or a broken certificate
    // — every failure mode that otherwise only shows up as a campaign with zero opens.
    const probe = await this.probePixel(base);

    const reasons: string[] = [];
    if (!probe.ok) reasons.push(`The tracking pixel could not be fetched from ${base} — ${probe.detail}. Opens will not be recorded.`);
    if (probe.ok && ephemeral) reasons.push('This is a temporary tunnel URL and will stop working when the tunnel restarts.');
    if (probe.ok && insecure) reasons.push('The address is plain http, so some mail clients will refuse to load the pixel.');
    if (probe.ok && !ephemeral && !insecure) {
      reasons.push('Reachable from this server. A recipient on another network should also be able to load it, provided the address is public.');
    }

    return {
      ok: probe.ok,
      url: base,
      ephemeral,
      insecure,
      reachable: probe.ok,
      status: probe.status,
      checked_at,
      reason: reasons.join(' '),
    };
  }

  /**
   * Request the tracking pixel over the configured public URL and confirm an image comes back.
   *
   * `c=0` matches no campaign, so the hit is discarded before anything is recorded — the probe
   * can never inflate a campaign's open count.
   */
  private async probePixel(base: string): Promise<{ ok: boolean; status: number | null; detail: string }> {
    const url = `${base}/api/campaigns/track/open?c=0&t=health-probe`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'TransactionDesk-TrackingHealth' } });
      const type = str(res.headers.get('content-type'));
      if (!res.ok) return { ok: false, status: res.status, detail: `it answered HTTP ${res.status}` };
      if (!/image\//i.test(type)) return { ok: false, status: res.status, detail: `it answered with "${type || 'no content type'}" instead of an image, so something else is serving that address` };
      return { ok: true, status: res.status, detail: 'the pixel loaded' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, status: null, detail: /abort/i.test(message) ? 'the request timed out after 6 seconds' : message };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- leads (the campaign audience) --------------------------------------
  // Declared BEFORE `:id` — Express matches in registration order, so a literal path
  // registered after it would be captured as an id and rejected by ParseIntPipe.
  @Get('leads/tags')
  @Screen('campaigns', 'view')
  async tags(@CurrentUser() user: AuthUserRecord): Promise<{ tags: string[] }> {
    return { tags: await this.campaigns.leadTags(user) };
  }

  /**
   * Queue a CSV import and return immediately.
   *
   * Shares the queue and the engine with `POST /api/leads/import` rather than keeping a second
   * implementation. The two had already diverged — this one had no in-file de-duplication and no
   * row cap — so the same file behaved differently depending on which screen it was dropped on.
   */
  @Post('leads/import')
  @HttpCode(202)
  @Screen('campaigns', 'edit')
  importLeads(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.imports.enqueue(str(body.csv), str(body.tag), 'campaigns', user);
  }

  /** Progress for one import. */
  @Get('leads/import/:jobId')
  @Screen('campaigns', 'view')
  importStatus(@Param('jobId') jobId: string): Promise<unknown> {
    return this.imports.status(jobId);
  }

  /** Preview or apply a tag across a lead segment. */
  @Post('leads/tag')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  async tagLeads(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    const filter = parseAudience(body);
    if (body.preview === true) return { count: await this.campaigns.countSegment(filter, user) };
    const tag = str(body.tagToApply);
    if (!tag) return { count: 0, message: 'Enter a tag to apply.' };
    return this.campaigns.tagSegment(filter, tag, body.mode === 'remove' ? 'remove' : 'add', user);
  }

  // NOTE: declared before `@Get(':id')`. Express matches in order, so `/campaigns/suppressions`
  // would otherwise be read as a campaign id — ParseIntPipe then rejects "suppressions" and the
  // screen gets a 400 for a route that exists. Same trap the Leads controller documents.
  // ------------------------------------------------------------- suppression list
  /**
   * Brokerage-wide, not scoped to the caller: a suppression is the recipient's decision about the
   * brokerage, and an agent must not be able to route around a colleague's opt-out by not seeing it.
   */
  @Get('suppressions')
  @Screen('campaigns', 'view')
  suppressions(
    @CurrentUser() user: AuthUserRecord,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ): Promise<unknown> {
    // The caller decides the scope: marketing and administrative roles see the brokerage's whole
    // opt-out list, everyone else sees the opt-outs of their own leads.
    return this.campaigns.listSuppressions(user, { page, limit, search });
  }

  /** Resuming mail to someone who opted out. Edit rights, and logged. */
  @Delete('suppressions/:email')
  @Screen('campaigns', 'edit')
  removeSuppression(@CurrentUser() user: AuthUserRecord, @Param('email') email: string): Promise<unknown> {
    return this.campaigns.removeSuppression(decodeURIComponent(email), user);
  }

  /** Call off a campaign that has not gone out yet. */
  @Post(':id/cancel')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  cancelScheduled(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.campaigns.cancelScheduled(id, user);
  }

  @Get(':id')
  @Screen('campaigns', 'view')
  get(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.campaigns.get(id, user);
  }

  /** Live recipient count for the builder. Sends nothing. */
  @Post('preview')
  @HttpCode(200)
  @Screen('campaigns', 'view')
  preview(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.campaigns.preview(parseAudience(body), user);
  }

  /** Create the campaign and send it. */
  @Post()
  @HttpCode(201)
  @Screen('campaigns', 'edit')
  send(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>, @Req() req: Request): Promise<unknown> {
    return this.campaigns.createAndSend({ ...body, baseUrl: trackingBaseUrl(req) } as never, user);
  }

  /**
   * Pre-flight: send one test email through the exact account a campaign would use, so an agent
   * can confirm their SMTP credentials before a real send. Returns the SMTP outcome rather than
   * throwing, so the UI can show the precise error (e.g. Gmail's "535 BadCredentials").
   */
  @Post('test-send')
  @HttpCode(200)
  @Screen('campaigns', 'edit')
  testSend(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<unknown> {
    const to = str(body.to);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new BadRequestException({ message: 'Enter a valid email address to send the test to.', errors: { to: ['A valid email address is required.'] } });
    }
    return this.campaigns.sendTest(user, to);
  }

  @Delete(':id')
  @Screen('campaigns', 'edit')
  remove(@CurrentUser() user: AuthUserRecord, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.campaigns.remove(id, user);
  }
}

/**
 * Whether a URL's host can only be reached from this machine or the local network — loopback,
 * a .local name, or an RFC1918 range. Such an address is useless for open tracking however
 * well it responds locally.
 */
export function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false; // not parseable — the probe will report the real failure
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '0.0.0.0') return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127                        // loopback
    || a === 10                           // 10.0.0.0/8
    || (a === 192 && b === 168)           // 192.168.0.0/16
    || (a === 172 && b >= 16 && b <= 31)  // 172.16.0.0/12
    || (a === 169 && b === 254);          // link-local
}

function parseAudience(body: Record<string, unknown>): AudienceFilter {
  return {
    leadStatus: str(body.leadStatus) || undefined,
    leadType: str(body.leadType) || undefined,
    leadSource: str(body.leadSource) || undefined,
    clientType: str(body.clientType) || undefined,
    tag: str(body.tag) || undefined,
  };
}

/**
 * Absolute base URL for tracking links.
 *  1. CAMPAIGN_PUBLIC_URL — set this in dev to a tunnel, since `localhost` is unreachable
 *     from a recipient's mail client.
 *  2. The incoming request origin (correct in production behind a real domain).
 */
export function trackingBaseUrl(req: Request): string {
  const override = str(process.env.CAMPAIGN_PUBLIC_URL);
  if (override) return override.replace(/\/+$/, '');
  const proto = str(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = str(req.headers['x-forwarded-host']) || str(req.headers.host);
  return host ? `${proto}://${host}` : '';
}
