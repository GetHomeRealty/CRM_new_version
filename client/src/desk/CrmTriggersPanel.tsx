import { useCallback, useEffect, useState } from 'react';
import { getMyTriggers, saveMyTriggers } from '../lib/crmSettingsApi';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import { useUnsavedGuard } from './useUnsavedGuard';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { apiErrorMessage } from '../lib/apiError';
import type { CrmMyTriggers } from '../types';

/**
 * CRM email triggers — YOUR OWN.
 *
 * WHAT CHANGED AND WHY. These switches lived on the single brokerage-wide settings row, so an agent
 * turning off promotional email turned it off for the whole office; and because this screen posted
 * that entire row back, a trigger flip also overwrote SMTP details somebody had changed elsewhere.
 * They are one row per person now (`crm_trigger_settings`), and this screen sends nothing but the
 * switches — so there is no shared field left for it to trample.
 *
 * The permission moved with it. The route and the sidebar have always asked for `triggers`; the data
 * behind them asked for `settings`, which agents, accounting, documentation and crm do not hold — so
 * four roles were offered this screen in the navigation and met a permission error. Both now ask for
 * `triggers`, which is safe to grant precisely because the rows are personal.
 *
 * INHERITED VS CHOSEN. A switch you have never touched follows the brokerage default and keeps
 * following it when an administrator changes that default. Touching one makes it yours. The screen
 * says which is which rather than presenting an inherited value as a decision you made.
 *
 * STILL NOT AUTOMATIC. Nothing here sends on a schedule; the switches decide what you may send by
 * hand from CRM Settings › Send a CRM Email.
 */

const title = (v: string): string =>
  v.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

const TRIGGER_LABELS: Record<string, string> = {
  wedding: 'Wedding Congratulations',
  seasonal: 'Seasonal Wishes',
  promotional: 'Promotional Offer',
  referral: 'Referral Code',
  custom: 'Custom Message',
};

const TRIGGER_HINTS: Record<string, string> = {
  wedding: 'Congratulations on a wedding date recorded against a lead.',
  seasonal: 'A seasonal greeting for a chosen season and year.',
  promotional: 'An offer with a title, discount, code and expiry.',
  referral: 'Sends a referral code to a lead who recommended you.',
  custom: 'A subject and message written at the time of sending.',
};

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '');

