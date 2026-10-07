import * as ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

/*
 * 2026-10-07 - THE APP GIVES EVERY TRADE NUMBER, AND THE USER'S FILE COMES BACK WITH THEM.
 *
 * Sai: bulk-imported deals get their trade numbers from the app, and "our excel should get the trade
 * numbers of the app to their corresponding deals". So:
 *   1. a Trade Number in the sheet is neither checked nor stored - it cannot turn a row red;
 *   2. after the import, the uploaded file is handed back with an App Trade Number column, the
 *      right number on the right row, every other cell untouched.
 *
 * STORAGE_ROOT is pointed at a throwaway folder BEFORE the service loads, so no file reaches the
 * real storage. No database: the batch row is stubbed.
 */
const ROOT = mkdtempSync(path.join(tmpdir(), 'td-tradeno-'));
process.env.STORAGE_ROOT = ROOT;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TransactionImportService } = require('./transaction-import.service') as typeof import('./transaction-import.service');

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const ADMIN = { id: 1, name: 'Admin', role: 'admin' } as never;
type Batch = { batch_id: string; file_name: string; status: string; errors: string };

function serviceWith(batch: Batch | null) {
  const prisma = {
    users: { findMany: async () => [{ name: 'Aswini' }] },
    transactions: { findMany: async () => [] },
    import_batches: { findUnique: async () => batch },
  };
  return new TransactionImportService(prisma as never, {} as never);
}
const priv = (svc: unknown) => svc as {
  keepUpload: (id: string, name: string, b: Buffer) => Promise<void>;
  toBody: (rec: Record<string, string>, type: string, primary: string) => Record<string, unknown>;
  validateRows: (r: unknown[]) => Promise<{ valid: boolean; issues: { field: string; message: string }[] }[]>;
};

