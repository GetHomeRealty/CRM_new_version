import { useCallback, useEffect, useState } from 'react';
import {
  getNotificationPreferences, saveNotificationPreferences,
  type NotificationCategory,
} from '../lib/accountApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

/**
 * Which push notifications this person wants.
 *
 * Everything here is the signed-in user's own: the server scopes every read and write to them, so
 * there is no way to reach anyone else's choices and no admin view of them. Muting a category is
 * a personal decision, not something an office can make on somebody's behalf.
 *
 * A category with no push sender yet is shown, and labelled as such. The alternative — hiding
 * them until each sender is built — would make this screen look complete when it is not, and
 * showing them unlabelled would be worse: somebody would switch one off, keep getting the email,
 * and reasonably conclude the setting was broken. The choice is stored either way and takes
 * effect the moment the sender exists.
 */
export default function NotificationPreferencesPage() {
  const toast = useToast();
  const [categories, setCategories] = useState<NotificationCategory[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getNotificationPreferences();
      setCategories(r.categories);
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load your notification settings'), 'bad');
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const toggle = (key: string) => {
    setCategories((cs) => (cs ?? []).map((c) => (c.key === key ? { ...c, enabled: !c.enabled } : c)));
    setDirty(true);
  };

  const save = async () => {
    if (!categories) return;
    setSaving(true);
    try {
      // Only the categories that can actually be changed. Sending the disabled ones too would
      // write a row per user per category saying "enabled", which is already the default when no
      // row exists — rows that mean nothing and would have to be reasoned about later.
      const body: Record<string, boolean> = {};
      for (const c of categories) if (c.readiness === 'live') body[c.key] = c.enabled;
      // Re-seat from the response rather than trusting local state: the server is the authority on
      // what was actually stored, and a category it rejected must not keep showing as saved.
      setCategories((await saveNotificationPreferences(body)).categories);
      setDirty(false);
      toast('Notification settings saved.', 'ok');
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not save your notification settings'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  if (!categories) return <div className="card"><p className="help">Loading your notification settings…</p></div>;

  const pending = categories.filter((c) => c.readiness === 'pending').length;

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="lead-title">Notification Preferences</h2>
            <div className="lead-subtitle">
              <span className="muted">
                Choose which push notifications reach your phone and desktop. These are your own
                settings — nobody else can see or change them.
              </span>
            </div>
          </div>
          <div className="toolbar-row">
            <button className="btn primary" type="button" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        {/* `crm-toggle` is the settings-row pattern the CRM panels already use, so this screen
            matches them rather than introducing a second look for the same control. */}
        {categories.map((c) => (
          <label className="crm-toggle" key={c.key}>
            <span className="crm-toggle-text">
              <strong>
                {c.label}
                {c.readiness === 'pending' && (
                  <span
                    className="pill warn"
                    style={{ marginLeft: 8 }}
                    title="No push notification is sent for this yet, so there is nothing here to switch off."
                  >
                    Coming Soon
                  </span>
                )}
              </strong>
              <em>{c.description}</em>
              <em className="muted">How you are told today: {c.currentChannel}</em>
            </span>
            {/* Disabled, not merely badged, until something actually sends this push. A control
                that moves implies it did something; leaving it live would let somebody switch a
                category off, carry on receiving the email, and reasonably conclude the setting
                was broken. It becomes operable on its own the moment the category's readiness
                turns 'live' server-side — no change is needed here. */}
            <input
              type="checkbox"
              checked={c.enabled}
              disabled={c.readiness === 'pending'}
              onChange={() => toggle(c.key)}
              aria-label={
                c.readiness === 'pending'
                  ? `${c.label} push notifications — coming soon, nothing sends this yet`
                  : `${c.label} push notifications`
              }
            />
          </label>
        ))}
      </div>

      {pending > 0 && (
        <div className="card">
          <p className="help">
            <strong>About “Coming Soon”.</strong> {pending} of these {pending === 1 ? 'category does' : 'categories do'} not
            send a push notification yet, so {pending === 1 ? 'its switch is' : 'their switches are'} turned
            off until {pending === 1 ? 'it is' : 'they are'} built. You are still told about
            {pending === 1 ? ' it' : ' them'} the ways listed above — those are unaffected, and
            nothing is being missed.
          </p>
          <p className="help">
            {pending === 1 ? 'It becomes' : 'They become'} switchable here automatically once push
            is added, with no action needed from you.
          </p>
        </div>
      )}

      <div className="card">
        <p className="help">
          Turning something off here stops the <strong>push notification only</strong>. Emails and
          in-app notifications are unaffected — a muted calendar reminder still emails you, so
          nothing is missed, your phone just stays quiet.
        </p>
        <p className="help">
          Push also needs this browser to be subscribed. If you are not receiving any push
          notifications at all, check that notifications are allowed for this site in your browser
          settings.
        </p>
      </div>
    </>
  );
}
