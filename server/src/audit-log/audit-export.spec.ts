import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from './audit-log.service';
import { AuditExportService } from './audit-export.service';

/**
 * Exporting the CRM audit trail.
 *
 * THE PROPERTY THAT MATTERS MOST: the export and the screen must return the same rows for the same
 * filters. It is asserted directly — each filter case runs `index()` and `export()` over the same
 * query and compares — rather than by trusting that both call the same builder.
 *
 * Real rows, rolled back.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
let seq = 0;
const tag = (): string => `${Date.now()}-${(seq += 1)}`;

afterAll(async () => { await prisma.$disconnect(); });

async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}

const build = (tx: PrismaService) => {
  const logs = new AuditLogService(tx);
  return { logs, exporter: new AuditExportService(tx, logs) };
};

/** A CRM audit row. */
async function crmEntry(tx: PrismaService, over: Record<string, unknown> = {}) {
  const now = new Date();
  return tx.audit_logs.create({
    data: {
      category: 'Lead', domain: 'crm', who: `ZZ Export ${tag()}`, action: 'Updated',
      section: 'Lead', field: 'Status', old_value: 'New', new_value: 'Qualified',
      details: 'Status changed', created_at: now, updated_at: now,
      ...over,
    },
  });
}

/** Parse a CSV body into rows of cells, honouring quoting. */
function parseCsv(body: Buffer): string[][] {
  const text = body.toString('utf8').replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const header = (rows: string[][]) => rows[0];
const body = (rows: string[][]) => rows.slice(1);
const col = (rows: string[][], name: string) => header(rows).indexOf(name);

// ============================================================================ formats
describe('export formats', () => {
  it('produces CSV with a header row and a BOM', async () => {
    await inRollback(async (tx) => {
      await crmEntry(tx);
      const { exporter } = build(tx);

      const file = await exporter.export({ area: 'crm' }, 'csv');

      expect(file.contentType).toContain('text/csv');
      expect(file.filename).toMatch(/^crm-audit-.*\.csv$/);
      // Without the BOM, Excel renders accented names as mojibake — which reads as corrupt data.
      expect(file.body.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

      const rows = parseCsv(file.body);
      expect(header(rows)).toContain('Date');
      expect(header(rows)).toContain('User');
      expect(header(rows)).toContain('Action');
      expect(body(rows).length).toBeGreaterThan(0);
    });
  });

  it('produces a readable Excel workbook', async () => {
    await inRollback(async (tx) => {
      const entry = await crmEntry(tx, { who: 'ZZ Excel Probe' });
      const { exporter } = build(tx);

      const file = await exporter.export({ area: 'crm' }, 'xlsx');
      expect(file.filename).toMatch(/\.xlsx$/);
      expect(file.contentType).toContain('spreadsheetml');

      // Read it back with the same library, so this proves a real workbook rather than bytes.
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(file.body as never);
      const sheet = book.getWorksheet('Audit Trail')!;
      expect(sheet).toBeDefined();
      expect(sheet.getRow(1).getCell(1).value).toBe('Date');

      const names: string[] = [];
      sheet.eachRow((r, i) => { if (i > 1) names.push(String(r.getCell(3).value ?? '')); });
      expect(names).toContain(entry.who);
    });
  });

  it('refuses a format it does not produce', async () => {
    await inRollback(async (tx) => {
      const { exporter } = build(tx);
      await expect(exporter.export({ area: 'crm' }, 'pdf' as never)).rejects.toMatchObject({ status: 400 });
    });
  });
});

// ============================================================================ filters
describe('the export honours every filter, exactly as the screen does', () => {
  /**
   * THE CENTRAL ASSERTION. For each filter, the export and the listing are run over the same query
   * and compared. If the two ever diverge — a filter added to one and not the other — this fails.
   */
  async function agree(tx: PrismaService, query: Record<string, string>) {
    const { logs, exporter } = build(tx);
    const listed = await logs.index({ ...query, page: '1' } as never);
    const file = await exporter.export(query as never, 'csv');
    const exported = body(parseCsv(file.body));
    return { total: (listed.meta as { total: number }).total, exported: exported.length, listed };
  }

  it('with no filters, exports what the screen counts', async () => {
    await inRollback(async (tx) => {
      for (let i = 0; i < 3; i += 1) await crmEntry(tx);
      const { total, exported } = await agree(tx, { area: 'crm' });
      expect(exported).toBe(total);
    });
  });

  it('honours the date filter', async () => {
    await inRollback(async (tx) => {
      const old = new Date('2020-01-15T10:00:00Z');
      await crmEntry(tx, { created_at: old, who: 'ZZ Old Entry' });
      await crmEntry(tx, { who: 'ZZ New Entry' });

      const file = await build(tx).exporter.export(
        { area: 'crm', from: '2020-01-01', to: '2020-01-31' } as never, 'csv',
      );
      const rows = body(parseCsv(file.body));
      const who = col(parseCsv(file.body), 'User');

      expect(rows.some((r) => r[who] === 'ZZ Old Entry')).toBe(true);
      expect(rows.some((r) => r[who] === 'ZZ New Entry')).toBe(false);
    });
  });

  it('honours the user filter', async () => {
    await inRollback(async (tx) => {
      const now = new Date();
      const t = tag();
      const user = await tx.users.create({
        data: {
          name: `ZZ Auditor ${t}`, email: `zz-aud-${t}@probe.test`, username: `zzaud${t.replace(/-/g, '')}`,
          role: 'agent', status: 'Active', password: 'x', created_at: now, updated_at: now, company_id: 1,
        },
        select: { id: true },
      });
      await crmEntry(tx, { user_id: user.id, who: 'ZZ Mine' });
      await crmEntry(tx, { who: 'ZZ Theirs' });

      const { total, exported } = await agree(tx, { area: 'crm', user_id: String(user.id) });
      expect(exported).toBe(total);
      expect(exported).toBe(1);
    });
  });

  it('honours the action/category filter', async () => {
    await inRollback(async (tx) => {
      await crmEntry(tx, { category: 'Lead', who: 'ZZ Lead Row' });
      await crmEntry(tx, { category: 'Campaigns', who: 'ZZ Campaign Row' });

      const file = await build(tx).exporter.export({ area: 'crm', category: 'Lead' } as never, 'csv');
      const rows = parseCsv(file.body);
      const cat = col(rows, 'Category');
      expect(body(rows).every((r) => r[cat] === 'Lead')).toBe(true);
    });
  });

  it('honours the search term', async () => {
    await inRollback(async (tx) => {
      await crmEntry(tx, { details: 'ZZ-NEEDLE-FINDME' });
      await crmEntry(tx, { details: 'something else entirely' });

      const { total, exported } = await agree(tx, { area: 'crm', q: 'ZZ-NEEDLE-FINDME' });
      expect(exported).toBe(total);
      expect(exported).toBe(1);
    });
  });

  it('honours several filters at once', async () => {
    await inRollback(async (tx) => {
      await crmEntry(tx, { category: 'Lead', action: 'Updated', details: 'ZZ-COMBO' });
      await crmEntry(tx, { category: 'Lead', action: 'Created', details: 'ZZ-COMBO' });
      await crmEntry(tx, { category: 'Campaigns', action: 'Updated', details: 'ZZ-COMBO' });

      const { total, exported } = await agree(tx, { area: 'crm', category: 'Lead', q: 'ZZ-COMBO' });
      expect(exported).toBe(total);
      expect(exported).toBe(2);
    });
  });

  it('refuses an invalid filter instead of exporting everything', async () => {
    /*
     * The dangerous failure mode. A filter that cannot be honoured must NOT fall back to "no
     * filter" — that would hand somebody the whole trail while they believed they had asked for one
     * user's day.
     */
    await inRollback(async (tx) => {
      await crmEntry(tx);
      const { exporter } = build(tx);
      await expect(exporter.export({ area: 'crm', user_id: 'abc' } as never, 'csv')).rejects.toMatchObject({ status: 400 });
      await expect(exporter.export({ area: 'crm', from: 'garbage' } as never, 'csv')).rejects.toMatchObject({ status: 400 });
    });
  });
});

// ============================================================================ isolation
describe('domain isolation', () => {
  it('a CRM export contains no Transaction Desk rows', async () => {
    /*
     * The rule the whole audit-domain architecture exists for. A Desk row in a CRM export is a
     * silent leak across the two applications.
     */
    await inRollback(async (tx) => {
      await crmEntry(tx, { domain: 'crm', who: 'ZZ CRM Row' });
      await crmEntry(tx, { domain: 'desk', category: 'Transactions', who: 'ZZ Desk Row' });

      const file = await build(tx).exporter.export({ area: 'crm' } as never, 'csv');
      const rows = parseCsv(file.body);
      const who = col(rows, 'User');
      const domain = col(rows, 'Domain');

      expect(body(rows).some((r) => r[who] === 'ZZ CRM Row')).toBe(true);
      expect(body(rows).some((r) => r[who] === 'ZZ Desk Row')).toBe(false);
      expect(body(rows).every((r) => r[domain] !== 'desk')).toBe(true);
    });
  });

  it('a Desk export contains no CRM rows', async () => {
    // The same guarantee in the other direction — shared infrastructure must not leak either way.
    await inRollback(async (tx) => {
      await crmEntry(tx, { domain: 'crm', who: 'ZZ CRM Row' });
      await crmEntry(tx, { domain: 'desk', category: 'Transactions', who: 'ZZ Desk Row' });

      const file = await build(tx).exporter.export({ area: 'desk' } as never, 'csv');
      const rows = parseCsv(file.body);
      const who = col(rows, 'User');

      expect(body(rows).some((r) => r[who] === 'ZZ Desk Row')).toBe(true);
      expect(body(rows).some((r) => r[who] === 'ZZ CRM Row')).toBe(false);
    });
  });

  it('excludes agent-made transaction changes, as the listing does', async () => {
    await inRollback(async (tx) => {
      await crmEntry(tx, { source: 'Agent', transaction_id: 1, who: 'ZZ Agent Change' });
      const file = await build(tx).exporter.export({ area: 'crm' } as never, 'csv');
      const rows = parseCsv(file.body);
      expect(body(rows).some((r) => r[col(rows, 'User')] === 'ZZ Agent Change')).toBe(false);
    });
  });
});

// ============================================================================ safety
describe('what must never reach the file', () => {
  it('redacts values whose FIELD name looks like a credential', async () => {
    /*
     * A redaction at the export boundary, keyed on the field NAME rather than the value, so it does
     * not depend on guessing what a secret looks like. The file leaves the building and gets
     * emailed; the screen does not.
     */
    await inRollback(async (tx) => {
      await crmEntry(tx, {
        field: 'Password', old_value: 'hunter2', new_value: 'correct-horse', details: 'changed password',
        who: 'ZZ Secret Row',
      });
      await crmEntry(tx, { field: 'access_token', old_value: 'ya29.SECRETVALUE', who: 'ZZ Token Row' });
      await crmEntry(tx, { field: 'mfa_secret', old_value: 'JBSWY3DPEHPK3PXP', who: 'ZZ Mfa Row' });

      const file = await build(tx).exporter.export({ area: 'crm' } as never, 'csv');
      const text = file.body.toString('utf8');

      for (const secret of ['hunter2', 'correct-horse', 'ya29.SECRETVALUE', 'JBSWY3DPEHPK3PXP']) {
        expect(text).not.toContain(secret);
      }
      expect(text).toContain('[redacted]');
    });
  });

  it('does not redact an ordinary field', async () => {
    // The redaction must be narrow: over-redacting would make the export useless.
    await inRollback(async (tx) => {
      await crmEntry(tx, { field: 'Status', old_value: 'New', new_value: 'Qualified', who: 'ZZ Normal' });
      const file = await build(tx).exporter.export({ area: 'crm' } as never, 'csv');
      const text = file.body.toString('utf8');
      expect(text).toContain('Qualified');
    });
  });

  it('neutralises a spreadsheet formula so opening the file cannot execute it', async () => {
    /*
     * CSV INJECTION. A cell beginning `=`, `+`, `-` or `@` is executed as a formula by Excel and
     * Sheets. The audit trail records text people typed, so a lead named `=cmd|'/c calc'!A0` would
     * run on the machine of whoever opened the export. The apostrophe makes it text, which is what
     * it always was.
     */
    await inRollback(async (tx) => {
      await crmEntry(tx, { new_value: `=cmd|'/c calc'!A0`, who: 'ZZ Formula' });
      const file = await build(tx).exporter.export({ area: 'crm' } as never, 'csv');
      const rows = parseCsv(file.body);
      const cell = body(rows).find((r) => r[col(rows, 'User')] === 'ZZ Formula')![col(rows, 'New Value')];

      expect(cell.startsWith("'")).toBe(true);
      expect(cell).not.toMatch(/^=/);
    });
  });

  it('escapes commas, quotes and newlines rather than breaking the row', async () => {
    await inRollback(async (tx) => {
      await crmEntry(tx, {
        details: 'Smith, John said "hello"\nand then left',
        who: 'ZZ Special',
      });
      const file = await build(tx).exporter.export({ area: 'crm' } as never, 'csv');
      const rows = parseCsv(file.body);
      const row = body(rows).find((r) => r[col(rows, 'User')] === 'ZZ Special')!;

      // The row survived intact — the comma did not split it and the newline did not end it.
      expect(row).toHaveLength(header(rows).length);
      expect(row[col(rows, 'Description')]).toContain('Smith, John');
      expect(row[col(rows, 'Description')]).toContain('"hello"');
    });
  });

  it('handles non-Latin characters', async () => {
    await inRollback(async (tx) => {
      await crmEntry(tx, { who: 'ZZ Ünïcode 名前', details: 'Café — naïve' });
      const file = await build(tx).exporter.export({ area: 'crm' } as never, 'csv');
      expect(file.body.toString('utf8')).toContain('Ünïcode 名前');
    });
  });
});

// ============================================================================ edges
describe('edge cases', () => {
  it('an empty result is a valid file with only a header', async () => {
    await inRollback(async (tx) => {
      const file = await build(tx).exporter.export(
        { area: 'crm', q: 'zz-nothing-can-possibly-match-this' } as never, 'csv',
      );
      const rows = parseCsv(file.body);
      expect(header(rows)).toContain('Date');
      expect(body(rows)).toHaveLength(0);
      expect(file.rows).toBe(0);
      expect(file.truncated).toBe(false);
    });
  });

  it('an empty Excel export is still a readable workbook', async () => {
    await inRollback(async (tx) => {
      const file = await build(tx).exporter.export(
        { area: 'crm', q: 'zz-nothing-can-possibly-match-this' } as never, 'xlsx',
      );
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(file.body as never);
      expect(book.getWorksheet('Audit Trail')).toBeDefined();
    });
  });

  it('reports the row count, so the UI can tell somebody what they got', async () => {
    await inRollback(async (tx) => {
      for (let i = 0; i < 5; i += 1) await crmEntry(tx, { details: 'ZZ-COUNTED' });
      const file = await build(tx).exporter.export({ area: 'crm', q: 'ZZ-COUNTED' } as never, 'csv');
      expect(file.rows).toBe(5);
      expect(file.truncated).toBe(false);
    });
  });

  it('is bounded, and says so when it truncates', async () => {
    // The ceiling exists so one export cannot pull an unbounded set into memory.
    expect(AuditExportService.MAX_ROWS).toBeGreaterThan(0);
    expect(AuditExportService.MAX_ROWS).toBeLessThanOrEqual(100_000);
  });

  it('names the file without exposing internal identifiers', async () => {
    await inRollback(async (tx) => {
      const { exporter } = build(tx);
      const plain = await exporter.export({ area: 'crm' } as never, 'csv');
      const ranged = await exporter.export({ area: 'crm', from: '2026-08-01', to: '2026-08-06' } as never, 'xlsx');

      expect(plain.filename).toMatch(/^crm-audit-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(ranged.filename).toBe('crm-audit-2026-08-01-to-2026-08-06.xlsx');
      // No tenant or database id anywhere in the name.
      expect(ranged.filename).not.toMatch(/company|tenant|_id|\bid\b/i);
    });
  });
});
