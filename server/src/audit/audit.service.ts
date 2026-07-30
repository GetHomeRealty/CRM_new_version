import { auditDomain } from '../common/domain';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decimalCast, parseJson, toDateString } from '../common/serialize';

// Column → cast classification (mirrors the Transaction model casts) so snapshot
// values stringify exactly like Laravel's cast values.
const DEC2 = new Set([
  'price', 'deposit', 'comm_value', 'comm_amt', 'comm_adjust_before', 'comm_adjust_after',
  'listing_comm_flat', 'coop_comm_flat', 'trust_payable', 'listing_adj_before', 'listing_adj_after',
  'coop_adj_before', 'coop_adj_after', 'precon_comm_amt_manual',
]);
const DEC4 = new Set(['comm_pct', 'listing_comm_pct', 'coop_comm_pct', 'precon_comm_pct']);
const BOOLCOL = new Set([
  'comm_adjust_enabled', 'listing_adj_enabled', 'coop_adj_enabled', 'precon_net_of_hst',
  'mls_verified', 'conditional_offer', 'inter_board_enabled',
]);
const DATECOL = new Set(['offer_date', 'closing_date', 'listing_contract_date', 'listing_expiry_date']);

const US = '\x1F'; // unit separator used to key snapshot entries

interface SnapEntry {
  section: string;
  field: string;
  value: string;
}

/** The acting user (from the request), or null → "System". */
export interface ActingUser {
  id: number;
  name: string;
}

export interface AuditInput {
  section?: string | null;
  field?: string | null;
  old?: unknown;
  new?: unknown;
  action?: string;
  source?: string;
  details?: string | null;
}

/** Scalar columns → [section, label] (mirrors AuditService::SCALAR_MAP). */
export const SCALAR_MAP: Record<string, [string, string]> = {
  type: ['Basic Information', 'Transaction Type'],
  agent: ['Basic Information', 'Assigned Agent'],
  conditional_offer: ['Basic Information', 'Conditional Offer'],
  inter_board_enabled: ['Basic Information', 'Inter-Board Enabled'],
  property: ['Property Information', 'Property Address'],
  mls_type: ['Property Information', 'MLS Type'],
  mls_num: ['Property Information', 'MLS Number'],
  mls_verified: ['Property Information', 'MLS Verified'],
  offer_date: ['Dates', 'Offer Date'],
  closing_date: ['Dates', 'Closing Date'],
  listing_contract_date: ['Dates', 'Listing Contract Date'],
  listing_expiry_date: ['Dates', 'Listing Expiry Date'],
  price: ['Financial Information', 'Price'],
  deposit: ['Deposit Information', 'Deposit'],
  comm_type: ['Commission Information', 'Commission Type'],
  comm_value: ['Commission Information', 'Commission Value'],
  comm_pct: ['Commission Information', 'Commission %'],
  comm_amt: ['Commission Information', 'Commission Amount'],
  comm_adjust_enabled: ['Commission Information', 'Commission Adjustment Enabled'],
  comm_adjust_before: ['Commission Information', 'Commission Adjustment (Before HST)'],
  comm_adjust_after: ['Commission Information', 'Commission Adjustment (After HST)'],
  listing_comm_pct: ['Commission Information', 'Listing Commission %'],
  coop_comm_pct: ['Commission Information', 'Co-op Commission %'],
  listing_comm_flat: ['Commission Information', 'Listing Commission (Flat)'],
  coop_comm_flat: ['Commission Information', 'Co-op Commission (Flat)'],
  trust_payable: ['Commission Information', 'Trust Payable'],
  listing_adj_enabled: ['Commission Information', 'Listing Adjustment Enabled'],
  listing_adj_before: ['Commission Information', 'Listing Adjustment (Before HST)'],
  listing_adj_after: ['Commission Information', 'Listing Adjustment (After HST)'],
  coop_adj_enabled: ['Commission Information', 'Co-op Adjustment Enabled'],
  coop_adj_before: ['Commission Information', 'Co-op Adjustment (Before HST)'],
  coop_adj_after: ['Commission Information', 'Co-op Adjustment (After HST)'],
  comm_status: ['Commission Information', 'Commission Status'],
  comm_paid_status: ['Commission Information', 'Commission Paid Status'],
  commission_agent: ['Commission Information', 'Commission Agent'],
  precon_listing_type: ['Commission Information', 'Preconstruction Listing Type'],
  precon_term_count: ['Commission Information', 'Preconstruction Term Count'],
  precon_net_of_hst: ['Commission Information', 'Preconstruction Net of HST'],
  precon_comm_pct: ['Commission Information', 'Preconstruction Commission %'],
  precon_comm_amt_manual: ['Commission Information', 'Preconstruction Commission Amount'],
  precon_details_of_terms: ['Commission Information', 'Preconstruction Details of Terms'],
  lawyer_name: ['Legal & Documents', 'Lawyer Name'],
  lawyer_email: ['Legal & Documents', 'Lawyer Email'],
  lawyer_phone: ['Legal & Documents', 'Lawyer Phone'],
  lawyer_address: ['Legal & Documents', 'Lawyer Address'],
  valid_status: ['Legal & Documents', 'Validation Status'],
  builder_name: ['Builder Information', 'Builder Name'],
  builder_vendor: ['Builder Information', 'Builder Vendor'],
  builder_project: ['Builder Information', 'Builder Project'],
  builder_address: ['Builder Information', 'Builder Address'],
  builder_office_email: ['Builder Information', 'Builder Office Email'],
  builder_invoice_email: ['Builder Information', 'Builder Invoice Email'],
  builder_phone: ['Builder Information', 'Builder Phone'],
};

