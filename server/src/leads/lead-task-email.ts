/**
 * Email about a lead task: who gets which message, and what it says.
 *
 * Pure functions only — no database, no mailer — so the rules the brokerage asked for (21 Oct 2026)
 * are asserted directly in `lead-task-email.spec.ts` rather than through a running server:
 *
 *   task created                    → the creator gets "Task Created: <title>"
 *   task created with an agent      → the creator gets that, AND the agent gets "New Task Assigned…"
 *   creator IS the agent            → ONE combined message, not two
 *   agent changed afterwards        → the new agent gets "New Task Assigned…"
 *   anything else saved             → nothing
 *
 * Delivery, retries and the record of what happened live in `LeadTaskNotificationService`.
 */

export type TaskEmailKind = 'created' | 'assigned' | 'created_assigned';

export interface PlannedTaskEmail {
  kind: TaskEmailKind;
  recipientUserId: number;
  /**
   * Unique in `lead_task_notifications`. It names the OCCURRENCE, so a repeated request or a
   * retried job cannot queue a second copy, while a genuinely new assignment gets its own key.
   */
  dedupeKey: string;
}

const positive = (v: number | null | undefined): v is number => Number.isInteger(v) && (v as number) > 0;

/** The emails a newly saved task produces. */
export function planNewTaskEmails(taskId: number, creatorUserId: number | null | undefined, assigneeUserId: number | null | undefined): PlannedTaskEmail[] {
  const creator = positive(creatorUserId) ? creatorUserId : null;
  const agent = positive(assigneeUserId) ? assigneeUserId : null;

  // Same person: one message that is both the confirmation and the assignment.
  if (creator && agent && creator === agent) {
    return [{ kind: 'created_assigned', recipientUserId: creator, dedupeKey: `task-created-assigned:${taskId}:${creator}` }];
  }
  const out: PlannedTaskEmail[] = [];
  if (creator) out.push({ kind: 'created', recipientUserId: creator, dedupeKey: `task-created:${taskId}:${creator}` });
  // Assignment number 1 — see `planReassignmentEmail` for why assignments are numbered.
  if (agent) out.push({ kind: 'assigned', recipientUserId: agent, dedupeKey: `task-assigned:${taskId}:1:${agent}` });
  return out;
}

/**
 * The email an assignment CHANGE produces, or null when there is nothing to send.
 *
 * `assignmentNumber` counts the task's real assignments (1 at creation). It is part of the key so
 * that A → B → A tells A again — it is a new hand-over — while the same change submitted twice
 * cannot: the caller only reaches here after a conditional update proved the assignee changed, and
 * the unique key backs that up.
 */
export function planReassignmentEmail(
  taskId: number, before: number | null | undefined, after: number | null | undefined, assignmentNumber: number,
): PlannedTaskEmail | null {
  if (!positive(after) || after === before) return null;
  return { kind: 'assigned', recipientUserId: after, dedupeKey: `task-assigned:${taskId}:${assignmentNumber}:${after}` };
}

// ---------------------------------------------------------------------------------------- address

/** A deliverable-looking address. Deliberately plain: the mail server is the real judge. */
export function validEmail(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/.test(s)) return null;
  // Placeholders this application stores for people with no real address.
  if (/@(meta|example)\.invalid$/i.test(s) || /\.invalid$/i.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------------------------------- retries

/** Attempts in total, including the first. Bounded: after this a row stays `failed` for a person. */
export const TASK_EMAIL_MAX_ATTEMPTS = 5;
/** Wait before attempt n+1, indexed by attempts already made (1 → 1 min, 2 → 5 min, …). */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export function nextRetryDelayMs(attemptsMade: number): number | null {
  if (attemptsMade >= TASK_EMAIL_MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptsMade, 1), RETRY_DELAYS_MS.length) - 1];
}

/**
 * What a failed send proves, which decides whether retrying it is safe.
 *
 * The same rule as Recruitment's `classifySendFailure` (kept separate because that module imports
 * this one's neighbour, and a cross-import would be a cycle):
 *   retry    4xx, or the server was never reached — nothing can have been delivered
 *   final    5xx — the server refused it; retrying gets the same answer
 *   unknown  anything else — a connection lost after the server took the message looks transient
 *            but may have delivered it, so it is NOT retried automatically (that is how one send
 *            becomes three copies); a person can choose to retry it
 */
export type SendFailure = 'retry' | 'final' | 'unknown';

export function classifyTaskSendFailure(err: unknown): SendFailure {
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown; message?: unknown };
  if (typeof e.responseCode === 'number') {
    if (e.responseCode >= 400 && e.responseCode < 500) return 'retry';
    if (e.responseCode >= 500 && e.responseCode < 600) return 'final';
  }
  const code = String(e.code ?? '');
  const msg = String(e.message ?? '');
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EDNS', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'retry';
  if (/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|Greeting never received/i.test(msg)) return 'retry';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------- content

