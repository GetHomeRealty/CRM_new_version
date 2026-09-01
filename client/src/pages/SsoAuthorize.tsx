import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import { authorizeSso, type SsoAuthorizeRequest } from '../lib/ssoApi';

function requestFrom(params: URLSearchParams): SsoAuthorizeRequest | null {
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const challenge = params.get('code_challenge');
  const method = params.get('code_challenge_method');
  const state = params.get('state');
  if (!clientId || !redirectUri || !challenge || method !== 'S256' || !state) return null;
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  };
}

/** Completes a Precon sign-in using the already authenticated CRM browser session. */
export default function SsoAuthorize() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const started = useRef(false);
  const request = useMemo(() => requestFrom(new URLSearchParams(location.search)), [location.search]);

  useEffect(() => {
    if (loading || !user || !request || started.current) return;
    started.current = true;
    authorizeSso(request)
      .then((destination) => { window.location.assign(destination); })
      .catch((err) => {
        started.current = false;
        setError(apiErrorMessage(err, 'Could not securely open Precon.'));
      });
  }, [attempt, loading, request, user]);

  if (loading) return <div className="centered" role="status">Checking your sign-in…</div>;
  if (!request) {
    return (
      <div className="auth-shell"><div className="auth-card">
        <h1>Invalid sign-in request</h1>
        <p className="error">The Precon sign-in link is incomplete. Return to CRM and open Precon again.</p>
      </div></div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ returnTo: `${location.pathname}${location.search}` }} />;
  }

  return (
    <div className="auth-shell"><div className="auth-card" aria-live="polite">
      <h1>Opening Precon/Canada</h1>
      {error ? (
        <>
          <p className="error">{error}</p>
          <button type="button" onClick={() => { started.current = false; setError(''); setAttempt((n) => n + 1); }}>Try again</button>
        </>
      ) : <p className="muted" role="status">Confirming your secure CRM sign-in…</p>}
    </div></div>
  );
}
