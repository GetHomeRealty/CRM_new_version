import { useState } from 'react';
import type { LeadDetail } from '../types';

type Activity = { id: string; kind: string; title: string; text: string; at: string | null; by: string | null; status?: string };
/** Render only stored lead activity. Email HTML is never inserted into the page. */
export function leadActivities(lead: LeadDetail): Activity[] {
  const rows: Activity[] = [
    ...lead.notes_history.map(n => ({ id: `note-${n.id}`, kind: 'Note', title: n.pinned ? 'Pinned note' : 'Note added', text: n.content, at: n.created_at, by: n.created_by })),
    ...lead.calls.map(c => ({ id: `call-${c.id}`, kind: 'Call', title: c.outcome || 'Call logged', text: c.notes || 'No call notes recorded.', at: c.called_at, by: c.created_by, status: c.status || undefined })),
    ...lead.messages.map(m => ({ id: `sms-${m.id}`, kind: 'Text', title: m.direction === 'inbound' ? 'Text received' : 'Outbound text', text: m.body, at: m.sent_at, by: m.created_by, status: m.status || undefined })),
    ...lead.emails.map(e => ({ id: `email-${e.id}`, kind: 'Email', title: e.subject || 'Email', text: `To: ${e.recipient}${e.error ? ` · ${e.error}` : ''}`, at: e.sent_at, by: e.sent_by, status: e.status })),
    ...(lead.assignment_history ?? []).map(a => ({ id: `assignment-${a.id}`, kind: 'Assignment', title: 'Assignment updated', text: a.description, at: a.created_at, by: a.actor_name })),
  ];
  const time = (s: string | null) => { const n = s ? Date.parse(s) : NaN; return Number.isFinite(n) ? n : 0; };
  return rows.sort((a, b) => time(b.at) - time(a.at) || a.id.localeCompare(b.id));
}

export default function LeadActivityTimeline({ lead }: { lead: LeadDetail }) {
  const [kind, setKind] = useState('All');
  const [limit, setLimit] = useState(20);
  const rows = leadActivities(lead).filter(a => kind === 'All' || a.kind === kind);
  return <section className="card lw-timeline" aria-label="Lead activity timeline">
    <header><h3>Activity <small>Latest first</small></h3><label>Filter <select aria-label="Filter activity" value={kind} onChange={e => { setKind(e.target.value); setLimit(20); }}>{['All', 'Note', 'Call', 'Text', 'Email', 'Assignment'].map(k => <option key={k}>{k}</option>)}</select></label></header>
    {!rows.length && <p className="help">No {kind === 'All' ? '' : kind.toLowerCase() + ' '}activity recorded yet.</p>}
    <ol>{rows.slice(0, limit).map(a => <li key={a.id}>
      <span className="lw-event-mark" aria-hidden="true">{({ Note: 'N', Call: 'C', Text: 'T', Email: 'E', Assignment: 'A' })[a.kind]}</span>
      <article><div className="lw-event-heading"><strong>{a.title}</strong><time dateTime={a.at || undefined}>{a.at && Number.isFinite(Date.parse(a.at)) ? new Date(a.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Date unavailable'}</time></div>
      <p className="lw-event-by">{a.kind}{a.by ? ` · ${a.by}` : ''}{a.status ? ` · ${a.status}` : ''}</p><p className="lw-event-text">{a.text}</p></article>
    </li>)}</ol>
    {limit < rows.length && <button className="btn ghost sm" type="button" onClick={() => setLimit(n => n + 20)}>Load more activity</button>}
  </section>;
}
