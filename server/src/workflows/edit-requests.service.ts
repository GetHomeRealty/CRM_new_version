import { ForbiddenException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type transaction_edit_requests } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toDateString, toDateTimeString } from '../common/serialize';
import type { AuthUserRecord } from '../auth/auth.types';


import { isAdminOrAbove, isSuperAdmin, superAdminRoles } from '../core/authz';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { leadTitle, mayDecide, teamLeadOfRequester } from './team-review';
import { TransactionsWriteService } from '../transactions/transactions-write.service';
/**
 * The scope that means "I am proposing these commission numbers", as opposed to "let me edit".
 *
 * A SCOPE OF ITS OWN, which is what gives duplicate prevention for free: `store` already refuses a
 * second pending request for the same deal and scope, so one commission proposal can be open on a
 * deal at a time without a second rule being written for it.
 */
/**
 * A comparable number from whatever the column holds.
 *
 * Prisma returns `Decimal` for every money and percentage column here, and a `Decimal` is never
 * `===` another `Decimal`. Baseline comparison is the whole staleness check, so the two sides have
 * to be reduced to something that compares — null stays null, so "unset" and "zero" remain
 * different answers.
 */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * A stable string for a value, whatever order its keys happen to be in.
 *
 * POSTGRES JSONB DOES NOT PRESERVE KEY ORDER. `{name, split, agent_pct, brok_pct}` goes into
 * `baseline` and comes back as `{name, split, brok_pct, agent_pct}` — same data, different
 * spelling. A plain `JSON.stringify` comparison called that a change, so every `team` proposal was
 * refused as stale the moment it was reviewed, on a deal where nothing had moved at all.
 *
 * Measured, not guessed: the round trip above is what the stored row actually reads back as.
 *
 * Keys are sorted at every depth so the two sides are compared on their content. Arrays keep their
 * order, which is right — the order of team members and terms is part of the data.
 */
const canonical = (v: unknown): string => {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, walk(val)]));
    }
    return x;
  };
  return JSON.stringify(walk(v) ?? null);
};

export const COMMISSION_SCOPE = 'commission';

/**
 * The commission fields a request may propose — nothing else is accepted.
 *
 * AN ALLOW-LIST, NOT A FILTER OF THE FORBIDDEN. A request carries values that a Super Admin's
 * approval will apply verbatim, so the question is "may this key be proposed", and anything
 * unrecognised is refused rather than quietly dropped — a dropped key would approve a proposal
 * that did not say what the requester thought it said.
 *
 * `comm_pct` / `comm_amt`            the deal's commission percentage and amount
 * `precon_comm_*`                     the preconstruction equivalents, including the bonus
 * `precon_terms`                      per-term commission, the shape the Financial modal sends
 * `team`                              per-agent commission within the split
 * `price` / `deposit`                 the figures the commission is calculated from
 *
 * PRICE AND DEPOSIT JOINED ON 2026-10-13, at the brokerage's request: Documentation corrects
 * Price, Deposit and Commission Amount from the Financial panel as ONE request, and a Super Admin
 * approves all of it together. They are applied through the same write path as every other key
 * here, so the usual price/deposit validation still runs on approval.
 */
export const COMMISSION_PROPOSABLE: ReadonlySet<string> = new Set([
  'price', 'deposit',
  'comm_pct', 'comm_amt',
  'precon_comm_pct', 'precon_comm_amt_manual', 'precon_comm_bonus',
  'precon_terms', 'team',
  /*
   * 2026-10-22 (brokerage request, Accounting): a Listing deal's own commission figures — Listing
   * and Co-op Commission (% or amount) and their Commission Adjustments — proposed from the
   * Financial panel the way Price and Deposit already are, and applied the same way on approval.
   */
  'listing_comm_pct', 'listing_comm_flat', 'coop_comm_pct', 'coop_comm_flat',
  'listing_adj_enabled', 'listing_adj_before', 'listing_adj_after',
  'coop_adj_enabled', 'coop_adj_before', 'coop_adj_after',
  // 2026-10-22 (Accounting): the Commission Adjustment of a Buying / Lease / Sale deal, the same way.
  'comm_adjust_enabled', 'comm_adjust_before', 'comm_adjust_after',
]);

/** The yes/no switches a commission proposal may carry — compared as booleans, not numbers. */
const COMMISSION_BOOLEANS: ReadonlySet<string> = new Set(['listing_adj_enabled', 'coop_adj_enabled', 'comm_adjust_enabled']);

/**
 * INSIDE `team`, the only keys a proposal may carry.
 *
 * `name` identifies which member the row is about; the other three are that member's commission.
 * Everything else a team row holds — `scope` and `access` (what the agent may see), `terms`, `id`
 * — is deliberately absent: a commission change must not be a route to granting somebody access
 * to a deal, and a reviewer approving "3% instead of 2.5%" is not approving that.
 */
