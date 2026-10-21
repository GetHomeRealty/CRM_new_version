import {
  TASK_EMAIL_MAX_ATTEMPTS, classifyTaskSendFailure, formatDue, nextRetryDelayMs, planNewTaskEmails,
  planReassignmentEmail, renderTaskEmail, taskEmailSubject, validEmail, type TaskEmailContext,
} from './lead-task-email';

/**
 * Who is emailed about a lead task, and what the email says — the rules the brokerage asked for
 * (21 Oct 2026), asserted without a database or a mail server. The delivery side is in
 * `lead-task-notification.spec.ts`.
 */

describe('who is emailed when a task is created', () => {
  it('creator only, when nobody is assigned', () => {
    expect(planNewTaskEmails(10, 7, null)).toEqual([
      { kind: 'created', recipientUserId: 7, dedupeKey: 'task-created:10:7' },
    ]);
  });

  it('creator AND agent, when somebody else is assigned', () => {
    expect(planNewTaskEmails(10, 7, 42)).toEqual([
      { kind: 'created', recipientUserId: 7, dedupeKey: 'task-created:10:7' },
      { kind: 'assigned', recipientUserId: 42, dedupeKey: 'task-assigned:10:1:42' },
    ]);
  });

  it('ONE combined email when the creator is the agent', () => {
    expect(planNewTaskEmails(10, 7, 7)).toEqual([
      { kind: 'created_assigned', recipientUserId: 7, dedupeKey: 'task-created-assigned:10:7' },
    ]);
  });

  it('only the agent when there is no signed-in creator', () => {
    expect(planNewTaskEmails(10, null, 42).map((p) => p.kind)).toEqual(['assigned']);
  });
});

describe('who is emailed when the agent changes', () => {
  it('the new agent, numbered so a hand-back is a new email', () => {
    expect(planReassignmentEmail(10, 42, 43, 2)).toEqual({ kind: 'assigned', recipientUserId: 43, dedupeKey: 'task-assigned:10:2:43' });
    // Back to 42 later: a different key from 42's first assignment, so it is not swallowed.
    expect(planReassignmentEmail(10, 43, 42, 3)?.dedupeKey).toBe('task-assigned:10:3:42');
  });

  it('nobody when the agent did not change, or was removed', () => {
    expect(planReassignmentEmail(10, 42, 42, 2)).toBeNull();
    expect(planReassignmentEmail(10, 42, null, 2)).toBeNull();
  });
});

describe('subjects', () => {
  it('match the requested wording', () => {
    expect(taskEmailSubject('created', 'Call back Ashu')).toBe('Task Created: Call back Ashu');
    expect(taskEmailSubject('assigned', 'Call back Ashu')).toBe('New Task Assigned to You: Call back Ashu');
    expect(taskEmailSubject('created_assigned', 'Call back Ashu')).toBe('Task Created and Assigned to You: Call back Ashu');
  });
});

describe('the email body', () => {
  const base: TaskEmailContext = {
    kind: 'assigned',
    recipientName: 'Akhil',
    task: { id: 55, title: 'CALL BACK', description: 'Ask about <b>pre-construction</b> units', priority: 'medium', status: 'pending', due_date: new Date('2026-10-21T00:00:00Z') },
    creatorName: 'Madhu',
    agentName: 'Akhil',
    client: { name: 'Ashu kuna', phone: '8688339242', email: 'ashu@example.test', property: '12 King St', location: 'Toronto' },
    viewUrl: 'https://gethomehub.ca/crm/lead/20545?task=55',
  };

  it('carries the task, the people, the client and a View Task button', () => {
    const { subject, html, text } = renderTaskEmail(base);
    expect(subject).toBe('New Task Assigned to You: CALL BACK');
    for (const s of ['#55', 'Medium', 'Pending', 'Wed, Oct 21, 2026', 'Madhu', 'Akhil', 'Ashu kuna', '8688339242', '12 King St', 'Toronto', 'GET HOME REALTY']) {
      expect(html).toContain(s);
    }
    expect(html).toContain('href="https://gethomehub.ca/crm/lead/20545?task=55"');
    expect(html).toContain('>View Task</a>');
    expect(text).toContain('View Task: https://gethomehub.ca/crm/lead/20545?task=55');
  });

  it('escapes what people typed', () => {
    const { html } = renderTaskEmail(base);
    expect(html).not.toContain('<b>pre-construction</b>');
    expect(html).toContain('&lt;b&gt;pre-construction&lt;/b&gt;');
  });

  it('leaves the client out entirely for a recipient who may not open the lead', () => {
    const { html, text } = renderTaskEmail({ ...base, client: null });
    for (const s of ['Ashu kuna', '8688339242', 'ashu@example.test', '12 King St']) {
      expect(html).not.toContain(s);
      expect(text).not.toContain(s);
    }
  });

  it('says how to reach the task when no app address is configured, rather than a dead button', () => {
    const { html } = renderTaskEmail({ ...base, viewUrl: null });
    expect(html).not.toContain('View Task</a>');
    expect(html).toContain('Sign in to the Get Home Realty CRM');
  });

  it('reads the DATE column in UTC, so the day never shifts', () => {
    expect(formatDue(new Date('2026-10-21T00:00:00Z'))).toBe('Wed, Oct 21, 2026');
  });
});

describe('addresses', () => {
  it('accepts a real-looking address and refuses placeholders and junk', () => {
    expect(validEmail(' akhil@gethomerealty.ca ')).toBe('akhil@gethomerealty.ca');
    for (const bad of [null, '', 'akhil', 'akhil@', '@x.ca', 'a b@x.ca', 'lead@meta.invalid', 'x@localhost.invalid']) {
      expect(validEmail(bad)).toBeNull();
    }
  });
});

describe('retries are bounded and only where nothing can have been delivered', () => {
  it('backs off and stops at the limit', () => {
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(5 * 60_000);
    expect(nextRetryDelayMs(4)).toBe(60 * 60_000);
    expect(nextRetryDelayMs(TASK_EMAIL_MAX_ATTEMPTS)).toBeNull();
  });

  it('classifies failures', () => {
    expect(classifyTaskSendFailure({ responseCode: 421 })).toBe('retry');
    expect(classifyTaskSendFailure({ code: 'ECONNREFUSED' })).toBe('retry');
    expect(classifyTaskSendFailure({ responseCode: 550 })).toBe('final');
    // Lost after DATA: may already be in the inbox, so never retried by itself.
    expect(classifyTaskSendFailure({ code: 'ECONNRESET', message: 'Connection closed' })).toBe('unknown');
  });
});
