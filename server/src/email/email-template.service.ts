import { Injectable, NotFoundException } from '@nestjs/common';
import { type email_templates, type mail_accounts } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { MailAccountService } from './mail-account.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { toDateTimeString } from '../common/serialize';
import { MAIL_EVENTS, renderTemplate, variablesFor, type MailEvent } from './mail-event-registry';

type TemplateWithAccount = email_templates & { mail_accounts: mail_accounts | null };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

    const templates = (await this.prisma.email_templates.findMany({ include: { mail_accounts: true } })) as TemplateWithAccount[];
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

    return { groups, mail_accounts: await this.mailAccounts.index() };
  }

  async update(id: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.prisma.email_templates.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ message: `No query results for model [App\\Models\\EmailTemplate] ${id}.` });
    const data = await this.validate(body);
    await this.prisma.email_templates.update({ where: { id }, data: { ...data, updated_at: new Date() } });
    const fresh = (await this.prisma.email_templates.findUnique({ where: { id }, include: { mail_accounts: true } })) as TemplateWithAccount;
    return this.resource(fresh);
  }

  async preview(id: number): Promise<{ subject: string; html: string }> {
    const t = await this.prisma.email_templates.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\EmailTemplate] ${id}.` });
    const vars = await this.sampleVars(t.event_key);
    return { subject: renderTemplate(t.subject, vars), html: renderTemplate(t.body_html, vars) };
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
}
