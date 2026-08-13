import { areaPath } from '../common/domain';
import { Controller, Get, Header, HttpCode, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MetaConnectionService } from './meta-connection.service';
import { MetaGraphService } from './meta-graph.service';
import { MetaSyncService } from './meta-sync.service';
import { MetaStateService } from './meta-state.service';
import { REQUIRED_LIVE_PERMISSIONS, isConfigured, redirectUri, webhookSecret, webhookVerifyToken } from './meta.constants';
import { createHash } from 'node:crypto';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthService } from '../auth/auth.service';

const str = (v: unknown): string => String(v ?? '').trim();

/**
 * Public Meta endpoints. These are called by Facebook, not by the SPA, so they carry NO
 * AuthGuard and NO CSRF token — the OAuth callback is trusted via its signed `state`, and the
 * webhook via its `x-hub-signature-256` HMAC.
 *
 * Registered BEFORE MetaController so `meta/callback` and `meta/webhook` are matched by these
 * literal routes rather than falling into the guarded controller.
 */
/**
 * Exempt from rate limiting.
 *
 * Meta lead-ad deliveries and the OAuth callback. A lead form spike arrives as a burst from
 * Meta's own addresses; a throttled webhook is a lost lead, not a blocked attacker.
 */
@SkipThrottle()
@Controller('meta')
export class MetaPublicController {
  private readonly log = new Logger(MetaPublicController.name);

  constructor(
    private readonly connections: MetaConnectionService,
    private readonly graph: MetaGraphService,
    private readonly sync: MetaSyncService,
    private readonly state: MetaStateService,
    private readonly auth: AuthService,
  ) {}

  /** Where the browser lands after Meta redirects back. */
  private frontendReturn(outcome: string): string {
    const base = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
    return `${base}${areaPath('crm', 'meta')}?${outcome}`;
  }

  /**
   * OAuth callback. Meta sends the user's browser here with `code` and our signed `state`.
   * Always ends in a redirect back to the SPA — the user must never see raw JSON.
   */
  @Get('callback')
  async callback(@Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const fail = (reason: string, detail = ''): void => {
      if (detail) this.log.warn(`Meta OAuth callback failed (${reason}): ${detail}`);
      res.redirect(this.frontendReturn(`meta_error=${encodeURIComponent(reason)}`));
    };

    if (str(q.error)) return fail(str(q.error_reason) || 'access_denied', str(q.error_description));

    // Validate the request itself before the server's own configuration: a forged callback must
    // always be reported as such, never masked by an unrelated "not configured" answer.
    const code = str(q.code);
    if (!code) return fail('missing_code');
    // A bad state means forged, expired or replayed — never fall back to "trust the caller".
    const userId = await this.state.verify(str(q.state));
    if (!userId) return fail('invalid_state');

    /**
     * Resolve who started this flow, and refuse if they can no longer act.
     *
     * The signed state is what proves whose connect this is — there is no session on this route, so
     * it is the only evidence available. `loadUser` returns null for an account that no longer
     * exists or has been deactivated, and that has to stop here: a departed agent must not be able
     * to finish binding a Facebook account to the CRM with a state parameter minted while they
     * still had access.
     */
    const user = await this.auth.loadUser(userId);
    if (!user) return fail('account_unavailable');

    if (!isConfigured()) return fail('not_configured');

    try {
      const proto = str(req.headers['x-forwarded-proto']) || req.protocol || 'http';
      const host = str(req.headers['x-forwarded-host']) || str(req.headers.host);
      const uri = redirectUri(host ? `${proto}://${host}` : '');

      const shortLived = await this.graph.exchangeCode(code, uri);
      const token = await this.graph.longLivedToken(shortLived);
      const profile = await this.graph.me(token);
      const pages = await this.graph.pages(token);

      await this.connections.save(userId, token, profile, pages);

      // Record what Meta actually granted and when the token dies, so the UI can warn ahead of
      // an expiry instead of the integration going quiet.
      const inspected = await this.graph.inspectToken(token);
      await this.connections.recordTokenState(userId, inspected.expiresAt, inspected.scopes);
      await this.connections.clearError(userId);

      const missing = REQUIRED_LIVE_PERMISSIONS.filter((p) => inspected.scopes.length > 0 && !inspected.scopes.includes(p));
      this.log.log(`Meta connected for user ${userId}: ${pages.length} page(s), scopes: ${inspected.scopes.join(',') || 'unknown'}.`);
      if (missing.length) {
        return res.redirect(this.frontendReturn(`meta_connected=1&meta_warning=missing_permissions&meta_missing=${encodeURIComponent(missing.join(','))}`));
      }

      // No Pages means lead ads can't be read — say so instead of reporting plain success.
      res.redirect(this.frontendReturn(pages.length ? 'meta_connected=1' : 'meta_connected=1&meta_warning=no_pages'));
    } catch (err) {
      fail('connect_failed', err instanceof Error ? err.message : String(err));
    }
  }

