import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { MAIL_EVENTS, renderTemplate, variablesFor } from '../email/mail-event-registry';
import { parseJsonObject } from '../common/serialize';

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

export interface OnboardingPreview {
  kind: OnboardingKind;
  event_key: string;
  subject: string;
  html: string;
  to: string;
  variables: string[];
  attachments: { id: number; filename: string; size: number }[];
  sender: string | null;
  /** Set when the template exists but is switched off — sending would fail, so say so up front. */
  warning: string | null;
}

@Injectable()
export class UserOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
  ) {}

  /** Values every onboarding template can use, drawn from the agent and company settings. */
  private async vars(userId: number): Promise<{ vars: Record<string, unknown>; to: string; name: string }> {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ message: `No query results for model [App\\Models\\User] ${userId}.` });

    const company = await this.settings.current();
    const profile = parseJsonObject(user.profile);
    // The agent's personal address is where onboarding mail belongs — their brokerage address may
    // not exist yet, which is the whole point of onboarding.
    const to = String(profile.personal_email ?? '').trim() || String(user.email ?? '').trim();
    const onboardDate = String(profile.onboard_date ?? '').trim();
    const today = new Date().toISOString().slice(0, 10);

    return {
      to,
      name: user.name,
      vars: {
        agent_name: user.name,
        agent_email: to,
        company_name: company.name,
        // Empty rather than a stand-in phrase: the template already says "our Broker of Record",
        // so a fallback of the same words rendered it twice in the same sentence.
        broker_of_record: String(profile.broker_of_record ?? '').trim(),
        broker_email: String(profile.broker_email ?? '').trim() || String(company.email ?? '').split('&')[0].trim(),
        accounts_email: String(company.email ?? '').split('&').pop()?.trim() ?? '',
        onboard_date: onboardDate || today,
        contract_date: onboardDate || today,
        current_date: today,
      },
    };
  }

  /** The message exactly as it would arrive for this agent, for review before sending. */
  async preview(userId: number, kind: OnboardingKind): Promise<OnboardingPreview> {
    const eventKey = EVENT_KEY[kind];
    if (!eventKey) throw new BadRequestException({ message: `Unknown onboarding email "${kind}".` });

    const { vars, to } = await this.vars(userId);
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

    return {
      kind,
      event_key: eventKey,
      subject: renderTemplate(template.subject, vars),
      html: renderTemplate(template.body_html, vars),
      to,
      variables: variablesFor(eventKey),
      attachments: template.attachments,
      sender: template.mail_accounts?.from_email ?? null,
      warning: !to
        ? 'This agent has no email address on file, so there is nowhere to send it.'
        : !template.is_active
          ? 'This template is switched off in Settings → Templates and will not send until it is set to Active.'
          : template.attachments.length === 0 && kind === 'contract'
            ? 'No contract document is attached. Attach the signed agreement below for this agent, or add one to the template in Settings → Templates to send it with every contract email.'
            : null,
    };
  }

  /**
   * Send it. `subject` and `html` are whatever came back from the review, so an edit made there
   * is what the agent receives; omit them and the stored template is used unchanged.
   */
  async send(
    userId: number,
    kind: OnboardingKind,
    edited: { subject?: string; html?: string; attachments?: AdHocAttachment[] },
  ): Promise<{ message: string; to: string }> {
    const preview = await this.preview(userId, kind);
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
    const files = (template?.attachments ?? []).map((a) => ({
      data: Buffer.from(a.data).toString('base64'),
      name: a.filename,
      mime: a.content_type,
    }));

    // Files picked in the review go out with this email only and are not stored on the template.
    // A contract agreement is usually filled in for one agent, so keeping it on the template would
    // attach that agent's copy to every future send.
    files.push(...this.adhocFiles(edited.attachments ?? []));

    await this.mailer.sendDirect(preview.to, subject, html, template?.mail_account_id ?? null, files, null);
    const extra = (edited.attachments ?? []).length;
    return {
      message: extra ? `Sent to ${preview.to} with ${extra} attached file${extra === 1 ? '' : 's'}.` : `Sent to ${preview.to}.`,
      to: preview.to,
    };
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
