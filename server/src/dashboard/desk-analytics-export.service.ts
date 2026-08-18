import { Injectable } from '@nestjs/common';
import { DeskAnalyticsService, type DeskAnalytics } from './desk-analytics.service';
import { ReportExportService } from '../reports/report-export.service';
import { CompanySettingsService } from '../settings/company-settings.service';
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
  ) {}

  async xlsx(user: ScopedUser | null, filters: AnalyticsFilters): Promise<{ buffer: Buffer; filename: string }> {
    const data = await this.analytics.summary(user, filters);
    const branding = (await this.settings.current()).name;
    const generatedAt = new Date();

    const payload: ExportPayload = {
      reportName: 'Transaction Desk Analytics',
      generatedAt,
      generatedBy: (user?.name ?? '').trim() || 'Unknown',
      appliedFilters: this.appliedFilters(filters, data),
      dealTypeHeading: filters.type ?? null,
      columns: COLUMNS,
      rows: this.rows(data),
      // The footer totals the two figures that ARE additive down the sheet. `count` is not summed
      // here because the same deal appears in the month block and again in the agent block; the
      // deal count for the filtered set is stated once, in the Summary block above.
      totals: { count: 0 },
      branding,
      sections: SECTIONS.map((s) => ({ ...s, count: this.rows(data).filter((r) => r.section === s.key).length })),
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
    for (const m of a.by_month) out.push({ section: 'by_month', group: m.month, count: null, commission: m.total });
    for (const r of a.by_agent) out.push({ section: 'by_agent', group: r.agent, count: r.count, commission: r.total });
    for (const r of a.by_type) out.push({ section: 'by_type', group: r.type, count: r.count, commission: r.total });
    return out;
  }

  /** The filter chips printed in the workbook header, so the file says what it is a view of. */
  private appliedFilters(f: AnalyticsFilters, a: DeskAnalytics): { label: string; value: string }[] {
    const out: { label: string; value: string }[] = [
      { label: 'Basis', value: 'Commission figures are before HST' },
    ];
    if (f.from || f.to) out.push({ label: 'Date', value: `${f.from ?? '…'} → ${f.to ?? '…'}` });
    if (f.type) out.push({ label: 'Deal Type', value: f.type });
    if (f.status) out.push({ label: 'Status', value: f.status });
    if (f.agent_user_id !== undefined) {
      // The name is taken from the result rather than looked up again: `by_agent` is already scoped
      // and already filtered, so it names exactly whose figures these are — and an export that had
      // to re-resolve an id could name somebody the rows do not belong to.
      out.push({ label: 'Agent', value: a.by_agent[0]?.agent ?? `#${f.agent_user_id}` });
    }
    return out;
  }
}
