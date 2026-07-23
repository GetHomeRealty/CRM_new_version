import api from './axios';
import type {
  ReportListItem, ReportMeta, ReportResult, ReportFilterOptions, ReportSearchBody,
  ReportDocuments, ReminderRequest, ReminderPreview, ReminderResult,
} from '../types';

/** Reports API client (uses the shared Sanctum-authenticated axios instance). */

export const listReports = (): Promise<ReportListItem[]> =>
  api.get<ReportListItem[]>('/api/reports').then((r) => r.data);

export const reportFilterOptions = (): Promise<ReportFilterOptions> =>
  api.get<ReportFilterOptions>('/api/reports/filter-options').then((r) => r.data);

export const reportColumns = (type: string): Promise<ReportMeta> =>
  api.get<ReportMeta>(`/api/reports/${type}/columns`).then((r) => r.data);

export const runReport = (type: string, body: ReportSearchBody): Promise<ReportResult> =>
  api.post<ReportResult>(`/api/reports/${type}/search`, body).then((r) => r.data);

/** Expand one deal to its individual documents (pending / invalid / valid kept separate). */
export const reportDocuments = (transactionId: number): Promise<ReportDocuments> =>
  api.get<ReportDocuments>(`/api/reports/documents/${transactionId}`).then((r) => r.data);

/** What a reminder would send — shown to the user before anything goes out. */
export const previewReminders = (body: ReminderRequest): Promise<ReminderPreview> =>
  api.post<ReminderPreview>('/api/reports/reminders/preview', body).then((r) => r.data);

/** Send documentation reminders (individual, whole-deal, or bulk across deals). */
export const sendReminders = (body: ReminderRequest): Promise<ReminderResult> =>
  api.post<ReminderResult>('/api/reports/reminders/send', body).then((r) => r.data);

/** POST the filter/column selection and download the returned XLSX/PDF blob (complete dataset). */
export async function exportReport(type: string, format: 'xlsx' | 'pdf', body: ReportSearchBody): Promise<void> {
  const res = await api.post(`/api/reports/${type}/export/${format}`, body, { responseType: 'blob' });
  const dispo = String(res.headers['content-disposition'] ?? '');
  const m = /filename="?([^";]+)"?/i.exec(dispo);
  const name = m ? m[1] : `${type}.${format}`;
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
