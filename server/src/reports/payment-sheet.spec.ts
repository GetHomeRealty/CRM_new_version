import ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { CommissionService } from '../transactions/commission.service';
import { PersonResolver } from '../core/person-resolver.service';
import { ReportDataService } from './report-data.service';
import { ReportsService } from './reports.service';
import { SHEET_COLUMNS, parseSheetXlsx, replaceSheet, clearSheet } from './payment-sheet';

/**
 * PENDING PAYMENTS SHOWS THE UPLOADED PAYMENT SHEET, AS WRITTEN (2026-10-19).
 *
 * An upload replaces the sheet; while it holds rows the report returns them — the sheet's own
 * columns, sections and order, and its words untouched — and agents keep the computed view.
 * Removing it brings the computed report back. Real tables, rolled back.
 */

const prisma = new PrismaClient();
const ROLLBACK = '__rollback__';
async function inRollback(fn: (tx: PrismaService) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => { await fn(tx as unknown as PrismaService); throw new Error(ROLLBACK); }, { timeout: 60000 });
  } catch (e) {
    if (!String((e as Error).message).includes(ROLLBACK)) throw e;
  }
}
afterAll(async () => { await prisma.$disconnect(); });

const as = (role: string, name = `ZZ ${role}`): AuthUserRecord =>
  ({ id: 1, name, role, user_permissions: [], user_modules: [] }) as unknown as AuthUserRecord;
const service = (tx: PrismaService) => new ReportsService(new ReportDataService(tx, new CommissionService(new PersonResolver(tx))), tx);
const HEAD = ['Section', 'Group', 'Trade No', 'Closing Date', 'Property Name', 'Agent Name', 'Docs Status', 'Validation Status',
  'Validation Comments', 'Payment Schedule', 'Karishma Remarks'];

async function workbook(rows: unknown[][], head = HEAD): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('Pay Sheet');
  ws.addRow(head);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const SAMPLE = [
  ['Client Payments', '', '101512', 'October 1, 2026', '4665 Central Parkway E, #9_Mutual Release', 'JAY PATEL RAJESHBHAI', 'NO', '-Kari',
    'No Deposit Rcpt, No Valid Mut Rls Doc', '', 'Client Void Cheque on Drive (Buyer: Mandeep Maheshbhai Savalia)'],
  ['Co-op Payments', '', '101242', new Date(Date.UTC(2026, 2, 25)), '15 Ellerslie Avenue, #603', 'VIGNESH SELVARAJ', 'YES', '-Kari', '-',
    'MEHome Brokerage RECO Escalation', 'Invoice Pending'],
  [],
  ['Agent Payments', 'Listing', '100286', '2023-03-01', '49 Schooner main MPR', 'SRIDEVI KALLAPALLY', 'YES', 'YES', '-', 'Proceed to Pay',
    'Hold till sai sir confirm'],
  ['Agent Payments', 'Pre-Construction', '300020-B', 'March 16, 2024', 'Suite: 1706A, Unit 6, Level 17_Term 2_LSQ', 'SAI RAMESH GOLLU',
    'YES', 'YES', '-', 'Proceed to Pay - Wait for 200K Adjust', 'Team Split'],
];

