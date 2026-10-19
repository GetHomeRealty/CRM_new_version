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
