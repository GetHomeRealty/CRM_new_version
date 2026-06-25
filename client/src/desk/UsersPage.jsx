import { useEffect, useState } from 'react';
import { getUsers, getUsersCatalog, createUser, updateUser, deleteUser } from '../lib/api';
import { roleLabel } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';

export default function UsersPage() {
  const toast = useToast();
  const { user: me, setUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // user object or {} for new

  const load = () => {
    setLoading(true);
    Promise.all([getUsers(), getUsersCatalog()])
      .then(([u, c]) => { setUsers(u); setCatalog(c); })
      .catch(() => toast('Could not load users', 'bad'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onDelete = async (u) => {
    if (!window.confirm(`Delete ${u.name}?`)) return;
    try { await deleteUser(u.id); setUsers((us) => us.filter((x) => x.id !== u.id)); toast('User deleted', 'ok'); }
    catch (e) { toast(e.response?.data?.message || 'Could not delete', 'bad'); }
  };

  const roleP = (r) => r === 'admin' ? 'bad' : (r === 'manager' ? 'warn' : 'info');
  const accessSummary = (perms) => {
    const v = Object.values(perms || {});
    return `${v.filter((l) => l === 'edit').length} edit · ${v.filter((l) => l === 'view').length} view`;
  };

  if (loading) return <div className="centered">Loading users…</div>;

  return (
    <>
      <div className="toolbar"><div className="toolbar-row">
        <span className="pill info" style={{ fontSize: 11 }}>{users.length} users</span>
        <div style={{ flex: 1 }} />
        <button className="btn primary sm" onClick={() => setEditing({})}>+ Add User</button>
      </div></div>

      <table className="list-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Screen Access</th><th>Actions</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}{u.id === me?.id && <span className="pill ok" style={{ fontSize: 9, marginLeft: 6 }}>You</span>}</td>
              <td>{u.email}</td>
              <td><span className={`pill ${roleP(u.role)}`}>{roleLabel(u.role)}</span></td>
              <td><span className="help" style={{ margin: 0 }}>{u.is_admin ? 'Full access (all screens)' : accessSummary(u.permissions)}</span></td>
              <td>
                <button className="btn ghost sm" onClick={() => setEditing(u)}>Edit</button>
                {u.id !== me?.id && <button className="btn ghost sm" style={{ marginLeft: 4 }} onClick={() => onDelete(u)}>🗑️</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && catalog && (
        <UserModal
          catalog={catalog}
          existing={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            load();
            // If I edited my own account, refresh my permissions immediately.
            if (saved.id === me?.id) setUser((m) => ({ ...m, ...saved }));
          }}
        />
      )}
    </>
  );
}

function UserModal({ catalog, existing, onClose, onSaved }) {
  const toast = useToast();
  const { screens, roles, levels, role_defaults } = catalog;
  const [form, setForm] = useState(() => ({
    name: existing?.name || '', email: existing?.email || '',
    password: '', password_confirmation: '',
    role: existing?.role || 'agent',
  }));
  // permission matrix: screen -> level (seed from effective perms or role defaults)
  const [perms, setPerms] = useState(() => existing?.permissions || role_defaults[existing?.role || 'agent']);
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const onRole = (r) => { set('role', r); setPerms({ ...role_defaults[r] }); }; // reset matrix to new role defaults
  const setScreen = (key, level) => setPerms((p) => ({ ...p, [key]: level }));
  const resetToRole = () => setPerms({ ...role_defaults[form.role] });

  const isAdminRole = form.role === 'admin';

  const save = async () => {
    if (!form.name.trim() || !form.email.trim()) { toast('Name and email are required', 'bad'); return; }
    if (!existing && !form.password) { toast('Password is required for a new user', 'bad'); return; }
    if (form.password && form.password !== form.password_confirmation) { toast('Passwords do not match', 'bad'); return; }
    const payload = {
      name: form.name.trim(), email: form.email.trim(), role: form.role,
      permissions: isAdminRole ? {} : perms,
    };
    if (form.password) { payload.password = form.password; payload.password_confirmation = form.password_confirmation; }
    setSaving(true);
    try {
      const saved = existing ? await updateUser(existing.id, payload) : await createUser(payload);
      toast(existing ? 'User updated' : 'User created', 'ok');
      onSaved(saved);
    } catch (e) {
      const errs = e.response?.data?.errors;
      toast(errs ? Object.values(errs)[0][0] : (e.response?.data?.message || 'Could not save'), 'bad');
    } finally { setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">{existing ? 'Edit User' : 'Add User'}</div>

        <div className="g2">
          <div className="field"><label>Full Name <span className="req">*</span></label><input value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div className="field"><label>Email <span className="req">*</span></label><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
        </div>
        <div className="g3">
          <div className="field"><label>Role</label>
            <select value={form.role} onChange={(e) => onRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select>
          </div>
          <div className="field"><label>{existing ? 'New Password' : 'Password'} {!existing && <span className="req">*</span>}</label>
            <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={existing ? 'leave blank to keep' : ''} /></div>
          <div className="field"><label>Confirm Password</label>
            <input type="password" value={form.password_confirmation} onChange={(e) => set('password_confirmation', e.target.value)} /></div>
        </div>

        <div className="modal-sub" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Screen Permissions</span>
          {!isAdminRole && <button className="btn ghost sm" onClick={resetToRole}>↺ Reset to {roleLabel(form.role)} defaults</button>}
        </div>

        {isAdminRole ? (
          <div style={{ padding: 14, background: '#f9fafb', border: '1px solid var(--line)', borderRadius: 8 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Administrators have <strong>full edit access to every screen</strong> and manage all users — permissions can't be restricted.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))', gap: 8 }}>
            {screens.map((s) => (
              <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px', background: '#fff' }}>
                <span style={{ fontSize: 13 }}>{s.label}</span>
                <select value={perms[s.key] || 'none'} onChange={(e) => setScreen(s.key, e.target.value)} style={{ width: 'auto', minWidth: 90 }}>
                  {levels.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (existing ? 'Save' : 'Create User')}</button>
        </div>
      </div>
    </div>
  );
}
