import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { type email_templates, type mail_accounts } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { MailAccountService } from './mail-account.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { toDateTimeString } from '../common/serialize';
import { MAIL_EVENTS, renderTemplate, variablesFor, type MailEvent } from './mail-event-registry';

type AttachmentMeta = { id: number; filename: string; content_type: string; size: number };
type TemplateWithAccount = email_templates & {
  mail_accounts: mail_accounts | null;
  attachments?: AttachmentMeta[];
};

/**
 * Files that ride along with every send of a template.
 *
 * The ceilings mirror the campaign templates, for the same reason: SMTP providers reject an
 * oversized message outright, and a template that quietly fails to send is worse than one that
 * refuses the file at upload time. Gmail's own limit is 25 MB for the whole encoded message, and
 * base64 inflates by a third, so 5 MB of attachments leaves ample room for the body.
 */
export const MAX_TEMPLATE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TEMPLATE_ATTACHMENTS = 5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Would a reader see anything in this body?
 *
 * NOT `html.trim() !== ''`. An emptied rich-text field yields `<br>`, and a body of `<p>&nbsp;</p>`
 * or a stray empty `<div>` is just as blank to the person receiving it. The question is whether the
 * email carries content, not whether the string carries characters.
 *
 * AN IMAGE COUNTS. A template that is one banner and nothing else is a real template, and a rule
 * that demanded text would refuse it — turning a fix for empty emails into a refusal of legitimate
 * ones, which is the worse failure of the two.
 */
export function hasVisibleContent(html: unknown): boolean {
  const raw = String(html ?? '');
  // Media is content even with no words around it.
  if (/<(img|video|iframe)\b/i.test(raw)) return true;
  const text = raw
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0;
}

