import { useCallback, useEffect, useState } from 'react';
import {
  CHANNEL_LABEL,
  getNotificationPreferences,
  saveNotificationPreferences,
  type NotificationCategory,
  type NotificationChannel,
} from '../lib/accountApi';
import { apiErrorMessage } from '../lib/apiError';
import { useToast } from './toast';

/**
 * Which notifications reach this person, and by which route.
 *
 * A MATRIX RATHER THAN A LIST OF SWITCHES, because the question people actually have is not "do I
 * want to hear about document reviews" but "I want the email, not the buzz on my phone". The old
 * screen could only answer the first: the table stored one boolean per category and it meant PUSH,
 * so the page had to explain in prose that turning something off left the email alone. It now stores
 * a row per (category, channel) and the screen says so directly.
 *
 * Everything here is the signed-in user's own: the server scopes every read and write to them, so
 * there is no way to reach anyone else's choices and no admin view of them. Muting a category is a
 * personal decision, not something an office can make on somebody's behalf.
 *
 * A cell with no sender yet is shown and disabled rather than hidden. Hiding them would make the
 * screen look complete when it is not; leaving them live would be worse — somebody would switch one
 * off, keep getting the notification another way, and reasonably conclude the setting was broken.
 */
export default function NotificationPreferencesPage() {
  const toast = useToast();
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [categories, setCategories] = useState<NotificationCategory[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getNotificationPreferences();
      setChannels(r.channels);
      setCategories(r.categories);
      setDirty(false);
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not load your notification settings'), 'bad');
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const toggle = (key: string, channel: NotificationChannel) => {
    setCategories((cs) => (cs ?? []).map((c) => (
      c.key === key ? { ...c, enabled: { ...c.enabled, [channel]: !c.enabled[channel] } } : c
    )));
    setDirty(true);
  };

  const save = async () => {
    if (!categories) return;
    setSaving(true);
    try {
      /*
       * Only the pairs that can actually be changed. Sending the disabled ones would write a row per
       * user per pair meaning "on", which is already what absence means — rows that say nothing and
       * would have to be reasoned about later.
       */
      const body: Record<string, Record<string, boolean>> = {};
      for (const c of categories) {
        const row: Record<string, boolean> = {};
        for (const ch of channels) if (c.channels[ch] === 'live') row[ch] = c.enabled[ch];
        if (Object.keys(row).length) body[c.key] = row;
      }
      // Re-seat from the response rather than trusting local state: the server is the authority on
      // what was stored, and a pair it rejected must not keep showing as saved.
      const saved = await saveNotificationPreferences(body);
      setChannels(saved.channels);
      setCategories(saved.categories);
      setDirty(false);
      toast('Notification settings saved.', 'ok');
    } catch (ex) {
      toast(apiErrorMessage(ex, 'Could not save your notification settings'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  if (!categories) return <div className="card"><p className="help">Loading your notification settings…</p></div>;

  const pendingPairs = categories.reduce(
    (n, c) => n + channels.filter((ch) => c.channels[ch] === 'pending').length,
    0,
  );

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="lead-title">Notification Preferences</h2>
            <div className="lead-subtitle">
              <span className="muted">
                Choose how each kind of notification reaches you. These are your own settings —
                nobody else can see or change them.
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

      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Notification</th>
              {channels.map((ch) => (
                <th key={ch} style={{ textAlign: 'center', padding: '8px 12px', whiteSpace: 'nowrap' }}>
                  {CHANNEL_LABEL[ch]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.key} style={{ borderTop: '1px solid var(--line, #eee)' }}>
                <td style={{ padding: '10px 12px' }}>
                  <strong>{c.label}</strong>
                  <div className="muted" style={{ fontSize: '0.9em' }}>{c.description}</div>
                </td>
                {channels.map((ch) => {
                  const readiness = c.channels[ch];
                  const unsupported = readiness === 'unsupported';
                  const pending = readiness === 'pending';
                  return (
                    <td key={ch} style={{ textAlign: 'center', padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      {unsupported ? (
                        <span className="muted" title={`${c.label} cannot be delivered by ${CHANNEL_LABEL[ch]}.`}>—</span>
                      ) : (
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={c.enabled[ch]}
                            disabled={pending}
                            onChange={() => toggle(c.key, ch)}
                            aria-label={
                              pending
                                ? `${c.label} by ${CHANNEL_LABEL[ch]} — coming soon, nothing sends this yet`
                                : `${c.label} by ${CHANNEL_LABEL[ch]}`
                            }
                          />
                          {pending && (
                            <span
                              className="pill warn"
                              title="Nothing sends this yet, so there is nothing here to switch off."
                            >
                              Soon
                            </span>
                          )}
                        </label>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pendingPairs > 0 && (
        <div className="card">
          <p className="help">
            <strong>About “Soon”.</strong> {pendingPairs} of these routes {pendingPairs === 1 ? 'is' : 'are'} not
            built yet, so {pendingPairs === 1 ? 'its switch is' : 'their switches are'} turned off. You are
            still told about those events the other ways shown in this table — nothing is being missed —
            and each becomes switchable here automatically once its sender exists, with no action
            needed from you.
          </p>
        </div>
      )}

      <div className="card">
        <p className="help">
          <strong>In-app</strong> notifications appear in the Notifications screen and the bell.{' '}
          <strong>Email</strong> goes to your account address. <strong>Push</strong> reaches your phone
          and desktop, and also needs this browser to be subscribed — if you get no push at all, check
          that notifications are allowed for this site in your browser settings.
        </p>
        <p className="help">
          A dash means that route does not apply to that kind of notification.
        </p>
      </div>
    </>
  );
}
