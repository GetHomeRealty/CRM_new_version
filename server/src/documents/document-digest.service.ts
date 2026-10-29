import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { schedulersEnabled, schedulerSkipReason } from '../common/schedulers';
import { registerWorker } from '../observability/worker-health';
import { clusterTick } from '../redis/cluster-tick';
import { RedisService } from '../redis/redis.service';
import { CacheService } from '../redis/cache.service';

/**
 * THE MORNING EMAIL TO DOCUMENTATION (Sai, 29 Oct 2026): "X documents are waiting for review".
 *
 * One email a day per person instead of one per upload (each upload is a bell + phone message only).
 * Each person sees the deals they handle, plus the deals nobody handles in the countries they work in
 * - the same "Handled by, else the team" rule as the upload notice. Nothing waiting, nothing sent.
 *
 * "Waiting" = a document with a file on it that is still Pending (not yet Valid or Invalid).
 *
 * WAKES HOURLY, SENDS ONCE A DAY, FROM 8 AM. The bell row is claimed in the dispatcher's ledger with a
 * per-person, per-day key BEFORE the email goes, so a restart, a second process or the next hourly
 * wake never sends it twice. Switched off from Triggers like any other message (its email template).
 */
const SEND_FROM_HOUR = 8;
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const MAX_DEALS_LISTED = 40;

const redirectTo = (): string | null => {
  const v = (process.env.MAIL_REDIRECT_TO ?? '').trim();
  return v === '' ? null : v;
};
const esc = (value: unknown): string =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface WaitingDeal { id: number; trade_no: string | null; property: string | null; agent: string | null; waiting: number; oldest: Date | null }

@Injectable()
export class DocumentDigestService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DocumentDigestService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    if (!schedulersEnabled()) {
      this.log.log(`Documentation morning summary not scheduled (${schedulerSkipReason()}).`);
      return;
    }
    registerWorker('document-digest', POLL_INTERVAL_MS);
    this.timer = setInterval(clusterTick({ redis: this.redis, cache: this.cache }, 'document-digest', () => this.run()), POLL_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    setTimeout(() => void this.run(), 90_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.send(now);
    } catch (err) {
      this.log.error(`Documentation morning summary failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass: each Documentation person gets today's summary once, from 8 am. Returns who was told. */
  async send(now: Date = new Date()): Promise<number[]> {
    if (now.getHours() < SEND_FROM_HOUR) return [];
    const people = await this.prisma.users.findMany({
      where: { role: 'documentation', status: 'Active' },
      select: { id: true, name: true, email: true, markets: true },
      orderBy: { id: 'asc' },
    });
    const told: number[] = [];
    for (const p of people) {
      const deals = await this.waitingFor(p.id, (p.markets ?? 'CA').split(',').map((m) => m.trim().toUpperCase()).filter(Boolean));
      if (deals.length === 0) continue;
      const docs = deals.reduce((n, d) => n + d.waiting, 0);
      const title = `${docs} document${docs === 1 ? '' : 's'} waiting for review on ${deals.length} deal${deals.length === 1 ? '' : 's'}`;

      // The bell row is the once-a-day lock: a duplicate means today's summary already went.
      const claimed = await this.dispatcher.dispatch({
        category: 'document_uploads', userId: p.id, title,
        link: '/desk/transactions', dedupeKey: `doc-waiting-${p.id}-${ymd(now)}`, channels: ['in_app'],
      }).catch(() => null);
      if (!claimed || claimed.skipped.some((x) => x.reason === 'duplicate')) continue;
      told.push(p.id);

      const address = (p.email ?? '').trim();
      if (!address) continue;
      try {
        await this.mailer.send('document.waiting_summary', {
          recipient_name: p.name,
          document_count: String(docs),
          deal_count: String(deals.length),
          deals_table: this.table(deals),
          company_name: (await this.settings.current()).name,
        }, redirectTo() ?? address);
      } catch (err) {
        // A switched-off template lands here too ("No active email template") - the bell row stands.
        this.log.warn(`Morning summary email to ${address} not sent: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return told;
  }

  /** The deals with documents waiting that this person looks after, oldest upload first. */
  async waitingFor(userId: number, markets: string[]): Promise<WaitingDeal[]> {
    const docs = await this.prisma.documents.findMany({
      where: {
        deleted_at: null,
        OR: [{ file_path: { not: null } }, { AND: [{ files: { not: null } }, { files: { notIn: ['', '[]'] } }] }],
        transactions: {
          deleted_at: null,
          market: { in: markets.length ? markets : ['CA'] },
          OR: [{ doc_handler_id: userId }, { doc_handler_id: null }],
        },
      },
      select: {
        validation: true, uploaded_at: true,
        transactions: { select: { id: true, trade_no: true, property: true, agent: true } },
      },
    });
    const byDeal = new Map<number, WaitingDeal>();
    for (const d of docs) {
      if (String(d.validation ?? '').trim().toLowerCase() !== 'pending' || !d.transactions) continue;
      const t = d.transactions;
      const e = byDeal.get(t.id) ?? { id: t.id, trade_no: t.trade_no, property: t.property, agent: t.agent, waiting: 0, oldest: null };
      e.waiting += 1;
      if (d.uploaded_at && (!e.oldest || d.uploaded_at < e.oldest)) e.oldest = d.uploaded_at;
      byDeal.set(t.id, e);
    }
    return [...byDeal.values()].sort((a, b) => (a.oldest?.getTime() ?? 0) - (b.oldest?.getTime() ?? 0));
  }

  private table(deals: WaitingDeal[]): string {
    const base = (process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '');
    const cell = 'padding:4px 8px;border:1px solid #e5e7eb';
    const rows = deals.slice(0, MAX_DEALS_LISTED).map((d) => {
      const deal = base ? `<a href="${esc(`${base}/desk/transactions/${d.id}`)}">${esc(d.trade_no ?? d.id)}</a>` : esc(d.trade_no ?? d.id);
      return `<tr><td style="${cell}">${deal}</td><td style="${cell}">${esc(d.property ?? '-')}</td><td style="${cell}">${esc(d.agent ?? '-')}</td>`
        + `<td style="${cell};text-align:center">${d.waiting}</td><td style="${cell}">${d.oldest ? esc(ymd(d.oldest)) : '-'}</td></tr>`;
    }).join('');
    const more = deals.length > MAX_DEALS_LISTED ? `<p>And ${deals.length - MAX_DEALS_LISTED} more deals.</p>` : '';
    return '<table style="border-collapse:collapse;font-size:13px;margin:10px 0">'
      + `<tr><th style="${cell};text-align:left">Deal</th><th style="${cell};text-align:left">Property</th><th style="${cell};text-align:left">Agent</th><th style="${cell}">Waiting</th><th style="${cell};text-align:left">Oldest upload</th></tr>`
      + rows + '</table>' + more;
  }
}
