import { DEFAULT_AREA, areaPath } from '../desk/area';
import '../styles/login-design.css';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import axios from 'axios';
import MfaChallenge from './MfaChallenge';
import { isChallenge, type MfaChallenge as MfaChallengeView } from '../lib/mfaApi';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ username: '', password: '' });
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [credentialsInvalid, setCredentialsInvalid] = useState(false);
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

  const update = (e: ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
    setError('');
    setCredentialsInvalid(false);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setCredentialsInvalid(false);
    setSubmitting(true);
    try {
      const outcome = await login(form.username, form.password, remember);
      if (isChallenge(outcome)) {
        // The password was right; the second factor is still outstanding. No navigation, because
        // there is nothing to navigate to yet.
        setChallenge(outcome.challenge);
        return;
      }
      navigate(destination, { replace: true });
    } catch (err) {
      const message = apiErrorMessage(err, 'Unable to sign in. Please try again.');
      const invalid = axios.isAxiosError(err) && (
        err.response?.status === 401 ||
        (err.response?.status === 422 && message === 'The provided credentials are incorrect.')
      );
      setCredentialsInvalid(invalid);
      setError(invalid ? 'Incorrect email/username or password. Please try again.' : message);
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
    <main className="auth-shell login-page">
      <section className="login-panel" aria-labelledby="login-heading">
        <div className="login-form-wrap">
          {/* Official supplied brokerage artwork. */}
          <img
            src="/get-home-realty-logo-fit.svg"
            alt="Get Home Realty — A Tradition of Trust"
            className="auth-logo login-logo"
          />

          {challenge ? (
            <div className="login-challenge">
              <MfaChallenge
                challenge={challenge}
                onSignedIn={() => navigate(destination, { replace: true })}
                onCancel={abandonChallenge}
              />
            </div>
          ) : (
            <>
              <div className="login-heading">
                <h1 id="login-heading" className="login-welcome-title">Welcome to<br /><span>Get Home Hub</span></h1>
              </div>

              <form onSubmit={onSubmit} className="login-form">
                <label className="login-field">
                  <span>Username or email</span>
                  <span className="login-input-wrap">
                    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5.75h16v12.5H4zM4.5 6.5 12 12l7.5-5.5" /></svg>
                    <input
                      type="text"
                      name="username"
                      value={form.username}
                      onChange={update}
                      placeholder="Email address or username"
                      autoComplete="username"
                      aria-invalid={credentialsInvalid || undefined}
                      aria-describedby={credentialsInvalid ? 'login-error' : undefined}
                      required
                    />
                  </span>
                </label>

                <label className="login-field">
                  <span>Password</span>
                  <span className="login-input-wrap login-password-wrap">
                    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 10V8a5 5 0 0 1 10 0v2M5.5 10.5h13v9h-13z" /></svg>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      name="password"
                      value={form.password}
                      onChange={update}
                      placeholder="Password"
                      autoComplete="current-password"
                      required
                      aria-invalid={credentialsInvalid || undefined}
                      aria-describedby={error ? 'login-error' : undefined}
                    />
                    <button className="login-eye" type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{showPassword && <path d="m3 3 18 18"/>}</svg>
                    </button>
                  </span>
                </label>

                {error && <p id="login-error" className="login-inline-error" role="alert">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v7m0 4h.01"/></svg>
                  <span>{error}</span>
                </p>}

                <div className="login-options">
                  <label className="login-remember">
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                    <span>Remember me</span>
                  </label>
                  <Link to="/forgot-password">Forgot password?</Link>
                </div>

                <button type="submit" className="login-submit" disabled={submitting}>
                  <span>{submitting ? 'Signing in…' : 'Sign In'}</span>
                  {!submitting && <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7M4 12h12" /></svg>}
                </button>
              </form>

              <p className="login-register">New to Get Home Hub? <Link to="/register">Create an account</Link></p>
              <img className="login-signature-art" src="/login-signature-transparent.png" alt="People, Properties, Possibilities" />
            </>
          )}

          <footer className="login-footer">
            <span>Need help? <a href="mailto:info@gethomerealty.ca">Contact Support</a></span>
          </footer>
        </div>
      </section>

      <section className="login-hero" aria-label="Your Get Home Realty workspace">
        <div className="login-hero-copy">
          <p>Real people<br />Real properties<br />Real possibilities</p>
          <span aria-hidden="true" />
        </div>
        <img src="/ghr-mascot-login.png" alt="Get Home Realty mascot welcoming you" className="login-mascot" />
        <p className="login-hero-promise">A Brighter<br />Tomorrow,<br />Together.</p>

        <div className="login-feature-row" aria-label="Platform benefits">
          <div><svg aria-hidden="true" viewBox="0 0 32 32"><circle cx="11" cy="10" r="4"/><circle cx="22" cy="11" r="3.5"/><path d="M3 26c.4-6 3.2-9 8-9s7.6 3 8 9M17 19c1.3-1.6 3-2.3 5-2.3 4.2 0 6.6 2.8 7 8.3"/></svg><span>Grow Your Network</span></div>
          <div><svg aria-hidden="true" viewBox="0 0 32 32"><path d="m3 15 13-11 13 11M6 13v15h20V13M13 28v-9h6v9"/></svg><span>Manage Properties</span></div>
          <div><svg aria-hidden="true" viewBox="0 0 32 32"><path d="M8 3h13l5 5v21H8zM21 3v6h6M12 15h10M12 20h10M12 25h7"/></svg><span>Close Deals Faster</span></div>
          <div><svg aria-hidden="true" viewBox="0 0 32 32"><path d="M4 28V17h5v11M13 28V10h6v18M23 28V4h5v24M2 28h28"/></svg><span>Achieve More</span></div>
        </div>
        <div className="login-trust"><i /><i /><i /><span>Tradition of Trust</span></div>
      </section>
    </main>
  );
}