export default function CrmTriggersPanel() {
  const toast = useToast();
  const { can, user } = useAuth();
  // The permission this screen's own endpoints ask for. `view` shows the switches; `edit` makes
  // them yours to change.
  const canEdit = can('triggers', 'edit');

  const [data, setData] = useState<CrmMyTriggers | null>(null);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);
  const { confirm, askDelete, closeConfirm } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(null);
    try {
      const r = await getMyTriggers();
      setData(r);
      setDraft({ ...r.triggers });
      setDirty(false);
    } catch (e) {
      // Kept on the page rather than only in a toast, so a failure that happened while the person
      // was looking elsewhere is still explained when they look back — and so it can offer a retry.
      setFailed(apiErrorMessage(e, 'Could not load your CRM triggers'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /*
   * Re-read when the tab is looked at again — but never over unsaved work.
   *
   * These switches are personal now, so nobody else can change them; what does change underneath is
   * the BROKERAGE side this screen displays — the defaults an unset switch inherits, and the
   * "Allow CRM emails" kill switch shown in the banner. Measured during the audit: an administrator
   * turned everything off through the API and an open screen went on reporting the old values
   * indefinitely, because nothing ever re-read them.
   *
   * `dirty` is the guard, and it is the whole reason this is safe. Refreshing while somebody has
   * half-flipped switches would throw their edits away to fix a display problem — a worse bug than
   * the one being fixed. A stale screen with unsaved work stays stale until they save or cancel.
   */
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && !dirty && !saving) void load(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [load, dirty, saving]);

  if (loading) return <div className="centered">Loading your triggers…</div>;

  if (failed || !data) {
    return (
      <div className="card">
        <h3 className="modal-h">CRM Triggers</h3>
        <p className="help">{failed ?? 'Your CRM triggers are unavailable.'}</p>
        <div className="actions">
          <button className="btn ghost" type="button" onClick={() => void load()}>↻ Try again</button>
        </div>
      </div>
    );
  }

  const set = (key: string, value: boolean) => {
    setDirty(true);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const changed = data.trigger_keys.filter((k) => draft[k] !== data.triggers[k]);

  /*
   * SEND ONLY THE SWITCHES THAT MOVED.
   *
   * This posted all five on every save. The server merges what it receives onto what is stored, so
   * that made the FIRST save sever inheritance for every trigger at once — while this screen tells
   * you, one switch at a time, "Following the brokerage default — change it and it becomes your own
   * choice." Flip wedding, press Save, and seasonal silently stopped following the brokerage too;
   * an administrator changing the default afterwards no longer reached you.
   *
   * Caught by a test asserting the inheritance the screen promises, not by reading this line.
   * `changed` is what the Save button already counts, so the request now says exactly what the
   * button said it would do.
   */
  const persist = async () => {
    setSaving(true);
    try {
      const r = await saveMyTriggers(Object.fromEntries(changed.map((k) => [k, !!draft[k]])));
      setData(r);
      setDraft({ ...r.triggers });
      setDirty(false);
      toast('Your CRM triggers were saved', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save your CRM triggers'), 'bad');
    } finally { setSaving(false); }
  };

  /*
   * Switching everything off is confirmed; switching things on is not.
   *
   * Turning every trigger off means no CRM email of any kind can leave under this person's name,
   * and nothing on the sending screen explains why — it simply refuses. That is worth one question.
   * Anything less than all-off is an ordinary edit and is saved without ceremony.
   */
  const save = () => {
    const allOff = data.trigger_keys.every((k) => !draft[k]);
    if (!allOff) { void persist(); return; }
    askDelete({
      title: 'Switch off every CRM email?',
      message: 'None of the CRM emails below will be available to you until you switch one back on. This affects only your own account — your colleagues are unchanged.',
      note: 'You can turn them back on here at any time.',
      onConfirm: () => { closeConfirm(); void persist(); },
    });
  };

  return (
    <div className="card">
      <h3 className="modal-h">CRM Triggers</h3>
      <p className="help">
        Which CRM emails <strong>you</strong> may send. A trigger that is switched off sends nothing,
        and these are yours alone — changing them does not affect any colleague or administrator.
      </p>
      <p className="help" style={{ marginTop: 0 }}>
        <strong>These are sent by hand, not on a schedule.</strong> Switching one on makes it
        available under CRM Settings → Send a CRM Email; nothing goes out on its own. The wording of
        each email is fixed.
      </p>

      {data.unreadable && (
        <div className="reminder-warn" style={{ marginTop: 8 }}>
          <strong>Your saved trigger choices could not be read.</strong> Until you save this screen
          again, every CRM email you try to send will be refused — deliberately, because a setting
          that cannot be read is not permission to send.
        </div>
      )}

      {!data.sending_allowed && (
        <div className="reminder-warn" style={{ marginTop: 8 }}>
          <strong>CRM email is switched off for the whole brokerage.</strong> Your choices below are
          saved, but nothing can send until an administrator turns “Allow CRM emails” back on under
          CRM Settings → Email Campaigns.
        </div>
      )}

      {!canEdit && (
        <p className="help">
          <strong>Read-only.</strong> You can see your triggers but not change them — that needs the
          Triggers permission at <em>Edit</em>, which an administrator grants under Settings →
          Roles &amp; Permissions.
        </p>
      )}

      {data.trigger_keys.map((key) => {
        const inherited = !data.customised[key] && draft[key] === data.triggers[key];
        return (
          <label className="crm-toggle" key={key}>
            <span className="crm-toggle-text">
              <strong>{TRIGGER_LABELS[key] ?? title(key)}</strong>
              {TRIGGER_HINTS[key] && <em>{TRIGGER_HINTS[key]}</em>}
              {inherited && (
                <em className="muted">
                  Following the brokerage default ({data.brokerage_defaults[key] ? 'on' : 'off'}) —
                  change it and it becomes your own choice.
                </em>
              )}
            </span>
            <input
              type="checkbox"
              checked={!!draft[key]}
              disabled={!canEdit}
              aria-label={`${TRIGGER_LABELS[key] ?? key} — my CRM emails`}
              onChange={(e) => set(key, e.target.checked)}
            />
          </label>
        );
      })}

      {(data.updated_at || data.updated_by) && (
        <p className="help" style={{ marginTop: 10 }}>
          Last changed by {data.updated_by ?? 'you'}{data.updated_at ? ` on ${stamp(data.updated_at)}` : ''}.
        </p>
      )}

      {canEdit && (
        <div className="actions">
          <button className="btn primary" type="button" disabled={saving || changed.length === 0} onClick={save}>
            {saving ? 'Saving…' : changed.length === 0 ? 'Saved' : `Save ${changed.length} change${changed.length === 1 ? '' : 's'}`}
          </button>
          {changed.length > 0 && (
            <button className="btn ghost" type="button" disabled={saving}
              onClick={() => { setDraft({ ...data.triggers }); setDirty(false); }}>
              Cancel
            </button>
          )}
        </div>
      )}

      <p className="help" style={{ marginTop: 10 }}>
        These are {user?.name ? `${user.name}'s` : 'your'} triggers. Every person in the brokerage has
        their own set.
      </p>

      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </div>
  );
}
