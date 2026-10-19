import { test, expect } from '@playwright/test';
import path from 'path';
import { signIn, apiSend } from './helpers';

// The e2e package has no spreadsheet library of its own; the server's is the same one that reads the upload.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ExcelJS = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'exceljs'));

/**
 * PENDING PAYMENTS ← THE UPLOADED PAYMENT SHEET (2026-10-19).
 *
 * Upload replaces the report's rows with the sheet's, word for word; Remove (two presses) returns it
 * to the rows computed from the deals.
 */

test.use({ viewport: { width: 1600, height: 900 } });

async function sheetFile(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('Pay Sheet');
  ws.addRow(['Section', 'Group', 'Trade No', 'Closing Date', 'Property Name', 'Agent Name', 'Docs Status', 'Validation Status',
    'Validation Comments', 'Payment Schedule', 'Karishma Remarks']);
  ws.addRow(['Client Payments', '', 'ZZ101512', 'October 1, 2026', 'ZZ 4665 Central Parkway E', 'JAY PATEL RAJESHBHAI', 'NO', '-Kari',
    'No Deposit Rcpt', '', 'Client Void Cheque on Drive']);
  ws.addRow(['Agent Payments', 'Listing', 'ZZ100286', 'March 1, 2023', 'ZZ 49 Schooner main MPR', 'SRIDEVI KALLAPALLY', 'YES', 'YES', '-',
    'Proceed to Pay', 'Hold till sai sir confirm']);
  return { name: 'Pay Sheet.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await book.xlsx.writeBuffer()) };
}

test('upload shows the Pay Sheet as written; remove brings the computed report back', async ({ page }) => {
  await signIn(page, 'superAdmin');
  try {
    await page.goto('/desk/reports/pending-payments');
    const bar = page.getByTestId('pay-sheet-bar');
    await expect(bar).toContainText('worked out from the deals', { timeout: 20_000 });

    await page.getByTestId('pay-sheet-file').setInputFiles(await sheetFile());
    await expect(bar).toContainText('Showing the uploaded Pay Sheet', { timeout: 15_000 });
    await expect(page.locator('.report-chips')).toContainText('Payment Sheet');

    const table = page.locator('.report-table');
    await expect(table.getByText('Karishma Remarks').first()).toBeVisible();
    await expect(table.getByText('ZZ 4665 Central Parkway E')).toBeVisible();
    await expect(table.getByText('Client Void Cheque on Drive')).toBeVisible();
    await expect(table.getByText('Hold till sai sir confirm')).toBeVisible();
    await expect(page.locator('tr.report-group-row', { hasText: 'Agent Payments' })).toBeVisible();
    await expect(page.locator('tr.report-section-row', { hasText: 'Listing' })).toBeVisible();
    // No money in the sheet, so no totals row.
    await expect(page.locator('tr.report-totals')).toHaveCount(0);

    const remove = page.getByRole('button', { name: 'Remove Pay Sheet' });
    await remove.click();
    await page.getByRole('button', { name: 'Press again to remove' }).click();
    await expect(bar).toContainText('worked out from the deals', { timeout: 15_000 });
    await expect(page.locator('.report-table').getByText('ZZ 4665 Central Parkway E')).toHaveCount(0);
  } finally {
    await apiSend(page, 'DELETE', '/api/reports/pending-payments/sheet').catch(() => undefined);
  }
});
