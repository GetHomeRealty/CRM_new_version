import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { isSuperAdmin } from '../core/authz';
import { deskTeamLeadIdOf } from '../users/team-lead';
import { marketOf } from '../common/market';

/**
 * DOCUMENTATION AND ACCOUNTING TEAMS ON THE DESK (Sai, 25 Oct 2026).
 *
 *   Handled by   - each deal can name who handles it in Documentation and in Accounting. Set by that
 *                  team's Team Lead (themselves or a member of their team) or by a Super Admin (anybody
 *                  active in that role). Information only: it opens nothing and closes nothing.
 *   My team      - a Team Lead's own team: each member, their requests waiting, the open deals they
 *                  handle, and the team's waiting requests.
 *   History      - what a member of the lead's team changed, from the audit trail.
 */
export type HandlerKind = 'documentation' | 'accounting';
const COLUMN: Record<HandlerKind, 'doc_handler_id' | 'acct_handler_id'> = { documentation: 'doc_handler_id', accounting: 'acct_handler_id' };
const WORD: Record<HandlerKind, string> = { documentation: 'Documentation', accounting: 'Accounting' };
const kindOf = (v: unknown): HandlerKind | null => (v === 'documentation' || v === 'accounting' ? v : null);

@Injectable()
export class DeskTeamService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** The people this person may name as handler, per team. A Super Admin: everybody active in it. */
  async options(user: AuthUserRecord): Promise<Record<HandlerKind, { id: number; name: string }[]> & { can_set: Record<HandlerKind, boolean> }> {
    const out = { documentation: [] as { id: number; name: string }[], accounting: [] as { id: number; name: string }[], can_set: { documentation: false, accounting: false } };
    for (const kind of ['documentation', 'accounting'] as HandlerKind[]) {
      const where = this.choosable(user, kind);
      if (!where) continue;
      out.can_set[kind] = true;
      out[kind] = await this.prisma.users.findMany({ where, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    }
    return out;
  }

  /** Set or clear who handles a deal in one team. */
  async setHandler(user: AuthUserRecord, txnId: number, body: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
    const kind = kindOf(body.kind);
    if (!kind) throw new UnprocessableEntityException({ message: 'Say which team: documentation or accounting.' });
    const where = this.choosable(user, kind);
    if (!where) throw new ForbiddenException({ message: `Only a Super Admin or the ${WORD[kind]} Team Lead can choose who handles a deal.` });
    const t = await this.prisma.transactions.findFirst({ where: { id: txnId, deleted_at: null, market: marketOf(user) }, select: { id: true, doc_handler_id: true, acct_handler_id: true } });
    if (!t) throw new NotFoundException({ message: 'Transaction not found.' });

    const raw = body.user_id;
    let next: { id: number; name: string } | null = null;
    if (raw !== null && raw !== '' && raw !== undefined) {
      const id = Number(raw);
      next = Number.isInteger(id) ? await this.prisma.users.findFirst({ where: { AND: [{ id }, where] }, select: { id: true, name: true } }) : null;
      if (!next) throw new UnprocessableEntityException({ message: `Choose a person from the ${WORD[kind]} team.` });
    }
    const col = COLUMN[kind];
    const before = t[col];
    if ((before ?? null) === (next?.id ?? null)) return { data: await this.handlersOf(txnId) };
    const prev = before ? await this.prisma.users.findUnique({ where: { id: before }, select: { name: true } }) : null;
    await this.prisma.transactions.update({ where: { id: txnId }, data: { [col]: next?.id ?? null } });
    await this.audit.record(txnId, { id: user.id, name: user.name }, {
      section: 'Basic Information', field: `Handled by (${WORD[kind]})`,
      old: prev?.name ?? '', new: next?.name ?? '', action: 'Updated', source: 'Manual',
    });
    return { data: await this.handlersOf(txnId) };
  }

  /** Who handles the deal, by name, for the deal page. */
  async handlersOf(txnId: number): Promise<Record<string, unknown>> {
    const t = await this.prisma.transactions.findUnique({ where: { id: txnId }, select: { doc_handler_id: true, acct_handler_id: true } });
    const ids = [t?.doc_handler_id, t?.acct_handler_id].filter((x): x is number => !!x);
    const people = ids.length ? await this.prisma.users.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const name = (id: number | null | undefined) => (id ? people.find((p) => p.id === id) ?? { id, name: '(removed user)' } : null);
    return { documentation: name(t?.doc_handler_id), accounting: name(t?.acct_handler_id) };
  }

  /** A Team Lead's own team at a glance. */
  async mine(user: AuthUserRecord): Promise<{ data: Record<string, unknown> }> {
    const lead = deskTeamLeadIdOf(user);
    if (lead === null) throw new ForbiddenException({ message: 'Only a Documentation or Accounting Team Lead has a team here.' });
    const members = await this.prisma.users.findMany({
      where: { team_lead_id: lead, role: user.role, status: 'Active' },
      select: { id: true, name: true }, orderBy: { name: 'asc' },
    });
    const ids = [lead, ...members.map((m) => m.id)];
    const col = user.role === 'accounting' ? 'acct_handler_id' : 'doc_handler_id';
    const pending = await this.prisma.transaction_edit_requests.findMany({
      where: { status: 'pending', requested_by: { in: members.map((m) => m.id) }, transactions: { deleted_at: null, market: marketOf(user) } },
      select: { id: true, transaction_id: true, scope: true, requested_by: true, requested_by_name: true, reason: true, created_at: true, transactions: { select: { trade_no: true, property: true } } },
      orderBy: { created_at: 'asc' },
    });
    const handled = await this.prisma.transactions.groupBy({
      by: [col], where: { [col]: { in: ids }, deleted_at: null, market: marketOf(user), NOT: { transaction_statuses: { some: { status: { in: ['Closed', 'Void', 'Mutual Release'] } } } } },
      _count: { _all: true },
    });
    const handledBy = new Map(handled.map((h) => [(h as Record<string, unknown>)[col] as number, h._count._all]));
    const row = (p: { id: number; name: string }, isLead: boolean) => ({
      id: p.id, name: p.name, is_lead: isLead,
      requests_waiting: pending.filter((r) => r.requested_by === p.id).length,
      open_deals_handled: handledBy.get(p.id) ?? 0,
    });
    return {
      data: {
        team: user.role === 'accounting' ? 'Accounting' : 'Documentation',
        members: [row({ id: lead, name: user.name }, true), ...members.map((m) => row(m, false))],
        waiting: pending.map((r) => ({
          id: r.id, transaction_id: r.transaction_id, trade_no: r.transactions?.trade_no ?? null, property: r.transactions?.property ?? null,
          scope: r.scope, requested_by_name: r.requested_by_name, reason: r.reason, stamp: r.created_at?.toISOString() ?? null,
        })),
      },
    };
  }

  /** What one person changed - for their Team Lead (their team, or themselves) or a Super Admin. */
  async history(user: AuthUserRecord, memberId: number): Promise<{ data: Record<string, unknown>[] }> {
    if (!isSuperAdmin(user)) {
      const lead = deskTeamLeadIdOf(user);
      const member = lead === null ? null : await this.prisma.users.findFirst({ where: { id: memberId, OR: [{ id: lead }, { team_lead_id: lead, role: user.role }] }, select: { id: true } });
      if (!member) throw new ForbiddenException({ message: 'You can see the history of your own team only.' });
    }
    const rows = await this.prisma.audit_logs.findMany({
      where: { user_id: memberId, transaction_id: { not: null }, transactions: { market: marketOf(user) } },
      select: { id: true, created_at: true, section: true, field: true, old_value: true, new_value: true, action: true, transaction_id: true, transactions: { select: { trade_no: true, property: true } } },
      orderBy: { id: 'desc' }, take: 200,
    });
    return {
      data: rows.map((r) => ({
        id: r.id, at: r.created_at?.toISOString() ?? null, section: r.section, field: r.field, action: r.action,
        old: r.old_value, new: r.new_value, transaction_id: r.transaction_id, trade_no: r.transactions?.trade_no ?? null, property: r.transactions?.property ?? null,
      })),
    };
  }

  /** Who this person may name in one team, or null when they may not set it at all. */
  private choosable(user: AuthUserRecord, kind: HandlerKind): Record<string, unknown> | null {
    if (isSuperAdmin(user)) return { role: kind, status: 'Active' };
    const lead = deskTeamLeadIdOf(user);
    if (lead === null || user.role !== kind) return null;
    return { role: kind, status: 'Active', OR: [{ id: lead }, { team_lead_id: lead }] };
  }
}