/** JSON tracking columns → [section, label-prefix] (mirrors AuditService::JSON_MAP). */
export const JSON_MAP: Record<string, [string, string]> = {
  admin_activities: ['Quick Actions', 'Admin Activities'],
  activity_tracker: ['Quick Actions', 'Activity Tracker'],
  adjustments: ['Adjustments', 'Adjustments'],
  commercial_lease: ['Financial Information', 'Commercial Lease'],
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Write a single audit entry against a transaction. Pass `db` to enlist in an
   *  interactive transaction (so it sees a just-created, uncommitted txn row). */
  async record(txnId: number, user: ActingUser | null, a: AuditInput, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    const now = new Date();
    await db.audit_logs.create({
      data: {
        transaction_id: txnId,
        // A transaction link is a Transaction Desk record by definition.
        domain: auditDomain({ transactionId: txnId }),
        who: user?.name ?? 'System',
        user_id: user?.id ?? null,
        section: a.section ?? null,
        field: a.field ?? null,
        old_value: this.clip(a.old),
        new_value: this.clip(a.new),
        action: a.action ?? 'Updated',
        source: a.source ?? 'Manual',
        details: a.details ?? null,
        created_at: now,
        updated_at: now,
      },
    });
  }

  /** Write a module-level audit entry (global Audit Trail, not tied to a transaction). */
  async logModule(user: ActingUser | null, category: string, a: AuditInput): Promise<void> {
    const now = new Date();
    await this.prisma.audit_logs.create({
      data: {
        category,
        transaction_id: null,
        // Classified by the same rules the backfill migration used, so new entries land in the same
        // trail their history did. Null when nothing applies — visible from both areas, never hidden
        // from both.
        domain: auditDomain({ category, section: a.section ?? null }),
        who: user?.name ?? 'System',
        user_id: user?.id ?? null,
        section: a.section ?? null,
        field: a.field ?? null,
        old_value: this.clip(a.old),
        new_value: this.clip(a.new),
        action: a.action ?? 'Updated',
        source: a.source ?? 'Manual',
        details: a.details ?? null,
        created_at: now,
        updated_at: now,
      },
    });
  }

  /** Reverse of SCALAR_MAP — the transaction column for an audit field label. */
  columnForLabel(label: string | null | undefined): string | null {
    if (label === null || label === undefined) return null;
    for (const [col, [, lbl]] of Object.entries(SCALAR_MAP)) {
      if (lbl === label) return col;
    }
    return null;
  }

  private clip(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const s = String(value);
    return [...s].length > 2000 ? [...s].slice(0, 2000).join('') + '…' : s;
  }

  /** Diff two snapshots and record one entry per changed field. */
  async recordChanges(
    txnId: number,
    user: ActingUser | null,
    before: Record<string, SnapEntry>,
    after: Record<string, SnapEntry>,
    source = 'Manual',
  ): Promise<void> {
    for (const change of this.diff(before, after)) {
      await this.record(txnId, user, { ...change, source });
    }
  }

  /** Flat snapshot of the whole transaction keyed by "section US field" for diffing. */
  async snapshot(txnId: number): Promise<Record<string, SnapEntry>> {
    const t = await this.prisma.transactions.findUnique({
      where: { id: txnId },
      include: {
        clients: { orderBy: { position: 'asc' } },
        conditions: { orderBy: { position: 'asc' } },
        team_members: { orderBy: { position: 'asc' } },
        brokerages: { include: { brokerage_agents: { orderBy: { position: 'asc' } } } },
        transaction_statuses: { orderBy: { status: 'asc' } },
        inter_board_listings: { orderBy: { position: 'asc' } },
        precon_terms: { orderBy: { term_no: 'asc' } },
      },
    });
    if (!t) return {};

    const out: Record<string, SnapEntry> = {};
    const add = (section: string, field: string, value: string): void => {
      out[section + US + field] = { section, field, value };
    };
    const row = t as unknown as Record<string, unknown>;

    for (const [col, [section, label]] of Object.entries(SCALAR_MAP)) {
      add(section, label, this.snapCol(col, row[col]));
    }

    for (const [col, [section, prefix]] of Object.entries(JSON_MAP)) {
      const flat: Record<string, unknown> = {};
      this.flatten(prefix, parseJson(row[col] as string | null), flat);
      for (const [field, value] of Object.entries(flat)) add(section, field, this.stringify(value));
    }

    t.clients.forEach((c, i) => {
      const n = i + 1;
      add('Client Information', `Client #${n} Name`, this.stringify(c.name));
      add('Client Information', `Client #${n} Email`, this.stringify(c.email));
      add('Client Information', `Client #${n} Phone`, this.stringify(c.phone));
    });

    t.conditions.forEach((c, i) => {
      const n = i + 1;
      const name = c.custom_name || c.type;
      add('Conditions', `Condition #${n} Name`, this.stringify(name));
      add('Conditions', `Condition #${n} Deadline`, toDateString(c.deadline) ?? '');
      add('Conditions', `Condition #${n} Status`, this.stringify(c.status));
    });

    t.team_members.forEach((m, i) => {
      const n = i + 1;
      add('Commission Information', `Team Member #${n} Name`, this.stringify(m.name));
      add('Commission Information', `Team Member #${n} Split %`, decimalCast(m.split, 4) ?? '');
      add('Commission Information', `Team Member #${n} Agent %`, decimalCast(m.agent_pct, 4) ?? '');
      add('Commission Information', `Team Member #${n} Brokerage %`, decimalCast(m.brok_pct, 4) ?? '');
      add('Commission Information', `Team Member #${n} Scope`, this.stringify(m.scope));
    });

    t.precon_terms.forEach((term) => {
      add('Commission Information', `Term ${term.term_no} %`, term.pct === null ? '' : decimalCast(term.pct, 4) ?? '');
      add('Commission Information', `Term ${term.term_no} Closing Date`, toDateString(term.closing_date) ?? '');
    });

    if (t.brokerages) {
      const b = t.brokerages;
      add('Contacts', 'Brokerage Name', this.stringify(b.name));
      add('Contacts', 'Brokerage Address', this.stringify(b.address));
      add('Contacts', 'Brokerage Email', this.stringify(b.email));
      add('Contacts', 'Brokerage Invoice Email', this.stringify(b.invoice_email));
      add('Contacts', 'Brokerage Agent Email', this.stringify(b.agent_email));
      add('Contacts', 'Brokerage Phone', this.stringify(b.phone));
      add('Contacts', 'Listing Agent Name(s)', b.brokerage_agents.map((a) => a.name).filter(Boolean).join(', '));
    }

    t.inter_board_listings.forEach((ib, i) => {
      const n = i + 1;
      add('Property Information', `Inter-Board #${n} Name`, this.stringify(ib.name));
      add('Property Information', `Inter-Board #${n} Board`, this.stringify(ib.board_id));
      add('Property Information', `Inter-Board #${n} Verified`, ib.verified ? 'Yes' : 'No');
    });

    add('Status', 'Status', t.transaction_statuses.map((s) => s.status).join(', '));
    return out;
  }

  private diff(before: Record<string, SnapEntry>, after: Record<string, SnapEntry>): {
    section: string; field: string; action: string; old: string; new: string;
  }[] {
    const changes: { section: string; field: string; action: string; old: string; new: string }[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const oldV = before[key]?.value ?? '';
      const newV = after[key]?.value ?? '';
      if (oldV === newV) continue;
      const meta = after[key] ?? before[key];
      const action = oldV === '' ? 'Added' : newV === '' ? 'Removed' : 'Updated';
      changes.push({ section: meta.section, field: meta.field, action, old: oldV, new: newV });
    }
    return changes;
  }

  /** Cast-aware stringify for a scalar transaction column. */
  private snapCol(col: string, raw: unknown): string {
    if (raw === null || raw === undefined) return '';
    if (DEC2.has(col)) return decimalCast(raw as number, 2) ?? '';
    if (DEC4.has(col)) return decimalCast(raw as number, 4) ?? '';
    if (BOOLCOL.has(col)) return raw ? 'Yes' : 'No';
    if (DATECOL.has(col)) return toDateString(raw as Date) ?? '';
    return String(raw);
  }

  /** General stringify for JSON leaves / collection values (mirrors AuditService::stringify). */
  private stringify(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (value instanceof Date) return toDateString(value) ?? '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /** Recursively flatten a JSON value into "Prefix › key" / "Prefix #n" leaves. */
  private flatten(prefix: string, value: unknown, out: Record<string, unknown>): void {
    if (value !== null && typeof value === 'object') {
      const entries: [string, unknown][] = Array.isArray(value)
        ? value.map((v, i) => [String(i), v] as [string, unknown])
        : Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return; // PHP $value === []
      for (const [k, v] of entries) {
        // PHP coerces canonical integer-string object keys to int → "#n"; else "› Humanized".
        const isInt = /^(0|[1-9][0-9]*)$/.test(k);
        const label = isInt ? `${prefix} #${Number(k) + 1}` : `${prefix} › ${this.humanize(k)}`;
        this.flatten(label, v, out);
      }
      return;
    }
    if (value === null || value === '') return;
    out[prefix] = value;
  }

  private humanize(key: string): string {
    return key.replace(/[_-]/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  }
}
