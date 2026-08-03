import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CLIENT_TYPE, IMPORT_FIELD_LIMITS, LEAD_SOURCE, LEAD_STATUS, LEAD_TYPE } from './lead.constants';

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
  /** Super-admins also own unattributed intake, exactly as the Leads module has it. */
  userIsSuperAdmin?: boolean;
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
    /*
     * Scoped to the importer's own book, because that is what uniqueness now means.
     *
     * `leads_company_owner_email_key` is UNIQUE on `(company_id, COALESCE(owner_user_id, 0),
     * lower(email))`, not on the address alone: the same person may be a lead of another brokerage,
     * and of another agent in this one, because they can arrive through anybody's ad, campaign or
     * referral. This lookup used to ask "does this address exist ANYWHERE", which under the old
     * global index was also the question that decided whether the row could be created — so an
     * agent importing a list that overlapped a colleague's was told "already existed" for leads
     * they had never had, and the rows were never created for them at all.
     *
     * SCOPED TO THE LEADS THIS PERSON ALREADY WORKS, which is wider than "rows they own". A lead
     * somebody else owns but has ASSIGNED to them is theirs to work — that is the Leads module's
     * rule everywhere else — and creating a second copy of it would split one person's history
     * across two records, the exact harm the constraint exists to prevent. So the SQL matches the
     * same set `mine()` does, rather than the narrower set the unique index alone would imply.
     *
     * `IS NOT DISTINCT FROM` rather than `=` so a null importer matches null rows; SQL equality
     * treats NULL as unknown and would match nothing.
     *
     * Raw SQL because Prisma cannot express `lower(email) IN (...)`; its `mode: 'insensitive'`
     * compiles to ILIKE, which cannot use the index. Parameterised, so the addresses are values and
     * never concatenated into the statement.
     */
    const keys = candidates.map((c) => c.key);
    const userId = ctx.userId;
    // Unattributed intake belongs to the top tier, so a super-admin's import must see it here or it
    // would create a duplicate of the very rows it is meant to recognise.
    const claimsUnowned = ctx.userIsSuperAdmin === true || userId == null;
    const existing = await this.prisma.$queryRaw<
      { id: number; email: string; tags: string | null; owner_user_id: number | null; assigned_to: number | null }[]
    >`
      SELECT id, email, tags, owner_user_id, assigned_to
        FROM leads
       WHERE lower(email) IN (${Prisma.join(keys)})
         AND (
              owner_user_id IS NOT DISTINCT FROM ${userId}
           OR assigned_to   IS NOT DISTINCT FROM ${userId}
           OR (${claimsUnowned} AND owner_user_id IS NULL)
         )
    `;

    /**
     * Whose lead is it?
     *
     * The SQL above already restricts the rows to this set; this restates it in TypeScript so the
     * tagging decision is legible at the point it is made, and so the two can be compared when one
     * of them is changed.
     */
    const mine = (e: { owner_user_id: number | null; assigned_to: number | null }): boolean => {
      if (ctx.userId == null) return e.owner_user_id === null;
      if (e.owner_user_id === ctx.userId || e.assigned_to === ctx.userId) return true;
      // Matches the Leads module: unattributed intake belongs to the top tier.
      return ctx.userIsSuperAdmin === true && e.owner_user_id === null;
    };

    const byKey = new Map(existing.map((e) => [String(e.email).toLowerCase(), e]));

    // ---- 3. decide, then write once ------------------------------------------------------------
    const now = new Date();
    const toCreate: Prisma.leadsCreateManyInput[] = [];
    const toTag: { id: number; tags: string }[] = [];

    for (const c of candidates) {
      const hit = byKey.get(c.key);
      if (hit) {
        tally.duplicate++;
        // Only tag it if it is actually this user's lead. Someone else's is left alone.
        if (ctx.tag && mine(hit)) {
          const tags = parseJsonArray(hit.tags);
          if (!tags.includes(ctx.tag)) toTag.push({ id: hit.id, tags: JSON.stringify([...tags, ctx.tag]) });
        }
        continue;
      }
      const pick = (...names: string[]): string | null => {
        for (const n of names) { const v = str(c.row[n]); if (v) return v; }
        return null;
      };
      /*
       * Fit the value to the column before `createMany` sees it.
       *
       * Postgres raises on the first over-length value and takes the whole batch with it — and it
       * does not name the column ("Column: (not available)"), so the operator was told a 500-row
       * batch failed and never which cell caused it. A spreadsheet with one 300-character name
       * therefore discarded 499 perfectly good leads. Truncating is the right trade here: the file
       * is somebody's existing contact list, and losing the tail of one name is recoverable in a
       * way that losing the batch is not.
       */
      const fit = (field: keyof typeof IMPORT_FIELD_LIMITS, value: string | null): string | null =>
        (value === null ? null : value.slice(0, IMPORT_FIELD_LIMITS[field]));

      /*
       * Vocabularies, matched the way the rest of the module matches them.
       *
       * These columns feed the filter dropdowns and the campaign audience builder, both of which
       * compare against a fixed list. The import wrote whatever the spreadsheet said, so a file
       * with "Hot Lead" in the status column produced leads that no filter and no campaign segment
       * could ever select — present in the database, invisible to every screen that matters.
       * A recognised value (in any casing) is normalised; anything else is left empty, which is
       * what the field means when nobody has said.
       */
      const vocab = (value: string | null, allowed: readonly string[]): string | null => {
        if (!value) return null;
        const hit = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
        return hit ?? null;
      };

      toCreate.push({
        name: fit('name', pick('name', 'fullname', 'firstname', 'leadname')) ?? c.email.split('@')[0].slice(0, 255),
        email: c.email,
        phone: fit('phone', pick('phone', 'phonenumber', 'mobile', 'contact')),
        lead_status: vocab(pick('leadstatus', 'status'), LEAD_STATUS),
        lead_type: vocab(pick('leadtype', 'type'), LEAD_TYPE),
        lead_source: vocab(pick('leadsource', 'source'), LEAD_SOURCE),
        client_type: vocab(pick('clienttype'), CLIENT_TYPE),
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
        // skipDuplicates covers the race where the same address lands in the SAME BOOK between the
        // lookup above and this write — a concurrent import by the same person, or them adding the
        // lead by hand in another tab. It resolves against `leads_company_owner_email_key`, so a
        // colleague or another brokerage creating the same address in the meantime is not a
        // conflict and does not suppress this row.
        const created = await tx.leads.createMany({ data: toCreate, skipDuplicates: true });
        tally.imported += created.count;
        // Anything skipped was created by someone else in the gap; count it as a duplicate rather
        // than silently losing it from the totals.
        tally.duplicate += toCreate.length - created.count;
      }
      // Tagging is grouped, not looped.
      //
      // This was one UPDATE per lead, awaited in turn — so a file whose addresses already exist,
      // imported with a tag, paid a round trip per row while brand-new rows went in with a single
      // `createMany`. Measured on this database: 4,454 rows/s creating, 704 rows/s tagging, a 6.3×
      // gap on the exact operation a brokerage repeats most — re-uploading a list to tag it.
      //
      // Grouping works because the NEW tag string is a function of the OLD one, and leads share
      // their tags: everything previously untagged becomes `["Spring Campaign"]` together. So a
      // batch of 500 collapses to as many statements as there are distinct tag sets, which is
      // typically one or two. In the worst case — every lead carrying a different set — it is no
      // worse than the loop it replaces.
      const byTags = new Map<string, number[]>();
      for (const t of toTag) {
        const ids = byTags.get(t.tags);
        if (ids) ids.push(t.id);
        else byTags.set(t.tags, [t.id]);
      }
      for (const [tags, ids] of byTags) {
        const done = await tx.leads.updateMany({ where: { id: { in: ids } }, data: { tags, updated_at: now } });
        tally.tagged += done.count;
      }
    });

    return tally;
  }
}
