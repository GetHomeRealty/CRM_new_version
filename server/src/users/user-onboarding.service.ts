import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { MAIL_EVENTS, SUPERSEDED_BODY_HASHES, renderTemplate, variablesFor } from '../email/mail-event-registry';
import type { MailAttachment } from '../email/mailer.service';
import { parseJsonObject } from '../common/serialize';
import { renderContractPdf } from './contract-pdf';

/**
 * The two emails sent to an agent from the Users screen: the onboarding guide and the contract
 * agreement. Both buttons used to be placeholders that only raised a toast.
 *
 * They are ordinary email templates, editable in Settings → Templates with their own subject,
 * body, sender and attachments — the resignation-letter sample, the 30-day action plan, the
 * contract PDF. What is different here is that nothing is sent blind: the screen asks for the
 * message as it will actually arrive for THIS agent, with the variables already filled in, and
 * whatever comes back from that review is what goes out.
 *
 * The edit is per-send, not to the template. Adjusting a sentence for one agent must not quietly
 * rewrite what every future agent receives; changing the template itself is what the Templates
 * screen is for.
 */

export type OnboardingKind = 'onboard' | 'contract';

const EVENT_KEY: Record<OnboardingKind, string> = {
  onboard: 'user.onboard_email',
  contract: 'user.contract_agreement',
};

/** A file picked in the review dialog, attached to this one send. */
export interface AdHocAttachment {
  filename: string;
  content_type?: string;
  /** Base64; a full `data:` URI from a file input is accepted too. */
  data: string;
}

/**
 * Ceiling for files attached to a single send, on top of whatever the template already carries.
 * Matches the template limit for the same reason: providers reject an oversized message outright,
 * and a send that fails after the fact is worse than a file refused up front.
 */
export const MAX_ADHOC_BYTES = 5 * 1024 * 1024;
export const MAX_ADHOC_FILES = 5;

/**
 * The documents the onboarding letter refers to, shipped with the server and put on the template
 * the first time it is used. Resolved from this file rather than the working directory, so it holds
 * whether the process is started from `server/`, systemd or a container.
 */
const ONBOARD_DOC_DIR = path.resolve(__dirname, '..', '..', 'assets', 'onboarding');
const ONBOARD_DOCUMENTS = [
  'Agent Resignation Letter Template.pdf',
  'Sample Headshots.pdf',
  'First 30 Days Action Plan.pdf',
];

export interface OnboardingPreview {
  kind: OnboardingKind;
  event_key: string;
  subject: string;
  html: string;
  to: string;
  variables: string[];
  attachments: { id: number; filename: string; size: number }[];
  /**
   * The document built from this message and attached to the send — the agreement itself, for the
   * contract. Named here so the screen can list it and offer it for reading before it goes; its size
   * is not known until it is rendered.
   */
  generated_document: string | null;
  sender: string | null;
  /** Set when something would make the send fail or arrive incomplete. */
  warning: string | null;
  /** Which warning it is, so the screen can reason about it rather than matching on the words. */
  warning_kind: 'no_recipient' | 'template_off' | null;
}

/**
 * The signature logo, as the review screen renders it and as the message carries it.
 *
 * The pattern matches the logo endpoint with any host and any `?v=`, because the body being sent is
 * whatever came back from the review — rendered against the address that review was loaded from.
 */
const LOGO_SRC = /src="[^"]*\/api\/company-settings\/logo[^"]*"/i;
const LOGO_CID = 'brand-logo';

/**
 * What a detail the profile does not hold looks like in the contract: the ruled blank of the paper
 * form, to be completed by hand. An empty gap would read as though the term simply does not apply.
 */
const BLANK = '<span style="color:#9ca3af">____________________________</span>';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "1st", "2nd", "23rd" — the agreement is dated the way the paper form is written. */
const ordinal = (day: number): string => {
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th');
  return `${day}${suffix}`;
};

/** A percentage as it should read in a contract: a whole number where it is one, and blank at zero. */
const pct = (value: unknown): string => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
};

/** The other side of a split. Written out so 95 never appears without the 5 that goes with it. */
const complement = (share: string): string => (share ? pct(100 - Number(share)) || '0' : '');

