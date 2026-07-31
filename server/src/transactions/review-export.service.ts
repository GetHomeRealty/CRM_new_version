import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import pdfMake from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { PrismaService } from '../prisma/prisma.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { toDateTimeString } from '../common/serialize';
import { TransactionReviewService, type ReviewFilters } from './transaction-review.service';
import type { AuthUserRecord } from '../auth/auth.types';

/**
 * Review history as a spreadsheet or a document.
 *
 * The export honours whatever filters the screen had applied — exporting "everything" from a screen
 * showing open items only is how a report ends up disagreeing with the page it was taken from — and
 * it is unpaginated, because a page boundary is a property of a screen, not of a record set.
 *
 * XLSX uses ExcelJS as the reports module does. The PDF uses pdfmake rather than the reports
 * module's hand-drawn pdfkit tables: this is a narrow, fixed-column document, and pdfmake gives it
 * a real table with repeating headers for a tenth of the code.
 */

const NAVY = '#1f3b73';
const HEADERS = ['When', 'Decision', 'Resolution', 'Field', 'Was', 'Changed to', 'Reason / note', 'Auto-revert', 'Agent', 'Reviewed by', 'Corrected', 'Resolved'];

let fontsReady = false;
function configurePdf(): void {
  if (fontsReady) return;
  pdfMake.addFonts({
    Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
  });
  const standard = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique']);
  pdfMake.setUrlAccessPolicy(() => false);
  pdfMake.setLocalAccessPolicy((t) => standard.has(t));
  fontsReady = true;
}

