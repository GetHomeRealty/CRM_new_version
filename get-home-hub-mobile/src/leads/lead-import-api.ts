import { environment } from '@/config/environment';

export interface LeadImportJob {
  job_id: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  percent: number;
  imported: number;
  tagged: number;
  duplicate: number;
  invalid: number;
  failure_reason: string | null;
  message: string;
  done: boolean;
}

export function validImportJob(value: unknown): value is LeadImportJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as LeadImportJob;
  return typeof job.job_id === 'string' && job.job_id.length > 0 && typeof job.status === 'string'
    && typeof job.message === 'string' && typeof job.done === 'boolean'
    && (job.failure_reason === null || typeof job.failure_reason === 'string')
    && ['total_rows', 'processed_rows', 'imported', 'tagged', 'duplicate', 'invalid'].every(key => {
      const count = job[key as keyof LeadImportJob];
      return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
    }) && job.processed_rows <= job.total_rows && Number.isFinite(job.percent) && job.percent >= 0 && job.percent <= 100;
}

/** Uses the caller-scoped recent endpoint; never starts or resumes an import. */
export async function fetchRecentLeadImports(token: string, signal?: AbortSignal): Promise<LeadImportJob[]> {
  if (!token) throw new Error('Please sign in to view imports.');
  if (signal?.aborted) throw new Error('Import history request cancelled.');
  const response = await fetch(`${environment.apiUrl}/api/leads/imports/recent`, {
    method: 'GET', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }).catch(() => { throw new Error('Could not connect. Retry loading import history.'); });
  if (!response.ok) throw new Error(response.status === 401 ? 'Please sign in again.'
    : response.status === 403 ? 'You do not have access to lead imports.' : 'Could not load import history. Please retry.');
  const body = await response.json().catch(() => { throw new Error('Import history could not be read. Please retry.'); });
  if (!Array.isArray(body) || !body.every(validImportJob)) throw new Error('Import history is invalid. Please retry.');
  return body;
}

export function validateImport(csv: string, tag: string): void {
  if (!csv.trim() || csv.length > 250_000 || csv.includes('\0')) throw new Error('Choose a non-empty UTF-8 CSV of at most 250,000 characters.');
  if (!csv.includes('\n') && !csv.includes('\r')) throw new Error('Include a header and at least one data row.');
  if (tag.length > 100 || /[\x00-\x1f\x7f]/.test(tag)) throw new Error('Use a tag of at most 100 characters without line breaks.');
}

/** Single submission only: callers must persist a pending record BEFORE invoking. */
export async function submitLeadImport(token: string, csv: string, tag: string, signal?: AbortSignal): Promise<LeadImportJob> {
  if (!token || signal?.aborted) throw new Error('Sign in and review your import before submitting.');
  validateImport(csv, tag);
  const uncertain = 'Import submission could not be confirmed. Check import history; do not upload the file again.';
  const response = await fetch(`${environment.apiUrl}/api/leads/import`, {
    method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv, tag: tag.trim() }),
  }).catch(() => { throw new Error(uncertain); });
  if (!response.ok) throw new Error(response.status === 403 ? 'You do not have permission to import leads.' : uncertain);
  const body = await response.json().catch(() => { throw new Error(uncertain); });
  if (!validImportJob(body)) throw new Error(uncertain);
  return body;
}
