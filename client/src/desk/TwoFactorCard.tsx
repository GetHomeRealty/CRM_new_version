import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { apiErrorMessage } from '../lib/apiError';
import {
  beginOtp,
  beginTotp,
  confirmEnrolment,
  getMfaStatus,
  regenerateRecoveryCodes,
  removeMethod,
  revokeAllDevices,
  revokeDevice,
  type MfaStatus,
  type MfaType,
  type OtpChannel,
} from '../lib/mfaApi';

/**
 * Two-factor authentication, on the account settings screen.
 *
 * WHAT THIS SCREEN HAS TO GET RIGHT, beyond looking like the rest of the application:
 *
 *   - The recovery codes appear exactly once, at enrolment, and the screen says so plainly. They are
 *     stored hashed, so the server genuinely cannot show them again — a person who closes this panel
 *     without saving them has to regenerate, and should be told that before it happens rather than
 *     after.
 *   - The QR code is drawn LOCALLY, from the `otpauth://` URI, by a library bundled with the
 *     application. The secret is never sent anywhere to be turned into a picture; a third-party QR
 *     service would mean posting a second-factor secret to a stranger.
 *   - Manual entry is always offered beside the QR. Cameras fail, and an enrolment that only works
 *     by scanning is one a person on a desktop cannot complete.
 *   - Turning a factor OFF costs the account password, so a borrowed session cannot strip it.
 */
