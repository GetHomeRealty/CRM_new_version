/**
 * What a campaign's deliverability actually looks like, before anybody sends one.
 *
 * WHY THIS EXISTS. The brokerage asked why campaigns land in Gmail's Promotions tab. The answer
 * turned out to start somewhere else entirely: `gethomerealty.ca` publishes NO SPF record and NO
 * DKIM selector, and its DMARC is `p=none` with no `rua`. That is a spam-folder risk, not a tab
 * problem, and nothing in the application reported it — it took a manual `nslookup` to find. A
 * check the screen can run is what stops that being true a second time.
 *
 * TWO KINDS OF FINDING, KEPT APART ON PURPOSE.
 *
 *   AUTHENTICATION is objective. SPF, DKIM and DMARC either exist in DNS or they do not, and Gmail
 *   has required at least one of SPF/DKIM from every sender since 2024. Failing these risks the
 *   SPAM FOLDER. They are fixable, and the fix is DNS.
 *
 *   CONTENT is advisory, and this file is careful not to overstate it. Gmail's tab classification is
 *   a separate system from spam filtering, it is undocumented, and it is decided per RECIPIENT from
 *   engagement history. No arrangement of links and images guarantees Primary. So content findings
 *   are reported as signals that CORRELATE with Promotions, never as a promise about placement.
 *
 * The pure functions live here so they can be asserted directly, without DNS or a database.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface AuthCheck {
  name: 'SPF' | 'DKIM' | 'DMARC';
  status: CheckStatus;
  /** What was found, or the absence that matters. Never a hostname the caller did not ask about. */
  detail: string;
  /** The record to publish, when there is a concrete one worth naming. */
  fix?: string;
}

export interface ContentReport {
  links: number;
  images: number;
  /** Visible text as a fraction of total HTML. Low means a mostly-markup, image-led message. */
  textRatio: number;
  imageOnly: boolean;
  signals: string[];
}

export type SpamRisk = 'low' | 'medium' | 'high';

/**
 * SPF, from the domain's TXT records.
 *
 * `-all` and `~all` both pass: a hard fail is stricter, but a soft fail is the ordinary Google
 * Workspace recommendation and penalising it would be inventing a standard. `?all` and `+all` are
 * warned about because they assert nothing — `+all` authorises the entire internet to send as the
 * domain, which is worse than publishing nothing at all.
 */
export function checkSpf(txtRecords: string[]): AuthCheck {
  const spf = txtRecords.map((r) => r.trim().replace(/^"|"$/g, '')).find((r) => /^v=spf1\b/i.test(r));
  if (!spf) {
    return {
      name: 'SPF',
      status: 'fail',
      detail: 'No SPF record is published for the sending domain.',
      fix: 'v=spf1 include:_spf.google.com ~all',
    };
  }
  if (/\+all\b/i.test(spf)) {
    return { name: 'SPF', status: 'fail', detail: 'SPF ends in "+all", which authorises anyone to send as this domain.', fix: 'v=spf1 include:_spf.google.com ~all' };
  }
  if (/\?all\b/i.test(spf)) {
    return { name: 'SPF', status: 'warn', detail: 'SPF ends in "?all" (neutral), which asserts nothing about unlisted senders.' };
  }
  if (!/[-~]all\b/i.test(spf)) {
    return { name: 'SPF', status: 'warn', detail: 'SPF has no "all" mechanism, so unlisted senders are unspecified.' };
  }
  return { name: 'SPF', status: 'pass', detail: spf.slice(0, 200) };
}

/**
 * DKIM, by asking whether ANY of the given selectors resolves.
 *
 * Selectors cannot be enumerated from DNS — they are only discoverable from a signed message — so
 * this probes the ones the common providers use. A miss is therefore reported honestly as "none of
 * the selectors tried", not as proof that DKIM is absent.
 */
export function checkDkim(found: { selector: string; record: string }[], tried: string[]): AuthCheck {
  const real = found.filter((f) => /v=DKIM1|k=rsa|p=/i.test(f.record));
  if (real.length) {
    return { name: 'DKIM', status: 'pass', detail: `Signing key published at "${real[0].selector}._domainkey".` };
  }
  return {
    name: 'DKIM',
    status: 'fail',
    detail: `No DKIM key found at any of the ${tried.length} selectors tried (${tried.slice(0, 6).join(', ')}).`,
    fix: 'Google Workspace → Apps → Google Workspace → Gmail → Authenticate email → Generate new record, then publish it. It is OFF by default.',
  };
}

