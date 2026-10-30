import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getReminderRules, saveReminderRules, getEmailTemplates, updateEmailTemplate } from '../lib/api';
import { deskPath } from './area';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import type { EmailTemplate, ReminderRules } from '../types';

/**
 * Transaction Desk triggers — the automations that belong to Transaction Management.
 *
 * This surfaces what already runs rather than inventing a new engine. Two kinds exist today:
 *
 *   • The scheduled reminders (lawyer details, closing date, conditions, listing expiry, deposit,
 *     commission, and the after-closing ones). Since 29 Oct 2026 each has an On/Off switch and its
 *     days can be changed here by a Super Admin.
 *
 *   • The transaction message triggers: each one is an event plus the message it sends, with its own
 *     Active switch. Turning one off stops that message being sent at all, which is the part that
 *     makes it a trigger rather than a template; the wording is edited in Settings → Templates.
 *
 * The CRM's triggers are deliberately not reachable from here, and these are not reachable from the
 * CRM. Section 13 asks for two independent modules, and a shared screen listing both is how a CRM
 * automation ends up quietly firing on a transaction.
 */

/**
 * Which template events belong to the Transaction Desk.
 *
 * Derived from the event key's own prefix rather than from a list of names, so a new invoice or
 * document event is picked up without this file being edited. Onboarding (`user.*`) is excluded: it
 * belongs to Users, a shared module, and those two messages are sent by hand from the Users screen —
 * calling them triggers would be describing a button as an automation.
 */
const DESK_EVENT_PREFIXES = ['invoice.', 'document.', 'notice_of_sale.', 'deposit_receipt.', 'trade_sheet.', 'agent_faq.'];

/*
 * TD-009 — the `transaction.*` events that are MESSAGE triggers, named one at a time.
 *
 * `transaction.` cannot be admitted as a prefix the way the others are. Most keys under it are the
 * nightly sweeps — closing dates, condition deadlines, listing expiry, the lawyer chase — and those
 * are in the Scheduled section, which has their own On/Off switches (29 Oct 2026). Admitting the
 * prefix would list every one of them a second time, as a second switch for the same thing.
 *
 * The status-change trigger is the exception and belongs here: it fires on a save like every other
 * message trigger, and it must be switchable from this screen. Left out of this list it would send
 * for ever with no way to turn it off from the page whose whole purpose is turning things off —
 * which is TD-141's defect, arrived at from the other side.
 */
const DESK_MESSAGE_EVENTS = new Set(['transaction.status_changed']);

const isDeskEvent = (key: string | undefined): boolean =>
  !!key && (DESK_EVENT_PREFIXES.some((p) => key.startsWith(p)) || DESK_MESSAGE_EVENTS.has(key));

/** Plain-language description of when each one fires. Falls back to the module name. */
const WHEN: Record<string, string> = {
  'invoice.send': 'when an invoice is issued to a client',
  'invoice.reminder': 'when a payment reminder is sent for an unpaid invoice',
  'invoice.overdue': 'when an invoice passes its due date',
  'document.pending_reminder': 'when outstanding documents are chased on a deal',
  'document.reminder': 'when a document reminder is sent from Reports',
  'document.waiting_summary': 'every morning at 8, to Documentation: the uploaded documents still waiting for review',
  'document.review_result': 'when the office marks documents Valid or Invalid - to every agent on the deal',
  'document.agent_upload': 'when an agent submits a document - to deals@gethomerealty.ca, with the file',
  'notice_of_sale.send': 'when a Notice of Sale is issued',
  'deposit_receipt.send': 'when a deposit receipt is issued',
  'trade_sheet.send': 'when a trade sheet is sent',
  'agent_faq.batch_review': 'when an agent’s batch of changes is reviewed',
  // TD-009 — the wording matches NOTIFIABLE_STATUSES: becoming firm, and every way of ending.
  'transaction.status_changed': 'when a deal becomes firm, or ends',
};

type DaysKey = 'lawyer' | 'closing' | 'condition' | 'listing_expiry';
type AfterKey = 'after_status' | 'after_docs' | 'after_lawyer';

/**
 * THE SCHEDULED REMINDERS (Sai, 29 Oct 2026): each one has an On/Off switch and, except commission,
 * days that can be changed. Only a Super Admin may change them - the server says who (`can_edit`).
 * Empty boxes go back to the usual days. Every change is written to the Settings audit trail.
 */
