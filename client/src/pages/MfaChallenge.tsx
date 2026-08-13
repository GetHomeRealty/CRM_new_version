import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import { sendChallengeCode, type MfaChallenge as Challenge, type MfaType } from '../lib/mfaApi';

/**
 * The second step of signing in.
 *
 * Shown only when the server has answered `mfa_required`. At this point a password has been proved
 * and nothing else — there is no session, no user, and no navigation, which is why this is rendered
 * inside the sign-in card rather than anywhere in the application shell.
 *
 * The wording avoids saying anything an unauthenticated visitor should not learn. It never confirms
 * whether a code was actually delivered, because whether an address is reachable is a fact about an
 * account, and this screen can be reached by anyone who has a password — including one they stole.
 */
export default function MfaChallenge({
  challenge,
  onSignedIn,
  onCancel,
}: {
  challenge: Challenge;
  onSignedIn: () => void;
  onCancel: () => void;
}) {
  const { completeMfa } = useAuth();
  const [method, setMethod] = useState<MfaType | 'recovery'>(challenge.preferred);
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sending, setSending] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // Focus the field on arrival and whenever the method changes — this screen exists to be typed
  // into, and a person with a phone in one hand should not have to click first.
  useEffect(() => { codeRef.current?.focus(); }, [method]);

  const label = (t: MfaType | 'recovery'): string => (
    t === 'totp' ? 'Authenticator app'
      : t === 'email' ? 'Email'
        : t === 'sms' ? 'Text message'
          : 'Recovery code'
  );

  const destinationFor = (t: MfaType): string | null =>
    challenge.methods.find((m) => m.type === t)?.destination ?? null;

  const resend = async (channel: 'email' | 'sms') => {
    setError('');
    setSending(true);
    try {
      await sendChallengeCode(channel);
      // Deliberately non-committal: the server does not report whether delivery succeeded, and
      // repeating that here is what keeps this from becoming an oracle.
      setNotice('If that method is set up, a code is on its way.');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not request a new code.'));
    } finally {
      setSending(false);
    }
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      await completeMfa(method, code.trim(), trustDevice);
      onSignedIn();
    } catch (err) {
      setError(apiErrorMessage(err, 'That code is not right, or it has expired.'));
      setCode('');
      codeRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const options: Array<MfaType | 'recovery'> = [
    ...challenge.methods.map((m) => m.type),
    ...(challenge.recovery_available ? (['recovery'] as const) : []),
  ];

  return (
    <>
      <h1>Two-step verification</h1>
      <p className="muted">
        {method === 'recovery'
          ? 'Enter one of the recovery codes you saved when you set this up.'
          : method === 'totp'
            ? 'Enter the six-digit code from your authenticator app.'
            : `Enter the code sent to ${destinationFor(method) ?? 'you'}.`}
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <form onSubmit={onSubmit}>
        <label>
          Code
          <input
            ref={codeRef}
            type="text"
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            // `one-time-code` is what lets iOS and Android offer the code from a text message, and
            // password managers fill a TOTP code. Without it people retype it by hand.
            autoComplete="one-time-code"
            inputMode={method === 'recovery' ? 'text' : 'numeric'}
            spellCheck={false}
            required
          />
        </label>

        <label className="checkline">
          <input
            type="checkbox"
            checked={trustDevice}
            onChange={(e) => setTrustDevice(e.target.checked)}
          />
          {' '}
          Do not ask again on this device
        </label>

        <button type="submit" disabled={submitting || code.trim().length === 0}>
          {submitting ? 'Checking…' : 'Verify'}
        </button>
      </form>

      {(method === 'email' || method === 'sms') && (
        <p className="muted">
          <button type="button" className="linklike" onClick={() => resend(method)} disabled={sending}>
            {sending ? 'Sending…' : 'Send a new code'}
          </button>
        </p>
      )}

      {options.length > 1 && (
        <p className="muted">
          Try another way:{' '}
          {options.filter((o) => o !== method).map((o, i) => (
            <span key={o}>
              {i > 0 && ' · '}
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  setMethod(o);
                  setCode('');
                  setError('');
                  setNotice('');
                  // Asking for the code is part of choosing the method — nobody should have to press
                  // a second button to receive the thing they just asked to be sent.
                  if (o === 'email' || o === 'sms') void resend(o);
                }}
              >
                {label(o)}
              </button>
            </span>
          ))}
        </p>
      )}

      <p className="muted">
        <button type="button" className="linklike" onClick={onCancel}>Back to sign in</button>
      </p>
    </>
  );
}
