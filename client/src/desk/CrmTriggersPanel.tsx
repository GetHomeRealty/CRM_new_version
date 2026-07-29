import { useEffect, useState } from 'react';
import { getCrmSettings, saveCrmSettings } from '../lib/crmSettingsApi';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import type { CrmSettings, CrmTriggerTemplates } from '../types/crmSettings';

/**
 * CRM trigger templates — the message sent by each automatic CRM email, with its own switch.
 *
 * These used to sit near the bottom of CRM Settings, below the mail accounts, referral codes and
 * broadcast form, which is a long way from anything that reads like an automation. They belong
 * with the other triggers, so this is the self-contained panel the Triggers screen mounts. The
 * data, the endpoints and the validation are unchanged — only where it is edited has moved.
 */

const title = (v: string): string =>
  v.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

export default function CrmTriggersPanel() {
  const toast = useToast();
  const [settings, setSettings] = useState<CrmSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getCrmSettings()
      .then(setSettings)
      .catch((e) => toast(apiErrorMessage(e, 'Could not load CRM triggers'), 'bad'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="centered">Loading triggers…</div>;
  if (!settings) return <div className="card"><p className="help">CRM triggers are unavailable.</p></div>;

  const templates = settings.templates;
  const patch = (key: keyof CrmTriggerTemplates, changes: Partial<CrmTriggerTemplates[keyof CrmTriggerTemplates]>) =>
    setSettings({ ...settings, templates: { ...templates, [key]: { ...templates[key], ...changes } } });

  const save = async () => {
    setSaving(true);
    try {
      await saveCrmSettings({ templates });
      toast('CRM triggers saved', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save CRM triggers'), 'bad');
    } finally { setSaving(false); }
  };

  return (
    <div className="card">
      <div className="modal-h">CRM Triggers</div>
      <p className="help">
        The message used for each automatic CRM email, with its own on/off switch. A trigger that
        is switched off sends nothing.
      </p>

      {(Object.keys(templates) as (keyof CrmTriggerTemplates)[]).map((key) => {
        const t = templates[key];
        return (
          <div key={String(key)} className="crm-trigger">
            <label className="crm-toggle">
              <span className="crm-toggle-text"><strong>{title(String(key))}</strong></span>
              <input type="checkbox" checked={t.enabled} onChange={(e) => patch(key, { enabled: e.target.checked })} />
            </label>
            <div className="g2">
              <div className="field">
                <label>Message</label>
                <input value={t.template} onChange={(e) => patch(key, { template: e.target.value })} />
              </div>
              {/* Only some triggers fire ahead of a date, so the field appears only where it applies. */}
              {t.daysBefore !== undefined && (
                <div className="field">
                  <label>Days Before</label>
                  <input type="number" min={0} max={365} value={t.daysBefore}
                    onChange={(e) => patch(key, { daysBefore: Number(e.target.value) })} />
                </div>
              )}
            </div>
          </div>
        );
      })}

      <div className="actions">
        <button className="btn primary" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save CRM Triggers'}
        </button>
      </div>
    </div>
  );
}
