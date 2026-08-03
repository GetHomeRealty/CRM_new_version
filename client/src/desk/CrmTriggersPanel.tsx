import { useEffect, useState } from 'react';
import { getCrmSettings, saveCrmSettings } from '../lib/crmSettingsApi';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import type { CrmSettings, CrmTriggerTemplates } from '../types/crmSettings';

/**
 * CRM trigger switches — which of the CRM emails may be sent, and from where.
 *
 * THESE ARE NOT AUTOMATIC, AND THIS SCREEN NO LONGER SAYS THEY ARE. It described "the message used
 * for each automatic CRM email" and offered a "Days Before" schedule; the CRM › Settings audit
 * established that no scheduler reads any of it. Every background job in the application is a
 * `setInterval` registered in a service — event reminders, campaign resume, IMAP sync, mail
 * retention, Meta sync, export sweep, lawyer reminders — and not one touches
 * `crm_settings.templates`, `template_toggles` or `auto_send_enabled`. The switches gate the manual
 * send on CRM Settings › Send a CRM Email and nothing else.
 *
 * The "Days Before" field is gone rather than disabled: it configured a schedule that does not
 * exist, so leaving it visible-but-inert would still promise the automation. The stored value is
 * untouched and the server still validates it, so nothing is lost if the sweep is built later.
 *
 * The message body was ALSO never used — `CrmAdvancedEmailService` builds each body from a
 * hardcoded template literal. Saying so on the screen is the honest version until one of the two is
 * made true. See docs/audit/CRM-SETTINGS-AUDIT.md, finding S-H3.
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
        Which CRM emails may be sent, each with its own on/off switch. A trigger that is switched
        off sends nothing.
      </p>
      <p className="help" style={{ marginTop: 0 }}>
        <strong>These are sent by hand, not on a schedule.</strong> Switching one on makes it
        available under CRM Settings → Send a CRM Email; nothing goes out on its own. The message
        below is a note for whoever sends it — the wording of the email itself is fixed.
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
                <label>Note</label>
                <input value={t.template} onChange={(e) => patch(key, { template: e.target.value })} />
              </div>
              {/*
                "Days Before" used to sit here. It configured a schedule with nothing behind it —
                see the note at the top of this file — so it is not offered. The stored value is
                left alone and still round-trips through the API.
              */}
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
