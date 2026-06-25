import { useEffect, useState } from 'react';
import { getUsers, getUsersCatalog, createUser, updateUser, deleteUser } from '../lib/api';
import { roleLabel, formatCurrency } from './format';
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

const COMM_PRESETS = ['90-10%', '95-5%', '60-40%', '70-30%'];
const todayStr = () => new Date().toISOString().slice(0, 10);

function UserModal({ catalog, existing, onClose, onSaved }) {
  const toast = useToast();
  const { screens, roles, levels, role_defaults } = catalog;
  const p = existing?.profile || {};
  const [form, setForm] = useState(() => ({
    name: existing?.name || '', username: existing?.username || '', email: existing?.email || '',
    password: '', password_confirmation: '', role: existing?.role || 'agent',
    status: existing?.status || 'Active',
    // profile fields
    mobile: p.mobile || '', gender: p.gender || '',
    onboard_date: p.onboard_date || '', personal_email: p.personal_email || '', org_email: p.org_email || '',
    experience: p.experience || 'N/A',
    commission_structure: p.commission_structure || '', agent_comm_pct: p.agent_comm_pct ?? '', brok_comm_pct: p.brok_comm_pct ?? '',
    lease_comm_pct: p.lease_comm_pct ?? '', completed_deals: p.completed_deals ?? 0,
    has_loan: p.has_loan || 'No', loan_entries: p.loan_entries || [], address: p.address || '',
  }));
  const [perms, setPerms] = useState(() => existing?.permissions || role_defaults[existing?.role || 'agent']);
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const onRole = (r) => { set('role', r); setPerms({ ...role_defaults[r] }); };
  const setScreen = (key, level) => setPerms((p2) => ({ ...p2, [key]: level }));
  const resetToRole = () => setPerms({ ...role_defaults[form.role] });
  const isAdminRole = form.role === 'admin';
  const isAgent = form.role === 'agent';

  const onCommStructure = (v) => {
    const m = v.match(/^(\d+)-(\d+)/);
    if (m) setForm((f) => ({ ...f, commission_structure: v, agent_comm_pct: m[1], brok_comm_pct: m[2] }));
    else set('commission_structure', v); // 'custom'
  };
  const setAgentSplit = (v) => setForm((f) => ({ ...f, agent_comm_pct: v, brok_comm_pct: v === '' ? '' : Math.max(0, 100 - (parseFloat(v) || 0)) }));

  // Loan entries
  const addLoan = () => set('loan_entries', [...form.loan_entries, { amount: '', date: todayStr(), remarks: '' }]);
  const setLoan = (i, k, v) => set('loan_entries', form.loan_entries.map((e, idx) => idx === i ? { ...e, [k]: v } : e));
  const rmLoan = (i) => set('loan_entries', form.loan_entries.filter((_, idx) => idx !== i));
  const loanTotal = form.loan_entries.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

  const emailStub = (what) => toast(`${what} will be sent once the email module is configured (next phase).`, 'info');

  const save = async () => {
    if (!form.name.trim() || !form.email.trim()) { toast('Name and email are required', 'bad'); return; }
    if (!existing && !form.username.trim()) { toast('Username is required', 'bad'); return; }
    if (!existing && !form.password) { toast('Password is required for a new user', 'bad'); return; }
    if (form.password && form.password !== form.password_confirmation) { toast('Passwords do not match', 'bad'); return; }
    const payload = {
      name: form.name.trim(), username: form.username.trim() || null, email: form.email.trim(), role: form.role,
      status: form.status, permissions: isAdminRole ? {} : perms,
      profile: {
        mobile: form.mobile, gender: form.gender,
        onboard_date: form.onboard_date || null, personal_email: form.personal_email, org_email: form.org_email,
        experience: form.experience,
        commission_structure: form.commission_structure, agent_comm_pct: form.agent_comm_pct, brok_comm_pct: form.brok_comm_pct,
        lease_comm_pct: form.lease_comm_pct, completed_deals: form.completed_deals,
        has_loan: form.has_loan, loan_amount: loanTotal, loan_entries: form.loan_entries, address: form.address,
      },
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
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">{existing ? 'Edit User' : 'Add User'}</div>

        {/* Basic Information */}
        <div className="modal-sub" style={{ marginTop: 0 }}>Basic Information</div>
        <div className="g3">
          <div className="field"><label>Name <span className="req">*</span></label><input value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div className="field"><label>Username <span className="req">*</span></label><input value={form.username} onChange={(e) => set('username', e.target.value)} /></div>
          <div className="field"><label>Email <span className="req">*</span></label><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
        </div>
        <div className="g3">
          <div className="field"><label>Mobile Number <span className="req">*</span></label><input value={form.mobile} onChange={(e) => set('mobile', e.target.value)} /></div>
          <div className="field"><label>Gender <span className="req">*</span></label>
            <select value={form.gender} onChange={(e) => set('gender', e.target.value)}><option value="">Select gender</option><option>Male</option><option>Female</option><option>Other</option></select></div>
          <div className="field"><label>Role <span className="req">*</span></label>
            <select value={form.role} onChange={(e) => onRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></div>
        </div>
        <div className="g3">
          <div className="field"><label>{existing ? 'New Password' : 'Password'} {!existing && <span className="req">*</span>}</label>
            <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={existing ? 'leave blank to keep' : ''} /></div>
          <div className="field"><label>Confirm Password</label>
            <input type="password" value={form.password_confirmation} onChange={(e) => set('password_confirmation', e.target.value)} /></div>
          <div className="field"><label>Status <span className="req">*</span></label>
            <select value={form.status} onChange={(e) => set('status', e.target.value)}><option>Active</option><option>Inactive</option></select>
            <span className="help">Inactive users cannot login to the system.</span></div>
        </div>

        {/* Agent Details */}
        {isAgent && (<>
          <div className="modal-sub">Agent Details</div>
          <div className="g3">
            <div className="field"><label>Date of Onboard (Joining / Contract Date) <span className="req">*</span></label><input type="date" value={form.onboard_date} onChange={(e) => set('onboard_date', e.target.value)} /></div>
            <div className="field"><label>Personal Mail ID</label><input type="email" value={form.personal_email} onChange={(e) => set('personal_email', e.target.value)} /></div>
            <div className="field"><label>Organisational Mail ID</label><input type="email" value={form.org_email} onChange={(e) => set('org_email', e.target.value)} /></div>
          </div>
          <div className="g3">
            <div className="field"><label>Fresher / Experienced</label>
              <select value={form.experience} onChange={(e) => set('experience', e.target.value)}><option>N/A</option><option>Fresher</option><option>Experienced</option></select></div>
            <div className="field"><label>Commission Structure (Split %) <span className="req">*</span></label>
              <select value={form.commission_structure} onChange={(e) => onCommStructure(e.target.value)}>
                <option value="">Select commission structure</option>
                {COMM_PRESETS.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value="custom">Add custom split…</option>
              </select></div>
            <div className="field"><label>Completed Deals Count</label><input type="number" min="0" value={form.completed_deals} onChange={(e) => set('completed_deals', e.target.value)} /></div>
          </div>
          {form.commission_structure === 'custom' && (
            <div className="g2">
              <div className="field"><label>Agent % (Agent + Brokerage = 100)</label><input type="number" min="0" max="100" value={form.agent_comm_pct} onChange={(e) => setAgentSplit(e.target.value)} /></div>
              <div className="field"><label>Brokerage %</label><input value={form.brok_comm_pct} readOnly style={{ background: '#f9fafb' }} /></div>
            </div>
          )}
          <div className="g2">
            <div className="field"><label>Current Agent Commission % <span className="req">*</span></label><input type="number" min="0" max="100" value={form.agent_comm_pct} onChange={(e) => set('agent_comm_pct', e.target.value)} /></div>
            <div className="field"><label>Lease (Residential / Listing / Commercial) % <span className="req">*</span></label><input type="number" min="0" max="100" value={form.lease_comm_pct} onChange={(e) => set('lease_comm_pct', e.target.value)} /><span className="help">Commission % for lease/listing transactions.</span></div>
          </div>

          {/* Loan */}
          <div className="g2">
            <div className="field"><label>Loan</label>
              <select value={form.has_loan} onChange={(e) => set('has_loan', e.target.value)}><option>No</option><option>Yes</option></select></div>
          </div>
          {form.has_loan === 'Yes' && (
            <div className="card" style={{ background: '#f9fafb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>Loan Details</strong>
                <span className="pill info" style={{ fontSize: 11 }}>Total: {formatCurrency(loanTotal)}</span>
              </div>
              <div className="g2">
                <div className="field"><label>Actual Loan Amount (Total)</label><input value={formatCurrency(loanTotal)} readOnly style={{ background: '#fff' }} /></div>
                <div className="field"><label>Balance Loan Amount (Yet to Adjust)</label><input value={formatCurrency(loanTotal)} readOnly style={{ background: '#fff' }} /><span className="help">Actual Loan Amount − total adjustments from this agent's deals.</span></div>
              </div>
              <div className="modal-sub" style={{ marginTop: 6 }}>Loan Entries</div>
              {form.loan_entries.map((e, i) => (
                <div className="g3" key={i} style={{ alignItems: 'end', marginBottom: 6 }}>
                  <div className="field" style={{ marginBottom: 0 }}><label>Amount</label><input value={e.amount} onChange={(ev) => setLoan(i, 'amount', ev.target.value)} placeholder="0.00" /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Date</label><input type="date" value={e.date} onChange={(ev) => setLoan(i, 'date', ev.target.value)} /></div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}><div className="field" style={{ marginBottom: 0, flex: 1 }}><label>Remarks</label><input value={e.remarks} onChange={(ev) => setLoan(i, 'remarks', ev.target.value)} /></div><button className="row-rm" onClick={() => rmLoan(i)}>🗑️</button></div>
                </div>
              ))}
              <button className="btn primary sm" onClick={addLoan}>+ Add Loan Entry</button>
            </div>
          )}

          <div className="field"><label>Address</label><textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
        </>)}

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

        <div className="actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          {isAgent && <button className="btn ghost" onClick={() => emailStub('Onboard email')}>📧 Send Onboard Email</button>}
          {isAgent && <button className="btn ghost" onClick={() => emailStub('Contract agreement')}>📄 Send Contract Agreement</button>}
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (existing ? 'Save' : 'Create User')}</button>
        </div>
      </div>
    </div>
  );
}
