import type { ImportJob } from '../lib/leadImportApi';

/**
 * Progress for a queued CSV import — "2,500 of 5,000 leads imported".
 *
 * Shared by the Leads and Campaigns import modals so both phrase it identically. The wording comes
 * from the server (`job.message`), which means the counts in the UI and the counts in the job row
 * can never disagree.
 *
 * WHY A DETERMINATE BAR. A spinner says only "still going", which for an import that can legitimately
 * run for minutes is indistinguishable from a hang — and the previous behaviour (a request held open
 * until it timed out) is exactly what taught people to distrust it. A bar that moves is the evidence
 * that the work is progressing.
 *
 * Uses the same tokens as the rest of the application; no colour is hard-coded.
 */
export default function ImportProgress({ job }: { job: ImportJob }) {
  const failed = job.status === 'Failed';
  const done = job.status === 'Completed';
  const bar = failed ? 'var(--bad)' : done ? 'var(--ok)' : 'var(--brand)';

  return (
    <div
      style={{ marginTop: 14, padding: '12px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface-3)', border: '1px solid var(--line)' }}
      // Announced to screen readers as it changes, rather than silently redrawing.
      role="status"
      aria-live="polite"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: failed ? 'var(--bad)' : 'var(--text-2)', fontWeight: 500 }}>{job.message}</span>
        {!done && !failed && (
          <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{job.percent}%</span>
        )}
      </div>

      {!failed && (
        <div style={{ height: 6, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              // Completed pins to 100 rather than trusting the ratio, so a rounding error cannot
              // leave a finished import showing 99%.
              width: `${done ? 100 : job.percent}%`,
              background: bar,
              borderRadius: 999,
              transition: 'width .3s ease',
            }}
          />
        </div>
      )}

      {done && (job.duplicate > 0 || job.invalid > 0) && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
          {job.duplicate > 0 && <span>{job.duplicate.toLocaleString()} address{job.duplicate === 1 ? '' : 'es'} already on file {job.tagged > 0 ? `(${job.tagged.toLocaleString()} tagged)` : 'were left unchanged'}. </span>}
          {job.invalid > 0 && <span>{job.invalid.toLocaleString()} row{job.invalid === 1 ? '' : 's'} had no usable email address.</span>}
        </div>
      )}
    </div>
  );
}
