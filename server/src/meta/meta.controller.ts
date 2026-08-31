import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { META_SYNC_LIMIT } from '../config/rate-limits';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { liveLeadWhere } from '../common/lead-scope';
import { MetaConnectionService } from './meta-connection.service';
import { MetaGraphService, GraphError } from './meta-graph.service';
import { MetaSyncService } from './meta-sync.service';
import { MetaStateService } from './meta-state.service';
import { tokenStorageIsSecure } from './meta-crypto';
import {
  BLOCKING_IF_NOT_LIVE, REQUIRED_LIVE_PERMISSIONS, appId, isConfigured, loginConfigId,
  oauthStrategy, redirectUri,
} from './meta.constants';

const str = (v: unknown): string => String(v ?? '').trim();

/** Origin of the incoming request, used when META_PUBLIC_URL isn't set. */
function origin(req: Request): string {
  const proto = str(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = str(req.headers['x-forwarded-host']) || str(req.headers.host);
  return host ? `${proto}://${host}` : '';
}

/**
 * Meta (Facebook / Instagram) lead ads. Reading needs `meta` view; connecting, syncing and
 * toggling forms need `meta` edit.
 *
 * Access tokens never leave the server — no endpoint here returns one.
 */
@Controller('meta')
@UseGuards(AuthGuard, ScreenGuard)
export class MetaController {
  constructor(
    private readonly connections: MetaConnectionService,
    private readonly graph: MetaGraphService,
    private readonly sync: MetaSyncService,
    private readonly state: MetaStateService,
    private readonly prisma: PrismaService,
  ) {}

  /** Connection state + whether the server is configured well enough to connect at all. */
  @Get('status')
  @Screen('meta', 'view')
  async status(@CurrentUser() user: AuthUserRecord, @Req() req: Request): Promise<Record<string, unknown>> {
    const conn = await this.connections.find(user.id ?? 0);
    /*
     * COUNTED THE SAME WAY THE LEAD PAGE COUNTS, which is the whole fix.
     *
     * This asked for `owner_user_id = you` alone. A Meta lead does not necessarily arrive owned:
     * the importer writes brokerage-owned rows with an ASSIGNEE, so a lead handed straight to the
     * person who is looking at this screen — and who was pushed a notification about it — matched
     * nothing and the card read 0. Observed exactly that: "Misha Abayev" landed with
     * `owner_user_id = null, assigned_to = 10108`, and every one of the three tiles stayed at zero
     * while the Lead page listed it.
     *
     * `liveLeadWhere` is the rule the Lead list, the dashboard and the task counters already share
     * — assigned to you, or owned by you, plus the brokerage's own when your role includes them.
     * Borrowed rather than restated, so this card cannot disagree with the page it links to again.
     */
    const leadsCount = await this.prisma.leads.count({
      where: { AND: [{ source: 'facebook_meta' }, liveLeadWhere(user)] },
    });
    const meta = conn ? await this.connections.meta(user.id ?? 0) : null;
    const forms = conn ? await this.prisma.meta_lead_forms.count({ where: { user_id: user.id ?? 0, is_active: true } }) : 0;

    // A long-lived token lasts ~60 days; warn while there is still time to reconnect.
    const expiresAt = meta?.token_expires_at ?? null;
    const daysLeft = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 86400000) : null;
    const granted = str(meta?.granted_scopes).split(',').filter(Boolean);
    const missingPermissions = granted.length ? REQUIRED_LIVE_PERMISSIONS.filter((p) => !granted.includes(p)) : [];

    return {
      connected_forms: forms,
      token_expires_at: expiresAt?.toISOString() ?? null,
      token_days_left: daysLeft,
      /*
       * Compared against the instant, not against whole days. `daysLeft` floors to 0 for anything
       * inside the last twenty-four hours, so a token that failed a moment ago read as "0 days
       * left" rather than expired — and that is exactly the state a sync writes when Meta answers
       * 190, since `markTokenDead` stamps the expiry as now.
       */
      token_expired: expiresAt !== null && expiresAt.getTime() <= Date.now(),
      needs_reconnect: (daysLeft !== null && daysLeft <= 7) || missingPermissions.length > 0,
      granted_scopes: granted,
      missing_permissions: missingPermissions,
      ad_account_id: meta?.ad_account_id ?? null,
      ad_account_name: meta?.ad_account_name ?? null,
      last_error: meta?.last_error ?? null,
      last_error_at: meta?.last_error_at?.toISOString() ?? null,
      last_webhook_at: meta?.last_webhook_at?.toISOString() ?? null,
      configured: isConfigured(),
      // Surfaced so a missing APP_KEY can't quietly mean tokens sit in plain text.
      token_storage_secure: tokenStorageIsSecure(),
      redirect_uri: redirectUri(origin(req)),
      oauth_strategy: oauthStrategy(),
      has_login_config_id: loginConfigId() !== '',
      is_connected: !!conn,
      facebook_user_name: conn?.facebook_user_name ?? null,
      pages_count: conn?.pages.length ?? 0,
      page_name: conn?.pages[0]?.name ?? null,
      connected_at: conn?.connected_at?.toISOString() ?? null,
      last_sync: conn?.last_sync?.toISOString() ?? null,
      leads_count: leadsCount,
    };
  }

  /**
   * Begin the OAuth flow. Returns the dialog URL rather than redirecting, so the SPA controls
   * navigation and can show an error inline when the server isn't configured.
   */
  @Get('auth-url')
  @Screen('meta', 'edit')
  authUrl(@CurrentUser() user: AuthUserRecord, @Req() req: Request): { auth_url: string } {
    if (!isConfigured()) {
      throw new BadRequestException({
        message: 'Meta is not configured on the server. Set META_APP_ID and META_APP_SECRET, then restart the API.',
      });
    }
    const uri = redirectUri(origin(req));
    if (!/^https:\/\//i.test(uri)) {
      throw new BadRequestException({
        message: `Meta only accepts an HTTPS redirect URI. This server resolved "${uri}" — set META_PUBLIC_URL to the public HTTPS address.`,
      });
    }
    // Signed, single-use, short-lived state — the callback arrives without a session cookie in
    // some browsers, so the state is the only thing proving who started the flow.
    return { auth_url: this.graph.buildAuthUrl(uri, this.state.issue(user.id ?? 0)) };
  }

  @Get('pages')
  @Screen('meta', 'view')
  async pages(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    const conn = await this.connections.find(user.id ?? 0);
    if (!conn) throw new BadRequestException({ message: 'Meta is not connected.' });
    // Page tokens are deliberately omitted.
    return { pages: conn.pages.map((p) => ({ id: p.page_id, name: p.name })) };
  }

  @Post('pages/refresh')
  @HttpCode(200)
  @Screen('meta', 'edit')
  async refreshPages(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    const count = await this.wrap(() => this.connections.refreshPages(user.id ?? 0));
    return { pages: count, message: `${count} page(s) available.` };
  }

  /** Lead forms on a Page, each flagged with whether it is connected here. */
  @Get('forms')
  @Screen('meta', 'view')
  async forms(@CurrentUser() user: AuthUserRecord, @Query('page_id') pageId: string): Promise<Record<string, unknown>> {
    const id = str(pageId);
    if (!id) throw new BadRequestException({ message: 'A page is required.' });

    const conn = await this.connections.find(user.id ?? 0);
    const page = conn?.pages.find((p) => p.page_id === id);
    if (!conn || !page) throw new BadRequestException({ message: 'That page is not part of your Meta connection.' });

    const forms = await this.wrap(() => this.graph.forms(id, page.token));
    const connected = await this.prisma.meta_lead_forms.findMany({
      where: { user_id: user.id ?? 0, page_id: id, is_active: true },
      select: { form_id: true },
    });
    const on = new Set(connected.map((f) => f.form_id));

    return {
      page_name: page.name,
      forms: forms.map((f) => ({
        id: f.id, name: f.name, status: f.status ?? null,
        leads_count: f.leads_count ?? 0, created_at: f.created_time ?? null,
        is_connected: on.has(f.id),
      })),
    };
  }

  /** Opt a lead form in or out. Only opted-in forms are ever read. */
  @Post('forms')
  @HttpCode(200)
  @Screen('meta', 'edit')
  async toggleForm(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const formId = str(body.form_id);
    const pageId = str(body.page_id);
    const connect = body.connect === true;
    if (!formId || !pageId) throw new BadRequestException({ message: 'A form and a page are required.' });

    const conn = await this.connections.find(user.id ?? 0);
    if (!conn?.pages.some((p) => p.page_id === pageId)) {
      throw new BadRequestException({ message: 'That page is not part of your Meta connection.' });
    }

    /*
     * A lead form belongs to one agent. Nothing is shared.
     *
     * Each agent connects their own Meta account, their own Page and their own forms, and receives
     * their own leads — so a form already connected by somebody else is a misconfiguration, refused
     * here with the holder named rather than allowed and then routed ambiguously. Allowing it is
     * what produced the original defect: the webhook picked one of the two arbitrarily, so one agent
     * silently received every lead and the other received none while their screen showed the form as
     * connected.
     *
     * Only `is_active` rows block. A form somebody previously connected and turned off is free to be
     * taken up by whoever is running it now.
     */
    if (connect) {
      const heldByAnother = await this.prisma.meta_lead_forms.findFirst({
        where: { form_id: formId, page_id: pageId, is_active: true, user_id: { not: user.id ?? 0 } },
        select: { user_id: true },
      });
      if (heldByAnother) {
        const holder = await this.prisma.users.findUnique({ where: { id: heldByAnother.user_id }, select: { name: true } });
        throw new BadRequestException({
          message: `This lead form is already connected by ${holder?.name ?? 'another agent'}. `
            + 'A form belongs to one agent, so each receives only their own leads — ask them to disconnect it first, '
            + 'or connect a form of your own.',
        });
      }
    }

    const now = new Date();
    await this.prisma.meta_lead_forms.upsert({
      where: { user_id_form_id_page_id: { user_id: user.id ?? 0, form_id: formId, page_id: pageId } },
      create: {
        user_id: user.id ?? 0, form_id: formId, page_id: pageId,
        form_name: str(body.form_name) || null, is_active: connect, created_at: now, updated_at: now,
      },
      update: { is_active: connect, form_name: str(body.form_name) || undefined, updated_at: now },
    });
    return { connected: connect, message: connect ? 'Lead form connected.' : 'Lead form disconnected.' };
  }

  @Post('sync')
  @HttpCode(200)
  // Fans out to Graph, whose limits are per APP — see META_SYNC_LIMIT.
  @Throttle({ default: META_SYNC_LIMIT })
  @Screen('meta', 'edit')
  async syncNow(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    const r = await this.wrap(() => this.sync.syncUser(user));
    return {
      ...r,
      message: r.imported || r.updated
        ? `Synced ${r.imported} new and ${r.updated} updated lead(s) from ${r.forms} form(s).`
        : r.errors.length ? r.errors[0] : 'No new leads.',
    };
  }

  @Delete('disconnect')
  @Screen('meta', 'edit')
  disconnect(@CurrentUser() user: AuthUserRecord): Promise<{ disconnected: boolean }> {
    return this.connections.disconnect(user.id ?? 0);
  }

  /** Meta leads already in the database, newest first — no Graph call, so this always works. */
  /** Ad accounts, for campaign attribution. Empty when ads_read was not granted. */
  @Get('ad-accounts')
  @Screen('meta', 'view')
  async adAccounts(@CurrentUser() user: AuthUserRecord): Promise<Record<string, unknown>> {
    const conn = await this.connections.find(user.id ?? 0);
    if (!conn) throw new BadRequestException({ message: 'Meta is not connected.' });
    // M-M6: through `wrap`, like every other Graph call on this controller. These two were the only
    // ones that were not, so an expired token or a missing `ads_read` grant surfaced here as a bare
    // 500 rather than as Meta's own message with its code — the one thing that tells somebody
    // whether to reconnect or to change the app's permissions.
    const accounts = await this.wrap(() => this.graph.adAccounts(conn.token));
    return {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, active: a.account_status === 1 })),
      note: accounts.length === 0
        ? 'No ad accounts are readable. Campaign, ad-set and ad names will be blank on imported leads; the leads themselves still import.'
        : '',
    };
  }

  @Post('ad-accounts/select')
  @HttpCode(200)
  @Screen('meta', 'edit')
  async selectAdAccount(@CurrentUser() user: AuthUserRecord, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = str(body.id);
    const conn = await this.connections.find(user.id ?? 0);
    if (!conn) throw new BadRequestException({ message: 'Meta is not connected.' });
    if (!id) {
      await this.connections.setAdAccount(user.id ?? 0, null, null);
      return { selected: null, message: 'Ad account cleared.' };
    }
    const accounts = await this.wrap(() => this.graph.adAccounts(conn.token));
    const match = accounts.find((a) => a.id === id);
    if (!match) throw new BadRequestException({ message: 'That ad account is not available on this connection.' });
    await this.connections.setAdAccount(user.id ?? 0, match.id, match.name);
    return { selected: match.id, message: `Attribution will use ${match.name}.` };
  }

  /** Past sync runs — manual, webhook and scheduled. */
  @Get('sync-history')
  @Screen('meta', 'view')
  syncHistory(@CurrentUser() user: AuthUserRecord, @Query('limit') limit?: string): Promise<unknown> {
    return this.sync.syncHistory(user.id ?? 0, Number(limit) || 20);
  }

  /** Recent webhook deliveries and whether they were processed. */
  @Get('webhook-health')
  @Screen('meta', 'view')
  webhookHealth(@CurrentUser() user: AuthUserRecord, @Query('limit') limit?: string): Promise<unknown> {
    return this.sync.webhookHealth(user, Number(limit) || 20);
  }

  @Get('leads')
  @Screen('meta', 'view')
  async leads(@CurrentUser() user: AuthUserRecord, @Query('limit') limit?: string): Promise<Record<string, unknown>> {
    const take = Math.min(200, Math.max(1, Number(limit) || 50));
    // Same scope as the card above, for the same reason: the list and the tiles counting it must
    // answer one question. `liveLeadWhere` already excludes deleted rows.
    const where = { AND: [{ source: 'facebook_meta' }, liveLeadWhere(user)] };
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

    const [rows, total, today, week] = await Promise.all([
      this.prisma.leads.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take }),
      this.prisma.leads.count({ where }),
      this.prisma.leads.count({ where: { ...where, created_at: { gte: startOfDay } } }),
      this.prisma.leads.count({ where: { ...where, created_at: { gte: startOfWeek } } }),
    ]);

    return {
      stats: { total, today, week },
      data: rows.map((r) => ({
        id: r.id, name: r.name, email: r.email, phone: r.phone,
        message: r.message, property: r.property, lead_status: r.lead_status,
        facebook_lead_id: r.facebook_lead_id,
        created_at: r.created_at?.toISOString() ?? null,
      })),
    };
  }

  /** Why a connection is failing: app permission status and the usual misconfigurations. */
  @Get('diagnostics')
  @Screen('meta', 'edit')
  async diagnostics(@Req() req: Request): Promise<Record<string, unknown>> {
    const uri = redirectUri(origin(req));
    const blockers: string[] = [];

    if (!isConfigured()) blockers.push('META_APP_ID / META_APP_SECRET are not set on the server.');
    if (!tokenStorageIsSecure()) blockers.push('APP_KEY is not set, so access tokens would be stored unencrypted.');
    if (!loginConfigId()) blockers.push('META_LOGIN_CONFIG_ID is not set — Business-type apps reject the dialog without it.');
    else if (oauthStrategy() === 'scope') blockers.push('META_OAUTH_STRATEGY=scope is incompatible with a Login for Business app; use "config".');
    if (!/^https:\/\//i.test(uri)) blockers.push(`The redirect URI resolves to "${uri}", which Meta will reject — it must be HTTPS. Set META_PUBLIC_URL.`);

    let app: { name?: string; link?: string; live: string[] } | null = null;
    if (isConfigured()) {
      try { app = await this.graph.appPermissions(); } catch (err) { blockers.push(`Could not read app permissions: ${(err as Error).message}`); }
    }

    const live = app?.live ?? [];
    const missing = isConfigured() && app ? REQUIRED_LIVE_PERMISSIONS.filter((p) => !live.includes(p)) : [];
    if (missing.length) blockers.push(`Permissions not yet Live: ${missing.join(', ')} — request them in App Review.`);
    for (const p of BLOCKING_IF_NOT_LIVE) {
      if (app && !live.includes(p)) blockers.push(`Remove "${p}" from the Login configuration until App Review grants it.`);
    }

    return {
      configured: isConfigured(),
      app_id: appId() || null,
      app_name: app?.name ?? null,
      app_link: app?.link ?? null,
      live_permissions: live,
      required_permissions: [...REQUIRED_LIVE_PERMISSIONS],
      missing_permissions: missing,
      redirect_uri: uri,
      oauth_strategy: oauthStrategy(),
      login_config_id: loginConfigId() || null,
      token_storage_secure: tokenStorageIsSecure(),
      blockers,
      fix_steps: [
        'Meta → Facebook Login for Business → Configurations → create or edit a configuration.',
        'Token type: User access token (not System-user).',
        'Permissions in the configuration: pages_show_list, pages_read_engagement, leads_retrieval, email.',
        `Valid OAuth Redirect URIs must include exactly: ${uri}`,
        'App domains must include this server\'s domain.',
        'Set META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID and META_PUBLIC_URL, then restart the API.',
      ],
    };
  }

  /** Turn a Graph failure into Meta's own message instead of a generic 500. */
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GraphError) {
        throw new BadRequestException({ message: `Meta: ${err.message}`, code: err.code, subcode: err.subcode });
      }
      throw err;
    }
  }
}
