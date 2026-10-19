import type { ReportFilterValues } from '../types';

/**
 * THE REPORT YOU WERE ON, REMEMBERED FOR THIS BROWSER TAB (brokerage request, 2026-10-19).
 *
 * Opening a report and then another module used to bring you back to the top of the Reports list.
 * Now the report page records itself here, and the Reports list reopens it — with its filters, page,
 * sort and columns — when you return from elsewhere. Going back to the list on purpose (← Reports,
 * or the browser's Back) forgets it, so the list is always reachable.
 *
 * sessionStorage: one tab, gone when the tab closes, never shared. Tied to the signed-in user, so a
 * different person signing in on the same tab starts at the list. Every access is guarded — storage
 * can be unavailable, and then this simply remembers nothing.
 */
export interface LastReport {
  user: number | string | null;
  type: string;
  draft: ReportFilterValues;
  applied: ReportFilterValues;
  page: number;
  perPage: number;
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  selectedCols: string[] | null;
  sections: string[] | null;
}

const KEY = 'desk.reports.last';

export function readLastReport(user: number | string | null | undefined): LastReport | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as LastReport;
    return v && typeof v.type === 'string' && v.type && v.user === (user ?? null) ? v : null;
  } catch { return null; }
}

export function saveLastReport(v: LastReport): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

export function forgetLastReport(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

/*
 * THE SECTION TO RETURN TO (brokerage request, 2026-10-19, second part).
 *
 * Kept apart from the report above, and NOT forgotten on the way back to the list: going back from
 * a Documentation and Compliance report lands on that section of the list, not at the top. Replaced
 * each time another report is opened. Same tab, same user, same guards.
 */
const FOCUS_KEY = 'desk.reports.focus';

export function saveReportFocus(user: number | string | null | undefined, type: string): void {
  try { sessionStorage.setItem(FOCUS_KEY, JSON.stringify({ user: user ?? null, type })); } catch { /* storage unavailable */ }
}

export function readReportFocus(user: number | string | null | undefined): string | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(FOCUS_KEY) || 'null') as { user: unknown; type: unknown } | null;
    return v && typeof v.type === 'string' && v.user === (user ?? null) ? v.type : null;
  } catch { return null; }
}