export const COMMISSION_PROPOSABLE_TEAM: ReadonlySet<string> = new Set([
  'name', 'agent_pct', 'brok_pct', 'split',
]);

/**
 * The scope for "I am proposing a new Closing Date" — Documentation's route to changing that one
 * Basic Info field, which it cannot write directly.
 *
 * A SCOPE OF ITS OWN rather than another key under 'commission', so a pending date request and a
 * pending Price/Commission request on the same deal do not block each other (`store` allows one
 * pending request per deal and scope).
 */
export const CLOSING_DATE_SCOPE = 'closing_date';
export const CLOSING_DATE_PROPOSABLE: ReadonlySet<string> = new Set(['closing_date']);

/**
 * The same, for the Offer Date (2026-10-22, brokerage request: Accounting asks for it as it asks
 * for the Closing Date). Its own scope, so it neither blocks nor is blocked by a pending closing
 * date or commission request on the same deal.
 */
export const OFFER_DATE_SCOPE = 'offer_date';
export const OFFER_DATE_PROPOSABLE: ReadonlySet<string> = new Set(['offer_date']);

/**
 * The MLS number (2026-10-22, brokerage request): Accounting asks for it the same way, by its own
 * scope, so it neither blocks nor waits on any other pending request.
 */
export const MLS_SCOPE = 'mls_num';

/** The single-field scopes, each proposing exactly its own one field. */
const DATE_SCOPES: Readonly<Record<string, { key: string; label: string; kind: 'date' | 'text' }>> = {
  [CLOSING_DATE_SCOPE]: { key: 'closing_date', label: 'closing date', kind: 'date' },
  [OFFER_DATE_SCOPE]: { key: 'offer_date', label: 'offer date', kind: 'date' },
  [MLS_SCOPE]: { key: 'mls_num', label: 'MLS number', kind: 'text' },
};

/**
 * LISTING / CO-OP BROKERAGE AND CLIENT INFORMATION, by request (2026-10-22, brokerage request).
 *
 * Documentation and Accounting used to save these two cards directly; they now propose them and a
 * Super Admin approves, like Price. Each card is its own scope, carrying the WHOLE card as the
 * screen shows it, so approval writes it through the ordinary save path (`syncBrokerage`,
 * `syncClients`), which replaces the card exactly as a direct save did.
 */
export const BROKERAGE_SCOPE = 'brokerage';
export const CLIENTS_SCOPE = 'clients';
const BROKERAGE_FIELDS = ['name', 'address', 'email', 'invoice_email', 'agent_email', 'phone'] as const;
const CLIENT_FIELDS = ['name', 'email', 'phone'] as const;
const PARTY_SCOPES: Readonly<Record<string, string>> = {
  [BROKERAGE_SCOPE]: 'brokerage information',
  [CLIENTS_SCOPE]: 'client information',
};

/** A text value as stored and compared: trimmed, with an empty box meaning "none". */
const textOrNull = (v: unknown): string | null => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? null : s;
};

/** The brokerage card in one comparable shape — the same for the proposal and the live rows. */
const normalBrokerage = (b: Record<string, unknown> | null | undefined): Record<string, unknown> => {
  const src = b ?? {};
  const out: Record<string, unknown> = {};
  for (const f of BROKERAGE_FIELDS) out[f] = textOrNull(src[f]);
  out.agents = (Array.isArray(src.agents) ? src.agents : []).map((a) => textOrNull(a)).filter((a): a is string => !!a);
  return out;
};

/** The client rows in one comparable shape, in screen order. */
const normalClients = (rows: unknown): Record<string, unknown>[] =>
  (Array.isArray(rows) ? rows : []).map((r) => {
    const src = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    return { name: textOrNull(src.name), email: textOrNull(src.email), phone: textOrNull(src.phone) };
  });

/** What a scope is called in messages: "the closing date", "the brokerage information", … */
const scopeLabel = (scope: string | null | undefined): string | undefined =>
  (scope ? DATE_SCOPES[scope]?.label ?? PARTY_SCOPES[scope] : undefined);

/** Inside `precon_terms`: which term, and that term's commission. Nothing else. */
export const COMMISSION_PROPOSABLE_TERM: ReadonlySet<string> = new Set([
  'term_no', 'pct', 'amt',
]);

/**
 * Refuse a proposal whose nested objects carry anything but commission.
 *
 * Throws rather than filters, for the same reason the outer allow-list does: a key silently
 * dropped would be approved as part of a proposal that did not say what the requester thought it
 * said, and nothing would record the difference.
 */