/** Zero-padded, the way the agreement writes a split: 95-05, not 95-5. */
const pad2 = (share: string): string => (share.length === 1 ? `0${share}` : share);

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * What the generated agreement is called. Kept to characters that survive every mail client and
 * filesystem, and short enough to read in an attachment strip.
 */
const documentName = (agentName: string): string =>
  `Independent Contractor Agreement - ${agentName.replace(/[^\w\s.-]/g, '').trim().slice(0, 60) || 'Agent'}.pdf`;

@Injectable()
export class UserOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
  ) {}

  /**
   * The brand logo for the signature block, as a complete <img> tag or nothing at all.
   *
   * Referenced by URL rather than embedded: `/api/company-settings/logo` is deliberately public
   * for this exact use (see CompanySettingsController), a `cid:` attachment cannot render in the
   * review screen, and Gmail drops `data:` images so an embedded copy would look right here and
   * arrive broken. `?v=` pins it to the settings timestamp, so the endpoint's immutable caching
   * applies and replacing the logo still busts it.
   *
   * `baseUrl` is the address the browser reached this API on, which is all this URL has to satisfy:
   * the review screen loads it over HTTP, and the copy that goes to the agent is swapped for the
   * image itself on the way out (see `embedLogo`).
   */
  private logoImg(company: { name: string; logo_path: string | null; updated_at: Date | null }, baseUrl: string): string {
    if (!company.logo_path || !baseUrl) return '';
    const version = company.updated_at ? company.updated_at.getTime() : '';
    const alt = company.name.replace(/[<>"&]/g, '');
    return `<img src="${baseUrl}/api/company-settings/logo?v=${version}" alt="${alt}" width="132"`
      + ' style="width:132px;max-width:132px;height:auto;display:block;border:0">';
  }

  /** "Fresher Agent", or "Experienced Agent" with the brokerage they came from, as the form has it. */
  private agentType(profile: Record<string, unknown>): string {
    const experience = String(profile.experience ?? '').trim();
    if (experience === 'Experienced') {
      const previous = String(profile.prev_brokerage ?? '').trim();
      return `Experienced Agent [Past Brokerage Name: ${escapeHtml(previous) || BLANK}]`;
    }
    return experience === 'Fresher' ? 'Fresher Agent' : BLANK;
  }

  /**
   * The commission lines of the agreement, from the split recorded on the agent's profile — the one
   * part that differs between copies of this contract.
   *
   * Two shapes, matching the two versions in circulation: a flat split on everything, or the tiered
   * one where the first N deals pay differently and lease is flat. The brokerage-lead line is only
   * written when a separate lead split is actually recorded, since silence there means the ordinary
   * split applies — stating a proportion nobody agreed to would be worse than omitting the line.
   *
   * With no split recorded at all the lines are left ruled, so the gap is visible rather than a
   * contract that quietly promises nothing.
   */
  private commissionTerms(profile: Record<string, unknown>): string {
    const agent = pad2(pct(profile.agent_comm_pct));
    const brokerage = pad2(pct(profile.brok_comm_pct) || complement(agent));
    const lease = pad2(pct(profile.lease_comm_pct));
    const threshold = Math.floor(Number(profile.completed_deals) || 0);
    const nextAgent = pad2(pct(profile.upgrade_agent_pct));
    const nextBrokerage = pad2(pct(profile.upgrade_brok_pct) || complement(nextAgent));
    const leadAgent = pad2(pct(profile.brokerage_lead_pct));
    const leadBrokerage = pad2(pct(profile.brokerage_lead_brok_pct) || complement(leadAgent));

    const note = (text: string): string =>
      `<br><em style="font-size:12px;color:#4b5563">[${text}]</em>`;

    const lines: string[] = [];
    if (!agent) {
      lines.push(`<li>${BLANK} split on all transactions (Inc. Buy/Sale/Pre-construction/Lease/Lease Listings/NB).</li>`);
    } else if (threshold > 0 && nextAgent) {
      const deals = `first ${threshold} Deal${threshold === 1 ? '' : 's'} (Buy/Sale/Pre-construction)`;
      lines.push(
        `<li>${agent}-${brokerage}% split for ${deals}, ${nextAgent}-${nextBrokerage}% split thereafter`
        + (lease ? ` &amp; Flat ${lease}% for Lease/Lease Listings` : '') + ';'
        + note(
          `${agent}% to Agent &amp; ${brokerage}% to Brokerage for ${deals}, ${nextAgent}% to Agent &amp; ${nextBrokerage}% to Brokerage thereafter`
          + (lease ? ` &amp; Flat ${lease}% to Agent &amp; ${pad2(complement(lease))}% to Brokerage for all Lease/Lease Listings` : '') + '.',
        )
        + '</li>',
      );
    } else {
      lines.push(
        `<li>Flat ${agent}-${brokerage}% split on all transactions (Inc. Buy/Sale/Pre-construction/Lease/Lease Listings/NB);`
        + note(`${agent}% to Agent &amp; ${brokerage}% to Brokerage.`)
        + '</li>',
      );
    }

    if (leadAgent) {
      lines.push(
        `<li>${leadAgent}-${leadBrokerage}% split on all Brokerage Leads (Buy/Sale/Pre-construction/Lease/Lease Listings/NB).`
        + note(`${leadAgent}% to Agent &amp; ${leadBrokerage}% to Brokerage; Any expenses associated with these leads will be shared in respective proportion.`)
        + '</li>',
      );
    }
    return lines.join('');
  }

  /** Values every onboarding template can use, drawn from the agent and company settings. */
  private async vars(userId: number, attachmentCount = 0, baseUrl = ''): Promise<{ vars: Record<string, unknown>; to: string; name: string }> {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${userId}.` });

    const company = await this.settings.current();
    const profile = parseJsonObject(user.profile);
    // The agent's personal address is where onboarding mail belongs — their brokerage address may
    // not exist yet, which is the whole point of onboarding.
    const to = String(profile.personal_email ?? '').trim() || String(user.email ?? '').trim();
    const onboardDate = String(profile.onboard_date ?? '').trim();
    const today = new Date().toISOString().slice(0, 10);
    // The agreement is dated the day the agent joined, falling back to today for one being drawn
    // up now. Split into three because the sentence on the paper form has three blanks.
    const signed = new Date(`${onboardDate || today}T00:00:00Z`);

    return {
      to,
      name: user.name,
      vars: {
        agent_name: user.name,
        agent_email: to,
        company_name: company.name,
        company_address: String(company.address ?? '').trim() || BLANK,
        agent_address: String(profile.address ?? '').trim() || BLANK,
        agent_type: this.agentType(profile),
        commission_terms: this.commissionTerms(profile),
        agreement_day: ordinal(signed.getUTCDate()),
        agreement_month: MONTHS[signed.getUTCMonth()],
        agreement_year: String(signed.getUTCFullYear()),
        // Empty rather than a stand-in phrase: the template already says "our Broker of Record",
        // so a fallback of the same words rendered it twice in the same sentence.
        broker_of_record: String(profile.broker_of_record ?? '').trim(),
        broker_email: String(profile.broker_email ?? '').trim() || String(company.email ?? '').split('&')[0].trim(),
        accounts_email: String(company.email ?? '').split('&').pop()?.trim() ?? '',
        onboard_date: onboardDate || today,
        contract_date: onboardDate || today,
        current_date: today,
        // How many documents actually go with this email, so the line asking the agent to confirm
        // them names the real number. Blank below two: "the 1 attached documents" is worse than
        // "the attached documents", and the sentence reads either way.
        attachment_count: attachmentCount >= 2 ? String(attachmentCount) : '',
        logo_img: this.logoImg(company, baseUrl),
      },
    };
  }

  /**
   * The message exactly as it would arrive for this agent, for review before sending.
   *
   * `baseUrl` is where this API is reachable, used to point the signature logo at it.
   */
  async preview(userId: number, kind: OnboardingKind, baseUrl = ''): Promise<OnboardingPreview> {
    const eventKey = EVENT_KEY[kind];
    if (!eventKey) throw new BadRequestException({ message: `Unknown onboarding email "${kind}".` });

    const meta = MAIL_EVENTS[eventKey];

    // Seeded on first use, exactly as the mailer does, so the template exists to be edited even
    // if nobody has opened the Templates screen yet.
    let template = await this.prisma.email_templates.findUnique({
      where: { event_key: eventKey },
      include: { mail_accounts: true, attachments: { select: { id: true, filename: true, size: true } } },
    });
    if (!template && meta) {
      const now = new Date();
      await this.prisma.email_templates.create({
        data: {
          event_key: eventKey, module: meta.module, name: meta.label,
          subject: meta.default_subject, body_html: meta.default_body_html,
          is_active: true, created_at: now, updated_at: now,
        },
      });
      template = await this.prisma.email_templates.findUnique({
        where: { event_key: eventKey },
        include: { mail_accounts: true, attachments: { select: { id: true, filename: true, size: true } } },
      });
    }
    if (!template) throw new NotFoundException({ message: `No email template for "${eventKey}".` });

    // A row still holding wording this app shipped has never been edited, so a correction reaches
    // agents without an admin re-pasting it. `updated_at` is deliberately left alone: moving it here
    // would make this the last refresh the row ever received. Once someone saves their own wording
    // in Settings → Templates, it is no longer recognised as shipped and the stored version wins.
    if (meta && (template.subject !== meta.default_subject || template.body_html !== meta.default_body_html)
      && this.isShippedWording(eventKey, template)) {
      await this.prisma.email_templates.update({
        where: { id: template.id },
        data: { subject: meta.default_subject, body_html: meta.default_body_html },
      });
      template.subject = meta.default_subject;
      template.body_html = meta.default_body_html;
    }

    // The onboarding letter tells the agent to look at documents it says are attached, so the
    // standard three are put on the template the first time it is used. Read after seeding, since
    // the count is quoted in the body.
    if (kind === 'onboard' && template.attachments.length === 0) {
      const added = await this.seedOnboardDocuments(template.id);
      if (added) template.attachments = added;
    }

    // Rendered with the real attachment count, which is only known once the template is loaded.
    const { vars, to, name } = await this.vars(userId, template.attachments.length, baseUrl);
    const html = renderTemplate(template.body_html, vars);

    return {
      kind,
      event_key: eventKey,
      subject: renderTemplate(template.subject, vars),
      html,
      to,
      variables: variablesFor(eventKey),
      attachments: template.attachments,
      generated_document: kind === 'contract' ? documentName(name) : null,
      sender: template.mail_accounts?.from_email ?? null,
      ...this.warningFor({ to, isActive: template.is_active }),
    };
  }

  /**
   * Whether this row still holds wording that came with the app, rather than something an admin
   * wrote — the question of whether it is safe to replace.
   *
   * A body matching a version this app shipped answers it outright. Failing that, a row whose
   * `updated_at` never moved from `created_at` has not been saved at all, which covers a version
   * whose hash was never recorded.
   */
  private isShippedWording(eventKey: string, template: { body_html: string; created_at: Date | null; updated_at: Date | null }): boolean {
    const hashes = SUPERSEDED_BODY_HASHES[eventKey] ?? [];
    if (hashes.length) {
      const hash = createHash('sha256').update(template.body_html, 'utf8').digest('hex');
      if (hashes.includes(hash)) return true;
    }
    return !!template.created_at && !!template.updated_at
      && template.updated_at.getTime() === template.created_at.getTime();
  }

  /**
   * The one thing worth saying before the button is pressed, most serious first — a send that
   * cannot happen, then one that will arrive incomplete.
   */
  private warningFor(s: { to: string; isActive: boolean }): Pick<OnboardingPreview, 'warning' | 'warning_kind'> {
    if (!s.to) {
      return { warning: 'This agent has no email address on file, so there is nowhere to send it.', warning_kind: 'no_recipient' };
    }
    if (!s.isActive) {
      return { warning: 'This template is switched off in Settings → Templates and will not send until it is set to Active.', warning_kind: 'template_off' };
    }
    // There is deliberately nothing here about the contract having no attachment: the agreement is
    // generated from the message and always goes with it, so the case the old warning covered can no
    // longer happen.
    return { warning: null, warning_kind: null };
  }

  /**
   * Send it. `subject` and `html` are whatever came back from the review, so an edit made there
   * is what the agent receives; omit them and the stored template is used unchanged.
   */
  async send(
    userId: number,
    kind: OnboardingKind,
    edited: { subject?: string; html?: string; attachments?: AdHocAttachment[] },
    baseUrl = '',
  ): Promise<{ message: string; to: string }> {
    const preview = await this.preview(userId, kind, baseUrl);
    if (!preview.to) throw new BadRequestException({ message: 'This agent has no email address on file.' });

    const subject = (edited.subject ?? '').trim() || preview.subject;
    const html = (edited.html ?? '').trim() || preview.html;
    if (!subject || !html) throw new BadRequestException({ message: 'The subject and message cannot be empty.' });

    // Sent as an already-rendered message rather than through the template registry, because the
    // body under review may have been edited and must not be re-rendered from the stored one. The
    // template's own sender and attachments are carried across explicitly so the agent still
    // receives the resignation sample, action plan or contract that is attached to it.
    const template = await this.prisma.email_templates.findUnique({
      where: { event_key: preview.event_key },
      select: { mail_account_id: true, attachments: { select: { filename: true, content_type: true, data: true } } },
    });
    const files: MailAttachment[] = (template?.attachments ?? []).map((a) => ({
      data: Buffer.from(a.data).toString('base64'),
      name: a.filename,
      mime: a.content_type,
    }));

    // Files picked in the review go out with this email only and are not stored on the template.
    // A contract agreement is usually filled in for one agent, so keeping it on the template would
    // attach that agent's copy to every future send.
    files.push(...this.adhocFiles(edited.attachments ?? []));

    // The agreement goes with it as a document, built from the same body the agent is about to read,
    // so there is something to print and sign rather than an email to scroll back through.
    if (kind === 'contract') {
      const document = await this.contractDocument(userId, html);
      files.push({ data: document.data.toString('base64'), name: document.filename, mime: 'application/pdf' });
    }

    // The signature logo travels inside the message rather than as a link back to this API. The
    // review screen has to load it over HTTP — it is a browser — but an agent's mail client is
    // somewhere else entirely, and a URL that resolves here may resolve to nothing there.
    const embedded = await this.embedLogo(html);
    if (embedded.file) files.push(embedded.file);

    await this.mailer.sendDirect(preview.to, subject, embedded.html, template?.mail_account_id ?? null, files, null);
    const extra = (edited.attachments ?? []).length;
    return {
      message: extra ? `Sent to ${preview.to} with ${extra} attached file${extra === 1 ? '' : 's'}.` : `Sent to ${preview.to}.`,
      to: preview.to,
    };
  }

  /**
   * The agreement as a document the agent can sign, built from the message being sent.
   *
   * Generated rather than stored: the contract is different for every agent, and one filled in for
   * somebody else is the worst possible thing to have on a template. Because it is rendered from the
   * reviewed HTML, a correction made in the dialog reaches the attachment as well as the email.
   */
  async contractDocument(userId: number, html: string): Promise<{ filename: string; data: Buffer }> {
    const user = await this.prisma.users.findUnique({ where: { id: userId }, select: { name: true } });
    if (!user) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${userId}.` });

    const logo = await this.logoDataUri();
    const data = await renderContractPdf(html, logo);
    return { filename: documentName(user.name), data };
  }

  /** The brand logo as a data URI for the generated document, or null when none is uploaded. */
  private async logoDataUri(): Promise<string | null> {
    const logo = await this.settings.logoFile();
    if (!logo) return null;
    try {
      const bytes = await fs.readFile(logo.abs);
      return `data:${logo.mime};base64,${bytes.toString('base64')}`;
    } catch {
      return null; // recorded but unreadable — the document is worth more than its letterhead
    }
  }

  /**
   * Swap the signature logo's URL for the image itself, carried in the message under `cid:`.
   *
   * Matched on the endpoint rather than the whole URL because the body being sent is whatever came
   * back from the review, where the host is this API's own address — and an admin may have edited
   * the message around it. If the file is missing from disk the URL is left as it stands: it is a
   * long shot, but a better one than an <img> pointing at nothing at all.
   */
  private async embedLogo(html: string): Promise<{ html: string; file: MailAttachment | null }> {
    if (!LOGO_SRC.test(html)) return { html, file: null };

    const logo = await this.settings.logoFile();
    if (!logo) return { html, file: null };
    try {
      const data = await fs.readFile(logo.abs);
      return {
        html: html.replace(LOGO_SRC, `src="cid:${LOGO_CID}"`),
        file: { data: data.toString('base64'), name: `logo${path.extname(logo.abs) || '.png'}`, mime: logo.mime, cid: LOGO_CID },
      };
    } catch {
      return { html, file: null };
    }
  }

  /**
   * One of the files that will be sent, so it can be read in the review screen before it goes.
   *
   * Addressed by the kind of email rather than by template id: the screen already knows which email
   * it is reviewing, and looking the template up here means there is no id to pass around and get
   * out of step, and no way to read a file off some other template through this route.
   */
  async attachment(kind: OnboardingKind, attachmentId: number): Promise<{ filename: string; contentType: string; data: Buffer }> {
    const eventKey = EVENT_KEY[kind];
    if (!eventKey) throw new BadRequestException({ message: `Unknown onboarding email "${kind}".` });

    const row = await this.prisma.email_template_attachments.findFirst({
      where: { id: attachmentId, template: { event_key: eventKey } },
    });
    if (!row) throw new NotFoundException({ message: 'That file is no longer attached to this email.' });
    return { filename: row.filename, contentType: row.content_type, data: Buffer.from(row.data) };
  }

  /**
   * Put the three standard onboarding documents on the template the first time it is used: the
   * resignation-letter sample the letter tells the agent to find attached, the sample headshots
   * they pick a business-card style from, and the 30-day action plan.
   *
   * They ship with the server rather than being pasted into a migration, so replacing one is
   * dropping a new file in `assets/onboarding`. Only ever done when the template carries no files
   * at all, so an office that curates its own set keeps it — and one that removes a document keeps
   * the remaining ones rather than having the default set restored underneath them.
   *
   * Best-effort: a missing or unreadable file leaves the email to go out without it, which is far
   * better than a review screen that will not open.
   */
  private async seedOnboardDocuments(templateId: number): Promise<{ id: number; filename: string; size: number }[] | null> {
    const now = new Date();
    let added = false;

    for (const filename of ONBOARD_DOCUMENTS) {
      try {
        const data = await fs.readFile(path.join(ONBOARD_DOC_DIR, filename));
        await this.prisma.email_template_attachments.create({
          data: {
            template_id: templateId,
            filename,
            content_type: 'application/pdf',
            size: data.length,
            data: new Uint8Array(data),
            created_at: now,
          },
        });
        added = true;
      } catch {
        // Skipped — see above.
      }
    }
    if (!added) return null;

    return this.prisma.email_template_attachments.findMany({
      where: { template_id: templateId },
      select: { id: true, filename: true, size: true },
      orderBy: { id: 'asc' },
    });
  }

  /** Decode and check the files picked in the review, before anything is sent. */
  private adhocFiles(input: AdHocAttachment[]): { data: string; name: string; mime: string }[] {
    if (!input.length) return [];
    if (input.length > MAX_ADHOC_FILES) {
      throw new BadRequestException({ message: `Attach at most ${MAX_ADHOC_FILES} files to one email.` });
    }

    let total = 0;
    return input.map((a) => {
      const name = String(a.filename ?? '').trim() || 'attachment';
      const base64 = String(a.data ?? '').replace(/^data:[^;]+;base64,/, '');
      if (!base64) throw new BadRequestException({ message: `"${name}" is empty.` });

      let bytes: number;
      try { bytes = Buffer.from(base64, 'base64').length; }
      catch { throw new BadRequestException({ message: `"${name}" could not be read.` }); }
      if (!bytes) throw new BadRequestException({ message: `"${name}" is empty.` });

      total += bytes;
      if (total > MAX_ADHOC_BYTES) {
        const mb = (MAX_ADHOC_BYTES / 1024 / 1024).toFixed(0);
        throw new BadRequestException({
          message: `Attachments total ${(total / 1024 / 1024).toFixed(1)} MB, above the ${mb} MB limit — most mail servers would reject the message.`,
        });
      }
      return { data: base64, name: name.slice(0, 255), mime: String(a.content_type ?? '').trim() || 'application/octet-stream' };
    });
  }
}
