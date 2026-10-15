import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { ExportPayload, ReportColumn, ReportRow, ReportTotals } from './report.types';

/** One rendered block: a whole report, or one section of a section-grouped report. */
interface Block { label: string | null; count: number; rows: ReportRow[]; totals: ReportTotals | null }

const BRAND = '#4f46e5', MUTED = '#64748b', LINE = '#e7e9f1', ZEBRA = '#fafbff';

/** One section of a Payment Sheet style export, with its own titles and column labels. */
interface SheetBlock {
  label: string | null; group: string | null; description: string | null; count: number;
  rows: ReportRow[]; totals: ReportTotals | null; labels: Record<string, string>; blank: string[];
}
/** The Payment Sheet's palette (Payments sheet.pdf — Google Sheets' standard colours). */
const SHEET = {
  head: '#20124d', title: '#ff0000', subtitle: '#980000', text: '#000000', grid: '#000000',
  total: '#efefef', muted: '#434343',
};
/** Status cells tinted as the Sheet tints them: green done, red not yet, orange part-way, yellow in hand. */
const SHEET_STATUS_FILL: Record<string, string> = {
  'Cleared': '#b6d7a8', 'Done': '#b6d7a8', 'Proceed to Pay': '#b6d7a8',
  'Pending': '#f4cccc', 'Not Ready': '#f4cccc', 'Invoice Pending': '#f4cccc',
  'Invalid': '#f9cb9c', 'Partially Paid': '#f9cb9c', '50% Paid': '#fce5cd',
  'Invoice Received': '#ffff00', 'N/A': '#efefef',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** More columns than this render landscape; fewer render portrait. */
const LANDSCAPE_MIN_COLS = 7;

/** "2026-07-21" → "July 21, 2026" (the app-wide report date format). */
export function longDate(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  if (!m) return String(v ?? '');
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}
/** "July 21, 2026 06:48 AM EST" — long date + 12-hour time with the server's timezone. */
export function longStamp(d: Date): string {
  const date = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(d);
  return `${date} ${time}`;
}

/** Renders a report ExportPayload to XLSX or PDF (complete filtered dataset, selected columns only). */
@Injectable()
export class ReportExportService {
  // ---- value formatting ----
  private cell(row: ReportRow, c: ReportColumn): string {
    const v = row[c.key];
    if (v === null || v === undefined || v === '') return '—';
    switch (c.type) {
      case 'currency': return this.money(Number(v));
      case 'percent': return Number(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
      case 'date': case 'datetime': return longDate(v);
      case 'number': return String(v);
      default: return String(v);
    }
  }
  private money(n: number): string { return '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  /**
   * Columns that must never wrap. Wrapping is word-based, and these values are single
   * tokens with no spaces ($1,234,567.89) or must stay on one line (dates, addresses) —
   * letting the renderer wrap them would split a number across its decimal point.
   */
  private noWrap(c: ReportColumn): boolean {
    return c.type === 'currency' || c.type === 'percent' || c.type === 'number'
      || c.type === 'date' || c.type === 'datetime' || c.key === 'property';
  }
  fileStamp(d: Date): string { return d.toISOString().slice(0, 16).replace('T', '_').replace(':', '-'); }

  /*
   * TD-041 — the exported total is formatted like the column it sits under, not always as money.
   *
   * The screen had the same defect and the same fix (`totalText` in `ReportDetailPage.tsx`): the
   * body cell branched on `c.type` while the totals row called the money formatter on anything
   * carrying `total: true`. A column of document counts printed "$44.00", which on an exported RECO
   * compliance report reads as a dollar figure to whoever opens the file.
   *
   * Counts keep their thousands separators and no forced decimals — 128, not 128.00.
   */
  private plain(n: number): string { return Number(n).toLocaleString('en-CA', { maximumFractionDigits: 2 }); }
  private totalText(c: ReportColumn, n: number): string {
    if (c.type === 'currency') return this.money(n);
    if (c.type === 'percent') return Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
    return this.plain(n);
  }

  /** Totals row cells — the record count lives here (not in the header). */
  private totalCell(totals: ReportTotals, count: number, c: ReportColumn, first: boolean): string {
    if (first) return `Totals (${count} record${count === 1 ? '' : 's'})`;
    if (c.total && totals[c.key] !== undefined) return this.totalText(c, totals[c.key]);
    if (c.average && totals[c.key] !== undefined) return 'Avg ' + totals[c.key].toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
    return '';
  }

  /**
   * Split the payload into render blocks. A normal report is one block (all rows + grand
   * totals); a section-grouped report is one block per enabled section — heading, its own
   * column headers, its rows and its subtotal — with `totals: null` meaning "count only"
   * (Mutual Release). Disabled sections never reach here, so they cannot be exported.
   */
  private blocks(p: ExportPayload): Block[] {
    if (!p.sections?.length) return [{ label: null, count: p.totals.count ?? p.rows.length, rows: p.rows, totals: p.totals }];
    return p.sections.map((s) => ({
      label: s.label,
      count: s.count,
      rows: p.rows.filter((r) => r.section === s.key),
      totals: s.totals ?? null,
    }));
  }

  /** Heading sub-lines: selected deal type + applied filters (generated info goes in the footer). */
  private headingLines(p: ExportPayload): string[] {
    const out: string[] = [];
    if (p.dealTypeHeading) out.push(`Deal Type: ${p.dealTypeHeading}`);
    if (p.appliedFilters.length) out.push(p.appliedFilters.map((f) => `${f.label}: ${f.value}`).join('   |   '));
    return out;
  }
  private footerLeft(p: ExportPayload): string { return `Generated: ${longStamp(p.generatedAt)}  ·  by ${p.generatedBy}`; }
  private isLandscape(p: ExportPayload): boolean { return p.columns.length > LANDSCAPE_MIN_COLS; }

  // ---- XLSX ----
  async xlsx(p: ExportPayload): Promise<Buffer> {
    if (p.sheetStyle) return this.sheetXlsx(p);
    const wb = new ExcelJS.Workbook();
    wb.creator = p.branding;
    wb.created = p.generatedAt;
    const ws = wb.addWorksheet(p.reportName.slice(0, 28) || 'Report');
    const nCols = Math.max(1, p.columns.length);
    const centerAcross = (row: ExcelJS.Row): void => { ws.mergeCells(row.number, 1, row.number, nCols); row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' }; };

    const brandRow = ws.addRow([p.branding]);
    brandRow.font = { bold: true, size: 12, color: { argb: 'FF4F46E5' } };
    centerAcross(brandRow);
    const titleRow = ws.addRow([p.reportName]);
    titleRow.font = { bold: true, size: 15 };
    centerAcross(titleRow);
    for (const line of this.headingLines(p)) {
      const r = ws.addRow([line]);
      r.font = { italic: true, size: 9, color: { argb: 'FF64748B' } };
      centerAcross(r);
    }
    // "Generated: <long date/time TZ> · by <user>" — same line the PDF shows in its footer.
    const genRow = ws.addRow([this.footerLeft(p)]);
    genRow.font = { italic: true, size: 9, color: { argb: 'FF64748B' } };
    centerAcross(genRow);
    ws.addRow([]);

    const addHeader = (): number => {
      const idx = ws.rowCount + 1;
      const header = ws.addRow(p.columns.map((c) => c.label));
      header.height = 30;
      header.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFE7E9F1' } } };
      });
      return idx;
    };
    const addTotals = (totals: ReportTotals, count: number): void => {
      const row = ws.addRow(p.columns.map((c, i) => this.totalValue(totals, count, c, i === 0)));
      row.height = 22;
      row.eachCell((cell) => {
        cell.font = { bold: true };
        cell.border = { top: { style: 'thin' } };
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      });
      // TD-041 — the cell's number format follows the column type, exactly as the body cells above
      // do. A totalled COUNT column formatted as currency turned 128 documents into $128.00 in the
      // spreadsheet, where the value is also the one a reader sums or charts.
      p.columns.forEach((c, i) => {
        if (!c.total && !c.average) return;
        const cell = row.getCell(i + 1);
        if (c.type === 'currency') cell.numFmt = '$#,##0.00';
        else if (c.type === 'percent') cell.numFmt = '0.00"%"';
        else cell.numFmt = '#,##0.##';
      });
    };

    const blocks = this.blocks(p);
    let headerRowIdx = 0;
    blocks.forEach((b, bi) => {
      if (b.label !== null) {
        // section band: "Closed & Paid (3)" across the full width
        if (bi > 0) ws.addRow([]);
        const band = ws.addRow([`${b.label} (${b.count})`]);
        band.height = 22;
        ws.mergeCells(band.number, 1, band.number, nCols);
        const c1 = band.getCell(1);
        c1.font = { bold: true, size: 11, color: { argb: 'FF312E81' } };
        c1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
        c1.alignment = { horizontal: 'left', vertical: 'middle' };
      }
      const idx = addHeader();
      if (!headerRowIdx) headerRowIdx = idx;

      for (const row of b.rows) {
        const r = ws.addRow(p.columns.map((c) => this.cellValue(row, c)));
        r.height = 20;
        p.columns.forEach((c, i) => {
          const cell = r.getCell(i + 1);
          if (c.type === 'currency') cell.numFmt = '$#,##0.00';
          else if (c.type === 'percent') cell.numFmt = '0.00"%"';
          else if (c.type === 'date' || c.type === 'datetime') cell.numFmt = 'mmmm d, yyyy';
          // Left-aligned + vertically centred throughout; wrapping is word-based (Excel never
          // splits a word) and off entirely for numeric/date columns, so no amount is ever
          // broken across its decimal point.
          cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: !this.noWrap(c) };
        });
      }
      // Mutual Release carries a count but no financial subtotal.
      if (b.totals) addTotals(b.totals, b.totals.count ?? b.count);
    });

    // grand totals under a section-grouped report (sections already carry their own subtotals)
    if (p.sections?.length) { ws.addRow([]); addTotals(p.totals, p.totals.count ?? p.rows.length); }

    p.columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(12, Math.min(42, (c.width ?? c.label.length) + 4)); });
    ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
    // A section-grouped sheet has several header rows, so a single autofilter would be wrong.
    if (!p.sections?.length) ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: headerRowIdx, column: nCols } };
    // Print setup mirrors the PDF: auto orientation, fit to width, generated left / page right.
    ws.pageSetup = { orientation: this.isLandscape(p) ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.5, header: 0.2, footer: 0.2 } };
    ws.headerFooter = { oddFooter: `&L&8${this.footerLeft(p).replace(/&/g, '&&')}&R&8Page &P of &N` };

    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Typed cell value for XLSX (numbers/dates stay native so Excel sorts + formats them). */
  private cellValue(row: ReportRow, c: ReportColumn): string | number | Date {
    const v = row[c.key];
    if (v === null || v === undefined || v === '') return '—';
    if (c.type === 'currency' || c.type === 'percent') return Number(v);
    if (c.type === 'number') return Number(v);
    if (c.type === 'date' || c.type === 'datetime') { const d = new Date(String(v)); return isNaN(d.getTime()) ? String(v) : d; }
    return String(v);
  }
  private totalValue(totals: ReportTotals, count: number, c: ReportColumn, first: boolean): string | number {
    if (first) return `Totals (${count} record${count === 1 ? '' : 's'})`;
    if ((c.total || c.average) && totals[c.key] !== undefined) return totals[c.key];
    return '';
  }

  // ---- PDF ----
  async pdf(p: ExportPayload): Promise<Buffer> {
    if (p.sheetStyle) return this.sheetPdf(p);
    const doc = new PDFDocument({
      size: 'A4',
      layout: this.isLandscape(p) ? 'landscape' : 'portrait',
      margins: { top: 28, bottom: 42, left: 24, right: 24 },
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;
    const avail = right - left;

    // centred heading block (brand + report title), then deal type / filters
    doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND).text(p.branding, left, doc.page.margins.top, { width: avail, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#0f172a').text(p.reportName, left, doc.y + 1, { width: avail, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    for (const line of this.headingLines(p)) doc.text(line, left, doc.y + 2, { width: avail, align: 'center' });
    doc.moveDown(0.5);

    // proportional column widths so nothing is cut off
    const weights = p.columns.map((c) => Math.max(6, c.width ?? c.label.length));
    const total = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / total) * avail);
    const xs: number[] = []; let acc = left; for (const w of colW) { xs.push(acc); acc += w; }

    const FS = 7, PAD = 3;
    const wraps = p.columns.map((c) => !this.noWrap(c));
    const drawHeader = (y: number): number => {
      const h = this.rowHeight(doc, p.columns.map((c) => c.label), colW, FS, PAD, true);
      doc.rect(left, y, avail, h).fill(BRAND);
      doc.font('Helvetica-Bold').fontSize(FS).fillColor('white');
      p.columns.forEach((c, i) => doc.text(c.label, xs[i] + PAD, y + PAD, { width: colW[i] - PAD * 2, align: 'left' }));
      return y + h;
    };

    /** Totals-style band (section subtotal or grand total), same geometry as a body row. */
    const drawTotals = (y0: number, totals: ReportTotals, count: number): number => {
      const cells = p.columns.map((c, i) => this.totalCell(totals, count, c, i === 0));
      const h = this.rowHeight(doc, cells, colW, FS, PAD, true, p.columns.map(() => false));
      let y = y0;
      if (y + h > bottom) { doc.addPage(); y = drawHeader(doc.page.margins.top); }
      doc.rect(left, y, avail, h).fill('#eef2ff');
      doc.font('Helvetica-Bold').fontSize(FS).fillColor('#0f172a');
      // the totals row never wraps — "Totals (13 records)" and every amount stay on one line
      p.columns.forEach((_c, i) => {
        const opts = { width: colW[i] - PAD * 2, align: 'left' as const, lineBreak: false };
        const hh = doc.heightOfString(cells[i] || '', opts);
        doc.text(cells[i], xs[i] + PAD, y + Math.max(PAD, (h - hh) / 2), opts);
      });
      return y + h;
    };

    let y = doc.y;
    const blocks = this.blocks(p);
    blocks.forEach((b, bi) => {
      if (b.label !== null) {
        // section band: heading + dynamic transaction count, then this section's own headers
        const label = `${b.label} (${b.count})`;
        const bh = FS + PAD * 3;
        if (bi > 0) y += 6;
        if (y + bh + 24 > bottom) { doc.addPage(); y = doc.page.margins.top; }
        doc.rect(left, y, avail, bh).fill('#e0e7ff');
        doc.font('Helvetica-Bold').fontSize(FS + 1).fillColor('#312e81').text(label, left + PAD, y + PAD, { width: avail - PAD * 2, align: 'left' });
        y += bh;
      }
      y = drawHeader(y);

      b.rows.forEach((row, ri) => {
        const cells = p.columns.map((c) => this.cell(row, c));
        const h = this.rowHeight(doc, cells, colW, FS, PAD, false, wraps);
        if (y + h > bottom) { doc.addPage(); y = drawHeader(doc.page.margins.top); }
        if (ri % 2 === 1) doc.rect(left, y, avail, h).fill(ZEBRA);
        doc.fillColor('#0f172a').font('Helvetica').fontSize(FS);
        // left-aligned, vertically centred; wrapping is word-based and disabled entirely
        // for numeric/date columns so a value is never split mid-word or mid-decimal
        p.columns.forEach((c, i) => {
          const opts = { width: colW[i] - PAD * 2, align: 'left' as const, lineBreak: !this.noWrap(c) };
          const th = doc.heightOfString(cells[i] || '', opts);
          doc.text(cells[i], xs[i] + PAD, y + Math.max(PAD, (h - th) / 2), opts);
        });
        doc.moveTo(left, y + h).lineTo(right, y + h).strokeColor(LINE).lineWidth(0.4).stroke();
        y += h;
      });

      // Mutual Release carries a count but no financial subtotal.
      if (b.totals) y = drawTotals(y, b.totals, b.totals.count ?? b.count);
    });

    // grand totals under a section-grouped report (sections already carry their own subtotals)
    if (p.sections?.length) drawTotals(y + 6, p.totals, p.totals.count ?? p.rows.length);

    // page footer: generated (left) + page numbers (right).
    // margins.bottom is temporarily zeroed so writing inside the bottom margin does NOT
    // make PDFKit auto-append a blank page.
    const range = doc.bufferedPageRange();
    const stamp = this.footerLeft(p);
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 26;
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      doc.text(stamp, left, fy, { width: avail / 2, align: 'left', lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left + avail / 2, fy, { width: avail / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = saved;
    }

    doc.end();
    return done;
  }

  // ---- Payment Sheet style (Pending Payments) ----
  /*
   * THE BROKERAGE'S PAYMENT SHEET, reproduced (Payments sheet.pdf, 2026-10-14 — a Google Sheets
   * export). Navy column headers with white text, red section titles (dark red under a group), black
   * text on white with black gridlines, and the status cells tinted as the Sheet tints them. EVERY
   * CELL STAYS ON ONE LINE (brokerage request): text that does not fit ends in "…" — the XLSX keeps
   * the full text in the cell — and the totals label runs across the empty columns beside it rather
   * than being squeezed into the first one.
   */

  /** One block per section, with what it needs to draw its own headings and column titles. */
  private sheetBlocks(p: ExportPayload): SheetBlock[] {
    if (!p.sections?.length) return [{ label: null, group: null, description: null, count: p.rows.length, rows: p.rows, totals: p.totals, labels: {}, blank: [] }];
    return p.sections.map((s) => ({
      label: s.label, group: s.group ?? null, description: s.description ?? null, count: s.count,
      rows: p.rows.filter((r) => r.section === s.key), totals: s.totals ?? null,
      labels: s.columnLabels ?? {}, blank: s.blankColumns ?? [],
    }));
  }
  private sheetLabel(b: SheetBlock, c: ReportColumn): string { return b.blank.includes(c.key) ? '' : (b.labels[c.key] ?? c.label); }
  /** A body cell's text: blank where the column does not apply, and a prefix field in front of it. */
  private sheetCell(b: SheetBlock, row: ReportRow, c: ReportColumn): string {
    if (b.blank.includes(c.key)) return '';
    const v = this.cell(row, c);
    if (!c.prefixKey) return v;
    const pre = row[c.prefixKey];
    if (pre == null || pre === '') return v;
    return v === '—' ? String(pre) : `${pre} · ${v}`;
  }
  /** The totals band's cells: the label, then each column's total; the label's run of empty columns. */
  private sheetTotals(cols: ReportColumn[], totals: ReportTotals, count: number, label: string): { cells: string[]; span: number } {
    const cells = cols.map((c, i) => (i === 0 ? `${label} (${count} record${count === 1 ? '' : 's'})` : this.totalCell(totals, count, c, false)));
    let span = 1;
    while (span < cells.length && !cells[span]) span++;
    return { cells, span };
  }
  /** Fill for a status cell, in the Sheet's palette; null leaves it white. */
  private sheetFill(c: ReportColumn, text: string): string | null {
    if (c.type !== 'status' && !c.prefixKey) return null;
    const head = c.prefixKey ? text.split(' · ')[0] : text;
    return SHEET_STATUS_FILL[head] ?? null;
  }

  private async sheetPdf(p: ExportPayload): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 26, bottom: 40, left: 20, right: 20 }, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const bottom = doc.page.height - doc.page.margins.bottom;
    const avail = right - left;
    const FS = 6.6, PAD = 2.6, ROW = FS + PAD * 2 + 1.4;

    /** `text` cut to `width` with an ellipsis — never wrapped. */
    const fit = (text: string, width: number): string => {
      if (!text || doc.widthOfString(text) <= width) return text;
      let lo = 0, hi = text.length;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (doc.widthOfString(text.slice(0, mid) + '…') <= width) lo = mid; else hi = mid - 1; }
      return text.slice(0, lo).trimEnd() + '…';
    };
    const line = (x: number, y: number, w: number, h: number) => doc.rect(x, y, w, h).lineWidth(0.4).strokeColor(SHEET.grid).stroke();

    // heading: brokerage, then the report title on the right as the Sheet has it, then filters
    doc.font('Helvetica-Bold').fontSize(10).fillColor(SHEET.text).text(p.branding, left, doc.page.margins.top, { width: avail / 2, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(SHEET.text).text(p.reportName.toUpperCase(), left + avail / 2, doc.page.margins.top - 1, { width: avail / 2, align: 'right', lineBreak: false });
    let y = doc.page.margins.top + 16;
    doc.font('Helvetica').fontSize(7).fillColor(SHEET.muted);
    doc.text(`Updated as on: ${longStamp(p.generatedAt)}`, left, y, { width: avail, lineBreak: false });
    y += 10;
    for (const l of this.headingLines(p)) { doc.text(fit(l, avail), left, y, { width: avail, lineBreak: false }); y += 10; }
    y += 4;

    const weights = p.columns.map((c) => Math.max(4, c.width ?? c.label.length));
    const sum = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / sum) * avail);
    const xs: number[] = []; let acc = left; for (const w of colW) { xs.push(acc); acc += w; }

    const drawHeader = (b: SheetBlock, y0: number): number => {
      const labels = p.columns.map((c) => this.sheetLabel(b, c));
      // Column titles may take up to three lines (whole words only); body cells never do.
      doc.font('Helvetica-Bold').fontSize(FS);
      const h = Math.max(ROW, ...labels.map((t, i) => Math.min(doc.heightOfString(t || ' ', { width: colW[i] - PAD * 2 }), FS * 3.9) + PAD * 2));
      doc.rect(left, y0, avail, h).fill(SHEET.head);
      doc.fillColor('#ffffff');
      labels.forEach((t, i) => {
        doc.text(t, xs[i] + PAD, y0 + PAD, { width: colW[i] - PAD * 2, height: h - PAD * 2, ellipsis: true });
        line(xs[i], y0, colW[i], h);
      });
      return y0 + h;
    };
    const ensure = (b: SheetBlock, need: number): void => {
      if (y + need <= bottom) return;
      doc.addPage(); y = doc.page.margins.top; y = drawHeader(b, y);
    };
    const drawTotals = (b: SheetBlock, totals: ReportTotals, count: number, label: string): void => {
      const { cells, span } = this.sheetTotals(p.columns, totals, count, label);
      ensure(b, ROW);
      doc.rect(left, y, avail, ROW).fill(SHEET.total);
      doc.font('Helvetica-Bold').fontSize(FS).fillColor(SHEET.text);
      const spanW = colW.slice(0, span).reduce((a, w) => a + w, 0);
      doc.text(fit(cells[0], spanW - PAD * 2), left + PAD, y + PAD + 0.6, { width: spanW - PAD * 2, lineBreak: false });
      line(left, y, spanW, ROW);
      for (let i = span; i < cells.length; i++) {
        doc.text(fit(cells[i], colW[i] - PAD * 2), xs[i] + PAD, y + PAD + 0.6, { width: colW[i] - PAD * 2, lineBreak: false });
        line(xs[i], y, colW[i], ROW);
      }
      y += ROW;
    };

    const blocks = this.sheetBlocks(p);
    blocks.forEach((b, bi) => {
      if (b.label !== null) {
        y += bi > 0 ? 8 : 2;
        // a group title (e.g. "Agent Payments:") above the first of its sections
        if (b.group && b.group !== blocks[bi - 1]?.group) {
          if (y + ROW * 4 > bottom) { doc.addPage(); y = doc.page.margins.top; }
          doc.font('Helvetica-Bold').fontSize(FS + 2.4).fillColor(SHEET.title).text(`${b.group}:`, left, y, { lineBreak: false });
          y += FS + 7;
        }
        if (y + ROW * 3 > bottom) { doc.addPage(); y = doc.page.margins.top; }
        const indent = b.group ? 14 : 0;
        const title = `${b.label}:`;
        doc.font('Helvetica-Bold').fontSize(FS + (b.group ? 1.4 : 2.4)).fillColor(b.group ? SHEET.subtitle : SHEET.title);
        doc.text(title, left + indent, y, { lineBreak: false });
        const tw = doc.widthOfString(title);
        doc.font('Helvetica-Oblique').fontSize(FS).fillColor(SHEET.text);
        const note = `${b.count} record${b.count === 1 ? '' : 's'}${b.description ? `   ·   ${b.description}` : ''}`;
        doc.text(fit(note, avail - indent - tw - 12), left + indent + tw + 8, y + 1.6, { lineBreak: false });
        y += FS + 7;
      }
      y = drawHeader(b, y);

      for (const row of b.rows) {
        ensure(b, ROW);
        doc.font('Helvetica').fontSize(FS);
        p.columns.forEach((c, i) => {
          const text = this.sheetCell(b, row, c);
          const fill = text ? this.sheetFill(c, text) : null;
          if (fill) doc.rect(xs[i], y, colW[i], ROW).fill(fill);
          doc.fillColor(SHEET.text).text(fit(text, colW[i] - PAD * 2), xs[i] + PAD, y + PAD + 0.6, { width: colW[i] - PAD * 2, lineBreak: false });
          line(xs[i], y, colW[i], ROW);
        });
        y += ROW;
      }
      if (b.totals) drawTotals(b, b.totals, b.totals.count ?? b.count, b.label ? `${b.label} total` : 'Totals');
    });

    // grand total under a section-grouped report
    if (p.sections?.length) { y += 6; drawTotals(blocks[blocks.length - 1], p.totals, p.totals.count ?? p.rows.length, 'Total pending'); }

    const range = doc.bufferedPageRange();
    const stamp = this.footerLeft(p);
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 24;
      doc.font('Helvetica').fontSize(7).fillColor(SHEET.muted);
      doc.text(stamp, left, fy, { width: avail / 2, align: 'left', lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, left + avail / 2, fy, { width: avail / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = saved;
    }
    doc.end();
    return done;
  }

  private async sheetXlsx(p: ExportPayload): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = p.branding;
    wb.created = p.generatedAt;
    const ws = wb.addWorksheet(p.reportName.slice(0, 28) || 'Report');
    const nCols = Math.max(1, p.columns.length);
    const argb = (hex: string) => 'FF' + hex.replace('#', '').toUpperCase();
    const thin = { style: 'thin' as const, color: { argb: argb(SHEET.grid) } };
    const grid = { top: thin, left: thin, bottom: thin, right: thin };
    const oneLine = { horizontal: 'left' as const, vertical: 'middle' as const, wrapText: false };

    const title = ws.addRow([p.branding]);
    title.font = { bold: true, size: 11 };
    ws.mergeCells(title.number, 1, title.number, Math.ceil(nCols / 2));
    title.getCell(Math.ceil(nCols / 2) + 1).value = p.reportName.toUpperCase();
    title.getCell(Math.ceil(nCols / 2) + 1).font = { bold: true, size: 14 };
    ws.mergeCells(title.number, Math.ceil(nCols / 2) + 1, title.number, nCols);
    title.getCell(Math.ceil(nCols / 2) + 1).alignment = { horizontal: 'right' };
    for (const l of [`Updated as on: ${longStamp(p.generatedAt)}`, ...this.headingLines(p)]) {
      const r = ws.addRow([l]);
      r.font = { italic: true, size: 9, color: { argb: argb(SHEET.muted) } };
      ws.mergeCells(r.number, 1, r.number, nCols);
    }
    ws.addRow([]);

    let firstHeader = 0;
    const blocks = this.sheetBlocks(p);
    const addTotals = (totals: ReportTotals, count: number, label: string): void => {
      const { cells, span } = this.sheetTotals(p.columns, totals, count, label);
      const r = ws.addRow(p.columns.map((c, i) => (i === 0 ? cells[0] : (c.total || c.average) && totals[c.key] !== undefined ? totals[c.key] : '')));
      r.height = 18;
      if (span > 1) ws.mergeCells(r.number, 1, r.number, span);
      p.columns.forEach((c, i) => {
        const cell = r.getCell(i + 1);
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(SHEET.total) } };
        cell.border = grid;
        cell.alignment = oneLine;
        if (c.type === 'currency') cell.numFmt = '$#,##0.00';
      });
    };
    blocks.forEach((b, bi) => {
      if (b.label !== null) {
        if (bi > 0) ws.addRow([]);
        if (b.group && b.group !== blocks[bi - 1]?.group) {
          const g = ws.addRow([`${b.group}:`]);
          g.font = { bold: true, size: 12, color: { argb: argb(SHEET.title) } };
        }
        const t = ws.addRow([`${b.label}:`, `${b.count} record${b.count === 1 ? '' : 's'}${b.description ? ` · ${b.description}` : ''}`]);
        t.getCell(1).font = { bold: true, size: b.group ? 11 : 12, color: { argb: argb(b.group ? SHEET.subtitle : SHEET.title) } };
        t.getCell(2).font = { italic: true, size: 9 };
        ws.mergeCells(t.number, 2, t.number, nCols);
      }
      const head = ws.addRow(p.columns.map((c) => this.sheetLabel(b, c)));
      if (!firstHeader) firstHeader = head.number;
      head.height = 30;
      head.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(SHEET.head) } };
        cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        cell.border = grid;
      });
      for (const row of b.rows) {
        const r = ws.addRow(p.columns.map((c) => {
          if (b.blank.includes(c.key)) return '';
          return c.prefixKey ? this.sheetCell(b, row, c) : this.cellValue(row, c);
        }));
        r.height = 16;
        p.columns.forEach((c, i) => {
          const cell = r.getCell(i + 1);
          if (c.type === 'currency') cell.numFmt = '$#,##0.00';
          else if (c.type === 'date' || c.type === 'datetime') cell.numFmt = 'mmmm d, yyyy';
          cell.alignment = oneLine;
          cell.border = grid;
          const fill = this.sheetFill(c, String(cell.value ?? ''));
          if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(fill) } };
        });
      }
      if (b.totals) addTotals(b.totals, b.totals.count ?? b.count, b.label ? `${b.label} total` : 'Totals');
    });
    if (p.sections?.length) { ws.addRow([]); addTotals(p.totals, p.totals.count ?? p.rows.length, 'Total pending'); }

    // Widths are in PDF points at 6.6 pt (about 3.3 pt a character); the same characters fit the cell.
    p.columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(6, Math.round((c.width ?? c.label.length * 3.3) / 3.3) + 2); });
    if (firstHeader) ws.views = [{ state: 'frozen', ySplit: firstHeader }];
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.5, header: 0.2, footer: 0.2 } };
    ws.headerFooter = { oddFooter: `&L&8${this.footerLeft(p).replace(/&/g, '&&')}&R&8Page &P of &N` };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /**
   * Max wrapped height of a row's cells at the given column widths (uniform row geometry).
   * `wraps` mirrors the per-column lineBreak used when drawing, so the measured height
   * matches what is actually rendered.
   */
  private rowHeight(doc: PDFKit.PDFDocument, cells: string[], colW: number[], fontSize: number, pad: number, bold: boolean, wraps?: boolean[]): number {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
    let max = fontSize + pad * 2;
    cells.forEach((txt, i) => {
      const h = doc.heightOfString(txt || '', { width: colW[i] - pad * 2, lineBreak: wraps ? wraps[i] : true }) + pad * 2;
      if (h > max) max = h;
    });
    return Math.min(max, 56);
  }
}