function nestedMustBeCommissionOnly(proposed: Record<string, unknown>): void {
  const check = (rows: unknown, allowed: ReadonlySet<string>, where: string): void => {
    if (!Array.isArray(rows)) {
      throw new UnprocessableEntityException({ message: `${where} must be a list.` });
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new UnprocessableEntityException({ message: `Each ${where} entry must be an object.` });
      }
      const bad = Object.keys(row as Record<string, unknown>).filter((k) => !allowed.has(k));
      if (bad.length) {
        throw new UnprocessableEntityException({
          message: `These cannot be proposed inside ${where}: ${bad.join(', ')}.`,
        });
      }
    }
  };
  if (proposed.team !== undefined) check(proposed.team, COMMISSION_PROPOSABLE_TEAM, 'team');
  if (proposed.precon_terms !== undefined) check(proposed.precon_terms, COMMISSION_PROPOSABLE_TERM, 'precon_terms');
}

/** §5.1 edit-approval workflow for DFT / Closed transactions. */
@Injectable()
export class EditRequestsService {
  private readonly log = new Logger(EditRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /*
     * OPTIONAL, like every other dispatcher dependency in this codebase, and for the same reason:
     * the existing specs construct this service directly with a Prisma client and an audit
     * service. They test who may request and who may approve, not who gets told, and making this
     * required would have rewritten all of them to add a feature none of them exercise.
     *
     * Absent, the workflow behaves exactly as it did before notifications existed.
     */
    private readonly dispatcher?: NotificationDispatcher,
    /*
     * Optional for the same reason the dispatcher is — the existing specs build this service with
     * a Prisma client and an audit service, and they test who may ask and who may decide.
     *
     * It is what makes approval APPLY the proposal rather than merely unlock the fields: the write
     * service is the one path that validates, recalculates and audits a commission change, and
     * reaching around it to `prisma.transactions.update` would be a second, quieter way to change
     * the brokerage's money. Absent, a commission request can still be raised and rejected; only
     * applying it needs this.
     */
    private readonly writes?: TransactionsWriteService,
  ) {}