/**
 * DMARC. Present-but-`p=none` is a WARN rather than a pass: it authenticates nothing and, without
 * `rua`, nobody receives the reports that would show whether SPF and DKIM are working.
 */
export function checkDmarc(txtRecords: string[]): AuthCheck {
  const rec = txtRecords.map((r) => r.trim().replace(/^"|"$/g, '')).find((r) => /^v=DMARC1\b/i.test(r));
  if (!rec) {
    return {
      name: 'DMARC',
      status: 'fail',
      detail: 'No DMARC record is published.',
      fix: 'v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.ca',
    };
  }
  const policy = (rec.match(/\bp=([a-z]+)/i) ?? [])[1]?.toLowerCase() ?? 'none';
  const hasRua = /\brua=/i.test(rec);
  if (policy === 'none') {
    return {
      name: 'DMARC',
      status: 'warn',
      detail: `Published, but "p=none" enforces nothing${hasRua ? '' : ' and there is no "rua=", so no reports are delivered to anyone'}.`,
      fix: hasRua ? undefined : 'Add rua=mailto:dmarc@yourdomain.ca, then move to p=quarantine once SPF and DKIM pass.',
    };
  }
  return { name: 'DMARC', status: 'pass', detail: `Policy "p=${policy}"${hasRua ? ' with reporting' : ' (no rua= — no reports are delivered)'}.` };
}

/** Visible text, with markup, style and script removed — the part a reader actually sees. */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The content signals that CORRELATE with the Promotions tab.
 *
 * Deliberately not called a score out of ten. Gmail does not publish its rules and decides per
 * recipient, so a number would imply a precision nobody has. These are observations an author can
 * act on if they choose.
 */
export function analyseContent(html: string): ContentReport {
  const body = String(html ?? '');
  const links = (body.match(/<a\b[^>]*href=/gi) ?? []).length;
  const allImages = (body.match(/<img\b/gi) ?? []).length;
  // The 1x1 open pixel is ours and is not a content decision, so it is not counted against the author.
  const trackingPixels = (body.match(/<img\b[^>]*(width=["']?1["']?[^>]*height=["']?1["']?|display:\s*none)[^>]*>/gi) ?? []).length;
  const images = Math.max(0, allImages - trackingPixels);

  const text = visibleText(body);
  const textRatio = body.length ? Number((text.length / body.length).toFixed(2)) : 0;
  const imageOnly = images > 0 && text.length < 200;

  const signals: string[] = [];
  if (imageOnly) signals.push('Almost no readable text beside the images — image-only mail is a strong Promotions signal and unreadable when images are blocked.');
  if (links > 10) signals.push(`${links} links. A personal message rarely carries more than two or three.`);
  if (images > 5) signals.push(`${images} images. A banner-led layout reads as a newsletter.`);
  if (textRatio < 0.05 && body.length > 400) signals.push('Very little text for the amount of markup — heavy HTML with little to read.');
  if (/\b(free|act now|limited time|buy now|click here|special offer|discount|% off|exclusive deal)\b/i.test(text)) {
    signals.push('Promotional phrasing ("free", "act now", "limited time" and similar) is one of the clearest Promotions cues.');
  }
  if (!/\{\{\s*[a-z_]+\s*\}\}/i.test(body) && !/\bhi\s+[A-Z]/.test(text)) {
    signals.push('No personalisation token — identical mail to every recipient is easier to classify as bulk.');
  }
  return { links, images, textRatio, imageOnly, signals };
}

/**
 * One overall verdict, weighted so AUTHENTICATION dominates.
 *
 * A missing SPF or DKIM risks the spam folder and is objectively wrong; a busy layout only
 * correlates with a tab. Letting content findings outweigh a missing signing key would point the
 * reader at the cosmetic problem and away from the real one.
 */
export function spamRisk(auth: AuthCheck[], content: ContentReport): SpamRisk {
  const failures = auth.filter((a) => a.status === 'fail').length;
  if (failures >= 2) return 'high';
  if (failures === 1) return 'medium';
  const warns = auth.filter((a) => a.status === 'warn').length;
  if (warns && content.signals.length >= 3) return 'medium';
  if (content.signals.length >= 4 || content.imageOnly) return 'medium';
  return 'low';
}