const DAYS_ROWS: { key: DaysKey; label: string; unit: string; help: string }[] = [
  {
    key: 'lawyer',
    label: 'Lawyer-detail reminders',
    unit: 'days before the closing date (0 = the closing day)',
    help: 'A Buying deal still missing its buyer\'s or seller\'s lawyer name, email or phone. The reminder asks only for the side that is missing, and stops once both are entered.',
  },
  {
    key: 'closing',
    label: 'Closing-date reminders',
    unit: 'days before the closing date (0 = the closing day)',
    help: 'Each deal that has not ended is reminded of its closing date. The agent is told in-app, by email and on their phone.',
  },
  {
    key: 'condition',
    label: 'Condition deadlines',
    unit: 'days before the deadline (0 = the deadline day)',
    help: 'Conditions reaching their deadline are collected per deal and the agent gets one message listing them. A condition marked Fulfilled or Waived is not chased.',
  },
  {
    key: 'listing_expiry',
    label: 'Listing expiry reminders',
    unit: 'days before the expiry date (1 or more - on the day itself the listing is expired)',
    help: 'An Active listing approaching its expiry date. On the expiry day itself the agent is told it expires today, and Documentation (the "Handled by" person, else the team) gets a bell message; Documentation is also told whenever a listing\'s expiry date is moved later (extended). The automatic change to Expired the next day happens whether this is on or off.',
  },
];

const AFTER_ROWS: { key: AfterKey; label: string; who: string; help: string }[] = [
  {
    key: 'after_status',
    label: 'Status still Firm / Conditional',
    who: 'Agent + Documentation',
    help: 'The closing date has passed but the deal is still Secured Firm, Secured Conditional or Sold Conditional. Documentation means the deal\'s "Handled by" person; when nobody is named, everyone in Documentation. Stops once the status is updated.',
  },
  {
    key: 'after_docs',
    label: 'Required documents outstanding',
    who: 'Agent',
    help: 'Required documents still Pending or Invalid after closing. The message lists them. Stops once every required document is Valid.',
  },
  {
    key: 'after_lawyer',
    label: 'Lawyer details missing',
    who: 'Agent',
    help: 'A Buying deal still missing lawyer details after closing - asks only for the side that is missing. Stops once they are entered.',
  },
];

