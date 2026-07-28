import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../lib/apiError';
import { companyLogoUrl } from '../lib/api';
import PasswordInput from '../desk/PasswordInput';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const update = (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [e.target.name]: e.target.value });

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(form.username, form.password);
      navigate('/app/transactions');
    } catch (err) {
      setError(apiErrorMessage(err, 'Login failed. Check your credentials.'));
    } finally {
      setSubmitting(false);
    }
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
        No account? <Link to="/register">Create one</Link>
      </p>
    </div></div>
  );
}