/** A workbook shaped like the brokerage's: a Transactions sheet, a blank row in the middle, a second sheet. */
async function workbook(withAppColumn = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Transactions');
  ws.addRow(['Transaction Type', 'Property Address', 'Trade Number', ...(withAppColumn ? ['App Trade Number'] : [])]);
  ws.addRow(['Residential Buying', '1 First St', '200954']);   // record row 2
  ws.addRow(['Residential Lease', '2 Second St', '']);          // record row 3
  ws.addRow([]);                                                // blank - skipped by the import
  ws.addRow(['Residential Buying', '3 Third St', '200999']);   // record row 4 - not imported
  ws.addRow(['Referral', '4 Fourth St', '']);                  // record row 5
  wb.addWorksheet('Notes').addRow(['kept as it was']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const imported = (id: string, file: string): Batch => ({
  batch_id: id, file_name: file, status: 'Partially Imported',
  errors: JSON.stringify({ created: [{ row: 2, trade_no: '000001' }, { row: 3, trade_no: '000002' }, { row: 5, trade_no: '000003_NB' }] }),
});

async function read(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

describe('the sheet\'s trade number is ignored', () => {
  const svc = serviceWith(null);

  it('is not carried into the deal the import writes', () => {
    const body = priv(svc).toBody({ 'Transaction Type': 'Residential Buying', 'Trade Number': '200954', 'Property Address': '1 First St' }, 'Residential Buying', 'Aswini');
    expect(body.trade_no).toBeUndefined();
    expect(body.property).toBe('1 First St');
  });

  it('never turns a row red, whatever it holds', async () => {
    const day = (o: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };
    for (const value of ['200954', '999999', 'abc', '000001']) {
      const [r] = await priv(svc).validateRows([{ row: 2, ref: 'r2', financial: {}, children: {}, main: {
        'Transaction Type': 'Residential Buying', 'Property Address': '3 ZZ-TEST Rd', Price: '500000', Deposit: '25000',
        Agent: 'Aswini', 'Offer Date': day(-30), 'Closing Date': day(30), 'Trade Number': value,
      } }]);
      expect(r.issues.filter((i) => i.field === 'Trade Number')).toEqual([]);
    }
  });
});

describe('the uploaded file comes back with App Trade Numbers', () => {
  it('puts the right number on the right row, says which rows were not imported, and changes nothing else', async () => {
    const svc = serviceWith(imported('IMP-T1', 'deals.xlsx'));
    await priv(svc).keepUpload('IMP-T1', 'deals.xlsx', await workbook());
    const out = await svc.numberedFile('IMP-T1', ADMIN);
    expect(out.fileName).toBe('deals - with App Trade Numbers.xlsx');

    const wb = await read(out.buffer);
    const ws = wb.getWorksheet('Transactions')!;
    expect(ws.getRow(1).getCell(4).value).toBe('App Trade Number');
    expect(ws.getRow(2).getCell(4).value).toBe('000001');
    expect(ws.getRow(3).getCell(4).value).toBe('000002');
    expect(ws.getRow(4).getCell(4).value ?? null).toBeNull();                 // the blank row stays blank
    expect(String(ws.getRow(5).getCell(4).value)).toMatch(/^Not imported/);
    expect(ws.getRow(6).getCell(4).value).toBe('000003_NB');
    expect(ws.getRow(2).getCell(4).numFmt).toBe('@');                         // text, so the zeros stay
    // the user's own cells, including the old Trade Number, are untouched
    expect(ws.getRow(2).getCell(3).value).toBe('200954');
    expect(ws.getRow(5).getCell(2).value).toBe('3 Third St');
    expect(wb.getWorksheet('Notes')!.getRow(1).getCell(1).value).toBe('kept as it was');
  });

  it('reuses an App Trade Number column already in the file instead of adding a second one', async () => {
    const svc = serviceWith(imported('IMP-T2', 'again.xlsx'));
    await priv(svc).keepUpload('IMP-T2', 'again.xlsx', await workbook(true));
    const ws = (await read((await svc.numberedFile('IMP-T2', ADMIN)).buffer)).getWorksheet('Transactions')!;
    expect(ws.getRow(1).getCell(4).value).toBe('App Trade Number');
    expect(ws.getRow(1).getCell(5).value ?? null).toBeNull();
    expect(ws.getRow(2).getCell(4).value).toBe('000001');
  });

  it('hands a CSV back as a workbook, so Excel does not drop the leading zeros', async () => {
    const svc = serviceWith(imported('IMP-T3', 'deals.csv'));
    const csv = 'Transaction Type,Property Address,Trade Number\nResidential Buying,1 First St,\nResidential Lease,2 Second St,\n,,\nResidential Buying,3 Third St,\nReferral,4 Fourth St,\n';
    await priv(svc).keepUpload('IMP-T3', 'deals.csv', Buffer.from(csv));
    const out = await svc.numberedFile('IMP-T3', ADMIN);
    expect(out.fileName).toBe('deals - with App Trade Numbers.xlsx');
    const ws = (await read(out.buffer)).worksheets[0];
    const appCol = (ws.getRow(1).values as unknown[]).indexOf('App Trade Number');
    const numbers: unknown[] = [];
    ws.eachRow((row, n) => { if (n > 1) numbers.push(row.getCell(appCol).value); });
    expect(numbers[0]).toBe('000001');
    expect(numbers[1]).toBe('000002');
    expect(String(numbers[2])).toMatch(/^Not imported/);
    expect(numbers[3]).toBe('000003_NB');
  });

  it('refuses a file that has not been imported yet', async () => {
    const svc = serviceWith({ ...imported('IMP-T4', 'x.xlsx'), status: 'Validated' });
    await expect(svc.numberedFile('IMP-T4', ADMIN)).rejects.toThrow(/not been imported yet/);
  });

  it('says so plainly when the file was not kept (an import from before this change)', async () => {
    const svc = serviceWith(imported('IMP-OLD', 'old.xlsx'));
    await expect(svc.numberedFile('IMP-OLD', ADMIN)).rejects.toThrow(/was not kept/);
  });

  it('is for whoever may import, like the import itself', async () => {
    const svc = serviceWith(imported('IMP-T1', 'deals.xlsx'));
    await expect(svc.numberedFile('IMP-T1', { id: 2, name: 'Agent', role: 'agent' } as never)).rejects.toThrow();
  });
});
