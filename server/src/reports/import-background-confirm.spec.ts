import { TransactionImportService } from './transaction-import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TransactionsWriteService } from '../transactions/transactions-write.service';
import type { AuthUserRecord } from '../auth/auth.types';

/*
 * TD-212, 2026-10-09 - A LONG IMPORT RUNS IN THE BACKGROUND AND THE SCREEN FOLLOWS IT.
 *
 * The confirm used to be one request held open for the whole import. 852 rows took 91.8 s on the
 * live server; the browser/proxy stopped waiting at about 60 s and the screen said "The import could
 * not be completed" while the server went on to import all 852. A user who believed it would press
 * Import again.
 *
 * Now startConfirm() claims the batch once (Validated -> Importing; a second press is refused), runs
 * the same row-by-row confirm() in the background, and records progress after every row. status()
 * reports the progress and, when finished, the same result the screen showed before. A batch left
 * 'Importing' with no progress for five minutes (the process restarted under it) reads as
 * 'Interrupted', and Undo works on it like a partial import.
 */
const admin = { id: 1, name: 'Akhil', role: 'admin' } as unknown as AuthUserRecord;

type Batch = Record<string, unknown> & { batch_id: string; status: string; updated_at: Date | null };
function harness(rows = 5, opts: { status?: string; updatedAgoMs?: number } = {}) {
  const now = Date.now();
  const batch: Batch = {
    batch_id: 'IMP-ZZ-1', status: opts.status ?? 'Validated', total_rows: rows, valid_rows: rows,
    imported_rows: 0, failed_rows: 0, duplicate_rows: 0, warning_rows: 0, completed_at: null,
    updated_at: new Date(now - (opts.updatedAgoMs ?? 0)), file_name: 'zz.csv', uploaded_by: 'Akhil', uploaded_at: new Date(now),
    errors: JSON.stringify({ issues: [], rows: Array.from({ length: rows }, (_, i) => ({ row: i + 2, reference: `r${i + 2}`, data: { property: `${i + 1} ZZ Rd` }, sections: {}, valid: true })) }),
  };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let n = 0;
  const prisma = {
    import_batches: {
      findUnique: async () => ({ ...batch }),
      update: async (a: { data: Record<string, unknown> }) => { Object.assign(batch, a.data); return { ...batch }; },
      updateMany: async (a: { where: { status?: string }; data: Record<string, unknown> }) => {
        if (a.where.status && batch.status !== a.where.status) return { count: 0 };
        Object.assign(batch, a.data); return { count: 1 };
      },
      findMany: async () => [{ ...batch }],
    },
    transactions: { count: async () => n },
  } as unknown as PrismaService;
  const write = {
    store: async (_u: unknown, body: Record<string, unknown>) => {
      if (n === 1) await gate;                       // hold the import after its first row
      n += 1;
      return { data: { id: 100 + n, trade_no: String(n).padStart(6, '0'), property: body.property } };
    },
    update: async () => ({ data: {} }),
  } as unknown as TransactionsWriteService;
  const svc = new TransactionImportService(prisma, write);
  return { svc, batch, release, created: () => n };
}
const tick = () => new Promise((r) => setTimeout(r, 20));
type Svc = { startConfirm: (b: string, u: AuthUserRecord) => Promise<Record<string, unknown>>; status: (b: string, u: AuthUserRecord) => Promise<Record<string, unknown>> };

describe('a long import runs in the background and the screen follows it (TD-212)', () => {
  it('answers straight away, before the rows are written', async () => {
    const h = harness();
    const started = await (h.svc as unknown as Svc).startConfirm('IMP-ZZ-1', admin);
    expect(started.status).toBe('Importing');
    await tick();
    expect(h.created()).toBe(1);                      // still running - held after row 1
    h.release(); await tick(); await tick();
  });

  it('can only be started once', async () => {
    const h = harness();
    const svc = h.svc as unknown as Svc;
    await svc.startConfirm('IMP-ZZ-1', admin);
    await expect(svc.startConfirm('IMP-ZZ-1', admin)).rejects.toThrow(/already/i);
    h.release(); await tick(); await tick();
  });

  it('reports progress while running, and the full result when finished', async () => {
    const h = harness();
    const svc = h.svc as unknown as Svc;
    await svc.startConfirm('IMP-ZZ-1', admin);
    await tick();
    const mid = await svc.status('IMP-ZZ-1', admin);
    expect(mid).toMatchObject({ status: 'Importing', done: false, imported_rows: 1, total_rows: 5 });
    h.release(); await tick(); await tick();
    const end = await svc.status('IMP-ZZ-1', admin) as { status: string; done: boolean; result: { imported_rows: number; created: { trade_no: string; property: string }[] } };
    expect(end.status).toBe('Imported');
    expect(end.done).toBe(true);
    expect(end.result.imported_rows).toBe(5);
    expect(end.result.created.map((c) => c.trade_no)).toEqual(['000001', '000002', '000003', '000004', '000005']);
    expect(end.result.created[0].property).toBe('1 ZZ Rd');
  });

  it('reads a batch stuck in Importing for five minutes as Interrupted', async () => {
    const h = harness(5, { status: 'Importing', updatedAgoMs: 6 * 60 * 1000 });
    const st = await (h.svc as unknown as Svc).status('IMP-ZZ-1', admin);
    expect(st).toMatchObject({ status: 'Interrupted', done: true });
    expect(h.batch.status).toBe('Interrupted');
  });

  it('does not call a batch that is still making progress Interrupted', async () => {
    const h = harness(5, { status: 'Importing', updatedAgoMs: 30 * 1000 });
    const st = await (h.svc as unknown as Svc).status('IMP-ZZ-1', admin);
    expect(st).toMatchObject({ status: 'Importing', done: false });
  });

  it('offers Undo on an Interrupted batch, like a partial import', () => {
    const h = harness();
    expect((h.svc as unknown as { UNDOABLE_BATCH_STATUSES: string[] }).UNDOABLE_BATCH_STATUSES).toContain('Interrupted');
  });
});