export default function TwoFactorCard() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Enrolment in progress
  const [setup, setSetup] = useState<{ type: MfaType; secret?: string; display?: string; qr?: string; masked?: string } | null>(null);
  const [code, setCode] = useState('');
  const [destination, setDestination] = useState('');

  // Shown once, after a successful enrolment or a regeneration.
  const [codes, setCodes] = useState<string[] | null>(null);

  // Removing a factor / regenerating codes both ask for the password.
  const [confirm, setConfirm] = useState<{ action: 'remove'; type: MfaType } | { action: 'regenerate' } | null>(null);
  const [password, setPassword] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await getMfaStatus());
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load your security settings.'));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const label = (t: MfaType): string =>
    (t === 'totp' ? 'Authenticator app' : t === 'sms' ? 'Text message' : 'Email');

  // ---------------------------------------------------------------- enrolment

  const startTotp = async () => {
    setError('');
    setBusy(true);
    try {
      const { secret, secret_display, uri } = await beginTotp();
      // Drawn in the browser. The URI — and therefore the secret — never leaves this machine.
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
      setSetup({ type: 'totp', secret, display: secret_display, qr });
      setCode('');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not start setting up an authenticator app.'));
    } finally {
      setBusy(false);
    }
  };

  const startOtp = async (channel: OtpChannel) => {
    setError('');
    setBusy(true);
    try {
      const { masked } = await beginOtp(channel, destination.trim());
      setSetup({ type: channel, masked });
      setCode('');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not send a code to that destination.'));
    } finally {
      setBusy(false);
    }
  };

  const finishEnrolment = async () => {
    if (!setup) return;
    setError('');
    setBusy(true);
    try {
      const { recovery_codes } = await confirmEnrolment(setup.type, code.trim());
      setCodes(recovery_codes);
      setSetup(null);
      setCode('');
      setDestination('');
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err, 'That code is not right. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------- password-gated actions

  const runConfirmed = async () => {
    if (!confirm) return;
    setError('');
    setBusy(true);
    try {
      if (confirm.action === 'remove') {
        await removeMethod(confirm.type, password);
      } else {
        const { recovery_codes } = await regenerateRecoveryCodes(password);
        setCodes(recovery_codes);
      }
      setConfirm(null);
      setPassword('');
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err, 'That did not work. Check your password.'));
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
    } catch {
      // Clipboard access can be refused; the codes are on screen either way, which is the point.
    }
  };

  if (!status) return <div className="card"><div className="modal-sub">Two-step verification</div><p className="help">Loading…</p></div>;

  const confirmedTypes = status.methods.filter((m) => m.confirmed).map((m) => m.type);
  const canAddTotp = !confirmedTypes.includes('totp') && status.storage_available;

  return (
    <div className="card">
      <div className="modal-sub">Two-step verification</div>
      <p className="muted">
        A second step at sign-in, so a stolen password is not enough on its own.
      </p>

      {error && <p className="error">{error}</p>}

      {status.obligation.state === 'overdue' && (
        <p className="error">Your role requires two-step verification. Set it up to keep using your account.</p>
      )}
      {status.obligation.state === 'grace' && (
        <p className="muted">
          Your role requires two-step verification within {status.obligation.days_left} day
          {status.obligation.days_left === 1 ? '' : 's'}.
        </p>
      )}

      {/* ---------------------------------------------------------------- the codes, shown once */}
      {codes && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="modal-sub">Save your recovery codes</div>
          <p>
            These are shown <strong>once</strong>. Keep them somewhere safe — each one signs you in
            if you lose your phone, and each works only once. We store them hashed and cannot show
            them again.
          </p>
          <ul className="recovery-codes">
            {codes.map((c) => <li key={c}><code>{c}</code></li>)}
          </ul>
          <button className="btn ghost sm" type="button" onClick={copyCodes}>Copy</button>{' '}
          <button className="btn primary sm" type="button" onClick={() => setCodes(null)}>I have saved them</button>
        </div>
      )}

      {/* ---------------------------------------------------------------- what is set up */}
      {status.enabled ? (
        <ul className="mfa-methods">
          {status.methods.filter((m) => m.confirmed).map((m) => (
            <li key={m.type}>
              <strong>{label(m.type)}</strong>
              {m.destination && <> — {m.destination}</>}
              {m.last_used_at && <span className="muted"> · last used {new Date(m.last_used_at).toLocaleDateString()}</span>}
              {' '}
              <button className="btn ghost sm" type="button" onClick={() => { setConfirm({ action: 'remove', type: m.type }); setPassword(''); }}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Not set up yet.</p>
      )}

      {status.enabled && (
        <p className="muted">
          {status.recovery_codes_remaining} recovery code{status.recovery_codes_remaining === 1 ? '' : 's'} left.{' '}
          <button type="button" className="linklike" onClick={() => { setConfirm({ action: 'regenerate' }); setPassword(''); }}>
            Generate new ones
          </button>
          {status.recovery_codes_remaining <= 2 && (
            <> <strong>Running low — generate a new set.</strong></>
          )}
        </p>
      )}

      {/* ---------------------------------------------------------------- adding a method */}
      {!setup && !confirm && (
        <div className="mfa-add">
          {canAddTotp && (
            <button className="btn primary sm" type="button" onClick={startTotp} disabled={busy}>Add an authenticator app</button>
          )}
          {!status.storage_available && (
            <p className="error">
              An authenticator app cannot be set up on this system: the server has no APP_KEY, so the
              secret could not be stored safely. Ask an administrator to set one.
            </p>
          )}
          {status.available_channels.filter((c) => !confirmedTypes.includes(c)).map((channel) => (
            <div key={channel} className="mfa-add-row">
              <label>
                {channel === 'sms' ? 'Mobile number' : 'Email address'}
                <input
                  type={channel === 'sms' ? 'tel' : 'email'}
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder={channel === 'sms' ? '416-555-0100' : 'you@example.com'}
                />
              </label>
              <button className="btn primary sm" type="button" onClick={() => startOtp(channel)} disabled={busy || destination.trim() === ''}>
                Send a code by {channel === 'sms' ? 'text' : 'email'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------------------- enrolment in progress */}
      {setup && (
        <div className="callout">
          <div className="modal-sub">Finish setting up {label(setup.type)}</div>

          {setup.type === 'totp' ? (
            <>
              <p>Scan this with your authenticator app:</p>
              {setup.qr && <img src={setup.qr} alt="Two-factor setup QR code" width={220} height={220} />}
              <p className="muted">
                Cannot scan it? Enter this key by hand:<br />
                <code>{setup.display}</code>
              </p>
            </>
          ) : (
            <p>We sent a code to {setup.masked}. Enter it below to confirm.</p>
          )}

          <label>
            Code
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
            />
          </label>
          <button className="btn primary sm" type="button" onClick={finishEnrolment} disabled={busy || code.trim() === ''}>
            {busy ? 'Checking…' : 'Confirm'}
          </button>{' '}
          <button className="btn ghost sm" type="button" onClick={() => { setSetup(null); setCode(''); }}>Cancel</button>
        </div>
      )}

      {/* ---------------------------------------------------------------- password confirmation */}
      {confirm && (
        <div className="callout">
          <div className="modal-sub">{confirm.action === 'remove' ? `Remove ${label(confirm.type)}` : 'Generate new recovery codes'}</div>
          <p className="muted">
            {confirm.action === 'remove'
              ? 'This makes your account easier to reach with only a password. Every trusted device will be asked for a code again.'
              : 'Your current recovery codes will stop working immediately.'}
          </p>
          <label>
            Your password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          <button className="btn primary sm" type="button" onClick={runConfirmed} disabled={busy || password === ''}>
            {busy ? 'Working…' : 'Confirm'}
          </button>{' '}
          <button className="btn ghost sm" type="button" onClick={() => { setConfirm(null); setPassword(''); }}>Cancel</button>
        </div>
      )}

      {/* ---------------------------------------------------------------- trusted devices */}
      {status.trusted_devices.length > 0 && (
        <>
          <div className="modal-sub" style={{ marginTop: 16 }}>Devices that skip the second step</div>
          <ul className="mfa-devices">
            {status.trusted_devices.map((d) => (
              <li key={d.id}>
                {d.label ?? 'A browser'}
                {d.ip && <span className="muted"> · {d.ip}</span>}
                {d.last_seen_at && <span className="muted"> · last used {new Date(d.last_seen_at).toLocaleString()}</span>}
                <span className="muted"> · expires {new Date(d.expires_at).toLocaleDateString()}</span>
                {' '}
                <button
                  className="btn ghost sm"
                  type="button"
                  onClick={async () => { await revokeDevice(d.id); await refresh(); }}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
          <button
            className="btn ghost sm"
            type="button"
            onClick={async () => { await revokeAllDevices(); await refresh(); }}
          >
            Revoke all — including this one
          </button>
        </>
      )}
    </div>
  );
}
