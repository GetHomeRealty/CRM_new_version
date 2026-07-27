import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { parseJsonObject, phpJsonNormalize } from '../common/serialize';
import { isBuyingType } from '../transactions/lawyer-details';
import type { AuthUserRecord } from '../auth/auth.types';

const SECTION = 'Quick Actions — Notice of Sale';
type Actor = AuthUserRecord | null;
type Notice = { buyers: string[]; sellers: string[]; date: string | null; sent_at: string | null; agents: Record<string, { signature?: string | null; signed_date?: string | null; sent_at?: string | null }> };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

@Injectable()
export class NoticeOfSaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
  ) {}

  private actor(u: Actor): { id: number; name: string } | null { return u ? { id: u.id, name: u.name } : null; }

  private async txnOr404(id: number): Promise<{ id: number; notice_of_sale: string | null; trade_no: string; property: string | null; price: unknown; deposit: unknown; closing_date: Date | null; agent: string | null }> {
    const t = await this.prisma.transactions.findFirst({ where: { id, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${id}.` });
    return t;
  }

  async show(txnId: number): Promise<Record<string, unknown>> {
    const t = await this.txnOr404(txnId);
    return this.present(this.normalize(t.notice_of_sale));
  }

  async save(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = await this.txnOr404(txnId);
    this.validateSave(body);
    const previous = this.normalize(t.notice_of_sale);
    const current: Notice = { ...previous, agents: { ...previous.agents } };

    current.buyers = (body.buyers as unknown[]).map((v) => String(v ?? '').trim()).filter((v) => v !== '');
    current.sellers = (body.sellers as unknown[]).map((v) => String(v ?? '').trim()).filter((v) => v !== '');
    current.date = (body.date as string) ?? current.date ?? null;

    const inAgents = (body.agents ?? {}) as Record<string, { signature?: string | null; signed_date?: string | null }>;
    for (const [name, row] of Object.entries(inAgents)) {
      const existing = current.agents[name] ?? {};
      current.agents[name] = {
        signature: row.signature ?? existing.signature ?? null,
        signed_date: row.signed_date ?? existing.signed_date ?? null,
        sent_at: existing.sent_at ?? null,
      };
    }

    const prevBuyers = (previous.buyers ?? []).join(', ');
    const prevSellers = (previous.sellers ?? []).join(', ');
    if (current.buyers.join(', ') !== prevBuyers) await this.audit.record(txnId, this.actor(user), { section: SECTION, field: 'Buyers', action: 'Updated', source: 'Quick Action', old: prevBuyers, new: current.buyers.join(', ') });
    if (current.sellers.join(', ') !== prevSellers) await this.audit.record(txnId, this.actor(user), { section: SECTION, field: 'Sellers', action: 'Updated', source: 'Quick Action', old: prevSellers, new: current.sellers.join(', ') });
    for (const name of Object.keys(inAgents)) {
      const hadSig = !!(previous.agents[name]?.signature);
      const hasSig = !!(current.agents[name]?.signature);
      if (hasSig && !hadSig) await this.audit.record(txnId, this.actor(user), { section: SECTION, field: `Signature — ${name}`, action: 'Document uploaded', source: 'Quick Action' });
      else if (!hasSig && hadSig) await this.audit.record(txnId, this.actor(user), { section: SECTION, field: `Signature — ${name}`, action: 'Document deleted', source: 'Quick Action' });
    }

    await this.store(txnId, current);
    const fresh = await this.txnOr404(txnId);
    return this.present(this.normalize(fresh.notice_of_sale));
  }

  async send(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = await this.txnOr404(txnId);
    this.validateSend(body);
    await this.requireBuyerLawyer(txnId);
    const agents = (body.agents as unknown[]).map(String);
    const current = this.normalize(t.notice_of_sale);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    current.sent_at = now;
    for (const name of agents) {
      const existing = current.agents[name] ?? { signature: null, signed_date: null };
      existing.sent_at = now;
      current.agents[name] = existing;
    }
    await this.store(txnId, current);
    await this.audit.record(txnId, this.actor(user), { section: SECTION, field: 'Send for signature', action: 'Quick Action executed', source: 'Quick Action', new: agents.join(', ') });

    const users = await this.prisma.users.findMany({ where: { name: { in: agents }, email: { not: '' } }, select: { email: true } });
    const emails = users.map((u) => u.email).filter((e) => e);
    if (emails.length) {
      const attachments = body.pdf ? [{ data: String(body.pdf), name: (body.filename as string) ?? `Notice of Sale ${t.trade_no}.pdf`, mime: 'application/pdf' }] : [];
      try {
        await this.mailer.send('notice_of_sale.send', {
          transaction_number: t.trade_no, property_address: t.property, sale_price: this.numberFormat(Number(t.price), 2),
          closing_date: t.closing_date ? this.formattedDate(t.closing_date) : null, agent_name: agents.join(', '), company_name: (await this.settings.current()).name,
        }, emails, [], attachments);
      } catch { /* mail failure never blocks the send */ }
    }

    const fresh = await this.txnOr404(txnId);
    return this.present(this.normalize(fresh.notice_of_sale));
  }

  /**
   * A Buying transaction's Notice of Sale cannot be sent for signature until the buyer lawyer
   * details are on file. Non-buying types are unaffected.
   */
  private async requireBuyerLawyer(txnId: number): Promise<void> {
    const t = await this.prisma.transactions.findUnique({
      where: { id: txnId }, select: { type: true, buyer_lawyer_name: true, property: true },
    });
    if (isBuyingType(t?.type) && !String(t?.buyer_lawyer_name ?? '').trim()) {
      throw new UnprocessableEntityException({
        message: `Buyer lawyer details are required before the Notice of Sale can be sent for ${t?.property || 'this transaction'}. Please update the buyer lawyer details first.`,
      });
    }
  }

  private async store(txnId: number, notice: Notice): Promise<void> {
    await this.prisma.transactions.update({ where: { id: txnId }, data: { notice_of_sale: JSON.stringify(phpJsonNormalize(notice as unknown as Record<string, unknown>)), updated_at: new Date() } });
  }

  private normalize(raw: string | null): Notice {
    const n = parseJsonObject(raw) as Record<string, unknown>;
    const agents = n.agents;
    return {
      buyers: Array.isArray(n.buyers) ? (n.buyers as string[]) : [],
      sellers: Array.isArray(n.sellers) ? (n.sellers as string[]) : [],
      date: (n.date as string) ?? null,
      sent_at: (n.sent_at as string) ?? null,
      agents: agents && typeof agents === 'object' && !Array.isArray(agents) ? (agents as Notice['agents']) : {},
    };
  }

  private present(n: Notice): Record<string, unknown> {
    return { buyers: n.buyers, sellers: n.sellers, date: n.date, sent_at: n.sent_at, agents: n.agents };
  }

  private numberFormat(value: number, decimals: number): string {
    const fixed = Math.abs(value).toFixed(decimals);
    const [int, dec] = fixed.split('.');
    return (value < 0 ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + dec : '');
  }

  private formattedDate(d: Date): string { return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; }

  private validateSave(body: Record<string, unknown>): void {
    const errors: FieldErrors = {};
    const push = (f: string, m: string): void => { (errors[f] ??= []).push(m); };
    for (const f of ['buyers', 'sellers']) {
      if (!Object.prototype.hasOwnProperty.call(body, f)) push(f, `The ${f} field must be present.`);
      else if (!Array.isArray(body[f])) push(f, `The ${f} field must be an array.`);
    }
    if (Object.keys(errors).length) throwValidation(errors);
  }

  private validateSend(body: Record<string, unknown>): void {
    const errors: FieldErrors = {};
    if (!Object.prototype.hasOwnProperty.call(body, 'agents')) (errors.agents ??= []).push('The agents field must be present.');
    else if (!Array.isArray(body.agents)) (errors.agents ??= []).push('The agents field must be an array.');
    if (Object.keys(errors).length) throwValidation(errors);
  }
}
