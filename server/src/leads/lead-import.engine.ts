import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The CSV lead import, done in batches against an index.
 *
 * WHAT WAS WRONG. The previous implementation — duplicated, and already diverged, between
 * `leads.service.ts` and `campaigns.service.ts` — did this per row of the uploaded file:
 *
 *     await prisma.leads.findFirst({ where: { email: { equals: e, mode: 'insensitive' } } })
 *
 * Prisma renders `mode: 'insensitive'` as `ILIKE`, and ILIKE cannot use the functional index this
 * schema already carries (`leads_email_lower_key ON lower(email)`). EXPLAIN confirmed a sequential
 * scan. Measured against absent addresses — which is the normal case when importing new leads, and
 * the case with no early exit — the cost is linear in the lead table:
 *
 *     leads    ILIKE per row     lower(email)= (indexed)
 *     5,000        3.84 ms              0.340 ms
 *    20,000       13.64 ms              0.355 ms
 *    40,000       26.34 ms              0.344 ms      ← 77× slower
 *
 * The indexed form is FLAT. Since the loop is also linear in the file, total cost was the product
 * of the two: a 5,000-row file against 40,000 leads spent ~132 seconds in lookups alone.
 *
 * WHAT THIS DOES INSTEAD. One `lower(email) IN (...)` per BATCH rather than one ILIKE per row, so
 * a batch of 500 costs a single indexed query instead of 500 scans. New rows go in with
 * `createMany`. Each batch is one transaction, so a failure rolls back that batch and no other —
 * whole-file transactions were rejected deliberately: 50,000 rows in one transaction holds locks
 * for minutes and blocks everything else writing to `leads`.
 *
 * DELIBERATELY NOT A NestJS-SCOPED SERVICE OVER THE WHOLE FILE. It exposes `runBatch`, so the
 * caller owns the loop and can record progress between batches. That is what makes
 * "2,500 of 5,000" possible without this file knowing anything about jobs.
 */

export const IMPORT_BATCH_SIZE = 500;

