import type { LeadMetaInquiry } from '../types';

/**
 * How many times this person submitted a Meta form, and what each submission asked about.
 *
 * ONE PERSON = ONE LEAD, ONE SUBMISSION = ONE INQUIRY. Newest first, numbered #N down to #1, and each
 * shows only its own address — addresses are never merged. A missing one reads "Not provided",
 * because that is what the form returned; nothing is guessed.
 */
export default function MetaInquiryHistory({ count, inquiries }: { count: number; inquiries: LeadMetaInquiry[] }) {
  if (!count) return null;
  return (
    <>
      <div className="modal-sub">Meta Inquiry History</div>
      <dl className="lead-dl">
        <dt>Meta Inquiries</dt><dd><strong>{count}</strong></dd>
      </dl>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {inquiries.map((q, i) => (
          <li key={q.id} className="lead-summary" style={{ whiteSpace: 'normal' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
              <strong>#{inquiries.length - i}</strong>
              <span className="muted" style={{ fontSize: 12 }}>Received: {when(q.submitted_at ?? q.created_at)}</span>
            </div>
            <dl className="lead-dl" style={{ margin: 0 }}>
              <dt>Property/Address</dt><dd>{q.property_address || <span className="muted">Not provided</span>}</dd>
              {q.project_name && <><dt>Project</dt><dd>{q.project_name}</dd></>}
              {q.form_name && <><dt>Meta Form</dt><dd>{q.form_name}</dd></>}
            </dl>
          </li>
        ))}
      </ol>
    </>
  );
}

/** "Oct 8, 2026, 11:20 AM", in the viewer's own time zone. */
function when(iso: string | null): string {
  if (!iso) return 'Not recorded';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not recorded';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
