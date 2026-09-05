import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../email/mailer.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { throwValidation, type FieldErrors } from '../common/laravel-exceptions';
import { toIso8601String } from '../common/serialize';
import { isBuyingType, missingLawyerParties, lawyerPartyLabel } from '../transactions/lawyer-details';
import { ResourceAccessService } from '../core/resource-access.service';
import type { AuthUserRecord } from '../auth/auth.types';

type Actor = AuthUserRecord | null;

@Injectable()
export class QuickSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly settings: CompanySettingsService,
    private readonly access: ResourceAccessService,
  ) {}

  private actor(u: Actor): { id: number; name: string } | null { return u ? { id: u.id, name: u.name } : null; }

  /*
   * TD-012 — LOADING A DEAL AND BEING ALLOWED TO IS ONE STEP, NOT TWO.
   *
   * Not one authorization call existed in this file. An agent with no part in a deal could POST to
   * `/transactions/:id/deposit-receipt/send` and get 200 — mailing the trade number, the property
   * address and the deposit amount to an address THEY supplied, plus a cc of their choosing. It
   * worked on administrator-only unassigned deals too. This is the exfiltration route, and it did
   * not require reading the deal first: the send endpoint composed the mail itself.
   *
   * The class-level `@Screen('transactions','edit')` looked like protection and is not — a screen
   * permission says which screens you may open, not which rows are yours, and every agent holds it.
   *
   * The check lives in the loader, not at the top of each public method, because that is the only
   * version that stays true for methods added later: every send here begins by loading the deal.
   * Renamed so the guarantee is stated at every call site.
   *
   * `assertTransaction` is the same rule the transaction, document and chat endpoints already
   * apply — one definition of who may reach a deal, deliberately not restated here.
   */
  private async reachableTxnOr404(user: Actor, id: number): Promise<{ id: number; trade_no: string; property: string | null; deposit: unknown; agent: string | null; agent_user_id: number | null; trade_sheet_sent_at: Date | null; trade_sheet_generated_at: Date | null }> {
    await this.access.assertTransaction(user, id);
    const t = await this.prisma.transactions.findFirst({ where: { id, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${id}.` });
    return t;
  }

  /*
   * TD-037 — WHO GETS CCED ON A SEND IS AN IDENTITY QUESTION, NOT A STRING MATCH.
   *
   * This matched the deal's agent and team NAMES against every row in `users`, with no role or
   * status restriction. `team_members.user_id` exists precisely so a name never has to be trusted
   * for this — "the user this member IS, resolved once instead of by name" — and this method was
   * the one caller still doing it the unresolved way, on the one action that mails the match to a
   * stranger instead of merely displaying it.
   *
   * REPRODUCED: a deal's agent name was "Akhil"; this database separately holds an unrelated admin
   * named "Akhilesh" whose account email is a personal Gmail address. A one-letter difference in
   * how a team member's name was typed is the entire distance between Ccing the right agent and
   * Ccing a stranger with the deal's deposit figures.
   *
   * THE SPLIT MIRRORS `common/transaction-scope.ts`'s OWN RULE: identity by id wherever a row
   * carries one; a NAME decides only the legacy rows that never resolved to an account. An id match
   * needs no further filter — `user_id` on a team row already means "this specific account is who
   * this member is," whatever their current role or status. A name-only fallback is restricted to
   * ACTIVE AGENTS, the same population `AgentsService.listNames()` searches, so an unresolved row
   * can still Cc a colleague but can no longer resolve to an admin, an accountant, or anyone whose
   * only connection to this name is coincidence.
   *
   * This is the SEND path — the union computed here reaches the outbound mail regardless of what a
   * caller passed in `cc`, which is also why `AgentsService.emails()` needed the same fix on its
   * own: fixing only one would leave the other free to reintroduce this at either end.
   */
  private async agentEmails(txnId: number, agent: string | null, agentUserId: number | null): Promise<string[]> {
    const members = await this.prisma.team_members.findMany({
      where: { transaction_id: txnId },
      select: { name: true, user_id: true },
    });

    const ids = new Set<number>();
    if (agentUserId) ids.add(agentUserId);
    for (const m of members) if (m.user_id) ids.add(m.user_id);

    const looseNames = new Set<string>();
    if (!agentUserId && agent) looseNames.add(agent);
    for (const m of members) if (!m.user_id && m.name) looseNames.add(m.name);

    const [byId, byName] = await Promise.all([
      ids.size ? this.prisma.users.findMany({ where: { id: { in: [...ids] } }, select: { email: true } }) : [],
      looseNames.size
        ? this.prisma.users.findMany({ where: { name: { in: [...looseNames] }, role: 'agent', status: 'Active' }, select: { email: true } })
        : [],
    ]);
    return [...new Set([...byId, ...byName].map((u) => u.email).filter((e) => e))];
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

  /*
   * TD-037 — WHAT THE EDITOR SHOWS BEFORE SEND MUST BE WHAT THE SEND ACTUALLY USES.
   *
   * The Deposit Receipt's Cc box used to pre-fill from `/api/agent-emails`, a flat name→email
   * dictionary of every user in the company. Two problems, not one: it could resolve a team
   * member's name to an unrelated person's account (the leak this defect reports), and — the part
   * only found while fixing that — restricting it to active agents to close the leak would have
   * silently DROPPED a genuine team member who happens to hold a different role. A manager sitting
   * on this deal's team, id-linked on the `team_members` row, is not an agent and would vanish from
   * the box while still being who `agentEmails()` correctly resolves and mails.
   *
   * So the editor gets the SAME resolution the send performs, rather than a second implementation
   * of the same question in a different shape. Whatever this returns is what depositReceipt() will
   * Cc if the caller adds nothing of their own — the two cannot drift apart because there is only
   * one place the answer comes from.
   */
  async ccSuggestions(user: Actor, txnId: number): Promise<string[]> {
    const t = await this.reachableTxnOr404(user, txnId);
    return this.agentEmails(txnId, t.agent, t.agent_user_id);
  }

  // ---- Deposit Receipt ----
  /*
   * TD-035 — A DEPOSIT RECEIPT FOLLOWS THE DEPOSIT, NOT THE DEAL TYPE.
   *
   * The button offering this document was decided by transaction TYPE alone, so a Buying deal
   * holding a real deposit could not receipt it while a listing at $0 offered to. The button now
   * asks whether there IS a deposit, and this is the same question asked where it is enforceable:
   * nothing but the hidden button stood between a direct POST and an emailed receipt reading
   * "Deposit: $0.00" — a document about money that was never taken, carrying the trade number and
   * the property address, with a Cc list of the caller's choosing.
   *
   * Zero and negative are both "no deposit". The column is NOT NULL DEFAULT 0.00, so a deal nobody
   * entered a deposit on arrives here as 0; a stored negative predates the API refusing to write
   * one (TD-055). `NaN > 0` is false, so the one comparison also covers a value too broken to
   * read, rather than formatting it into a receipt.
   *
   * Ahead of email validation deliberately: this receipt cannot exist for this deal whatever the
   * payload says, so the deal is the first thing answered. The refusal is a 422 naming the deal,
   * the shape the Trade Record Sheet's own precondition already uses.
   */
  async depositReceipt(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = await this.reachableTxnOr404(user, txnId);
    if (!(Number(t.deposit) > 0)) {
      throw new UnprocessableEntityException({
        message: `There is no deposit recorded on ${t.property || 'this transaction'}, so a Deposit Receipt cannot be sent. Please enter the deposit first.`,
      });
    }
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

    const cc = [...String(ccRaw ?? '').split(/[,;\s]+/).filter((e) => e), ...(await this.agentEmails(txnId, t.agent, t.agent_user_id))];
    try {
      await this.mailer.send('deposit_receipt.send', {
        transaction_number: t.trade_no, deposit_amount: this.numberFormat(Number(t.deposit)), property_address: t.property, company_name: (await this.settings.current()).name,
      }, email, cc);
    } catch { /* non-blocking */ }

    return { ok: true, email, cc: ccRaw };
  }

  // ---- Trade Record Sheet ----
  async tradeSheet(user: Actor, txnId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = await this.reachableTxnOr404(user, txnId);
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
      }, email, await this.agentEmails(txnId, t.agent, t.agent_user_id), attachments);
    } catch (err) {
      throw new UnprocessableEntityException({ ok: false, message: 'Send failed: ' + ((err as { message?: string })?.message ?? '') });
    }

    const now = new Date();
    await this.prisma.transactions.update({ where: { id: txnId }, data: { trade_sheet_sent_at: now, updated_at: now } });
    await this.audit.record(txnId, this.actor(user), { section: 'Quick Actions — Trade Record Sheet', field: 'Trade Record Sheet', action: resend ? 'Resent' : 'Sent', source: 'Quick Action', new: email });

    return { ok: true, message: (resend ? 'Resent' : 'Sent') + ' to ' + email, sent_at: toIso8601String(now) };
  }

  /**
   * TD-088 — the deal records that the Trade Record Sheet was PRODUCED.
   *
   * The sheet is a RECO trade record. It generated on demand and left nothing behind: no flag, no
   * date, no entry — so a brokerage under audit could produce one today and had nothing to show it
   * had produced one at the time. `trade_sheet_sent_at` answers a different question (was it
   * emailed to somebody) and is null on every sheet handed over in person or filed.
   *
   * WHY THE CLIENT HAS TO SAY SO. The sheet is filled in the browser — a static OREA Form 640 with
   * `pdf-lib` writing the deal's values into it — so the server never sees the production unless it
   * is told. This is that call, and it is deliberately not the PDF: storing another copy of a
   * document the system can regenerate from the deal buys nothing, while the evidence question is
   * only ever "was it produced, when, and by whom".
   *
   * BOTH HALVES ARE WRITTEN. The column carries the LATEST production, for the header pill and
   * anything that reports on it; the audit trail carries every one of them, with the actor, which
   * is what "by whom" means here. It goes through `reachableTxnOr404` like every other quick
   * action, so a deal somebody has no part in cannot be marked from outside (TD-012).
   */
  async tradeSheetGenerated(user: Actor, txnId: number): Promise<Record<string, unknown>> {
    const t = await this.reachableTxnOr404(user, txnId);
    const now = new Date();
    await this.prisma.transactions.update({ where: { id: txnId }, data: { trade_sheet_generated_at: now, updated_at: now } });
    await this.audit.record(txnId, this.actor(user), {
      section: 'Quick Actions — Trade Record Sheet',
      field: 'Trade Record Sheet',
      action: t.trade_sheet_generated_at ? 'Regenerated' : 'Generated',
      source: 'Quick Action',
      new: `Trade Record Sheet ${t.trade_no}`,
    });
    return { ok: true, generated_at: toIso8601String(now) };
  }
}
