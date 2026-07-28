import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { toIso8601String } from '../common/serialize';
import { isBuyingType, missingLawyerParties, lawyerPartyLabel } from '../transactions/lawyer-details';
import type { AuthUserRecord } from '../auth/auth.types';

type Actor = AuthUserRecord | null;

@Injectable()
export class QuickSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
  ) {}

  private actor(u: Actor): { id: number; name: string } | null { return u ? { id: u.id, name: u.name } : null; }

  private async txnOr404(id: number): Promise<{ id: number; trade_no: string; property: string | null; deposit: unknown; agent: string | null; trade_sheet_sent_at: Date | null }> {
    const t = await this.prisma.transactions.findFirst({ where: { id, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${id}.` });
    return t;
  }

  private async agentEmails(txnId: number, agent: string | null): Promise<string[]> {
    const members = await this.prisma.team_members.findMany({ where: { transaction_id: txnId }, select: { name: true } });
    const names = [...new Set([agent, ...members.map((m) => m.name)].filter((n): n is string => !!n))];
    if (names.length === 0) return [];
    const users = await this.prisma.users.findMany({ where: { name: { in: names }, email: { not: '' } }, select: { email: true } });
    return [...new Set(users.map((u) => u.email).filter((e) => e))];
  }

  private numberFormat(value: number): string {
    const fixed = Math.abs(value).toFixed(2);
    const [int, dec] = fixed.split('.');
    return (value < 0 ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
  }

  private validateEmail(body: Record<string, unknown>, extra?: (e: FieldErrors) => void): void {
    const errors: FieldErrors = {};
    if (body.email === undefined || body.email === null || body.email === '') (errors.email ??= []).push('The email field is required.');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email))) (errors.email ??= []).push('The email field must be a valid email address.');
    else if ([...String(body.email)].length > 255) (errors.email ??= []).push('The email field must not be greater than 255 characters.');
    if (extra) extra(errors);
    if (Object.keys(errors).length) throwValidation(errors);
  }

  // ---- Deposit Receipt ----
  async depositReceipt(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = await this.txnOr404(txnId);
    this.validateEmail(body, (errors) => {
      if (body.cc !== undefined && body.cc !== null && body.cc !== '') {
        if (typeof body.cc !== 'string') (errors.cc ??= []).push('The cc field must be a string.');
        else if ([...(body.cc as string)].length > 1000) (errors.cc ??= []).push('The cc field must not be greater than 1000 characters.');
      }
    });
    const email = String(body.email);
    const ccRaw = (body.cc as string) ?? null;

    await this.audit.record(txnId, this.actor(user), {
      section: 'Quick Actions — Deposit Receipt', field: 'Send Deposit Receipt', action: 'Quick Action executed', source: 'Quick Action',
      new: email, details: ccRaw ? 'Cc: ' + ccRaw : null,
    });

    const cc = [...String(ccRaw ?? '').split(/[,;\s]+/).filter((e) => e), ...(await this.agentEmails(txnId, t.agent))];
    try {
      await this.mailer.send('deposit_receipt.send', {
        transaction_number: t.trade_no, deposit_amount: this.numberFormat(Number(t.deposit)), property_address: t.property, company_name: (await this.settings.current()).name,
      }, email, cc);
    } catch { /* non-blocking */ }

    return { ok: true, email, cc: ccRaw };
  }

  // ---- Trade Record Sheet ----
  async tradeSheet(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = await this.txnOr404(txnId);
    // A Buying transaction's Trade Record Sheet needs both the buyer AND seller lawyer details
    // before it can be sent for signature. Non-buying types are unaffected.
    const g = await this.prisma.transactions.findUnique({
      where: { id: txnId }, select: { type: true, buyer_lawyer_name: true, seller_lawyer_name: true, property: true },
    });
    if (isBuyingType(g?.type)) {
      const missing = missingLawyerParties(g ?? {});
      if (missing.length > 0) {
        throw new UnprocessableEntityException({
          message: `${lawyerPartyLabel(missing).replace(/^./, (c) => c.toUpperCase())} lawyer details are required before the Trade Record Sheet can be sent for ${g?.property || 'this transaction'}. Please update them first.`,
        });
      }
    }
    this.validateEmail(body, (errors) => {
      if (body.filename !== undefined && body.filename !== null && body.filename !== '' && [...String(body.filename)].length > 255) (errors.filename ??= []).push('The filename field must not be greater than 255 characters.');
    });
    const email = String(body.email);
    const resend = !!t.trade_sheet_sent_at;
    const attachments = body.pdf ? [{ data: String(body.pdf), name: (body.filename as string) ?? `Trade Record Sheet ${t.trade_no}.pdf`, mime: 'application/pdf' }] : [];

    try {
      await this.mailer.send('trade_sheet.send', {
        transaction_number: t.trade_no, property_address: t.property, agent_name: t.agent, company_name: (await this.settings.current()).name,
      }, email, await this.agentEmails(txnId, t.agent), attachments);
    } catch (err) {
      throw new UnprocessableEntityException({ ok: false, message: 'Send failed: ' + ((err as { message?: string })?.message ?? '') });
    }

    const now = new Date();
    await this.prisma.transactions.update({ where: { id: txnId }, data: { trade_sheet_sent_at: now, updated_at: now } });
    await this.audit.record(txnId, this.actor(user), { section: 'Quick Actions — Trade Record Sheet', field: 'Trade Record Sheet', action: resend ? 'Resent' : 'Sent', source: 'Quick Action', new: email });

    return { ok: true, message: (resend ? 'Resent' : 'Sent') + ' to ' + email, sent_at: toIso8601String(now) };
  }
}