/** Anything that looks like an address. Deliberately loose — the mail provider is the real judge. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ImportRow { [key: string]: string }

export interface ImportTally {
  imported: number;
  tagged: number;
  duplicate: number;
  invalid: number;
}

export const emptyTally = (): ImportTally => ({ imported: 0, tagged: 0, duplicate: 0, invalid: 0 });

export interface ImportContext {
  tag: string;
  userName: string | null;
  userId: number | null;
}

const parseJsonArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();

@Injectable()
export class LeadImportEngine {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Split a CSV into rows keyed by normalised header.
   *
   * Headers are lowercased with non-alphanumerics stripped, so "Lead Source", "lead_source" and
   * "LeadSource" all reach the same field — the three spellings a spreadsheet exported from three
   * different CRMs will actually contain.
   */
  parseCsv(csv: string): ImportRow[] {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length);
    if (lines.length < 2) return [];

    const headers = this.splitLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const rows: ImportRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = this.splitLine(lines[i]);
      const row: ImportRow = {};
      headers.forEach((h, idx) => { if (h) row[h] = cells[idx] ?? ''; });
      rows.push(row);
    }
    return rows;
  }

  /**
   * Run a batch's writes atomically, opening a transaction only if we are not already inside one.
   *
   * Prisma's transaction client has no `$transaction` of its own — transactions do not nest — so an
   * engine that unconditionally opened one could never be called from inside a caller's
   * transaction. That is not a hypothetical: it is how the tests roll their changes back, and it
   * would equally block ever composing an import into a larger unit of work.
   *
   * When we are already inside a transaction the caller owns the boundary and the batch is atomic
   * for free, which is exactly the guarantee we wanted.
   */
  private async inTransaction<T>(fn: (tx: PrismaService) => Promise<T>): Promise<T> {
    const client = this.prisma as unknown as { $transaction?: (f: (tx: PrismaService) => Promise<T>) => Promise<T> };
    if (typeof client.$transaction !== 'function') return fn(this.prisma);
    return client.$transaction(fn);
  }

  /** Comma-separated with double-quote escaping — enough for what spreadsheets export. */
  private splitLine(line: string): string[] {
    const out: string[] = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  /**
   * Import one batch. Returns what changed; the caller accumulates and records progress.
   *
   * `seen` carries addresses already handled by EARLIER batches of the same file, so a duplicate
   * spanning a batch boundary is still caught — the previous code kept that set only in
   * `leads.service`, and `campaigns.service` had no in-file de-duplication at all, which is how
   * the same file imported cleanly through one screen and created duplicates through the other.
   */
  async runBatch(rows: ImportRow[], ctx: ImportContext, seen: Set<string>): Promise<ImportTally> {
    const tally = emptyTally();

    // ---- 1. shape and de-duplicate within the file, before touching the database ---------------
    const candidates: { email: string; key: string; row: ImportRow }[] = [];
    for (const row of rows) {
      const email = str(row.email ?? row.emailaddress ?? row.email_address);
      if (!EMAIL_SHAPE.test(email)) { tally.invalid++; continue; }
      const key = email.toLowerCase();
      if (seen.has(key)) { tally.duplicate++; continue; }
      seen.add(key);
      candidates.push({ email, key, row });
    }
    if (!candidates.length) return tally;

    // ---- 2. ONE indexed lookup for the whole batch --------------------------------------------
    // Raw SQL because Prisma cannot express `lower(email) IN (...)`; its `mode: 'insensitive'`
    // compiles to ILIKE, which is exactly what could not use the index. Parameterised, so the
    // addresses are values and never concatenated into the statement.
    const keys = candidates.map((c) => c.key);
    const existing = await this.prisma.$queryRaw<{ id: number; email: string; tags: string | null }[]>`
      SELECT id, email, tags FROM leads WHERE lower(email) IN (${Prisma.join(keys)})
    `;
    const byKey = new Map(existing.map((e) => [String(e.email).toLowerCase(), e]));

    // ---- 3. decide, then write once ------------------------------------------------------------
    const now = new Date();
    const toCreate: Prisma.leadsCreateManyInput[] = [];
    const toTag: { id: number; tags: string }[] = [];

    for (const c of candidates) {
      const hit = byKey.get(c.key);
      if (hit) {
        tally.duplicate++;
        if (ctx.tag) {
          const tags = parseJsonArray(hit.tags);
          if (!tags.includes(ctx.tag)) toTag.push({ id: hit.id, tags: JSON.stringify([...tags, ctx.tag]) });
        }
        continue;
      }
      const pick = (...names: string[]): string | null => {
        for (const n of names) { const v = str(c.row[n]); if (v) return v; }
        return null;
      };
      toCreate.push({
        name: pick('name', 'fullname', 'firstname', 'leadname') ?? c.email.split('@')[0],
        email: c.email,
        phone: pick('phone', 'phonenumber', 'mobile', 'contact'),
        lead_status: pick('leadstatus', 'status'),
        lead_type: pick('leadtype', 'type'),
        lead_source: pick('leadsource', 'source'),
        client_type: pick('clienttype'),
        tags: JSON.stringify(ctx.tag ? [ctx.tag] : []),
        created_by: ctx.userName,
        owner_user_id: ctx.userId,
        created_at: now,
        updated_at: now,
      });
    }

    // One transaction PER BATCH. A whole-file transaction would hold locks on `leads` for the
    // duration of a 50,000-row import and block every agent working at the same time; per batch,
    // a failure loses at most this batch and the job records where it stopped.
    await this.inTransaction(async (tx) => {
      if (toCreate.length) {
        // skipDuplicates covers the race where the same address is created between the lookup
        // above and this write — by a concurrent import, or by an agent adding the lead by hand.
        const created = await tx.leads.createMany({ data: toCreate, skipDuplicates: true });
        tally.imported += created.count;
        // Anything skipped was created by someone else in the gap; count it as a duplicate rather
        // than silently losing it from the totals.
        tally.duplicate += toCreate.length - created.count;
      }
      for (const t of toTag) {
        await tx.leads.update({ where: { id: t.id }, data: { tags: t.tags, updated_at: now } });
        tally.tagged++;
      }
    });

    return tally;
  }
}
