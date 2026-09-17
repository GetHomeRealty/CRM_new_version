import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentCacheService } from '../transactions/payment-cache.service';

export interface RenameResult {
  /** Deals that carried an older spelling and were (or, on a dry run, would be) brought up to date. */
  deals: number;
  agentRows: number;
  teamRows: number;
  adminKeys: number;
  commissionAgent: number;
  /** Deal ids and the reason, where something was deliberately left alone. */
  skipped: string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** An Admin Activities entry holding nothing but the defaults the screen writes on open. */
function blankEntry(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  const e = obj(v);
  if (arr(e.payments).length > 0) return false;
  const defaultCta = (c: unknown): boolean => { const x = obj(c); return x.cta === 'No' && !x.date && !x.batch_no; };
  if (!arr(e.cta).every(defaultCta)) return false;
  const inv = e.invoice_received;
  if (inv !== undefined && inv !== null && inv !== '' && inv !== 'N/A') return false;
  return Object.keys(e).every((k) => k === 'payments' || k === 'cta' || k === 'invoice_received');
}

/**
 * TD-190 - A RENAMED USER'S DEALS CARRY THE NEW NAME.
 *
 * Measured 2026-09-16: renaming an agent ('Sai Ramesh Gollu' -> 'Ramesh Gollu', and a change of
 * capital letters for others) left every figure on their dashboard at $0.00. The deals were linked
 * to the account by id, but the dashboard, the reports and the Admin Activities payouts all read
 * the agent by NAME - and the deals still spelled the old one.
 *
 * Teaching every reader to use the id is the long road; this is the other half, and it is needed
 * either way: when the account's name changes, the name written on the deals LINKED TO THAT
 * ACCOUNT changes with it. The main agent, the team rows, the Admin Activities entries (deal-level
 * and per precon term) and the precon commission agent.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH:
 *  - a deal that merely spells the same name but is not linked to this account. Two people can
 *    share a name; the link is the only proof of who a row is.
 *  - history: audit rows, sent-mail logs, notifications, reminders already filed. They record what
 *    was true when they were written.
 *  - an Admin Activities entry under the NEW name that already holds real payments, beside one
 *    under the old name that also does. Merging two payout histories is a decision for a person;
 *    both are left and the deal is reported.
 *
 * Idempotent: a deal already carrying the account's name is not written. So the same call is the
 * backfill for accounts renamed before this existed.
 */
@Injectable()
export class UserRenameService {
  private readonly log = new Logger(UserRenameService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentCache: PaymentCacheService,
  ) {}

  async syncNameToDeals(userId: number, opts: { dryRun?: boolean } = {}): Promise<RenameResult> {
    const out: RenameResult = { deals: 0, agentRows: 0, teamRows: 0, adminKeys: 0, commissionAgent: 0, skipped: [] };
    const user = await this.prisma.users.findUnique({ where: { id: userId }, select: { name: true } });
    const name = user?.name ?? '';
    if (!name.trim()) return out;

    const deals = await this.prisma.transactions.findMany({
      where: { OR: [{ agent_user_id: userId }, { team_members: { some: { user_id: userId } } }] },
      select: {
        id: true, agent: true, agent_user_id: true, commission_agent: true, admin_activities: true,
        team_members: { where: { user_id: userId }, select: { id: true, name: true } },
      },
      orderBy: { id: 'asc' },
    });

    const changed: number[] = [];
    for (const d of deals) {
      const old = new Set<string>();
      const agentStale = d.agent_user_id === userId && (d.agent ?? '') !== name;
      if (agentStale && d.agent) old.add(d.agent);
      const staleMembers = d.team_members.filter((m) => m.name !== name);
      for (const m of staleMembers) old.add(m.name);
      if (!agentStale && old.size === 0) continue;

      const commissionStale = !!d.commission_agent && old.has(d.commission_agent);

      let admin: string | null = d.admin_activities;
      let keys = 0;
      if (d.admin_activities) {
        let parsed: unknown = null;
        try { parsed = JSON.parse(d.admin_activities); } catch { parsed = null; }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const a = parsed as Json;
          const conflicts: string[] = [];
          const rekey = (bucket: Json): Json => {
            let next = bucket;
            for (const o of old) {
              if (!Object.prototype.hasOwnProperty.call(next, o)) continue;
              const hasNew = Object.prototype.hasOwnProperty.call(next, name);
              if (hasNew && !blankEntry(next[name]) && !blankEntry(next[o])) { conflicts.push(o); continue; }
              const keepOld = !hasNew || blankEntry(next[name]) ? next[o] : next[name];
              // Rebuilt rather than mutated so the entry keeps its place in the list.
              const rebuilt: Json = {};
              for (const [k, v] of Object.entries(next)) {
                if (k === o) rebuilt[name] = keepOld;
                else if (k !== name) rebuilt[k] = v;
              }
              next = rebuilt;
              keys += 1;
            }
            return next;
          };
          if (a.agents && typeof a.agents === 'object') a.agents = rekey(obj(a.agents));
          if (a.term_admin && typeof a.term_admin === 'object') {
            for (const [k, term] of Object.entries(obj(a.term_admin))) {
              const t = obj(term);
              if (t.agents && typeof t.agents === 'object') (a.term_admin as Json)[k] = { ...t, agents: rekey(obj(t.agents)) };
            }
          }
          if (conflicts.length) out.skipped.push(`deal ${d.id}: Admin Activities has entries under both "${conflicts.join('", "')}" and "${name}" - left for a person to merge`);
          if (keys > 0) admin = JSON.stringify(a);
        } else {
          out.skipped.push(`deal ${d.id}: Admin Activities unreadable - its entries were not renamed`);
        }
      }

      out.deals += 1;
      if (agentStale) out.agentRows += 1;
      out.teamRows += staleMembers.length;
      out.adminKeys += keys;
      if (commissionStale) out.commissionAgent += 1;
      if (opts.dryRun) continue;

      const now = new Date();
      const wrote = await this.prisma.$transaction(async (tx) => {
        // Written only if Admin Activities is still what was read, so a save made in between is
        // never overwritten with the older copy.
        const hit = await tx.transactions.updateMany({
          where: { id: d.id, admin_activities: d.admin_activities },
          data: {
            ...(agentStale ? { agent: name } : {}),
            ...(commissionStale ? { commission_agent: name } : {}),
            ...(keys > 0 ? { admin_activities: admin } : {}),
            updated_at: now,
          },
        });
        if (hit.count !== 1) return false;
        if (staleMembers.length) {
          await tx.team_members.updateMany({ where: { id: { in: staleMembers.map((m) => m.id) } }, data: { name, updated_at: now } });
        }
        return true;
      });
      if (wrote) changed.push(d.id);
      else out.skipped.push(`deal ${d.id}: changed while this ran - left as it was, the next rename or backfill picks it up`);
    }

    if (changed.length) {
      try {
        await this.paymentCache.recompute(changed);
      } catch (e) {
        this.log.warn(`name carried onto ${changed.length} deals but the report figures did not refresh: ${(e as Error).message}`);
      }
    }
    return out;
  }
}
