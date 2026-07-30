import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCompanySettings, updateCompanySettings, getEmailTemplates, updateEmailTemplate } from '../lib/api';
import { deskPath } from './area';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import type { CompanySettings, EmailTemplate } from '../types';

/**
 * Transaction Desk triggers — the automations that belong to Transaction Management.
 *
 * This surfaces what already runs rather than inventing a new engine. Two kinds exist today:
 *
 *   • The recurring lawyer-detail reminder, a real scheduled trigger. It sweeps hourly and re-emails
 *     the agent every N days while a lawyer detail is still missing. Its cadence has always been
 *     editable — it just lived in Company Settings under a number field with no explanation of what
 *     it drove. Zero switches the recurring reminder off.
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
const isDeskEvent = (key: string | undefined): boolean =>
  !!key && DESK_EVENT_PREFIXES.some((p) => key.startsWith(p));

/** Plain-language description of when each one fires. Falls back to the module name. */
const WHEN: Record<string, string> = {
  'invoice.send': 'when an invoice is issued to a client',
  'invoice.reminder': 'when a payment reminder is sent for an unpaid invoice',
  'invoice.overdue': 'when an invoice passes its due date',
  'document.pending_reminder': 'when outstanding documents are chased on a deal',
  'document.reminder': 'when a document reminder is sent from Reports',
  'notice_of_sale.send': 'when a Notice of Sale is issued',
  'deposit_receipt.send': 'when a deposit receipt is issued',
  'trade_sheet.send': 'when a trade sheet is sent',
  'agent_faq.batch_review': 'when an agent’s batch of changes is reviewed',
};

export default function DeskTriggersPanel() {
  const toast = useToast();
  const navigate = useNavigate();
  const { isSuperAdmin, can } = useAuth();
  const canEdit = can('settings', 'edit') || isSuperAdmin;

  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [days, setDays] = useState('');
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');

  useEffect(() => {
    Promise.all([
      getCompanySettings().catch(() => null),
      // Templates are Super-Admin-gated; a manager sees the reminder cadence and an empty message
      // list rather than an error, which is what their permissions already allow elsewhere.
      getEmailTemplates().catch(() => null),
    ])
      .then(([s, t]) => {
        if (s) { setSettings(s); setDays(String(s.lawyer_reminder_days ?? 3)); }
        // The response is grouped by module; the triggers are the flattened templates.
        const all: EmailTemplate[] = (t?.groups ?? []).flatMap((g) => g.templates ?? []);
        setTemplates(all.filter((x) => isDeskEvent(x.event_key)));
      })
      .catch((e) => toast(apiErrorMessage(e, 'Could not load triggers'), 'bad'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveCadence = async () => {
    const n = Math.max(0, Math.min(365, Math.floor(Number(days) || 0)));
    setSaving('cadence');
    try {
      await updateCompanySettings({ lawyer_reminder_days: n });
      setDays(String(n));
      toast(n === 0 ? 'Recurring lawyer-detail reminders switched off.' : `Reminders will repeat every ${n} day${n === 1 ? '' : 's'}.`, 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save the reminder cadence'), 'bad');
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

  const cadence = Number(days) || 0;

  return (
    <>
      <div className="card">
        <div className="modal-h">Scheduled</div>
        <p className="help" style={{ marginTop: 0 }}>
          Runs on its own, without anyone asking.
        </p>

        <div className="field" style={{ maxWidth: 520 }}>
          <label>Lawyer-detail reminders</label>
          <p className="help" style={{ margin: '0 0 8px' }}>
            Every hour, each Buying or Lease deal that still has a lawyer name, email, phone or
            address missing is re-checked. The agent on the deal is emailed again once this many days
            have passed since their last reminder, and keeps being reminded until the details are
            entered. <strong>Zero switches the recurring reminder off</strong> — the one-off nudge
            when a deal is saved with details missing still goes out.
          </p>
          <div className="toolbar-row" style={{ gap: 8, alignItems: 'center' }}>
            <input type="number" min={0} max={365} value={days} disabled={!canEdit || saving === 'cadence'}
              onChange={(e) => setDays(e.target.value)} style={{ width: 110 }} />
            <span className="muted" style={{ fontSize: 12 }}>days between reminders</span>
            <span className={`pill ${cadence > 0 ? 'ok' : ''}`}>{cadence > 0 ? `Every ${cadence} day${cadence === 1 ? '' : 's'}` : 'Recurring reminder off'}</span>
            {canEdit && (
              <button className="btn primary sm" disabled={saving === 'cadence' || String(settings?.lawyer_reminder_days ?? 3) === days}
                onClick={() => void saveCadence()}>{saving === 'cadence' ? 'Saving…' : 'Save'}</button>
            )}
          </div>
          {!canEdit && <span className="help">You do not have permission to change this.</span>}
        </div>
      </div>

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
        <p className="help" style={{ marginTop: 0 }}>
          There are no triggers on transaction status changes, offer or closing dates, document
          deadlines, payments, commissions or compliance conditions. The closing and document figures
          on the Dashboard are read when you open it — nothing watches them and acts. Adding those
          means a new rules engine rather than a change to this screen.
        </p>
      </div>
    </>
  );
}