  /** Webhook handshake. Meta calls this once when the subscription is created. */
  @Get('webhook')
  @Header('Content-Type', 'text/plain')
  verifyWebhook(@Query() q: Record<string, string>, @Res() res: Response): void {
    const expected = webhookVerifyToken();
    const token = str(q['hub.verify_token']);
    // Refuse rather than echo the challenge when no token is configured — otherwise anyone
    // could complete the handshake and point a subscription at this server.
    if (expected && str(q['hub.mode']) === 'subscribe' && token === expected) {
      res.status(200).send(str(q['hub.challenge']));
      return;
    }
    this.log.warn('Meta webhook verification rejected (token mismatch or META_WEBHOOK_VERIFY_TOKEN unset).');
    res.status(403).send('Forbidden');
  }

  /**
   * Lead delivery. Meta retries anything that isn't a 200, so this returns 200 even for
   * problems it can't fix — except a failed signature check, which must be rejected.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: Request): Promise<{ received: boolean }> {
    const secret = webhookSecret();
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;

    if (!secret) {
      this.log.error('Meta webhook received but no secret is configured — ignoring.');
      return { received: false };
    }
    if (!raw) {
      this.log.error('Meta webhook received without a raw body; signature cannot be verified.');
      return { received: false };
    }
    if (!this.signatureValid(raw, str(req.headers['x-hub-signature-256']), secret)) {
      this.log.warn('Meta webhook signature invalid — ignoring.');
      return { received: false };
    }

    const body = req.body as { object?: string; entry?: { id?: string; changes?: { field?: string; value?: Record<string, string> }[] }[] };
    if (body?.object !== 'page') return { received: true };

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'leadgen') continue;
        const v = change.value ?? {};
        try {
          await this.sync.ingestWebhookLead(str(v.leadgen_id), str(v.form_id), str(v.page_id) || str(entry.id));
        } catch (err) {
          // Swallow: a throw here would make Meta retry the whole batch forever.
          this.log.error(`Webhook lead ${v.leadgen_id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { received: true };
  }

  /**
   * Data deletion callback. Meta requires every app that reads user data to publish one, and
   * calls it when a user removes the app from their Facebook account.
   *
   * The request is signed with the app secret. On a valid request the user's Meta connection
   * and its tokens are erased; leads already imported are business records and are kept, which
   * is what the deletion status URL explains.
   */
  @Post('data-deletion')
  @HttpCode(200)
  async dataDeletion(@Req() req: Request): Promise<Record<string, unknown>> {
    const body = req.body as { signed_request?: string };
    const parsed = this.parseSignedRequest(str(body?.signed_request));
    const base = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

    if (!parsed?.user_id) {
      this.log.warn('Meta data-deletion callback received with an invalid signed_request.');
      return { url: `${base}${areaPath('crm', 'meta')}`, confirmation_code: 'invalid-request' };
    }

    const connection = await this.connections.findByFacebookUserId(parsed.user_id);
    if (connection) {
      await this.connections.disconnect(connection.user_id);
      this.log.log(`Meta data-deletion: erased tokens for user ${connection.user_id} (fb ${parsed.user_id}).`);
    }

    // A short, stable code Meta shows the user, and a URL where they can check the status.
    const code = createHash('sha256').update(`del:${parsed.user_id}`).digest('hex').slice(0, 16);
    return { url: `${base}${areaPath('crm', 'meta')}?deletion=${code}`, confirmation_code: code };
  }

  /**
   * Verify and decode Meta's `signed_request` (base64url payload + HMAC, app-secret signed).
   * Returns null when the signature does not match — never trust the payload otherwise.
   */
  private parseSignedRequest(signed: string): { user_id?: string } | null {
    const [sigPart, payloadPart] = signed.split('.');
    if (!sigPart || !payloadPart) return null;
    const secret = webhookSecret();
    if (!secret) return null;
    try {
      const expected = createHmac('sha256', secret).update(payloadPart).digest();
      const given = Buffer.from(sigPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      return JSON.parse(Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { user_id?: string };
    } catch {
      return null;
    }
  }

  /** HMAC-SHA256 of the exact bytes Meta sent, compared in constant time. */
  private signatureValid(raw: Buffer, header: string, secret: string): boolean {
    if (!header.startsWith('sha256=')) return false;
    const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
