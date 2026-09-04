import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { ExportPayload, ReportColumn, ReportRow, ReportTotals } from './report.types';

/** One rendered block: a whole report, or one section of a section-grouped report. */
interface Block { label: string | null; count: number; rows: ReportRow[]; totals: ReportTotals | null }

const BRAND = '#4f46e5', MUTED = '#64748b', LINE = '#e7e9f1', ZEBRA = '#fafbff';
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