  /** The live values of exactly the keys a proposal names — the baseline, and the staleness check. */
  private async currentValues(
    txnId: number,
    keys: string[],
    /** Defaults to the service's own client — `store` reads outside any transaction. */
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Record<string, unknown>> {
    const t = await db.transactions.findFirstOrThrow({ where: { id: txnId } }) as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k === 'team') {
        const team = await db.team_members.findMany({
          where: { transaction_id: txnId },
          orderBy: [{ id: 'asc' }],
          select: { name: true, split: true, agent_pct: true, brok_pct: true },
        });
        out.team = team.map((m) => ({
          name: m.name, split: num(m.split), agent_pct: num(m.agent_pct), brok_pct: num(m.brok_pct),
        }));
      } else if (k === 'precon_terms') {
        const terms = await db.precon_terms.findMany({
          where: { transaction_id: txnId },
          orderBy: [{ term_no: 'asc' }],
          select: { term_no: true, pct: true, amt: true },
        });
        out.precon_terms = terms.map((x) => ({ term_no: x.term_no, pct: num(x.pct), amt: num(x.amt) }));
      } else if (k === 'closing_date' || k === 'offer_date') {
        // A date column: compared as YYYY-MM-DD, the same shape the request carries.
        out[k] = toDateString(t[k] as Date | null);
      } else if (k === 'mls_num') {
        out[k] = textOrNull(t[k]);
      } else if (k === 'brokerage') {
        const b = await db.brokerages.findUnique({
          where: { transaction_id: txnId },
          include: { brokerage_agents: { orderBy: [{ position: 'asc' }, { id: 'asc' }], select: { name: true } } },
        });
        out.brokerage = normalBrokerage(b ? { ...b, agents: b.brokerage_agents.map((a) => a.name) } : null);
      } else if (k === 'clients') {
        const rows = await db.clients.findMany({
          where: { transaction_id: txnId },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: { name: true, email: true, phone: true },
        });
        out.clients = normalClients(rows);
      } else if (COMMISSION_BOOLEANS.has(k)) {
        out[k] = t[k] === null || t[k] === undefined ? null : Boolean(t[k]);
      } else {
        out[k] = num(t[k]);
      }
    }
    return out;
  }

  /**
   * The people this workflow lets review a request — and therefore the only people told one has
   * arrived.
   *
   * DERIVED FROM THE SAME AUTHZ SOURCE AS THE APPROVE GUARD. `review()` below refuses anybody who
   * is not `isSuperAdmin`, and `superAdminRoles()` is that predicate's role list. Hard-coding
   * 'admin' here instead would be a second, quieter answer to "who may approve" that could drift
   * from the one actually enforced.
   *
   * Active accounts only: a deactivated reviewer cannot act on it.
   */
  private async reviewers(): Promise<number[]> {
    const rows = await this.prisma.users.findMany({
      where: { role: { in: superAdminRoles() }, status: 'Active' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Tell the reviewers, in the bell, that there is something waiting.
   *
   * NEVER FAILS THE REQUEST. The request is the record and the notification is the courtesy —
   * exactly the stance `transaction-review.service.ts` takes about its own sends. A dispatcher
   * that throws must not leave the requester with an error for a request that was in fact filed.
   *
   * THE DEDUPE KEY IS THE REQUEST'S OWN ID, which is what makes this safe to retry. A row is
   * created once per pending request — `store` refuses a second one for the same deal and scope
   * while one is pending — so the id identifies the submission, and a re-dispatch of the same id
   * is dropped by the ledger rather than ringing the bell twice. Re-reading a page raises nothing
   * at all: this runs on the POST that creates the row, not on any read.
   */
  private async notifyReviewers(req: transaction_edit_requests, property: string | null): Promise<void> {
    if (!this.dispatcher) return;
    try {
      // The Super Admins, and the requester's own Team Lead (25 Oct 2026) - either may decide it.
      const ids = await this.reviewers();
      const lead = await teamLeadOfRequester(this.prisma, req.requested_by);
      if (lead && !ids.includes(lead.id)) ids.push(lead.id);
      if (!ids.length) return;
      const named = scopeLabel(req.scope);
      const what = named ? `the ${named}` : req.scope ? `${req.scope} fields` : 'this deal';
      await this.dispatcher.dispatchMany(ids, {
        category: 'approval_requested',
        title: 'Approval requested',
        // Enough to recognise WHICH request without opening it: who asked, which deal, what for.
        body: `${req.requested_by_name || 'Someone'} asked to edit ${what} on ${property || `deal #${req.transaction_id}`}.`
          + (req.reason ? ` Reason: ${req.reason}` : ''),
        // Opens the deal; `approvals` is what the detail page reads to show the approval section.
        link: `/desk/transactions/${req.transaction_id}?section=approvals`,
        dedupeKey: `edit-request:${req.id}`,
        channels: ['in_app'],
      });
    } catch (err) {
      this.log.error(`Edit request ${req.id}: could not notify reviewers — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async statusList(txnId: number): Promise<string[]> {
    const rows = await this.prisma.transaction_statuses.findMany({ where: { transaction_id: txnId }, select: { status: true } });
    const list = rows.map((r) => r.status);
    return list.length ? list : ['Open'];
  }

  async store(
    user: AuthUserRecord,
    txnId: number,
    reason: string | null,
    scope: string | null,
    proposed?: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null } });
    if (!t) throw new NotFoundException({ message: `No query results for model [App\\Models\\Transaction] ${txnId}.` });

    const statuses = await this.statusList(txnId);
    // TD-159 - 'mandatory' joins 'financial' as a scope anybody below Super Admin may ASK about,
    // rather than one only an Admin may raise on a locked deal. The two behave identically: the
    // top tier does not queue a request to itself.
    /*
     * A COMMISSION PROPOSAL IS CHECKED BEFORE ANYTHING IS WRITTEN.
     *
     * Required, allow-listed, and non-empty: a request with nothing in it would sit in a reviewer's
     * queue asking them to approve no change, and a request naming a key this workflow cannot
     * apply would be approved and then silently do nothing.
     */
    let baseline: Record<string, unknown> | null = null;
    if (scope === COMMISSION_SCOPE) {
      const keys = Object.keys(proposed ?? {});
      if (!keys.length) {
        throw new UnprocessableEntityException({ message: 'Say which commission values you are proposing.' });
      }
      const unknownKeys = keys.filter((k) => !COMMISSION_PROPOSABLE.has(k));
      if (unknownKeys.length) {
        throw new UnprocessableEntityException({
          message: `These cannot be proposed as a commission change: ${unknownKeys.join(', ')}.`,
        });
      }
      /*
       * THE NESTED KEYS TOO. `team` and `precon_terms` are arrays of objects, and allow-listing
       * only the outer name would let a proposal called "commission" carry an agent's access
       * scope, a payment field or an invoice reference inside it — approved by a reviewer who was
       * shown two percentages.
       */
      nestedMustBeCommissionOnly(proposed ?? {});
      if (!String(reason ?? '').trim()) {
        throw new UnprocessableEntityException({ message: 'A commission change request needs a reason.' });
      }
      // Captured now, so the reviewer is shown the comparison the REQUESTER saw — and so a figure
      // that moves afterwards can be detected rather than silently overwritten.
      baseline = await this.currentValues(txnId, keys);
    } else if (scope && DATE_SCOPES[scope]) {
      const { key, label, kind } = DATE_SCOPES[scope];
      const keys = Object.keys(proposed ?? {});
      if (keys.length !== 1 || keys[0] !== key) {
        throw new UnprocessableEntityException({ message: `A ${label} request carries the new ${label} and nothing else.` });
      }
      const v = String((proposed ?? {})[key] ?? '');
      if (kind === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) {
        throw new UnprocessableEntityException({ message: `Give the new ${label} as a valid date.` });
      }
      if (kind === 'text' && (!v.trim() || v.trim().length > 255)) {
        throw new UnprocessableEntityException({ message: `Give the new ${label} (up to 255 characters).` });
      }
      if (!String(reason ?? '').trim()) {
        throw new UnprocessableEntityException({ message: `A ${label} change request needs a reason.` });
      }
      baseline = await this.currentValues(txnId, keys);
    } else if (scope === BROKERAGE_SCOPE || scope === CLIENTS_SCOPE) {
      const label = PARTY_SCOPES[scope];
      const keys = Object.keys(proposed ?? {});
      if (keys.length !== 1 || keys[0] !== scope) {
        throw new UnprocessableEntityException({ message: `A ${label} request carries the ${label} card and nothing else.` });
      }
      const value = (proposed ?? {})[scope];
      if (scope === BROKERAGE_SCOPE) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new UnprocessableEntityException({ message: 'Send the brokerage card as one record.' });
        }
        const bad = Object.keys(value as Record<string, unknown>).filter((k) => k !== 'agents' && !(BROKERAGE_FIELDS as readonly string[]).includes(k));
        if (bad.length) throw new UnprocessableEntityException({ message: `These cannot be proposed for the brokerage: ${bad.join(', ')}.` });
        if (!Array.isArray((value as Record<string, unknown>).agents ?? [])) {
          throw new UnprocessableEntityException({ message: 'The brokerage agents must be a list of names.' });
        }
      } else {
        if (!Array.isArray(value)) throw new UnprocessableEntityException({ message: 'Send the clients as a list.' });
        (value as unknown[]).forEach((row, i) => {
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new UnprocessableEntityException({ message: `Client ${i + 1} must be a record.` });
          }
          const bad = Object.keys(row as Record<string, unknown>).filter((k) => !(CLIENT_FIELDS as readonly string[]).includes(k));
          if (bad.length) throw new UnprocessableEntityException({ message: `These cannot be proposed for a client: ${bad.join(', ')}.` });
          if (!textOrNull((row as Record<string, unknown>).name)) {
            throw new UnprocessableEntityException({ message: `Client ${i + 1} needs a name.` });
          }
        });
      }
      if (!String(reason ?? '').trim()) {
        throw new UnprocessableEntityException({ message: `A ${label} change request needs a reason.` });
      }
      // Stored in the compared shape, so the reviewer reads exactly what will be written.
      proposed = { [scope]: scope === BROKERAGE_SCOPE ? normalBrokerage(value as Record<string, unknown>) : normalClients(value) };
      baseline = await this.currentValues(txnId, keys);
      if (canonical(baseline[scope]) === canonical(proposed[scope])) {
        throw new UnprocessableEntityException({ message: `Nothing in the ${label} has changed.` });
      }
    }

    // 'commission' joins 'financial' and 'mandatory': scopes anybody below Super Admin may ASK
    // about, rather than ones only an Admin may raise on a locked deal. The top tier does not
    // queue a request to itself — it can change the figures directly.
    if (scope === 'financial' || scope === 'mandatory' || scope === COMMISSION_SCOPE || !!scopeLabel(scope)) {
      if (isSuperAdmin(user)) {
        throw new UnprocessableEntityException({
          message: scope === 'financial'
            ? 'Super Admins can edit financial fields directly.'
            : scope === COMMISSION_SCOPE
              ? 'Super Admins can change the commission directly.'
              : scopeLabel(scope)
                ? `Super Admins can change the ${scopeLabel(scope)} directly.`
              : 'Super Admins can change whether a document is Mandatory directly.',
        });
      }
    } else {
      if (!isAdminOrAbove(user)) throw new ForbiddenException({ message: 'Only Admins can request edits.' });
      if (statuses.includes('Closed')) throw new ForbiddenException({ message: 'Closed transactions can only be edited by a Super Admin.' });
    }

    const dup = await this.prisma.transaction_edit_requests.findFirst({
      where: { transaction_id: txnId, scope: scope ?? null, status: 'pending' },
    });
    if (dup) throw new UnprocessableEntityException({ message: 'A request is already pending approval.' });

    const locked = statuses.filter((s) => s === 'DFT' || s === 'Closed');
    const statusAtRequest = locked.length ? locked.join(', ') : statuses[0] ?? '';
    const now = new Date();
    const req = await this.prisma.transaction_edit_requests.create({
      data: {
        transaction_id: txnId,
        status_at_request: statusAtRequest,
        scope: scope ?? null,
        requested_by: user.id,
        requested_by_name: user.name,
        reason: reason ?? null,
        status: 'pending',
        proposed: (proposed ?? undefined) as never,
        baseline: (baseline ?? undefined) as never,
        created_at: now,
        updated_at: now,
      },
    });

    await this.audit.record(txnId, { id: user.id, name: user.name }, {
      section: 'Approvals',
      field: 'Edit Request',
      action: 'Edit requested',
      source: 'Manual',
      new: req.status_at_request,
      details: reason ?? null,
    });
    // After the row and the audit entry, so a notification can never be the only trace of a
    // request that failed to save.
    await this.notifyReviewers(req, t.property);
    return this.payload(req);
  }

  async approve(user: AuthUserRecord, reqId: number): Promise<Record<string, unknown>> {
    return this.review(user, reqId, 'approved', 'Edit approved');
  }

  async reject(user: AuthUserRecord, reqId: number): Promise<Record<string, unknown>> {
    return this.review(user, reqId, 'rejected', 'Edit rejected');
  }

  private async review(user: AuthUserRecord, reqId: number, status: string, action: string): Promise<Record<string, unknown>> {
    const existing = await this.prisma.transaction_edit_requests.findUnique({ where: { id: reqId } });
    if (!existing) throw new NotFoundException({ message: `No query results for model [App\\Models\\TransactionEditRequest] ${reqId}.` });
    // A Super Admin, or - since 25 Oct 2026 - the requester's own Documentation / Accounting Team Lead.
    if (!(await mayDecide(this.prisma, user, existing.requested_by))) {
      throw new ForbiddenException({ message: status === 'approved'
        ? 'Only a Super Admin or the team lead of the person who asked can approve.'
        : 'Only a Super Admin or the team lead of the person who asked can reject.' });
    }
    const byLead = !isSuperAdmin(user);

    /*
     * ================================================================================================
     * APPROVING A PROPOSAL IS ONE TRANSACTION: claim, check, apply, mark.
     *
     * All four write through the same client, so there is no moment at which some of them have
     * happened and the rest have not. The failure this closes is the one that cannot be seen
     * afterwards: a commission applied under a request that still reads "pending", or a request
     * reading "approved" over figures that never moved. Either is a number somebody bills on and a
     * paper trail that disagrees with it.
     *
     * THE CLAIM IS STILL AN ATOMIC COMPARE-AND-SET, and still earns its place. `updateMany` on
     * (id, status = 'pending') is one statement, so of two Super Admins pressing Approve together
     * exactly one matches a row. The transaction alone would not settle that — both could read a
     * pending request — and the claim alone would not make the four steps one unit. They do
     * different jobs.
     *
     * NO 'approving' STATE IS EVER COMMITTED. It exists only inside the transaction, as the marker
     * that makes the claim atomic; a rollback takes it with everything else, so nothing can be
     * found stranded in it — not by the next reviewer, not by the dashboard, not by a crash.
     *
     * REJECTION TAKES NONE OF THIS. It applies nothing, so there is nothing to make atomic.
     * ================================================================================================
     */
    const applying = status === 'approved' && !!existing.proposed;

    const req = await this.prisma.$transaction(async (tx) => {
      if (applying) {
        const claimed = await tx.transaction_edit_requests.updateMany({
          where: { id: reqId, status: 'pending' },
          data: { status: 'approving', updated_at: new Date() },
        });
        if (!claimed.count) {
          throw new UnprocessableEntityException({
            message: 'This request is already being reviewed, or has already been decided.',
          });
        }
        /*
         * Throws on a stale baseline or a refused write, which rolls the claim back with it.
         *
         * A TEAM LEAD'S APPROVAL CARRIES APPROVAL AUTHORITY. The proposal is written by the same write
         * path as a Super Admin's, and that path drops the fields a Documentation or Accounting role may
         * not write - so written as the lead's own role, an approved commission change would be marked
         * approved and silently not applied. The approval IS the authority: the write runs with it, and
         * the history still names the lead who approved.
         */
        await this.applyProposal(byLead ? ({ ...user, role: 'admin' } as AuthUserRecord) : user, existing, tx);
      } else {
        /*
         * ONE DECISION ONLY. With a Team Lead and the Super Admins both able to decide, the second
         * person to press finds it already decided rather than overwriting the first decision.
         */
        const open = await tx.transaction_edit_requests.updateMany({
          where: { id: reqId, status: 'pending' },
          data: { updated_at: new Date() },
        });
        if (!open.count) {
          throw new UnprocessableEntityException({ message: 'This request has already been decided.' });
        }
      }

      const updated = await tx.transaction_edit_requests.update({
        where: { id: reqId },
        data: { status, reviewed_by: user.id, reviewed_by_name: user.name, reviewed_at: new Date(), updated_at: new Date() },
      });
      await this.audit.record(updated.transaction_id, { id: user.id, name: user.name }, {
        section: 'Approvals',
        field: 'Edit Request',
        action,
        source: 'Manual',
      }, tx);
      return updated;
    }, {
      /*
       * Longer than the 5s default. Applying a commission runs the whole write path —
       * recalculation, the invoice refresh and the audit diff — and a timeout here would roll back
       * a correct change for being unhurried.
       */
      timeout: 30_000,
    });

    /*
     * AFTER THE COMMIT, NEVER INSIDE IT. A notification cannot be un-sent, so telling somebody
     * their change was approved from inside a transaction that then rolls back is a message about
     * something that did not happen. It is also why this is not awaited for its result: the
     * decision is the record, the message is the courtesy.
     */
    await this.notifyRequester(req);
    await this.notifyOtherReviewer(req, user, byLead);
    return this.payload(req);
  }

  /**
   * THE OTHER SIDE IS TOLD (Sai, 25 Oct 2026: "if team lead approves the super admin should know that,
   * if super admin approves team lead should know that"). In the bell only, like every message here.
   */
  private async notifyOtherReviewer(req: transaction_edit_requests, decider: AuthUserRecord, byLead: boolean): Promise<void> {
    if (!this.dispatcher) return;
    try {
      const done = req.status === 'approved' ? 'approved' : 'rejected';
      const named = scopeLabel(req.scope);
      const what = named ? `the ${named}` : 'an edit';
      const property = (await this.prisma.transactions.findUnique({ where: { id: req.transaction_id }, select: { property: true } }))?.property;
      const where = property || `deal #${req.transaction_id}`;
      let ids: number[] = [];
      let by = decider.name;
      if (byLead) {
        ids = (await this.reviewers()).filter((id) => id !== decider.id);
        by = leadTitle(decider);
      } else {
        const lead = await teamLeadOfRequester(this.prisma, req.requested_by);
        if (lead && lead.id !== decider.id) ids = [lead.id];
      }
      if (!ids.length) return;
      await this.dispatcher.dispatchMany(ids, {
        category: 'transaction_approvals',
        title: `Request ${done} by ${by}`,
        body: `${by} ${done} ${req.requested_by_name || 'a team member'}'s request to change ${what} on ${where}.`,
        link: `/desk/transactions/${req.transaction_id}?section=approvals`,
        dedupeKey: `edit-request-other:${req.id}:${req.status}`,
        channels: ['in_app'],
      });
    } catch (err) {
      this.log.error(`Edit request ${req.id}: could not tell the other reviewer — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Write the proposed commission values, through the service that owns commission changes.
   *
   * STALE FIRST. The live values are compared with the baseline captured when the request was
   * raised; if they differ, somebody has changed the commission in the meantime and applying this
   * proposal would revert their work without either of them knowing. Refused, with the fields
   * named, so the requester can look again and ask afresh.
   *
   * THEN THE ORDINARY WRITE PATH, as the REVIEWER. `TransactionsWriteService.update` is what
   * validates these fields, recalculates every derived figure and writes the audit trail; calling
   * it is the difference between approval applying a change and approval merely unlocking a form.
   * It runs as the Super Admin who approved, because they are the person authorising the change —
   * which is also what keeps the write inside the permissions that already exist rather than
   * needing new ones.
   */
  private async applyProposal(
    user: AuthUserRecord,
    req: transaction_edit_requests,
    /** The approval's transaction. Every read and write below joins it. */
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const proposed = (req.proposed ?? {}) as Record<string, unknown>;
    const keys = Object.keys(proposed);
    if (!keys.length) return;

    const { version } = await tx.transactions.findFirstOrThrow({
      where: { id: req.transaction_id }, select: { version: true },
    });
    // Read inside the transaction, so the baseline is compared against what this transaction sees.
    const live = await this.currentValues(req.transaction_id, keys, tx);
    const baseline = (req.baseline ?? {}) as Record<string, unknown>;
    const moved = keys.filter((k) => canonical(live[k]) !== canonical(baseline[k]));
    if (moved.length) {
      throw new UnprocessableEntityException({
        message: (scopeLabel(req.scope) ? `The ${scopeLabel(req.scope)}` : 'The commission')
          + ' has changed since this was requested, so applying it would undo that change. '
          + `Ask for it again from the current figures (${moved.join(', ')}).`,
      });
    }

    if (!this.writes) {
      throw new UnprocessableEntityException({
        message: 'Commission changes cannot be applied in this configuration.',
      });
    }

    /*
     * MERGED ONTO THE LIVE ROWS, NEVER SENT VERBATIM.
     *
     * Writing `team` or `precon_terms` REPLACES them, so a proposal carrying only a name and a
     * percentage would wipe every other column on those rows — an agent's access scope, which
     * terms they are on. Overlaying the proposed commission values onto what is actually there
     * makes it structurally impossible for this workflow to change anything it did not propose,
     * rather than relying on the proposal having remembered to carry it.
     */
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(proposed)) {
      if (k === 'team') body.team = await this.mergeTeam(req.transaction_id, v as Record<string, unknown>[], tx);
      else if (k === 'precon_terms') body.precon_terms = await this.mergeTerms(req.transaction_id, v as Record<string, unknown>[], tx);
      else body[k] = v;
    }

    /*
     * THE VERSION TOKEN CLOSES THE GAP between the baseline check above and this write.
     *
     * Read a moment ago, so a commission change that lands in between bumps `version` and the
     * write service refuses this one as stale — the same optimistic lock (TD-003) that protects
     * two people editing a deal at once. Without it the check and the write are two separate
     * reads with a window between them.
     */
    // `tx` is what makes the commission write part of this approval rather than beside it.
    await this.writes.update(user, req.transaction_id, { ...body, version }, { tx });
  }

  /** The live team, with only the proposed commission values overlaid, matched by name. */
  private async mergeTeam(txnId: number, proposed: Record<string, unknown>[], db: Prisma.TransactionClient): Promise<Record<string, unknown>[]> {
    const live = await db.team_members.findMany({
      where: { transaction_id: txnId },
      orderBy: [{ id: 'asc' }],
      // `terms` is a relation, and `access`/`scope` are what an agent may SEE of the deal. All
      // three are carried through untouched — a commission change is not a change of access.
      include: { team_member_terms: { select: { term_no: true }, orderBy: { term_no: 'asc' } } },
    });
    const byName = new Map(proposed.map((p) => [String(p.name ?? ''), p]));
    return live.map((m) => {
      const p = byName.get(m.name) ?? {};
      const pick = (k: 'agent_pct' | 'brok_pct' | 'split') =>
        (p[k] === undefined || p[k] === null ? num(m[k]) : Number(p[k]));
      return {
        name: m.name,
        split: pick('split'),
        agent_pct: pick('agent_pct'),
        brok_pct: pick('brok_pct'),
        is_primary: m.is_primary,
        scope: m.scope,
        access: m.access,
        terms: m.team_member_terms.map((x) => x.term_no),
      };
    });
  }

  /** The live terms, with only the proposed commission values overlaid, matched by term number. */
  private async mergeTerms(txnId: number, proposed: Record<string, unknown>[], db: Prisma.TransactionClient): Promise<Record<string, unknown>[]> {
    const live = await db.precon_terms.findMany({ where: { transaction_id: txnId }, orderBy: [{ term_no: 'asc' }] });
    const byNo = new Map(proposed.map((p) => [Number(p.term_no), p]));
    return live.map((t) => {
      const p = byNo.get(t.term_no) ?? {};
      return {
        term_no: t.term_no,
        pct: p.pct === undefined || p.pct === null ? num(t.pct) : Number(p.pct),
        amt: p.amt === undefined || p.amt === null ? num(t.amt) : Number(p.amt),
      };
    });
  }

  /**
   * Tell whoever asked what was decided — the existing outcome notification, not a new one.
   *
   * `transaction_approvals` is the category already described as "a correction or review on one of
   * your deals has been approved or turned down", which is exactly this. The request's own id and
   * the decision make the dedupe key, so a retried review cannot tell somebody twice, and an
   * approval followed later by something else remains a separate occurrence.
   *
   * Wrapped, like every other send here: the decision is the record and telling somebody is the
   * courtesy.
   */
  private async notifyRequester(req: transaction_edit_requests): Promise<void> {
    if (!this.dispatcher || !req.requested_by) return;
    try {
      const approved = req.status === 'approved';
      const named = scopeLabel(req.scope);
      const what = req.scope === COMMISSION_SCOPE ? 'commission change' : named ? `${named} change` : 'edit request';
      await this.dispatcher.dispatch({
        category: 'transaction_approvals',
        userId: req.requested_by,
        title: approved ? `Your ${what} was approved` : `Your ${what} was rejected`,
        body: approved
          ? `${req.reviewed_by_name || 'A Super Admin'} approved it${req.scope === COMMISSION_SCOPE ? ' and the new figures have been applied.' : named ? ` and the new ${named} has been applied.` : '.'}`
          : `${req.reviewed_by_name || 'A Super Admin'} turned it down. The existing values are unchanged.`,
        link: `/desk/transactions/${req.transaction_id}?section=approvals`,
        dedupeKey: `edit-request-decision:${req.id}:${req.status}`,
        channels: ['in_app'],
      });
    } catch (err) {
      this.log.error(`Edit request ${req.id}: could not notify the requester — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private payload(r: transaction_edit_requests): Record<string, unknown> {
    return {
      id: r.id,
      status: r.status,
      scope: r.scope,
      status_at_request: r.status_at_request,
      requested_by_name: r.requested_by_name,
      reason: r.reason,
      reviewed_by_name: r.reviewed_by_name,
      // What was asked for, and what it was asked FROM — the reviewer's whole comparison.
      proposed: r.proposed ?? null,
      baseline: r.baseline ?? null,
      reviewed_at: toDateTimeString(r.reviewed_at),
      stamp: toDateTimeString(r.created_at),
    };
  }
}
