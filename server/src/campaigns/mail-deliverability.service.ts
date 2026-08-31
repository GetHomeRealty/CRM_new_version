import { Injectable, Logger } from '@nestjs/common';
import {
  analyseContent, checkDkim, checkDmarc, checkSpf, spamRisk,
  type AuthCheck, type ContentReport, type SpamRisk,
} from './deliverability-report';

// DNS record types in the DNS-over-HTTPS JSON response.
const DNS_TYPE_A = 1;
const DNS_TYPE_TXT = 16;
const DNS_TYPE_MX = 15;
const DOH_TIMEOUT_MS = 4000;

/**
 * Pre-send deliverability check.
 *
 * Raw DNS (port 53) is blocked on many hosting networks, so `dns.resolveMx` is unreliable;
 * this rides over HTTPS instead, which is always available. Catches mistyped or fake
 * domains so they are recorded as bounced rather than wasting a send.
 *
 * Fails OPEN: any lookup error leaves the address deliverable, so a transient DNS problem
 * can never block a legitimate campaign. Only a definitive NXDOMAIN marks a bounce.
 */
@Injectable()
export class MailDeliverabilityService {
  private readonly log = new Logger(MailDeliverabilityService.name);
  private readonly cache = new Map<string, boolean>();

  /** Clear the per-domain cache (used by tests). */
  reset(): void {
    this.cache.clear();
  }

  async domainCanReceiveMail(email: string): Promise<boolean> {
    const domain = String(email).split('@')[1]?.toLowerCase().trim();
    if (!domain) return false;
    const cached = this.cache.get(domain);
    if (cached !== undefined) return cached;

    let deliverable = true; // fail-open default
    const mx = await this.dohQuery(domain, 'MX');
    if (mx) {
      if (mx.Status === 3) {
        deliverable = false; // NXDOMAIN — the domain does not exist
      } else if (mx.Status === 0) {
        const hasMx = Array.isArray(mx.Answer) && mx.Answer.some((a) => a.type === DNS_TYPE_MX && a.data);
        if (hasMx) {
          deliverable = true;
        } else {
          // The domain exists but publishes no MX — some still accept mail via an A record.
          const a = await this.dohQuery(domain, 'A');
          deliverable = !!(a && a.Status === 0 && Array.isArray(a.Answer) && a.Answer.some((x) => x.type === DNS_TYPE_A));
        }
      }
      // Any other status (SERVFAIL, etc.) leaves deliverable = true.
    }

    if (!deliverable) this.log.warn(`Domain "${domain}" does not exist — treating as a bounce.`);
    this.cache.set(domain, deliverable);
    return deliverable;
  }

  /**
   * Selectors to probe for DKIM.
   *
   * DNS cannot be asked "which selectors exist" — a selector is only discoverable from a message
   * that has already been signed. So the common providers' are tried by name, and a miss is
   * reported as "none of these resolved" rather than as proof of absence.
   */
  private static readonly DKIM_SELECTORS = [
    'google', 'default', 'selector1', 'selector2', 'k1', 'k2', 'dkim', 's1', 's2', 'mail', 'zoho', 'mandrill',
  ];

  /**
   * The deliverability of one sending domain, plus optional campaign HTML.
   *
   * READ-ONLY and safe to call from a screen: three kinds of DNS lookup and some string work. It
   * sends nothing and writes nothing.
   */
  async report(domain: string, html?: string): Promise<{
    domain: string;
    auth: AuthCheck[];
    content: ContentReport | null;
    risk: SpamRisk;
    checked_at: string;
  }> {
    const host = String(domain ?? '').trim().toLowerCase().replace(/^@/, '');
    const [rootTxt, dmarcTxt, dkim] = await Promise.all([
      this.txtRecords(host),
      this.txtRecords(`_dmarc.${host}`),
      this.findDkim(host),
    ]);

    const auth = [
      checkSpf(rootTxt),
      checkDkim(dkim, MailDeliverabilityService.DKIM_SELECTORS),
      checkDmarc(dmarcTxt),
    ];
    const content = html ? analyseContent(html) : null;
    // With no HTML supplied there is nothing to weigh on the content side, so an empty report keeps
    // the verdict driven by authentication alone rather than crediting content that was not seen.
    const risk = spamRisk(auth, content ?? { links: 0, images: 0, textRatio: 1, imageOnly: false, signals: [] });

    return { domain: host, auth, content, risk, checked_at: new Date().toISOString() };
  }

  /** Every TXT string published at a name. Empty on any lookup failure — see the fail-open note. */
  private async txtRecords(name: string): Promise<string[]> {
    const res = await this.dohQuery(name, 'TXT');
    if (!res || res.Status !== 0 || !Array.isArray(res.Answer)) return [];
    return res.Answer
      .filter((a) => a.type === DNS_TYPE_TXT && a.data)
      // A long TXT record arrives as adjacent quoted chunks that must be joined, not listed.
      .map((a) => String(a.data).replace(/"\s+"/g, '').replace(/^"|"$/g, ''));
  }

  private async findDkim(host: string): Promise<{ selector: string; record: string }[]> {
    const hits = await Promise.all(
      MailDeliverabilityService.DKIM_SELECTORS.map(async (selector) => {
        const records = await this.txtRecords(`${selector}._domainkey.${host}`);
        return records.length ? { selector, record: records.join('') } : null;
      }),
    );
    return hits.filter((h): h is { selector: string; record: string } => h !== null);
  }

  private async dohQuery(name: string, type: 'MX' | 'A' | 'TXT'): Promise<{ Status?: number; Answer?: { type: number; data?: string }[] } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
    try {
      const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal: controller.signal,
      });
      return res.ok ? ((await res.json()) as { Status?: number; Answer?: { type: number; data?: string }[] }) : null;
    } catch {
      return null; // fail open
    } finally {
      clearTimeout(timer);
    }
  }
}