const fmtDay = (ymd: string | null): string => {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-CA', { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function DeskTriggersPanel() {
  const toast = useToast();
  const navigate = useNavigate();

  const [rules, setRules] = useState<ReminderRules | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [maxDays, setMaxDays] = useState(60);
  /** What is typed in each box, keyed `closing`, `deposit`, `after_docs.first` ... */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');

  const fill = (r: ReminderRules) => {
    const d: Record<string, string> = {};
    for (const row of DAYS_ROWS) d[row.key] = r[row.key].days.join(', ');
    d.deposit = String(r.deposit.days);
    d['void_cheque.before'] = String(r.void_cheque.before);
    d['void_cheque.after'] = String(r.void_cheque.after);
    d['void_cheque.gap'] = String(r.void_cheque.gap);
    d['void_cheque.never'] = r.void_cheque.never.join(',');
    d['void_cheque.always'] = r.void_cheque.always.join(',');
    for (const row of AFTER_ROWS) {
      d[`${row.key}.first`] = String(r[row.key].first);
      d[`${row.key}.every`] = String(r[row.key].every);
      d[`${row.key}.until`] = String(r[row.key].until);
    }
    setDraft(d);
  };

  useEffect(() => {
    Promise.all([
      getReminderRules().catch(() => null),
      // Templates are Super-Admin-gated; anyone else sees the reminders and an empty message list
      // rather than an error, which is what their permissions already allow elsewhere.
      getEmailTemplates().catch(() => null),
    ])
      .then(([r, t]) => {
        if (r) { setRules(r.data); setCanEdit(r.can_edit); setMaxDays(r.max_days); fill(r.data); }
        // The response is grouped by module; the triggers are the flattened templates.
        const all: EmailTemplate[] = (t?.groups ?? []).flatMap((g) => g.templates ?? []);
        setTemplates(all.filter((x) => isDeskEvent(x.event_key)));
      })
      .catch((e) => toast(apiErrorMessage(e, 'Could not load triggers'), 'bad'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Save one reminder. `what` is the toast on success. */
  const saveRule = async (key: string, payload: Record<string, unknown>, what: string) => {
    setSaving(key);
    try {
      const r = await saveReminderRules({ [key]: payload });
      setRules(r.data);
      fill(r.data);
      toast(what, 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save that reminder'), 'bad');
    } finally { setSaving(''); }
  };

  const toggle = async (t: EmailTemplate) => {
    setSaving(String(t.id));
    try {
      await updateEmailTemplate(t.id, { is_active: !t.is_active });
      setTemplates((list) => list.map((x) => (x.id === t.id ? { ...x, is_active: !x.is_active } : x)));
      toast(t.is_active ? `${t.name} switched off — it will not be sent.` : `${t.name} switched on.`, 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not change that trigger'), 'bad');
    } finally { setSaving(''); }
  };

  if (loading) return <div className="centered">Loading triggers…</div>;

  const onOff = (key: string, label: string, on: boolean) => (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <span className={`pill ${on ? 'ok' : ''}`}>{on ? 'On' : 'Off'}</span>
      {canEdit && (
        <button className="btn ghost sm" disabled={saving === key}
          onClick={() => void saveRule(key, { on: !on }, on ? `${label} switched off.` : `${label} switched on.`)}>
          {on ? 'Switch off' : 'Switch on'}
        </button>
      )}
    </span>
  );

  const box = (name: string, width: number, label: string) => (
    <input aria-label={label} value={draft[name] ?? ''} disabled={!canEdit} style={{ width }}
      onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))} />
  );

  return (
    <>
      <div className="card">
        <div className="modal-h">Scheduled</div>
        <p className="help" style={{ marginTop: 0 }}>
          Runs on its own every night, without anyone asking. Each reminder can be switched on or off, and
          its days changed: whole numbers up to {maxDays}, separated by commas. An empty box goes back to
          the usual days.
          {!canEdit && <> <strong>Only a Super Admin can change these.</strong></>}
        </p>

        {rules && DAYS_ROWS.map((row) => {
          const r = rules[row.key];
          const changed = (draft[row.key] ?? '') !== r.days.join(', ');
          return (
            <div className="field" style={{ maxWidth: 640 }} key={row.key}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{row.label} {onOff(row.key, row.label, r.on)}</label>
              <p className="help" style={{ margin: '0 0 8px' }}>{row.help}</p>
              <div className="toolbar-row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {box(row.key, 240, `${row.label} days`)}
                <span className="muted" style={{ fontSize: 12 }}>{row.unit}</span>
                {canEdit && changed && (
                  <button className="btn primary sm" disabled={saving === row.key}
                    onClick={() => void saveRule(row.key, { days: draft[row.key] ?? '' }, `${row.label}: days saved.`)}>
                    {saving === row.key ? 'Saving…' : 'Save'}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {rules && (
          <div className="field" style={{ maxWidth: 640 }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>Deposit not recorded {onOff('deposit', 'Deposit not recorded', rules.deposit.on)}</label>
            <p className="help" style={{ margin: '0 0 8px' }}>
              A deal that expects a deposit and has none recorded as received chases its agent once.
              Recording the deposit under Quick Actions &rarr; Admin stops it.
            </p>
            <div className="toolbar-row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {box('deposit', 70, 'Deposit reminder day')}
              <span className="muted" style={{ fontSize: 12 }}>days after the offer date (one number)</span>
              {canEdit && (draft.deposit ?? '') !== String(rules.deposit.days) && (
                <button className="btn primary sm" disabled={saving === 'deposit'}
                  onClick={() => void saveRule('deposit', { days: draft.deposit ?? '' }, 'Deposit not recorded: day saved.')}>
                  {saving === 'deposit' ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          </div>
        )}

        {rules && (
          <div className="field" style={{ maxWidth: 640 }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>Commission received {onOff('commission', 'Commission received', rules.commission.on)}</label>
            <p className="help" style={{ margin: 0 }}>
              When an invoice is settled and the commission date is recorded, the deal&rsquo;s agent is
              told that night. This is the brokerage being paid &mdash; the agent&rsquo;s own payment
              is a separate thing and is not what this announces.
            </p>
          </div>
        )}

        {rules && (() => {
          // 29-30 Oct 2026 (Sai) - the client's void cheque: daily before closing, then every other day
          // plus Tuesdays and Thursdays after closing, never on Wednesday or Friday (payment days).
          const v = rules.void_cheque;
          const days = (k: string, fallback: number[]) => (draft[k] ?? fallback.join(',')).split(',').filter((x) => x !== '').map(Number);
          const never = days('void_cheque.never', v.never);
          const always = days('void_cheque.always', v.always);
          const same = (a: number[], b: number[]) => [...a].sort().join(',') === [...b].sort().join(',');
          const changed = (draft['void_cheque.before'] ?? '') !== String(v.before) || (draft['void_cheque.after'] ?? '') !== String(v.after)
            || (draft['void_cheque.gap'] ?? '') !== String(v.gap) || !same(never, v.never) || !same(always, v.always);
          const flip = (which: 'never' | 'always', wd: number) => {
            const mine = which === 'never' ? never : always;
            const other = which === 'never' ? always : never;
            const nextMine = mine.includes(wd) ? mine.filter((x) => x !== wd) : [...mine, wd];
            const nextOther = other.filter((x) => x !== wd); // a day cannot be both
            setDraft((d) => ({
              ...d,
              [`void_cheque.${which}`]: nextMine.join(','),
              [`void_cheque.${which === 'never' ? 'always' : 'never'}`]: nextOther.join(','),
            }));
          };
          const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const row = (which: 'never' | 'always', label: string) => (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginTop: 6, fontSize: 12.5 }}>
              <span style={{ minWidth: 90 }}>{label}</span>
              {WD.map((n, wd) => {
                const on = (which === 'never' ? never : always).includes(wd);
                return (
                  <button key={n} type="button" className={`btn sm ${on ? 'primary' : 'ghost'}`} disabled={!canEdit}
                    aria-pressed={on} aria-label={`${label} ${n}`} onClick={() => flip(which, wd)}>{n}</button>
                );
              })}
            </div>
          );
          return (
            <div className="field" style={{ maxWidth: 640 }}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>Client void cheque not received <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>to Agent + co-agents</span> {onOff('void_cheque', 'Client void cheque reminders', v.on)}</label>
              <p className="help" style={{ margin: '0 0 8px' }}>
                A Sold sale listing or Leased lease listing with money Payable to Client, whose client void
                cheque has not been uploaded (Agent Payment Readiness) or marked received (Admin Activities).
                Every day before closing; after closing, every other day plus the "always" days. Never on the
                "never" days. Stops once it is received. After closing, only deals closing from the day this went live.
              </p>
              <div className="toolbar-row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
                <span>Every day from</span>{box('void_cheque.before', 56, 'Void cheque days before closing')}
                <span>days before closing; after closing for</span>{box('void_cheque.after', 56, 'Void cheque days after closing')}
                <span>days, every</span>{box('void_cheque.gap', 56, 'Void cheque gap after closing')}
                <span>days</span>
              </div>
              {row('never', 'Never on')}
              {row('always', 'Always on')}
              {canEdit && changed && (
                <button className="btn primary sm" style={{ marginTop: 8 }} disabled={saving === 'void_cheque'}
                  onClick={() => void saveRule('void_cheque', {
                    before: draft['void_cheque.before'] ?? '', after: draft['void_cheque.after'] ?? '', gap: draft['void_cheque.gap'] ?? '',
                    never, always,
                  }, 'Client void cheque: timing saved.')}>
                  {saving === 'void_cheque' ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          );
        })()}
      </div>

      {rules && (
        <div className="card">
          <div className="modal-h">After the closing date</div>
          <p className="help" style={{ marginTop: 0 }}>
            Once a deal&rsquo;s closing date has passed, these keep reminding until the thing is done
            &mdash; by default 1, 3, 5, 7&hellip; days after closing (every other day), for up to {maxDays} days.
            They start <strong>Off</strong>. When one is switched on, only deals closing from that day are
            reminded; deals that had already closed are left alone.
          </p>
          {AFTER_ROWS.map((row) => {
            const r = rules[row.key];
            const changed = ['first', 'every', 'until'].some((f) => (draft[`${row.key}.${f}`] ?? '') !== String(r[f as 'first' | 'every' | 'until']));
            return (
              <div className="field" style={{ maxWidth: 640 }} key={row.key}>
                <label style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  {row.label} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>to {row.who}</span> {onOff(row.key, row.label, r.on)}
                </label>
                <p className="help" style={{ margin: '0 0 8px' }}>{row.help}</p>
                {r.on && rules.after_started[row.key] && (
                  <p className="help" style={{ margin: '0 0 8px' }}>
                    Switched on {fmtDay(rules.after_started[row.key] ?? null)} &mdash; reminding deals that close on or after that day.
                  </p>
                )}
                <div className="toolbar-row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
                  <span>First reminder</span>{box(`${row.key}.first`, 56, `${row.label} first day`)}
                  <span>day(s) after closing, then every</span>{box(`${row.key}.every`, 56, `${row.label} every`)}
                  <span>day(s), up to</span>{box(`${row.key}.until`, 56, `${row.label} last day`)}
                  <span>days after closing</span>
                  {canEdit && changed && (
                    <button className="btn primary sm" disabled={saving === row.key}
                      onClick={() => void saveRule(row.key, {
                        first: draft[`${row.key}.first`] ?? '', every: draft[`${row.key}.every`] ?? '', until: draft[`${row.key}.until`] ?? '',
                      }, `${row.label}: timing saved.`)}>
                      {saving === row.key ? 'Saving…' : 'Save'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="card">
        <div className="modal-h">Message triggers</div>
        <p className="help" style={{ marginTop: 0 }}>
          Each one fires on a transaction event and sends its message. Switching a trigger off stops
          that message being sent; the wording is edited in Settings → Templates.
        </p>

        {templates.length === 0 ? (
          <p className="help">No transaction message triggers are available to you.</p>
        ) : (
          <ul className="tmpl-files" style={{ marginTop: 10 }}>
            {templates.map((t) => (
              <li key={String(t.id)} style={{ alignItems: 'flex-start', gap: 10 }}>
                <span className="tmpl-file-ico">{t.is_active ? '⚡' : '⏸'}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>
                    {t.name}
                    <span className={`pill ${t.is_active ? 'ok' : ''}`} style={{ marginLeft: 6, fontSize: 10 }}>
                      {t.is_active ? 'Active' : 'Off'}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {WHEN[String(t.event_key)] ?? t.module ?? t.event_key}
                  </div>
                </span>
                <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
                  <button className="btn ghost sm" disabled={saving === String(t.id)}
                    onClick={() => void toggle(t)}>{t.is_active ? 'Switch off' : 'Switch on'}</button>
                  <button className="btn ghost sm"
                    onClick={() => navigate(`${deskPath('settings')}?tab=desk&section=templates`)}>Edit message</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        Said plainly rather than shown as an empty panel or a disabled control. Section 13 lists
        trigger events this application does not have — and section 19 forbids replacing working
        functionality with placeholders, which cuts both ways: a row of switches that do nothing
        would read as configuration and would be worse than a sentence saying what is missing.
      */}
      <div className="card">
        <div className="modal-h">Not built yet</div>
        {/*
          TD-009 — the card names what is MISSING, so every line of it has to keep being true.
          Status changes came off this list when the trigger below them was built; "document
          deadlines" came off because it was never the right description — a document has no
          deadline field to watch, and the two document reminders fire on a document still being
          pending, which is a different thing and does exist.
        */}
        <p className="help" style={{ marginTop: 0 }}>
          There are no triggers on offer dates. The document figures on the Dashboard are read when
          you open it — nothing watches them and acts. Documents are chased on whether they are still
          pending rather than against a deadline, because a document has no due date recorded against
          it, and the deposit is chased the same way and for the same reason.
        </p>
        <p className="help" style={{ marginBottom: 0 }}>
          The two money questions have now been answered rather than left open. A deposit still has
          no due date, so it is chased on whether it has been received rather than against a
          deadline. And of the three things “commission received” could mean — the trust deposit, the
          invoice being paid, or the agent being paid — the trigger fires on the invoice, which is
          the one the system records by itself; the other two are entered by hand, and announcing
          them would be announcing the typing rather than the money.
        </p>
      </div>
    </>
  );
}