@Injectable()
export class ReviewExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CompanySettingsService,
    private readonly reviews: TransactionReviewService,
  ) {}

  /** Filename the browser saves it as. Kept to characters every filesystem accepts. */
  filename(tradeNo: string | null, ext: string): string {
    const deal = String(tradeNo ?? 'transaction').replace(/[^\w.-]/g, '');
    return `Review History - ${deal}.${ext}`;
  }

  async xlsx(user: AuthUserRecord | null, txnId: number, filters: ReviewFilters): Promise<{ buffer: Buffer; filename: string }> {
    const { rows, txn, company, heading } = await this.gather(user, txnId, filters);

    const wb = new ExcelJS.Workbook();
    wb.creator = company;
    wb.created = new Date();
    const ws = wb.addWorksheet('Review History');

    const wide = (r: ExcelJS.Row) => { ws.mergeCells(r.number, 1, r.number, HEADERS.length); r.getCell(1).alignment = { horizontal: 'center' }; };
    const brand = ws.addRow([company]);
    brand.font = { bold: true, size: 12, color: { argb: 'FF1F3B73' } };
    wide(brand);
    const title = ws.addRow(['Review History']);
    title.font = { bold: true, size: 15 };
    wide(title);
    for (const line of heading) {
      const r = ws.addRow([line]);
      r.font = { italic: true, size: 9, color: { argb: 'FF64748B' } };
      wide(r);
    }
    ws.addRow([]);

    const header = ws.addRow(HEADERS);
    header.height = 26;
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B73' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });

    for (const r of rows) {
      const row = ws.addRow(this.cells(r));
      row.alignment = { vertical: 'top', wrapText: true };
      // The two that need finding at a glance keep their colour in the spreadsheet as well.
      if (r.decision === 'Rejected') row.getCell(2).font = { bold: true, color: { argb: 'FFB91C1C' } };
      if (r.resolution_status === 'Open') row.getCell(3).font = { bold: true, color: { argb: 'FFB45309' } };
      if (r.resolution_status === 'Resolved') row.getCell(3).font = { color: { argb: 'FF15803D' } };
    }

    ws.columns.forEach((c, i) => { c.width = [18, 12, 13, 26, 20, 20, 44, 30, 18, 18, 22, 22][i] ?? 18; });
    ws.views = [{ state: 'frozen', ySplit: header.number }];

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, filename: this.filename(txn.trade_no, 'xlsx') };
  }

  async pdf(user: AuthUserRecord | null, txnId: number, filters: ReviewFilters): Promise<{ buffer: Buffer; filename: string }> {
    configurePdf();
    const { rows, txn, company, heading } = await this.gather(user, txnId, filters);

    // Narrower than the spreadsheet on purpose: the columns that matter on paper are what was
    // decided, about what, and why. The rest is in the XLSX for anyone reconciling.
    const cols = ['When', 'Decision', 'Resolution', 'Field', 'Was → Changed to', 'Reason / note', 'Reviewed by'];
    const body: Content[][] = [
      cols.map((h) => ({ text: h, bold: true, fontSize: 8, color: '#ffffff', fillColor: NAVY })),
      ...rows.map((r) => [
        { text: r.created_at ?? '—', fontSize: 7.5 },
        { text: r.decision, fontSize: 7.5, bold: true, color: r.decision === 'Rejected' ? '#b91c1c' : '#15803d' },
        { text: r.resolution_status, fontSize: 7.5, color: r.resolution_status === 'Open' ? '#b45309' : r.resolution_status === 'Resolved' ? '#15803d' : '#1d4ed8' },
        { text: r.field_label ?? 'All agent changes', fontSize: 7.5 },
        { text: r.old_value || r.new_value ? `${r.old_value ?? '—'} → ${r.new_value ?? '—'}` : '—', fontSize: 7.5 },
        { text: [r.reason ?? '', r.auto_revert_result ? `\n${r.auto_revert_result}` : ''].join(''), fontSize: 7.5 },
        { text: r.actor_name ?? '—', fontSize: 7.5 },
      ]),
    ];

    const definition: TDocumentDefinitions = {
      pageSize: 'A4',
      pageOrientation: 'landscape',
      pageMargins: [28, 30, 28, 34],
      defaultStyle: { font: 'Helvetica', fontSize: 8, color: '#111827' },
      info: { title: `Review History — ${txn.trade_no ?? txnId}`, author: company },
      content: [
        { text: company, alignment: 'center', bold: true, fontSize: 11, color: NAVY },
        { text: 'Review History', alignment: 'center', bold: true, fontSize: 15, margin: [0, 2, 0, 4] },
        ...heading.map((line) => ({ text: line, alignment: 'center' as const, fontSize: 8, italics: true, color: '#64748b' })),
        {
          table: { headerRows: 1, widths: [58, 42, 46, 92, 110, '*', 62], body },
          layout: {
            hLineWidth: (i: number) => (i <= 1 ? 0.9 : 0.4),
            vLineWidth: () => 0.4,
            hLineColor: (i: number) => (i === 1 ? NAVY : '#d1d5db'),
            vLineColor: () => '#d1d5db',
            paddingTop: () => 3,
            paddingBottom: () => 3,
            // Zebra striping. `null` rather than undefined: pdfmake's own type for a dynamic fill
            // is "a colour or null", and undefined is not in it.
            fillColor: (i: number) => (i !== 0 && i % 2 === 0 ? '#fafbfc' : null),
          },
          margin: [0, 8, 0, 0],
        },
      ],
      footer: (page, total) => ({
        columns: [
          { text: `Generated ${toDateTimeString(new Date())} · ${rows.length} record${rows.length === 1 ? '' : 's'}`, fontSize: 7, color: '#9ca3af', margin: [28, 12, 0, 0] },
          { text: `Page ${page} of ${total}`, fontSize: 7, color: '#9ca3af', alignment: 'right', margin: [0, 12, 28, 0] },
        ],
      }),
    };

    const out = await pdfMake.createPdf(definition).getBuffer();
    return { buffer: Buffer.from(out), filename: this.filename(txn.trade_no, 'pdf') };
  }

  /** The rows and the context both formats print, fetched once. */
  private async gather(user: AuthUserRecord | null, txnId: number, filters: ReviewFilters) {
    // Unpaginated: a page boundary belongs to a screen, not to an exported record set.
    const page = await this.reviews.list(user, txnId, { ...filters, page: 1, per_page: 1000 });
    const rows = page.data as ReviewRow[];

    const txn = await this.prisma.transactions.findUnique({
      where: { id: txnId },
      select: { trade_no: true, property: true, agent: true },
    });
    const company = (await this.settings.current()).name;

    const applied = Object.entries(filters)
      .filter(([k, v]) => !['page', 'per_page'].includes(k) && v !== undefined && v !== '')
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`);

    const heading = [
      `${txn?.trade_no ?? txnId} — ${txn?.property ?? 'Untitled'}${txn?.agent ? ` · ${txn.agent}` : ''}`,
      `${rows.length} record${rows.length === 1 ? '' : 's'}${applied.length ? ` · filtered by ${applied.join(', ')}` : ''}`,
    ];
    return { rows, txn: txn ?? { trade_no: null, property: null, agent: null }, company, heading };
  }

  private cells(r: ReviewRow): (string | number)[] {
    return [
      r.created_at ?? '',
      r.decision,
      r.resolution_status,
      r.field_label ?? 'All agent changes',
      r.old_value ?? '',
      r.new_value ?? '',
      r.reason ?? '',
      r.auto_revert_result ?? '',
      r.agent_name ?? '',
      r.actor_name ?? '',
      r.corrected_at ? `${r.corrected_at}${r.corrected_by ? ` · ${r.corrected_by}` : ''}` : '',
      r.resolved_at ? `${r.resolved_at}${r.resolved_by ? ` · ${r.resolved_by}` : ''}` : '',
    ];
  }
}

interface ReviewRow {
  decision: string;
  resolution_status: string;
  field_label: string | null;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  auto_revert_result: string | null;
  agent_name: string | null;
  actor_name: string | null;
  corrected_at: string | null;
  corrected_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string | null;
}
