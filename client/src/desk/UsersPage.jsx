import { useEffect, useState } from 'react';
import { getUsers, getUsersCatalog, createUser, updateUser, deleteUser, getUserDealHistory, getAgentLoans } from '../lib/api';
import { roleLabel, formatCurrency } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import PasswordInput from './PasswordInput';

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
    experience: (p.experience && p.experience !== 'N/A') ? p.experience : '', prev_brokerage: p.prev_brokerage || '',
    commission_structure: p.commission_structure || '', agent_comm_pct: p.agent_comm_pct ?? 0, brok_comm_pct: p.brok_comm_pct ?? 0,
    lease_comm_pct: p.lease_comm_pct ?? 95, completed_deals: p.completed_deals ?? 0,
    upgrade_agent_pct: p.upgrade_agent_pct ?? '', upgrade_brok_pct: p.upgrade_brok_pct ?? '',
    commission_history: p.commission_history || [],
    has_loan: p.has_loan || 'No', loan_entries: p.loan_entries || [], address: p.address || '',
  }));
  const [perms, setPerms] = useState(() => existing?.permissions || role_defaults[existing?.role || 'agent']);
  const [saving, setSaving] = useState(false);
  // Previous Commission History is derived: the agent's paid deals (under the previous split).
  const [dealHistory, setDealHistory] = useState([]);
  useEffect(() => {
    if (existing?.id) getUserDealHistory(existing.id).then(setDealHistory).catch(() => setDealHistory([]));
  }, [existing?.id]);

  // Amount of this agent's loan already repaid via loan-repayment adjustments on
  // their deals (from the backend), so "Balance Loan Amount" = actual − repaid.
  const [loanRepaid, setLoanRepaid] = useState(0);
  const [loanRepayments, setLoanRepayments] = useState([]);
  useEffect(() => {
    if (!existing?.name) { setLoanRepaid(0); setLoanRepayments([]); return; }
    getAgentLoans().then((m) => {
      setLoanRepaid(m[existing.name]?.loan_repaid || 0);
      setLoanRepayments(m[existing.name]?.repayments || []);
    }).catch(() => { setLoanRepaid(0); setLoanRepayments([]); });
  }, [existing?.name]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const onRole = (r) => { set('role', r); setPerms({ ...role_defaults[r] }); };
  const setScreen = (key, level) => setPerms((p2) => ({ ...p2, [key]: level }));
  const resetToRole = () => setPerms({ ...role_defaults[form.role] });
  const isAdminRole = form.role === 'admin';
  const isAgent = form.role === 'agent';

  // Selecting a preset split (e.g. "90-10%") auto-fills Agent % / Brokerage %.
  // "Add custom split…" leaves both empty for manual entry.
  const onCommStructure = (v) => {
    const m = v.match(/^(\d+)-(\d+)/);
    if (m) setForm((f) => ({ ...f, commission_structure: v, agent_comm_pct: m[1], brok_comm_pct: m[2] }));
    else setForm((f) => ({ ...f, commission_structure: v, agent_comm_pct: '', brok_comm_pct: '' }));
  };
  const setAgentSplit = (v) => setForm((f) => ({ ...f, agent_comm_pct: v, brok_comm_pct: v === '' ? '' : Math.max(0, 100 - (parseFloat(v) || 0)) }));

  // Loan entries
  const addLoan = () => set('loan_entries', [...form.loan_entries, { amount: '', date: todayStr(), remarks: '' }]);
  const setLoan = (i, k, v) => set('loan_entries', form.loan_entries.map((e, idx) => idx === i ? { ...e, [k]: v } : e));
  const rmLoan = (i) => set('loan_entries', form.loan_entries.filter((_, idx) => idx !== i));
  const loanTotal = form.loan_entries.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const loanBalance = Math.max(0, loanTotal - loanRepaid);
  // Already-saved loan entries are locked (amount/date/remarks); only newly added rows are editable.
  const savedLoanCount = (p.loan_entries || []).length;
  const lockedLoan = { background: '#f3f4f6', cursor: 'not-allowed' };

  // Previous Commission History entries (brokerage + agent/brokerage split + remarks)
  const addHist = () => set('commission_history', [...form.commission_history, { brokerage: '', agent_pct: '', brok_pct: '', remarks: '' }]);
  const setHist = (i, k, v) => set('commission_history', form.commission_history.map((e, idx) => {
    if (idx !== i) return e;
    if (k === 'agent_pct') return { ...e, agent_pct: v, brok_pct: v === '' ? '' : Math.max(0, 100 - (parseFloat(v) || 0)) };
    return { ...e, [k]: v };
  }));
  const rmHist = (i) => set('commission_history', form.commission_history.filter((_, idx) => idx !== i));

  const emailStub = (what) => toast(`${what} will be sent once the email module is configured (next phase).`, 'info');

  const save = async () => {
    if (!form.name.trim() || !form.email.trim()) { toast('Name and email are required', 'bad'); return; }
    if (!existing && !form.username.trim()) { toast('Username is required', 'bad'); return; }
    if (!existing && !form.password) { toast('Password is required for a new user', 'bad'); return; }
    if (form.password && form.password !== form.password_confirmation) { toast('Passwords do not match', 'bad'); return; }
    // Mandatory Basic Information fields.
    if (!String(form.mobile).trim()) { toast('Mobile Number is required', 'bad'); return; }
    if (!form.gender) { toast('Gender is required', 'bad'); return; }
    if (!form.status) { toast('Status is required', 'bad'); return; }
    // Mandatory Agent Details (only shown for the Agent role).
    if (isAgent) {
      if (!form.onboard_date) { toast('Date of Onboard is required', 'bad'); return; }
      if (!form.experience) { toast('Please select Fresher / Experienced', 'bad'); return; }
      if (form.experience === 'Experienced' && !String(form.prev_brokerage).trim()) { toast('Previous Brokerage Name is required for an experienced agent', 'bad'); return; }
      if (!form.commission_structure) { toast('Commission Structure is required', 'bad'); return; }
      if (form.agent_comm_pct === '' || form.agent_comm_pct === null) { toast('Agent % is required', 'bad'); return; }
      if (form.lease_comm_pct === '' || form.lease_comm_pct === null) { toast('Lease % is required', 'bad'); return; }
    }
    const payload = {
      name: form.name.trim(), username: form.username.trim() || null, email: form.email.trim(), role: form.role,
      status: form.status, permissions: isAdminRole ? {} : perms,
      profile: {
        mobile: form.mobile, gender: form.gender,
        onboard_date: form.onboard_date || null, personal_email: form.personal_email, org_email: form.org_email,
        experience: form.experience, prev_brokerage: form.experience === 'Experienced' ? form.prev_brokerage : '',
        commission_structure: form.commission_structure, agent_comm_pct: form.agent_comm_pct, brok_comm_pct: form.brok_comm_pct,
        lease_comm_pct: form.lease_comm_pct, completed_deals: form.completed_deals,
        upgrade_agent_pct: form.upgrade_agent_pct, upgrade_brok_pct: form.upgrade_brok_pct,
        commission_history: form.commission_history,
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
          <div className="field"><label>Mobile Number <span className="req">*</span></label><input type="tel" autoComplete="off" value={form.mobile} onChange={(e) => set('mobile', e.target.value)} /></div>
          <div className="field"><label>Gender <span className="req">*</span></label>
            <select value={form.gender} onChange={(e) => set('gender', e.target.value)}><option value="">Select gender</option><option>Male</option><option>Female</option><option>Other</option></select></div>
          <div className="field"><label>Role <span className="req">*</span></label>
            <select value={form.role} onChange={(e) => onRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></div>
        </div>
        <div className="g3">
          <div className="field"><label>{existing ? 'New Password' : 'Password'} {!existing && <span className="req">*</span>}</label>
            <PasswordInput value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={existing ? 'leave blank to keep' : ''} autoComplete="new-password" /></div>
          <div className="field"><label>Confirm Password</label>
            <PasswordInput value={form.password_confirmation} onChange={(e) => set('password_confirmation', e.target.value)} autoComplete="new-password" /></div>
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
            <div className="field"><label>Fresher / Experienced <span className="req">*</span></label>
              <select value={form.experience} onChange={(e) => set('experience', e.target.value)}><option value="">Select</option><option>Fresher</option><option>Experienced</option></select></div>
            {form.experience === 'Experienced' && (
              <div className="field"><label>Previous Brokerage Name <span className="req">*</span></label>
                <input value={form.prev_brokerage} onChange={(e) => set('prev_brokerage', e.target.value)} placeholder="Where did they work before?" /></div>
            )}
            <div className="field"><label>Lease (Residential / Listing / Commercial) % <span className="req">*</span></label><input type="number" min="0" max="100" value={form.lease_comm_pct} onChange={(e) => set('lease_comm_pct', e.target.value)} /><span className="help">Commission % for lease/listing transactions.</span></div>
          </div>
          <div className="g3">
            <div className="field"><label>Commission Structure (Split %) <span className="req">*</span></label>
              <select value={form.commission_structure} onChange={(e) => onCommStructure(e.target.value)}>
                <option value="">Select commission structure</option>
                {COMM_PRESETS.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value="custom">Add custom split…</option>
              </select></div>
            <div className="field"><label>Agent % <span className="req">*</span></label><input type="number" min="0" max="100" value={form.agent_comm_pct} onChange={(e) => setAgentSplit(e.target.value)} /><span className="help">Agent + Brokerage = 100.</span></div>
            <div className="field"><label>Brokerage %</label><input value={form.brok_comm_pct} readOnly style={{ background: '#f9fafb' }} /></div>
          </div>
          <div className="g3">
            <div className="field" style={{ marginBottom: 0 }}><label>Existing Split Deals Count</label>
              <input type="number" min="0" value={form.completed_deals} onChange={(e) => set('completed_deals', e.target.value)} />
              <span className="help">After this many deals close with the agent as primary, the split below is applied.</span></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Agent % (new split)</label>
              <input type="number" min="0" max="100" value={form.upgrade_agent_pct} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, upgrade_agent_pct: v, upgrade_brok_pct: v === '' ? '' : Math.max(0, 100 - (parseFloat(v) || 0)) })); }} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Brokerage % (new split)</label>
              <input value={form.upgrade_brok_pct} readOnly style={{ background: '#f9fafb' }} /></div>
          </div>
          <div className="field"><label>Address</label><textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} /></div>

          {/* Loan */}
          <div className="modal-sub">Loan</div>
          <div className="g2">
            <div className="field" style={{ marginBottom: 0 }}><label>Loan</label>
              <select value={form.has_loan} onChange={(e) => set('has_loan', e.target.value)} disabled={loanBalance > 0} style={loanBalance > 0 ? lockedLoan : undefined} title={loanBalance > 0 ? "Can't be turned off while a loan balance is outstanding." : undefined}><option>No</option><option>Yes</option></select>
              {loanBalance > 0 && <span className="help">🔒 Locked — an outstanding balance of {formatCurrency(loanBalance)} is yet to be adjusted.</span>}</div>
          </div>
          {form.has_loan === 'Yes' && (
            <div className="card" style={{ background: '#f9fafb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>Loan Details</strong>
                <span className="pill info" style={{ fontSize: 11 }}>Total: {formatCurrency(loanTotal)}</span>
              </div>
              <div className="g2">
                <div className="field"><label>Actual Loan Amount (Total)</label><input value={formatCurrency(loanTotal)} readOnly style={{ background: '#fff' }} /></div>
                <div className="field"><label>Balance Loan Amount (Yet to Adjust)</label><input value={formatCurrency(loanBalance)} readOnly style={{ background: '#fff' }} /><span className="help">Actual Loan Amount − loan repayments recorded on this agent's deals{loanRepaid > 0 ? ` (${formatCurrency(loanRepaid)} repaid)` : ''}.</span></div>
              </div>
              <div className="modal-sub" style={{ marginTop: 6 }}>Loan Entries</div>
              {form.loan_entries.map((e, i) => (
                <div className="g3" key={i} style={{ alignItems: 'end', marginBottom: 6 }}>
                  {i < savedLoanCount ? (<>
                    <div className="field" style={{ marginBottom: 0 }}><label>Amount</label><input value={e.amount} readOnly style={lockedLoan} title="A recorded loan entry can't be modified." /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>Date</label><input type="date" value={e.date} readOnly style={lockedLoan} title="A recorded loan entry can't be modified." /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>Remarks</label><input value={e.remarks} readOnly style={lockedLoan} title="A recorded loan entry can't be modified." /></div>
                  </>) : (<>
                    <div className="field" style={{ marginBottom: 0 }}><label>Amount</label><input value={e.amount} onChange={(ev) => setLoan(i, 'amount', ev.target.value)} placeholder="0.00" /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>Date</label><input type="date" value={e.date} onChange={(ev) => setLoan(i, 'date', ev.target.value)} /></div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}><div className="field" style={{ marginBottom: 0, flex: 1 }}><label>Remarks</label><input value={e.remarks} onChange={(ev) => setLoan(i, 'remarks', ev.target.value)} /></div><button className="row-rm" onClick={() => rmLoan(i)}>🗑️</button></div>
                  </>)}
                </div>
              ))}
              <button className="btn primary sm" onClick={addLoan}>+ Add Loan Entry</button>

              {/* Loan repayments deducted from this agent's deal commissions. */}
              <div className="modal-sub" style={{ marginTop: 12 }}>Loan Repayments</div>
              {loanRepayments.length === 0
                ? <div className="help" style={{ margin: 0 }}>No repayments yet. Amounts marked “Loan repayment” in a deal's Adjustment Details appear here.</div>
                : (<>
                  <div className="g3" style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.03em' }}>
                    <div>Transaction</div><div>Closing Date</div><div style={{ textAlign: 'right' }}>Amount Deducted</div>
                  </div>
                  {loanRepayments.map((r, i) => (
                    <div className="g3" key={i} style={{ alignItems: 'center', marginBottom: 6, fontSize: 12.5 }}>
                      <div style={{ fontWeight: 600 }}>{r.property || `Trade #${r.trade_no}`}</div>
                      <div style={{ color: 'var(--muted)' }}>{r.closing_date || '—'}</div>
                      <div style={{ textAlign: 'right', fontWeight: 700, color: '#b45309' }}>{formatCurrency(r.amount)}</div>
                    </div>
                  ))}
                  <div className="g3" style={{ alignItems: 'center', marginTop: 4, paddingTop: 6, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                    <div style={{ fontWeight: 700 }}>Total repaid</div><div />
                    <div style={{ textAlign: 'right', fontWeight: 700, color: '#b45309' }}>{formatCurrency(loanRepaid)}</div>
                  </div>
                </>)}
            </div>
          )}

          {/* Previous Commission History — auto-derived: the agent's paid (Closed) deals
              done as primary agent under the previous split (up to Existing Split Deals Count). */}
          <div className="modal-sub">Previous Commission History</div>
          <div className="card" style={{ background: '#f9fafb' }}>
            {dealHistory.length === 0
              ? <div className="help" style={{ margin: 0 }}>No paid deals under the previous split yet. Closed deals where this agent is the primary agent appear here automatically.</div>
              : (<>
                <div className="g4" style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.03em' }}>
                  <div>Brokerage</div><div>Agent %</div><div>Brokerage %</div><div>Deal</div>
                </div>
                {dealHistory.map((e, i) => (
                  <div className="g4" key={i} style={{ alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ fontSize: 13 }}>{e.brokerage}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626' }}>{e.agent_pct ?? '—'}{e.agent_pct != null ? '%' : ''}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#dc2626' }}>{e.brok_pct ?? '—'}{e.brok_pct != null ? '%' : ''}</div>
                    <div style={{ fontSize: 12.5 }}>
                      <div style={{ fontWeight: 600 }}>{e.property || '—'}</div>
                      {e.closing_date && <div style={{ color: 'var(--muted)', fontSize: 11 }}>{e.closing_date}</div>}
                    </div>
                  </div>
                ))}
              </>)}
          </div>
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