describe('the Payment Sheet on Pending Payments', () => {
  it('reads the template, keeps every word, and skips blank lines', async () => {
    const rows = await parseSheetXlsx(await workbook(SAMPLE));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ section: 'client', agent_group: null, trade_no: '101512', validation_status: '-Kari',
      remarks: 'Client Void Cheque on Drive (Buyer: Mandeep Maheshbhai Savalia)' });
    expect(rows[0].closing_date?.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(rows[1].closing_date?.toISOString().slice(0, 10)).toBe('2026-03-25');
    expect(rows[3]).toMatchObject({ section: 'agent', agent_group: 'Pre-Construction', payment_schedule: 'Proceed to Pay - Wait for 200K Adjust' });
  });

  it('refuses a file it cannot place, naming the row', async () => {
    await expect(parseSheetXlsx(await workbook([['Other Payments', '', '1', '', '', '', '', '', '', '', '']]))).rejects.toThrow(/Row 2: Section/);
    await expect(parseSheetXlsx(await workbook([['Agent Payments', 'Rentals', '1', '', '', '', '', '', '', '', '']]))).rejects.toThrow(/Row 2: Group/);
    await expect(parseSheetXlsx(await workbook([['Client Payments', '', '1', 'someday', '', '', '', '', '', '', '']]))).rejects.toThrow(/Row 2: Closing Date/);
    await expect(parseSheetXlsx(await workbook([], ['Section', 'Trade No']))).rejects.toThrow(/Missing/);
  });

  it('shows the sheet as written while it is stored, and the computed report once it is removed', async () => {
    await inRollback(async (tx) => {
      const before = await service(tx).run('pending-payments', as('admin'), { filters: {} });
      expect(before.sheet).toBeUndefined();

      await replaceSheet(tx, as('accounting', 'Karishma'), await parseSheetXlsx(await workbook(SAMPLE)));
      const r = await service(tx).run('pending-payments', as('admin'), { filters: {} });
      expect(r.sheet?.uploaded_by).toBe('Karishma');
      expect(r.columns).toEqual(SHEET_COLUMNS);
      expect(r.sections?.map((s) => s.label)).toEqual(['Client Payments', 'Co-op Payments', 'Listing', 'Pre-Construction']);
      expect(r.rows.map((x) => x.trade_no)).toEqual(['101512', '101242', '100286', '300020-B']);
      expect(r.rows[0]).toMatchObject({ final_validation: '-Kari', sheet_remarks: 'Client Void Cheque on Drive (Buyer: Mandeep Maheshbhai Savalia)', closing_date: '2026-10-01' });
      expect(r.totals).toEqual({});

      // Payment Head and Search narrow it.
      const coop = await service(tx).run('pending-payments', as('admin'), { filters: { payment_head: 'coop' } });
      expect(coop.rows.map((x) => x.trade_no)).toEqual(['101242']);
      const found = await service(tx).run('pending-payments', as('admin'), { filters: { search: 'schooner' } });
      expect(found.rows.map((x) => x.trade_no)).toEqual(['100286']);

      // An agent keeps the computed view: the sheet names everybody's payments.
      const agentView = await service(tx).run('pending-payments', as('agent', 'Pay Agent'), { filters: {} });
      expect(agentView.sheet).toBeUndefined();

      // The export is the sheet too, with no money total under it.
      const exp = await service(tx).exportData('pending-payments', as('admin'), { filters: {} }, 'GHR');
      expect(exp).toMatchObject({ sheetStyle: true, noGrandTotal: true, columns: SHEET_COLUMNS });
      expect(exp.rows).toHaveLength(4);

      // Another upload replaces it whole.
      await replaceSheet(tx, as('admin'), await parseSheetXlsx(await workbook([SAMPLE[0]])));
      expect((await service(tx).run('pending-payments', as('admin'), { filters: {} })).rows).toHaveLength(1);

      await clearSheet(tx, as('manager'));
      expect((await service(tx).run('pending-payments', as('admin'), { filters: {} })).sheet).toBeUndefined();
    });
  });

  it('only Super Admin, Admin and Accounting may change it', async () => {
    await inRollback(async (tx) => {
      const rows = await parseSheetXlsx(await workbook(SAMPLE));
      for (const role of ['documentation', 'agent', 'crm']) {
        await expect(replaceSheet(tx, as(role), rows)).rejects.toThrow(/Only Super Admin, Admin or Accounting/);
        await expect(clearSheet(tx, as(role))).rejects.toThrow(/Only Super Admin, Admin or Accounting/);
      }
    });
  });
});
