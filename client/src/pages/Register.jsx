import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { registrationOpen } from '../lib/api';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    password_confirmation: '',
  });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => { registrationOpen().then(setOpen).catch(() => setOpen(true)); }, []);

  if (open === false) {
    return (
      <div className="auth-shell"><div className="auth-card">
        <h1>Registration closed</h1>
        <p className="muted" style={{ textAlign: 'left' }}>
          This Transaction Desk already has an administrator. New accounts are created by an admin under <strong>Users</strong>.
        </p>
        <p className="muted">Have an account? <Link to="/login">Sign in</Link></p>
      </div></div>
    );
  }

  const update = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setErrors({});
    setSubmitting(true);
    try {
      await register(form);
      navigate('/app/transactions');
    } catch (err) {
      // Laravel returns 422 with { errors: { field: [msg] } }
      setErrors(err.response?.data?.errors ?? { general: ['Registration failed.'] });
    } finally {
      setSubmitting(false);
    }
  };

  const fieldError = (name) => errors[name]?.[0];

  return (
    <div className="auth-shell"><div className="auth-card">
      <h1>Create account</h1>
      {errors.general && <p className="error">{errors.general[0]}</p>}
      <form onSubmit={onSubmit}>
        <label>
          Name
          <input name="name" value={form.name} onChange={update} required autoFocus />
          {fieldError('name') && <span className="field-error">{fieldError('name')}</span>}
        </label>
        <label>
          Email
          <input type="email" name="email" value={form.email} onChange={update} required />
          {fieldError('email') && <span className="field-error">{fieldError('email')}</span>}
        </label>
        <label>
          Password
          <input type="password" name="password" value={form.password} onChange={update} required />
          {fieldError('password') && <span className="field-error">{fieldError('password')}</span>}
        </label>
        <label>
          Confirm password
          <input
            type="password"
            name="password_confirmation"
            value={form.password_confirmation}
            onChange={update}
            required
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p className="muted">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </div></div>
  );
}
