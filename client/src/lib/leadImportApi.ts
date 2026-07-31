import api from './axios';

/**
 * Starting and following a CSV lead import.
 *
 * The import used to be one POST that returned when it had finished. For a large file that meant
 * holding the request open for minutes — past a proxy timeout — so the browser showed a failure
 * over an import the server was still happily running. It is now a queued job: the POST returns
 * straight away with an id, and progress is polled.
 *
 * Both the Leads screen and the Campaigns screen import through here, against the same server-side
 * queue. They previously had separate implementations that had quietly diverged — only one of them
 * de-duplicated addresses within the uploaded file — so the same file gave different results
 * depending on which screen it was dropped on.
 */

export interface ImportJob {
  job_id: string;
  status: 'Queued' | 'Processing' | 'Completed' | 'Failed';
  total_rows: number;
  processed_rows: number;
  percent: number;
  imported: number;
  tagged: number;
  duplicate: number;
  invalid: number;
  failure_reason: string | null;
  /** Phrased by the server, so every screen says the same thing. */
  message: string;
  done: boolean;
}

/** Which screen is importing. Only changes the endpoint; the work and the rules are identical. */
export type ImportSource = 'leads' | 'campaigns';

const base = (source: ImportSource) => (source === 'campaigns' ? '/api/campaigns/leads/import' : '/api/leads/import');

export const startLeadImport = (csv: string, tag: string, source: ImportSource = 'leads'): Promise<ImportJob> =>
  api.post<ImportJob>(base(source), { csv, tag }).then((r) => r.data);

export const leadImportStatus = (jobId: string, source: ImportSource = 'leads'): Promise<ImportJob> =>
  api.get<ImportJob>(`${base(source)}/${jobId}`).then((r) => r.data);

/** Imports the caller has run recently, so a reloaded page can pick a running one back up. */
export const recentLeadImports = (): Promise<ImportJob[]> =>
  api.get<ImportJob[]>('/api/leads/imports/recent').then((r) => r.data);

const POLL_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start an import and follow it to completion, reporting progress as it goes.
 *
 * `cancelled` lets a caller stop polling when its screen goes away. It does NOT stop the import —
 * that is the point of moving the work off the request, and stopping a half-finished import would
 * be worse than letting it finish. It only stops this browser asking about it.
 *
 * A poll that fails is ignored rather than fatal: one dropped request during a five-minute import
 * should not report failure for a job that is running perfectly well. A job that has genuinely
 * failed says so in its own status.
 */
export async function runLeadImport(
  csv: string,
  tag: string,
  opts: { source?: ImportSource; onProgress?: (job: ImportJob) => void; cancelled?: () => boolean } = {},
): Promise<ImportJob> {
  const source = opts.source ?? 'leads';
  let job = await startLeadImport(csv, tag, source);
  opts.onProgress?.(job);

  while (!job.done) {
    if (opts.cancelled?.()) return job;
    await sleep(POLL_MS);
    try {
      job = await leadImportStatus(job.job_id, source);
      opts.onProgress?.(job);
    } catch {
      // Transient — keep polling. The job is on the server, not in this tab.
    }
  }
  return job;
}
