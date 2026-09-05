import { Injectable } from '@nestjs/common';
import { DeskAnalyticsService, NO_CLOSING_DATE, type DeskAnalytics } from './desk-analytics.service';
import { ReportExportService } from '../reports/report-export.service';
import { CompanySettingsService } from '../settings/company-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AnalyticsFilters } from './desk-analytics.filters';
import type { ScopedUser } from '../common/transaction-scope';
import type { ExportPayload, ReportColumn, ReportRow } from '../reports/report.types';

/**
 * The Analytics screen, as a spreadsheet.
 *
 * IT REUSES THE REPORTS EXPORT RENDERER rather than introducing a second one. `ReportExportService`
 * already renders a branded, sectioned workbook with a heading, the applied filters and a totals
 * row, and it is the renderer every Transaction Desk export goes through — a separate engine here
 * would be a second thing to keep formatted, branded and correct.
 *
 * IT ALSO REUSES THE SCREEN'S OWN QUERY. The export calls `DeskAnalyticsService.summary()` with the
 * caller and the same parsed filters, so there is no second definition of what Analytics means and
 * no way for the file to contain a different set of deals from the chart it was exported from. That
 * matters for authorization as much as for arithmetic: the scope rule, the agent lock and the filter
 * validation are all upstream of this file, and it cannot reach past them.
 */

/** The workbook's three blocks, rendered as sections of one sheet. */
const SECTIONS = [
  { key: 'summary', label: 'Summary' },
  { key: 'by_month', label: 'By Month' },
  { key: 'by_agent', label: 'By Agent' },
  { key: 'by_type', label: 'By Transaction Type' },
];

const COLUMNS: ReportColumn[] = [
  { key: 'group', label: 'Group', type: 'text', default: true, width: 34 },
  { key: 'count', label: 'Deals', type: 'number', default: true, width: 12 },
  { key: 'commission', label: 'Commission (before HST)', type: 'currency', default: true, width: 24 },
];

@Injectable()
export class DeskAnalyticsExportService {
  constructor(
    private readonly analytics: DeskAnalyticsService,
    private readonly exporter: ReportExportService,
    private readonly settings: CompanySettingsService,
    // TD-064 - to name the agent the caller actually filtered by, rather than guessing from rows.
    private readonly prisma: PrismaService,
  ) {}

  async xlsx(user: ScopedUser | null, filters: AnalyticsFilters): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.analytics.summary(user, filters);
    const branding = (await this.settings.current()).name;
    const generatedAt = new Date();

    // TD-064 - built once. The rows are the sheet, the section counts and the record count, and
    // deriving them three times invited the three to disagree.
    const rows = this.rows(data);

    const payload: ExportPayload = {
      reportName: 'Transaction Desk Analytics',
      generatedAt,
      generatedBy: (user?.name ?? '').trim() || 'Unknown',
      appliedFilters: await this.appliedFilters(filters),
      dealTypeHeading: filters.type ?? null,
      columns: COLUMNS,
      rows,
      // The footer totals the two figures that ARE additive down the sheet. `count` is not summed
      // here because the same deal appears in the month block and again in the agent block; the
      // deal count for the filtered set is stated once, in the Summary block above.
      /*
       * TD-064 - the number of rows this sheet actually carries.
       *
       * This was `0`, with a comment explaining that deal counts must not be summed down the sheet
       * because the same deal appears in the month block and again in the agent block. That
       * reasoning is right, but it was applied to the wrong thing: the Deals column is not declared
       * `total`, so it was never going to print a column total, and `totals.count` feeds only the
       * record count in the footer - which the renderer reads as `p.totals.count ?? p.rows.length`.
       * `??` does not fall back on 0, so a populated workbook signed off "Totals (0 records)".
       */
      totals: { count: rows.length },
      branding,
      sections: SECTIONS.map((s) => ({ ...s, count: rows.filter((r) => r.section === s.key).length })),
    };

    return {
      buffer: await this.exporter.xlsx(payload),
      filename: `Transaction Desk Analytics ${this.exporter.fileStamp(generatedAt)}.xlsx`,
    };
  }

  /**
   * Every figure the screen shows, as rows — one block per panel.
   *
   * The Summary block states the basis in words. A spreadsheet outlives the screen it came from and
   * gets forwarded without its context, so "Commission figures are before HST" has to be IN the file
   * rather than implied by the column heading — the same reason the tiles say it.
   */
  private rows(a: DeskAnalytics): ReportRow[] {
    const out: ReportRow[] = [
      { section: 'summary', group: 'Total commission (before HST)', count: a.totals.paid_count + a.totals.pending_count, commission: a.totals.total },
      { section: 'summary', group: 'Paid (before HST)', count: a.totals.paid_count, commission: a.totals.paid },
      { section: 'summary', group: 'Pending (before HST)', count: a.totals.pending_count, commission: a.totals.pending },
    ];
    /*
     * TD-092 — the no-closing-date bucket is spelled out in the file too.
     *
     * An export outlives the screen it came from: a row keyed `none` in a workbook headed "By
     * Month" is a puzzle to whoever opens it, and the whole point of the bucket is that it says
     * what it is.
     */
    for (const m of a.by_month) {
      const group = m.month === NO_CLOSING_DATE ? 'No closing date' : m.month;
      out.push({ section: 'by_month', group, count: null, commission: m.total });
    }
    for (const r of a.by_agent) out.push({ section: 'by_agent', group: r.agent, count: r.count, commission: r.total });
    for (const r of a.by_type) out.push({ section: 'by_type', group: r.type, count: r.count, commission: r.total });
    return out;
  }

  /** The filter chips printed in the workbook header, so the file says what it is a view of. */
  private async appliedFilters(f: AnalyticsFilters): Promise<{ label: string; value: string }[]> {
    const out: { label: string; value: string }[] = [
      { label: 'Basis', value: 'Commission figures are before HST' },
    ];
    if (f.from || f.to) out.push({ label: 'Date', value: `${f.from ?? '…'} → ${f.to ?? '…'}` });
    if (f.type) out.push({ label: 'Deal Type', value: f.type });
    if (f.status) out.push({ label: 'Status', value: f.status });
    if (f.agent_user_id !== undefined) {
      /*
       * TD-064 - the agent the caller FILTERED BY, resolved from the id they selected.
       *
       * This read `by_agent[0].agent`, and the comment here argued that taking the name from the
       * result was safer than re-resolving the id. It is not: `by_agent` groups by the deal's agent
       * NAME, which is free text (TD-045), so the first row is whichever name sorts first among the
       * scoped deals - not the person who was asked for. Measured 2026-08-21, a workbook filtered to
       * Aswini carried the header "Agent: Sai".
       *
       * The id IS the filter, and `parseAnalyticsFilters` has already refused an agent asking for
       * anyone else's figures, so resolving it names exactly who was asked for. The id remains the
       * fallback when the account no longer exists, so the header is never silently blank.
       */
      const named = await this.prisma.users.findUnique({
        where: { id: f.agent_user_id },
        select: { name: true },
      });
      out.push({ label: 'Agent', value: named?.name?.trim() || `#${f.agent_user_id}` });
    }
    return out;
  }
}
