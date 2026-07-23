import { Injectable, Logger } from '@nestjs/common';

// DNS record types in the DNS-over-HTTPS JSON response.
const DNS_TYPE_A = 1;
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

  private async dohQuery(name: string, type: 'MX' | 'A'): Promise<{ Status?: number; Answer?: { type: number; data?: string }[] } | null> {
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
