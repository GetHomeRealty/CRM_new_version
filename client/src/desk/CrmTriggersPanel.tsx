import { useCallback, useEffect, useRef, useState } from 'react';
import { getCrmEmailSettings, getMyTriggers, saveCrmEmailSettings, saveMyTriggers } from '../lib/crmSettingsApi';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import { useUnsavedGuard } from './useUnsavedGuard';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { apiErrorMessage } from '../lib/apiError';
import type { CrmEmailSettings, CrmMyTriggers } from '../types';

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
  welcome: 'New Lead Welcome Email',
};

const TRIGGER_HINTS: Record<string, string> = {
  wedding: 'Congratulations on a wedding date recorded against a lead.',
  seasonal: 'A seasonal greeting for a chosen season and year.',
  promotional: 'An offer with a title, discount, code and expiry.',
  referral: 'Sends a referral code to a lead who recommended you.',
  custom: 'A subject and message written at the time of sending.',
  welcome: 'Sent once to each new lead you receive, from your own CRM address.',
};

const stamp = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '');

export default function CrmTriggersPanel() {
  const toast = useToast();
  const { can, user } = useAuth();
  // The permission this screen's own endpoints ask for. `view` shows the switches; `edit` makes
  // them yours to change.
  const canEdit = can('triggers', 'edit');

  /*
   * THE BROKERAGE KILL SWITCH, on a screen everybody can open.
   *
   * `settings`, NOT `triggers`. Everything else here is one row per person, which is exactly why
   * this screen's own permission was safe to widen to every agent. The switch below is the opposite
   * kind of control — one row, one value, every colleague's sending — so it keeps the permission its
   * endpoint has always enforced (`@Screen('settings', ...)` on `email-settings`). Gating the card
   * on the same permission the server checks, rather than on a role, is what stops the two drifting.
   *
   * An agent therefore sees no switch, only the notice further down that already told them CRM email
   * was off. What changes for an ADMINISTRATOR is that the notice and the fix are now on one screen:
   * the warning used to say "an administrator must turn this back on under CRM Settings" to the very
   * person who had to go there and do it.
   */
  const canSeeBrokerage = can('settings', 'view');
  const canSetBrokerage = can('settings', 'edit');

  const [data, setData] = useState<CrmMyTriggers | null>(null);
  const [brokerage, setBrokerage] = useState<CrmEmailSettings | null>(null);
  const [savingSwitch, setSavingSwitch] = useState(false);

  /**
   * What the switch was when this screen last agreed with the server.
   *
   * The confirmation fires on the TRANSITION to off, not on the state, so a brokerage that already
   * has CRM email off is not asked to confirm it again — and a confirmation people meet when nothing
   * is happening is one they learn to click through.
   */
  const loadedSending = useRef(true);
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

      /*
       * Fetched separately, and only by someone allowed to read it. `sending_allowed` already rides
       * on the triggers payload and is what the notice below uses, so an agent needs nothing more;
       * this second call exists to give the card a value it can WRITE back. Failing it must not take
       * the screen down — the triggers are the point of the page and they have already loaded.
       */
      if (canSeeBrokerage) {
        try {
          const e = await getCrmEmailSettings();
          setBrokerage(e);
          loadedSending.current = e.autoSendEnabled;
        } catch {
          setBrokerage(null);
        }
      }
    } catch (e) {
      // Kept on the page rather than only in a toast, so a failure that happened while the person
      // was looking elsewhere is still explained when they look back — and so it can offer a retry.
      setFailed(apiErrorMessage(e, 'Could not load your CRM triggers'));
    } finally {
      setLoading(false);
    }
  }, [canSeeBrokerage]);

  useEffect(() => { void load(); }, [load]);

  /*
   * Re-read when the tab is looked at again — but never over unsaved work.
   *
   * These switches are personal now, so nobody else can change them; what does change underneath is
   * the BROKERAGE side this screen displays — the defaults an unset switch inherits, and the kill
   * switch in the card above, which another administrator can flip. Measured during the audit: an
   * administrator
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

  /**
   * Save the brokerage switch, asking first when it is being turned OFF.
   *
   * The confirmation is the point, and its blast radius is why it reads differently from the
   * all-off question above: that one affects the person clicking it, this one affects everybody.
   * Turning it back on saves without ceremony.
   */
  const persistBrokerage = async () => {
    if (!brokerage) return;
    setSavingSwitch(true);
    try {
      const saved = await saveCrmEmailSettings({ ...brokerage });
      setBrokerage(saved);
      loadedSending.current = saved.autoSendEnabled;
      // Re-read so the notice below agrees with the switch immediately, rather than at the next
      // focus. `sending_allowed` comes from the triggers payload, not from this response.
      void load();
      toast('Settings updated successfully', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not change CRM email for the brokerage'), 'bad');
    } finally {
      setSavingSwitch(false);
    }
  };

  const saveBrokerage = () => {
    if (!brokerage) return;
    const switchingOff = !brokerage.autoSendEnabled && loadedSending.current;
    if (!switchingOff) { void persistBrokerage(); return; }
    askDelete({
      title: 'Switch off CRM email for the whole brokerage?',
      message: 'No CRM email will send for anybody — not yours, not any colleague’s — whatever their own trigger choices say. The sending screen will refuse without explaining why. Campaigns are not affected; those are stopped on the Campaigns screen.',
      note: 'You can turn it back on here at any time.',
      onConfirm: () => { closeConfirm(); void persistBrokerage(); },
    });
  };

  return (
    <>
      {/*
        Above the personal switches, because it overrides every one of them — a control that can
        make the card below inert should not sit underneath it.
      */}
      {canSeeBrokerage && brokerage && (
        <div className="card">
          <h3 className="modal-h">Brokerage</h3>
          <p className="help" style={{ marginTop: 0 }}>
            This applies to <strong>everybody</strong>, not just you.
          </p>
          <label className="crm-toggle">
            <span className="crm-toggle-text">
              {/*
                NAMED FOR WHAT IT ACTUALLY STOPS. It was "Allow CRM emails — turn off to block every
                CRM send, for everybody", which overstated it: the flag is read on one path, the
                CRM's per-lead emails, and a campaign goes out regardless. An administrator reaching
                for this during a complaint would have believed they had stopped everything.
              */}
              <strong>Allow the CRM&apos;s per-lead emails</strong>
              <em>
                Wedding, seasonal, promotional, referral and custom messages — for everybody. Email
                campaigns are not affected; those are stopped on the Campaigns screen.
              </em>
            </span>
            <input type="checkbox" checked={brokerage.autoSendEnabled} disabled={!canSetBrokerage || savingSwitch}
              onChange={(e) => setBrokerage({ ...brokerage, autoSendEnabled: e.target.checked })} />
          </label>
          {canSetBrokerage ? (
            <div className="actions">
              {/* Named, not a bare "Save": this screen has one per card, and the accessible name is
                  how both a screen reader and the regression suite tell them apart. */}
              <button className="btn primary" type="button" disabled={savingSwitch} onClick={saveBrokerage}>
                {savingSwitch ? 'Saving…' : 'Save CRM Email'}
              </button>
            </div>
          ) : (
            <p className="help" style={{ marginTop: 0 }}>
              <strong>Read-only.</strong> Changing this needs the Settings permission at <em>Edit</em>.
            </p>
          )}
        </div>
      )}

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
          <strong>The CRM&apos;s per-lead emails are switched off for the whole brokerage.</strong>{' '}
          Your choices below are saved, but nothing can send until{' '}
          {/* Told to the person who can act on it, rather than about them. The old wording sent an
              administrator to another screen to fix a warning they were already looking at. */}
          {canSetBrokerage
            ? 'you switch them back on in the Brokerage card above.'
            : 'an administrator switches them back on.'}
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
    </>
  );
}