export interface TaskEmailContext {
  kind: TaskEmailKind;
  recipientName: string;
  task: {
    id: number; title: string; description: string | null;
    priority: string | null; status: string | null; due_date: Date | null;
  };
  creatorName: string | null;
  agentName: string | null;
  /**
   * The lead's client and property details, or NULL when the recipient may not open this lead.
   * The caller decides with the same `assertLead` rule the lead page applies, so an email can
   * never show more than the link would.
   */
  client: { name: string | null; phone: string | null; email: string | null; property: string | null; location: string | null } | null;
  /** Absolute link to the task, or null when FRONTEND_URL is not configured. */
  viewUrl: string | null;
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const cap = (s: string | null | undefined): string => {
  const v = String(s ?? '').trim();
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : '';
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `due_date` is a DATE column, handed back as UTC midnight — read it in UTC or the day shifts. */
export function formatDue(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function taskEmailSubject(kind: TaskEmailKind, title: string): string {
  const t = title.trim() || 'Follow-up';
  if (kind === 'created') return `Task Created: ${t}`;
  if (kind === 'assigned') return `New Task Assigned to You: ${t}`;
  return `Task Created and Assigned to You: ${t}`;
}

/** Subject, HTML and the plain-text alternative for one task email. */
export function renderTaskEmail(ctx: TaskEmailContext): { subject: string; html: string; text: string } {
  const { kind, task } = ctx;
  const title = task.title.trim() || 'Follow-up';
  const subject = taskEmailSubject(kind, title);
  const agent = ctx.agentName?.trim() || 'Unassigned';
  const creator = ctx.creatorName?.trim() || '—';

  const intro = kind === 'created'
    ? `Your task has been created${ctx.agentName ? ` and assigned to <strong>${esc(agent)}</strong>` : ''}.`
    : kind === 'assigned'
      ? `<strong>${esc(creator)}</strong> has assigned you a task.`
      : 'Your task has been created and assigned to you.';
  const introText = kind === 'created'
    ? `Your task has been created${ctx.agentName ? ` and assigned to ${agent}` : ''}.`
    : kind === 'assigned' ? `${creator} has assigned you a task.` : 'Your task has been created and assigned to you.';

  const details: Array<[string, string]> = [
    ['Task ID', `#${task.id}`],
    ['Priority', cap(task.priority)],
    ['Status', cap(task.status)],
    ['Due', formatDue(task.due_date)],
    ['Created by', creator],
    ['Assigned agent', agent],
  ];
  const clientRows: Array<[string, string]> = ctx.client
    ? [
      ['Client', ctx.client.name ?? ''],
      ['Phone', ctx.client.phone ?? ''],
      ['Email', ctx.client.email ?? ''],
      ['Property', ctx.client.property ?? ''],
      ['Location', ctx.client.location ?? ''],
    ]
    : [];

  const row = ([k, v]: [string, string]) => (v.trim()
    ? `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top">${esc(k)}</td>`
      + `<td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600">${esc(v)}</td></tr>`
    : '');
  const table = (rows: Array<[string, string]>) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">${rows.map(row).join('')}</table>`;
  const section = (heading: string, inner: string) =>
    `<p style="margin:22px 0 6px;color:#b91c1c;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">${esc(heading)}</p>${inner}`;

  const description = task.description?.trim()
    ? section('Description', `<p style="margin:0;color:#374151;font-size:14px;line-height:1.5;white-space:pre-line">${esc(task.description.trim())}</p>`)
    : '';
  const client = clientRows.some(([, v]) => v.trim()) ? section('Client & property', table(clientRows)) : '';
  const button = ctx.viewUrl
    ? `<p style="margin:28px 0 8px"><a href="${esc(ctx.viewUrl)}" style="display:inline-block;background:#b91c1c;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;font-size:14px">View Task</a></p>`
      + '<p style="margin:0;color:#9ca3af;font-size:12px">You will be asked to sign in. The task opens only for people who have access to this lead.</p>'
    : '<p style="margin:28px 0 0;color:#374151;font-size:14px">Sign in to the Get Home Realty CRM to view this task.</p>';

  const html =
    '<div style="background:#f3f4f6;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">'
    + '<div style="max-width:580px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">'
    + '<div style="background:#b91c1c;padding:18px 28px;color:#ffffff">'
    + '<div style="font-size:20px;font-weight:800;letter-spacing:.02em">GET HOME REALTY</div>'
    + '<div style="font-size:11px;opacity:.85;font-style:italic">“A Tradition of Trust” · Brokerage</div>'
    + '</div>'
    + '<div style="padding:26px 28px 28px">'
    + `<p style="margin:0 0 6px;color:#111827;font-size:15px">Hello ${esc(ctx.recipientName || 'there')},</p>`
    + `<p style="margin:0 0 18px;color:#374151;font-size:15px">${intro}</p>`
    + `<h1 style="margin:0 0 4px;color:#111827;font-size:20px;line-height:1.3">${esc(title)}</h1>`
    + section('Task details', table(details))
    + description
    + client
    + button
    + '</div>'
    + '<div style="padding:14px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px">'
    + 'Get Home Realty · CRM task notification. Sent automatically; replies to this message are not monitored.'
    + '</div></div></div>';

  const lines = [
    `Hello ${ctx.recipientName || 'there'},`, '', introText, '', title, '',
    ...details.filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v}`),
    ...(task.description?.trim() ? ['', 'Description:', task.description.trim()] : []),
    ...(clientRows.some(([, v]) => v.trim()) ? ['', 'Client & property:', ...clientRows.filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v}`)] : []),
    '', ctx.viewUrl ? `View Task: ${ctx.viewUrl}` : 'Sign in to the Get Home Realty CRM to view this task.',
  ];
  return { subject, html, text: lines.join('\n') };
}