@Injectable()
export class EmailTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CompanySettingsService,
    private readonly mailAccounts: MailAccountService,
  ) {}

  /** Seed any missing template rows from the registry, then group by module. */
  async index(): Promise<Record<string, unknown>> {
    for (const [key, meta] of Object.entries(MAIL_EVENTS)) await this.firstOrCreate(key, meta);

    const templates = (await this.prisma.email_templates.findMany({
      include: { mail_accounts: true, attachments: { select: { id: true, filename: true, content_type: true, size: true } } },
    })) as TemplateWithAccount[];
    templates.sort((a, b) =>
      a.module.localeCompare(b.module, 'en', { sensitivity: 'base' }) ||
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      a.id - b.id,
    );

    const groups: { module: string; templates: Record<string, unknown>[] }[] = [];
    const byModule = new Map<string, Record<string, unknown>[]>();
    for (const t of templates) {
      if (!byModule.has(t.module)) { const arr: Record<string, unknown>[] = []; byModule.set(t.module, arr); groups.push({ module: t.module, templates: arr }); }
      byModule.get(t.module)!.push(this.resource(t));
    }

    // Desk senders, not brokerage-only accounts — see MailAccountService.sendersForDesk.
    return { groups, mail_accounts: await this.mailAccounts.sendersForDesk() };
  }

  async update(id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.prisma.email_templates.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ message: `No query results for model [App\\Models\\EmailTemplate] ${id}.` });
    const data = await this.validate(body);
    await this.prisma.email_templates.update({ where: { id }, data: { ...data, updated_at: new Date() } });
    const fresh = (await this.prisma.email_templates.findUnique({
      where: { id },
      include: { mail_accounts: true, attachments: { select: { id: true, filename: true, content_type: true, size: true } } },
    })) as TemplateWithAccount;
    return this.resource(fresh);
  }

  /**
   * Render a template with sample values.
   *
   * `draft` RENDERS WHAT IS ON SCREEN WITHOUT STORING IT, and that is the whole of CRM-040.
   *
   * The editor's Preview button used to SAVE the form and then ask for this - a deliberate choice,
   * with a comment reading "save first so the preview reflects the current edits". It did reflect
   * them, by committing them to the live template real clients receive: fourteen customer-facing
   * automatic emails, changed by the one button a careful person presses BECAUSE it sounds safe,
   * with no confirmation and no toast. Clearing the body and pressing Preview left the stored
   * template empty.
   *
   * The event key still comes from the stored row: sample values depend on which event this
   * template serves, and that is not something the form can change.
   */
  async preview(
    id: number,
    draft?: { subject?: unknown; body_html?: unknown },
  ): Promise<{ subject: string; html: string }> {
    const t = await this.prisma.email_templates.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\EmailTemplate] ${id}.` });
    const vars = await this.sampleVars(t.event_key);

    // Only a string counts as supplied, so a caller sending nothing still previews what is stored.
    const pick = (given: unknown, stored: string): string => (typeof given === 'string' ? given : stored);
    return {
      subject: renderTemplate(pick(draft?.subject, t.subject), vars),
      html: renderTemplate(pick(draft?.body_html, t.body_html), vars),
    };
  }

  events(): Record<string, MailEvent> {
    return MAIL_EVENTS;
  }

  private async firstOrCreate(key: string, meta: MailEvent): Promise<void> {
    const found = await this.prisma.email_templates.findUnique({ where: { event_key: key } });
    if (found) return;
    const now = new Date();
    await this.prisma.email_templates.create({
      data: { event_key: key, module: meta.module, name: meta.label, subject: meta.default_subject, body_html: meta.default_body_html, is_active: true, created_at: now, updated_at: now },
    });
  }

  private resource(t: TemplateWithAccount): Record<string, unknown> {
    return {
      id: t.id,
      event_key: t.event_key,
      module: t.module,
      name: t.name,
      subject: t.subject,
      body_html: t.body_html,
      mail_account_id: t.mail_account_id,
      is_active: !!t.is_active,
      variables: variablesFor(t.event_key),
      mail_account: t.mail_accounts ? { id: t.mail_accounts.id, name: t.mail_accounts.name, from_email: t.mail_accounts.from_email } : null,
      // Metadata only — the bytes are fetched on demand, so listing templates stays small.
      attachments: t.attachments ?? [],
      updated_at: toDateTimeString(t.updated_at),
    };
  }

  /** Realistic sample values for each known variable (used by preview). */
  private async sampleVars(eventKey: string): Promise<Record<string, unknown>> {
    const company = (await this.settings.current()).name;
    const now = new Date();
    const fmt = (d: Date): string => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
    const plus = (days: number): Date => new Date(now.getTime() + days * 86400000);
    const samples: Record<string, unknown> = {
      invoice_number: 'INV-1042',
      invoice_total: '$5,250.00',
      due_date: fmt(plus(14)),
      customer_name: 'John Smith',
      transaction_number: 'GHR-002',
      property_address: '83 Parity Road, Brampton, ON, L6X 5N1',
      sale_price: '$750,000.00',
      closing_date: fmt(plus(45)),
      agent_name: 'Jane Agent',
      pending_docs: 'FINTRAC, Client Photo IDs, Deposit Receipt',
      deposit_amount: '$25,000.00',
      company_name: company,
      current_date: fmt(now),
      current_year: String(now.getUTCFullYear()),
    };
    const vars: Record<string, unknown> = {};
    for (const v of [...variablesFor(eventKey), 'current_date', 'current_year']) vars[v] = Object.prototype.hasOwnProperty.call(samples, v) ? samples[v] : `{${v}}`;
    return vars;
  }

  // ---- validation (port of UpdateEmailTemplateRequest) ----

  private async validate(body: Record<string, unknown>): Promise<{ subject: string; body_html: string; mail_account_id?: number | null; is_active?: boolean }> {
    const errors: FieldErrors = {};
    const push = (f: string, m: string): void => { (errors[f] ??= []).push(m); };
    const empty = (v: unknown): boolean => v === undefined || v === null || v === '';

    if (empty(body.subject)) push('subject', 'The subject field is required.');
    else if (typeof body.subject !== 'string') push('subject', 'The subject field must be a string.');
    else if ([...(body.subject as string)].length > 998) push('subject', 'The subject field must not be greater than 998 characters.');

    if (empty(body.body_html)) push('body_html', 'The body html field is required.');
    else if (typeof body.body_html !== 'string') push('body_html', 'The body html field must be a string.');
    /*
     * "REQUIRED" HAS TO MEAN "HAS SOMETHING IN IT", not "is not the empty string".
     *
     * Clearing the message in the editor leaves `<br>` behind - what a rich-text field yields when
     * it is emptied - and `<br> !== ''`, so this check passed and an automatic customer email was
     * stored with no content. These templates send on their own initiative to real clients: an
     * empty one is a message from the brokerage with a subject line and nothing under it.
     *
     * CHECKED HERE AS WELL AS ON THE SCREEN. The editor refuses it too, but a screen is not a rule -
     * and this exact save also arrived through a path that skipped the screen's check entirely
     * (CRM-040).
     */
    else if (!hasVisibleContent(body.body_html)) {
      push('body_html', 'The message is empty. Write the email body before saving — this template sends to clients on its own.');
    }

    if (!empty(body.mail_account_id)) {
      const exists = await this.prisma.mail_accounts.findUnique({ where: { id: Number(body.mail_account_id) } });
      if (!exists) push('mail_account_id', 'The selected mail account id is invalid.');
    }
    if (!empty(body.is_active) && !(body.is_active === true || body.is_active === false || body.is_active === 1 || body.is_active === 0 || ['1', '0', 'true', 'false'].includes(String(body.is_active)))) {
      push('is_active', 'The is active field must be true or false.');
    }

    if (Object.keys(errors).length) throwValidation(errors);

    const out: { subject: string; body_html: string; mail_account_id?: number | null; is_active?: boolean } = { subject: String(body.subject), body_html: String(body.body_html) };
    if (Object.prototype.hasOwnProperty.call(body, 'mail_account_id')) out.mail_account_id = empty(body.mail_account_id) ? null : Number(body.mail_account_id);
    if (Object.prototype.hasOwnProperty.call(body, 'is_active')) out.is_active = body.is_active === true || body.is_active === 1 || ['1', 'true'].includes(String(body.is_active));
    return out;
  }
  // ----------------------------------------------------------- attachments
  /**
   * Store a file that is sent with every email from this template — a brochure, a form, a
   * terms sheet. Held in the row rather than on disk so a template and its files travel
   * together in a backup and neither can be orphaned by the other.
   */
  async addAttachment(templateId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const template = await this.prisma.email_templates.findUnique({
      where: { id: templateId },
      include: { attachments: { select: { id: true, size: true } } },
    });
    if (!template) throw new NotFoundException({ message: `No query results for model [App\Models\EmailTemplate] ${templateId}.` });

    const filename = String(body.filename ?? '').trim() || 'attachment';
    const contentType = String(body.content_type ?? '').trim() || 'application/octet-stream';
    // A file input may hand over a full data: URI; accept either that or bare base64.
    const base64 = String(body.data ?? '').replace(/^data:[^;]+;base64,/, '');
    if (!base64) throw new BadRequestException({ message: 'The file is empty.' });

    let buffer: Buffer;
    try { buffer = Buffer.from(base64, 'base64'); }
    catch { throw new BadRequestException({ message: 'That file could not be read.' }); }
    if (buffer.length === 0) throw new BadRequestException({ message: 'The file is empty.' });

    if (template.attachments.length >= MAX_TEMPLATE_ATTACHMENTS) {
      throw new BadRequestException({ message: `A template can carry at most ${MAX_TEMPLATE_ATTACHMENTS} attachments.` });
    }
    const totalAfter = template.attachments.reduce((sum, a) => sum + a.size, 0) + buffer.length;
    if (totalAfter > MAX_TEMPLATE_ATTACHMENT_BYTES) {
      const mb = (MAX_TEMPLATE_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0);
      throw new BadRequestException({
        message: `Attachments would total ${(totalAfter / 1024 / 1024).toFixed(1)} MB, above the ${mb} MB limit — most mail servers would reject the message.`,
      });
    }

    return this.prisma.email_template_attachments.create({
      data: {
        template_id: templateId,
        filename: filename.slice(0, 255),
        content_type: contentType.slice(0, 128),
        size: buffer.length,
        // Prisma's Bytes maps to Uint8Array; a Node Buffer may sit on a SharedArrayBuffer,
        // which the generated type rejects. Copy into a plain view.
        data: new Uint8Array(buffer),
        created_at: new Date(),
      },
      select: { id: true, filename: true, content_type: true, size: true },
    });
  }

  /** The stored bytes, for downloading a file back out of a template. */
  async getAttachment(templateId: number, attachmentId: number): Promise<{ filename: string; contentType: string; data: Buffer }> {
    const row = await this.prisma.email_template_attachments.findFirst({ where: { id: attachmentId, template_id: templateId } });
    if (!row) throw new NotFoundException({ message: 'Attachment not found.' });
    return { filename: row.filename, contentType: row.content_type, data: Buffer.from(row.data) };
  }

  async removeAttachment(templateId: number, attachmentId: number): Promise<{ deleted: boolean }> {
    const row = await this.prisma.email_template_attachments.findFirst({ where: { id: attachmentId, template_id: templateId }, select: { id: true } });
    if (!row) throw new NotFoundException({ message: 'Attachment not found.' });
    await this.prisma.email_template_attachments.delete({ where: { id: row.id } });
    return { deleted: true };
  }

}
