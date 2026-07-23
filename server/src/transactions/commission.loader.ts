import type { Prisma, PrismaClient } from '@prisma/client';
import { parseJson } from '../common/serialize';
import type { CommissionTxn } from './commission.types';

/** Prisma include that loads the relations the commission math needs. */
export const commissionInclude = {
  team_members: { include: { team_member_terms: true }, orderBy: { position: 'asc' } },
  precon_terms: { orderBy: { term_no: 'asc' } },
} satisfies Prisma.transactionsInclude;

type TeamMemberWithTerms = Prisma.team_membersGetPayload<{ include: { team_member_terms: true } }>;

/**
 * A transaction with the commission relations optionally loaded. summarize() only
 * reads scalar fields, so the list endpoint (which doesn't eager-load teamMembers)
 * can normalize too; breakdown() needs the relations and the show endpoint loads them.
 */
type TxnWithCommission = Prisma.transactionsGetPayload<object> & {
  team_members?: TeamMemberWithTerms[];
  precon_terms?: Prisma.precon_termsGetPayload<object>[];
};

const num = (d: Prisma.Decimal | number | null): number => (d === null ? 0 : Number(d));
const numN = (d: Prisma.Decimal | number | null): number | null => (d === null ? null : Number(d));

/** Convert a loaded transaction row (Decimals + relations) into CommissionTxn. */
export function normalizeCommissionTxn(t: TxnWithCommission): CommissionTxn {
  return {
    type: t.type,
    price: num(t.price),
    deposit: num(t.deposit),
    comm_type: t.comm_type,
    comm_value: num(t.comm_value),
    comm_pct: numN(t.comm_pct),
    comm_amt: numN(t.comm_amt),
    comm_adjust_enabled: t.comm_adjust_enabled,
    comm_adjust_before: num(t.comm_adjust_before),
    comm_adjust_after: num(t.comm_adjust_after),
    listing_comm_pct: numN(t.listing_comm_pct),
    coop_comm_pct: numN(t.coop_comm_pct),
    listing_comm_flat: numN(t.listing_comm_flat),
    coop_comm_flat: numN(t.coop_comm_flat),
    listing_adj_enabled: t.listing_adj_enabled,
    listing_adj_before: num(t.listing_adj_before),
    listing_adj_after: num(t.listing_adj_after),
    coop_adj_enabled: t.coop_adj_enabled,
    coop_adj_before: num(t.coop_adj_before),
    coop_adj_after: num(t.coop_adj_after),
    precon_net_of_hst: t.precon_net_of_hst,
    precon_comm_pct: numN(t.precon_comm_pct),
    precon_comm_amt_manual: numN(t.precon_comm_amt_manual),
    precon_term_count: t.precon_term_count,
    comm_paid_status: t.comm_paid_status,
    comm_status: t.comm_status,
    agent: t.agent,
    adjustments: parseJson<Record<string, unknown>>(t.adjustments),
    teamMembers: (t.team_members ?? []).map((m) => ({
      name: m.name,
      split: num(m.split),
      agent_pct: num(m.agent_pct),
      brok_pct: num(m.brok_pct),
      scope: m.scope,
      terms: m.team_member_terms.map((x) => x.term_no),
    })),
    preconTerms: (t.precon_terms ?? []).map((p) => ({ term_no: p.term_no, pct: numN(p.pct), closing_date: p.closing_date })),
  };
}

/** Load + normalize a transaction for the commission math. */
export async function loadCommissionTxn(prisma: PrismaClient, id: number): Promise<CommissionTxn | null> {
  const t = await prisma.transactions.findUnique({ where: { id }, include: commissionInclude });
  return t ? normalizeCommissionTxn(t) : null;
}
