import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { companyLogoUrl, resetPassword } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import PasswordInput from '../desk/PasswordInput';

/**
 * Set a new password from an emailed link.
 *
 * THE TOKEN STAYS IN THE URL AND NOWHERE ELSE. It is not copied into component state that outlives
 * the page, not stored, and not logged — it is a credential for the minute it is being spent. The
 * page is reached only from the email, so a missing token means somebody arrived here by hand and
 * is told so rather than shown a form that cannot work.
 *
 * ON SUCCESS EVERY SESSION ENDS, including any the person still had open, because the server treats
 * a reset as revoking access obtained with the old password. So this sends them to sign in rather
 * than pretending they are already through.
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const email = params.get('email') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // Checked here as well as on the server so the obvious mistake is caught without a round trip;
    // the server still refuses it, because a browser check is not a rule.
    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await resetPassword({ email, token, password, password_confirmation: confirmation });
      setDone(r.message);
      // A moment to read it, then to the sign-in page they now need.
      setTimeout(() => navigate('/login'), 2500);
    } catch (ex) {
      setError(apiErrorMessage(ex, 'That reset link is invalid or has expired.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!token || !email) {
    return (
      <div className="auth-wrap"><div className="auth-card">
        <img className="auth-logo" src={companyLogoUrl()} alt="" />
        <h1>That link is incomplete</h1>
        <p className="muted">
          Open the link from the email exactly as it was sent, or ask for a new one.
        </p>
        <p className="muted"><Link to="/forgot-password">Request a new link</Link></p>
      </div></div>
    );
  }

  return (
    <div className="auth-wrap"><div className="auth-card">
      <img className="auth-logo" src={companyLogoUrl()} alt="" />
      {done ? (
        <>
          <h1>Password changed</h1>
          <p className="muted">{done}</p>
          <p className="muted"><Link to="/login">Sign in</Link></p>
        </>
      ) : (
        <>
          <h1>Choose a new password</h1>
          <p className="muted">Setting a new password for <strong>{email}</strong>.</p>
          {error && <p className="error">{error}</p>}
          <form onSubmit={onSubmit}>
            <label>
              New password
              <PasswordInput name="password" value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} />
            </label>
            <label>
              Confirm new password
              <PasswordInput name="password_confirmation" value={confirmation} onChange={(e: ChangeEvent<HTMLInputElement>) => setConfirmation(e.target.value)} />
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Set new password'}
            </button>
          </form>
          <p className="muted">
            Signing in elsewhere ends when this is saved — that is what makes a reset worth doing.
          </p>
        </>
      )}
    </div></div>
  );
}
