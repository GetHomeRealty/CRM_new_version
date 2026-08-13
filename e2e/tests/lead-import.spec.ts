import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Importing leads from a CSV, in a real browser, from clicking Import to seeing the result.
 *
 * THE BUG THIS EXISTS FOR. The import appeared to hang: the dialog sat on "Queued — 8 rows to
 * import. 0%" indefinitely. The server was never at fault — its log showed the same file finishing
 * in under a tenth of a second — and nothing was wrong with the file either. What failed was the
 * FOLLOWING: `runLeadImport` polls until the job reports done, and it checks a `cancelled()`
 * callback before each poll. That callback reads a ref set by the modal's unmount cleanup, and
 * React 18's StrictMode mounts every effect, unmounts it and mounts it again in development — so
 * the cleanup had already run and set the flag before anybody clicked anything. The loop took the
 * first response, which says "Queued", and never asked a second time.
 *
 * WHY NO EXISTING TEST CAUGHT IT. There was no browser coverage of the import at all, and the
 * server-side suite could never have caught it: every assertion there passes, because the import
 * genuinely works. The defect lives entirely in the browser, and only when React is in development
 * mode. This file runs against `npx vite` — the dev server, StrictMode active — which is the only
 * configuration where it reproduces.
 *
 * Addresses are unique per run so a second run is not a file of duplicates, which would report
 * "0 imported" and prove nothing about whether the import ran.
 */

const IMPORT_TIMEOUT = 30_000;

/** A small valid file, with the columns the dialog advertises. */
function csvFor(stamp: string): string {
  return [
    'name,email,phone,location,property,lead status,lead type,lead source,lead response,client type',
    `Ada Import,ada-${stamp}@import.test,416-555-0101,Toronto,12 Elm St,hot,buyer,website,active,first home buyer`,
    `Bob Import,bob-${stamp}@import.test,416-555-0102,Ajax,7 Oak Ave,warm,seller,refferal,inactive,Investor`,
  ].join('\r\n');
}

/**
 * Open the dialog and return it.
 *
 * Everything is scoped to the returned modal rather than to the page. The toolbar button and the
 * dialog heading both read "Import Leads", so a page-level text match hits two elements; and the
 * submit button inside is plain "Import", which only stays unambiguous while the search is confined
 * to the dialog.
 */
async function openImport(page: import('@playwright/test').Page) {
  await page.goto('/crm/lead');
  await page.getByRole('button', { name: 'Import Leads' }).click();
  const modal = page.locator('.modal', { hasText: 'Import Leads' });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  return modal;
}

test.describe('importing leads from a CSV', () => {
  test('the import finishes and reports its result, rather than sitting on Queued', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const modal = await openImport(page);

    const stamp = String(Date.now());
    await modal.locator('input[type=file]').setInputFiles({
      name: 'leads.csv', mimeType: 'text/csv', buffer: Buffer.from(csvFor(stamp), 'utf8'),
    });

    await modal.getByRole('button', { name: 'Import', exact: true }).click();

    /*
     * The assertion that matters. "2 imported" is the finished message; the failure being guarded
     * against leaves "Queued" on screen for ever, so this is what separates a working import from
     * one that only looks started.
     */
    await expect(page.getByText(/\b2 imported\b/)).toBeVisible({ timeout: IMPORT_TIMEOUT });
    await expect(page.getByText(/Queued/)).toHaveCount(0);
  });

  test('a row without an email is skipped, and the message says why', async ({ page }) => {
    // "N skipped" alone sent people looking for a broken importer; there is one cause and it is
    // worth naming, because the fix is in their spreadsheet.
    await signIn(page, 'superAdmin');
    const modal = await openImport(page);

    const stamp = String(Date.now());
    const csv = ['name,email,phone', `Valid,valid-${stamp}@import.test,416-555-0103`, 'No Address,,416-555-0104'].join('\r\n');
    await modal.locator('input[type=file]').setInputFiles({
      name: 'partial.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8'),
    });
    await modal.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByText(/1 skipped \(no email address\)/)).toBeVisible({ timeout: IMPORT_TIMEOUT });
  });

  test('the file is confirmed on screen without showing its contents', async ({ page }) => {
    /*
     * The raw "CSV data" textarea used to render the whole file the moment one was chosen. A lead
     * list is people's names, addresses and phone numbers, and a settings dialog is not where those
     * belong on display. What replaced it has to still confirm the file loaded — otherwise the only
     * signal is the Import button becoming enabled.
     */
    await signIn(page, 'superAdmin');
    const modal = await openImport(page);

    const stamp = String(Date.now());
    await modal.locator('input[type=file]').setInputFiles({
      name: 'leads.csv', mimeType: 'text/csv', buffer: Buffer.from(csvFor(stamp), 'utf8'),
    });
    await expect(modal.getByText('leads.csv')).toBeVisible();
    await expect(modal.getByText(/2 data rows ready to import/)).toBeVisible();

    // No textarea, and no address from the file anywhere on screen.
    await expect(modal.locator('textarea')).toHaveCount(0);
    await expect(modal.getByText(`ada-${stamp}@import.test`)).toHaveCount(0);
  });

  test('the sample template downloads with the columns the importer actually reads', async ({ page }) => {
    await signIn(page, 'superAdmin');
    const modal = await openImport(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      modal.getByText('Download the sample template').click(),
    ]);
    expect(download.suggestedFilename()).toBe('lead-import-template.csv');

    const path = await download.path();
    const text = require('node:fs').readFileSync(path, 'utf8') as string;
    const [header, first] = text.replace(/^﻿/, '').split(/\r?\n/);

    expect(header).toBe('name,email,phone,location,property,lead status,lead type,lead source,lead response,client type');

    /*
     * The example values must be ones the importer ACCEPTS. Status, type, source, response and
     * client type are matched against fixed vocabularies and anything else is stored empty — so a
     * template demonstrating "New", "Buyer" or "Referral" would teach every agent to build files
     * that silently lose four columns. This asserts the trap is not being taught.
     */
    expect(first).toContain('hot');
    expect(first).toContain('buyer');
    expect(first).toContain('website');
    expect(first).toContain('active');
    for (const notAVocabularyValue of ['New', 'Referral', 'Interested', 'Contacted']) {
      expect(text).not.toContain(notAVocabularyValue);
    }
  });
});
