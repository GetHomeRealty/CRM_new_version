import { DEFAULT_AREA, areaPath } from '../desk/area';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import { companyLogoUrl } from '../lib/api';
import PasswordInput from '../desk/PasswordInput';
import MfaChallenge from './MfaChallenge';
import { isChallenge, type MfaChallenge as MfaChallengeView } from '../lib/mfaApi';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /**
   * Set when the server answered `mfa_required`. While this is set, the password step is replaced
   * rather than hidden — there is no session yet, and nothing else on this screen is usable.
   */
  const [challenge, setChallenge] = useState<MfaChallengeView | null>(null);

  // Only an internal SSO handoff route may override the normal landing page. The value comes from
  // router state rather than a public `return_to=https://...` query, so this login cannot become an
  // open redirect to an attacker-controlled website.
  const requested = (location.state as { returnTo?: unknown } | null)?.returnTo;
  const destination = typeof requested === 'string' && requested.startsWith('/sso/authorize?')
    ? requested
    : areaPath(DEFAULT_AREA);

  const update = (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [e.target.name]: e.target.value });

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const outcome = await login(form.username, form.password);
      if (isChallenge(outcome)) {
        // The password was right; the second factor is still outstanding. No navigation, because
        // there is nothing to navigate to yet.
        setChallenge(outcome.challenge);
        return;
      }
      navigate(destination, { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err, 'Login failed. Check your credentials.'));
    } finally {
      setSubmitting(false);
    }
  };

  const abandonChallenge = () => {
    // The half-finished sign-in is left to expire on the server; clearing the password here means a
    // shared machine is not left one keystroke away from a completed sign-in.
    setChallenge(null);
    setForm((f) => ({ ...f, password: '' }));
    setError('');
  };

  return (
    <div className="auth-shell"><div className="auth-card">
      {/* The uploaded brand logo, served without a session so it shows before sign-in. */}
      <img
        src={companyLogoUrl()}
        alt="Get Home Realty"
        className="auth-logo"
        onError={(e) => { const i = e.currentTarget; if (i.src !== `${window.location.origin}/logo.svg`) i.src = '/logo.svg'; }}
      />
      {challenge ? (
        <MfaChallenge
          challenge={challenge}
          onSignedIn={() => navigate(destination, { replace: true })}
          onCancel={abandonChallenge}
        />
      ) : (
        <>
          <h1>Sign in</h1>
          {error && <p className="error">{error}</p>}
          <form onSubmit={onSubmit}>
            <label>
              Username
              <input type="text" name="username" value={form.username} onChange={update} required autoFocus />
            </label>
            <label>
              Password
              <PasswordInput name="password" value={form.password} onChange={update} />
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <p className="muted">
            {/* Beneath the form, not beside the password field: it is a way out of a dead end, not
                a step in signing in. */}
            <Link to="/forgot-password">Forgot your password?</Link>
          </p>
          <p className="muted">
            No account? <Link to="/register">Create one</Link>
          </p>
        </>
      )}
    </div></div>
  );
}
