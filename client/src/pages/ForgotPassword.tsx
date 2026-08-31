import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { forgotPassword } from '../lib/api';
import { apiErrorMessage } from '../lib/apiError';
import { companyLogoUrl } from '../lib/api';

/**
 * "I have forgotten my password."
 *
 * THE SCREEN MUST NOT SAY WHETHER THE ADDRESS EXISTS. The server deliberately returns the same
 * answer for a real address, an unknown one and a disabled account, so that an endpoint anyone can
 * call cannot be used to find out who has an account here. Showing "no such user" would hand back
 * exactly what the server refused to disclose, so the confirmation below is shown unconditionally.
 *
 * That is also why the confirmation replaces the form rather than sitting under it: a form still
 * on screen invites a second guess at the address, which is the behaviour the wording is trying to
 * avoid.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await forgotPassword(email.trim());
      setSent(r.message);
    } catch (ex) {
      // Only a genuine failure to REACH the server belongs here. A 422 from a malformed address is
      // about the field, not about whether the account exists.
      setError(apiErrorMessage(ex, 'Could not send the reset link. Try again in a moment.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-wrap"><div className="auth-card">
      <img className="auth-logo" src={companyLogoUrl()} alt="" />
      {sent ? (
        <>
          <h1>Check your email</h1>
          <p className="muted">{sent}</p>
          <p className="muted">The link works once, and expires after an hour.</p>
          <p className="muted"><Link to="/login">Back to sign in</Link></p>
        </>
      ) : (
        <>
          <h1>Forgot your password?</h1>
          <p className="muted">
            {/* Both accepted, because sign-in accepts both and somebody locked out is the least
                likely person to know which one this form wants. */}
            Enter your username or the email address on your account. We will send a link to the
            email address on the account.
          </p>
          {error && <p className="error">{error}</p>}
          <form onSubmit={onSubmit}>
            <label>
              Username or email
              {/* `type="text"`, not `email` — the browser would otherwise refuse to submit a
                  perfectly valid username for want of an "@". */}
              <input
                type="text" name="email" value={email} autoFocus required
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
          <p className="muted"><Link to="/login">Back to sign in</Link></p>
        </>
      )}
    </div></div>
  );
}
