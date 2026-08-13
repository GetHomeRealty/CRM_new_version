import { AREAS, AREA_LABEL, type Area } from './area';
import { useEffect, useRef, useState } from 'react';
import Icon from '../ui/Icon';
import { getUsers, getUsersCatalog, createUser, updateUser, deleteUser, getUserDealHistory, getAgentLoans, uploadUserPhoto, getOffboarding, type OffboardingChecklist } from '../lib/api';
import { fileToBase64 } from '../lib/importApi';
import { roleLabel, formatCurrency } from './format';
import { useToast } from './toast';
import { apiErrorMessage, apiFieldErrors } from '../lib/apiError';
import { useAuth } from '../context/AuthContext';
import PasswordInput from './PasswordInput';
import UserAvatar, { bumpPhotoVersion } from './UserAvatar';

const PHOTO_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp';
const PHOTO_MAX_MB = 4;
import type {
  AuthUser, CommissionHistoryEntry, DealHistoryEntry, LoanEntry, LoanRepayment,
  ManagedUser, Permissions, ScreenLevel, UserProfile, UsersCatalog,
} from '../types';
import OnboardingEmailModal from './OnboardingEmailModal';
import { useArea } from './AreaContext';

export default function UsersPage() {
  const toast = useToast();
  const { user: me, setUser } = useAuth();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [catalog, setCatalog] = useState<UsersCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<ManagedUser> | null>(null); // user object or {} for new
  // Profile pictures: administrators may set one for any user, not just themselves.
  const [photoBusy, setPhotoBusy] = useState<number | null>(null);
  const [viewing, setViewing] = useState<ManagedUser | null>(null);
  const [photoV, setPhotoV] = useState<Record<number, number>>({});
  const photoInput = useRef<HTMLInputElement>(null);
  const photoTarget = useRef<number | null>(null);

  const pickFor = (userId: number) => { photoTarget.current = userId; photoInput.current?.click(); };

  const onPhotoChosen = async (file: File | null) => {
    const userId = photoTarget.current;
    if (!file || !userId) return;
    if (file.size > PHOTO_MAX_MB * 1024 * 1024) {
      toast(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${PHOTO_MAX_MB} MB.`, 'bad');
      return;
    }
    setPhotoBusy(userId);
    try {
      const info = await uploadUserPhoto(userId, file.name, await fileToBase64(file));
      setPhotoV((v) => ({ ...v, [userId]: info.photo_version ?? Date.now() }));
      bumpPhotoVersion();
      toast('Profile picture updated', 'ok');
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not upload the picture'), 'bad');
    } finally {
      setPhotoBusy(null);
      photoTarget.current = null;
      if (photoInput.current) photoInput.current.value = '';
    }
  };

  /**
   * One failure, one message.
   *
   * React runs mount effects twice in development, so a failing load produced two identical
   * "Could not load users" toasts stacked on top of each other — observed while auditing. The guard
   * is on the FAILURE rather than the fetch, because a deliberate reload after saving should still
   * be able to report a new problem; it is cleared as soon as a load succeeds.
   */
  const reportedFailure = useRef(false);
  const load = () => {
    setLoading(true);
    Promise.all([getUsers(), getUsersCatalog()])
      .then(([u, c]) => { setUsers(u); setCatalog(c); reportedFailure.current = false; })
      .catch(() => {
        if (reportedFailure.current) return;
        reportedFailure.current = true;
        toast('Could not load users', 'bad');
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onDelete = async (u: ManagedUser) => {
    if (!window.confirm(`Delete ${u.name}?`)) return;
    try { await deleteUser(u.id); setUsers((us) => us.filter((x) => x.id !== u.id)); toast('User deleted', 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Could not delete'), 'bad'); }
  };

  const roleP = (r: string) => r === 'admin' ? 'bad' : (r === 'manager' ? 'warn' : 'info');
  const accessSummary = (perms: Permissions | undefined) => {
    const v = Object.values(perms || {});
    return `${v.filter((l) => l === 'edit').length} edit · ${v.filter((l) => l === 'view').length} view`;
  };

  if (loading) return <div className="centered">Loading users…</div>;

  return (
    <>
      {/* One hidden picker, retargeted per row — avoids an input per user. */}
      <input ref={photoInput} type="file" accept={PHOTO_ACCEPT} style={{ display: 'none' }}
        onChange={(e) => void onPhotoChosen(e.target.files?.[0] ?? null)} />

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
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <UserAvatar userId={u.id} name={u.name} size={32} version={photoV[u.id]} />
                  <span>{u.name}{u.id === me?.id && <span className="pill ok" style={{ fontSize: 9, marginLeft: 6 }}>You</span>}</span>
                </div>
              </td>
              <td>{u.email}</td>
              <td><span className={`pill ${roleP(u.role)}`}>{roleLabel(u.role)}</span></td>
              <td><span className="help" style={{ margin: 0 }}>{u.is_admin ? 'Full access (all screens)' : accessSummary(u.permissions)}</span></td>
              <td>
                <button className="btn ghost sm" onClick={() => setEditing(u)}>Edit</button>
                {/* The eye now does what an eye means.
                    It used to open a file picker to set the user's profile picture — an icon that
                    reads as "view" wired to an upload, so pressing it produced a file dialog and
                    nothing that looked like user details. The picture upload has kept its function
                    and moved to its own button beside this one. */}
                <button className="btn ghost sm" style={{ marginLeft: 4 }}
                  title={`View ${u.name}'s details`} onClick={() => setViewing(u)}>
                  <Icon name="eye" size={14} />
                </button>
                <button className="btn ghost sm" style={{ marginLeft: 4 }} disabled={photoBusy === u.id}
                  title={`Set ${u.name}'s profile picture`} onClick={() => pickFor(u.id)}>
                  {photoBusy === u.id ? '…' : <Icon name="upload" size={14} />}
                </button>
                {u.id !== me?.id && <button className="btn ghost sm" style={{ marginLeft: 4 }} onClick={() => onDelete(u)}><Icon name="trash" size={14} /></button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {viewing && (
        <UserDetailsModal
          user={viewing}
          catalog={catalog}
          isMe={viewing.id === me?.id}
          photoVersion={photoV[viewing.id]}
          onClose={() => setViewing(null)}
          onEdit={() => { const u = viewing; setViewing(null); setEditing(u); }}
        />
      )}

      {editing && catalog && (
        <UserModal
          catalog={catalog}
          existing={editing.id ? (editing as ManagedUser) : null}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            load();
            // If I edited my own account, refresh my permissions immediately.
            if (saved.id === me?.id) setUser((m) => (m ? { ...m, ...saved } as AuthUser : m));
          }}
        />
      )}
    </>
  );
}

/**
 * A user's details, read-only.
 *
 * The Actions column's eye opened a file picker; there was no way to look at a user without
 * entering the editor and risking a change. This shows what the Users screen already holds — no
 * extra request — and hands off to Edit for anything that needs changing.
 *
 * Deliberately omits the commission percentages, loans and deal history the editor carries. Those
 * are somebody's pay, and a glance at "who is this person" should not put them on screen.
 */
function UserDetailsModal({ user, catalog, isMe, photoVersion, onClose, onEdit }: {
  user: ManagedUser;
  catalog: UsersCatalog | null;
  isMe: boolean;
  photoVersion?: number;
  onClose: () => void;
  onEdit: () => void;
}) {
  const p: UserProfile = (user.profile ?? {}) as UserProfile;
  const dash = (v: unknown) => { const s = String(v ?? '').trim(); return s === '' ? '—' : s; };

  // Escape, listened for on the document rather than on the overlay.
  //
  // A React `onKeyDown` on the overlay only fires when focus is already inside it, and this dialog
  // has nothing to focus — no form, no autoFocus. So the key never arrived, the dialog stayed put,
  // and its overlay swallowed every click behind it: the only way out was the ✕. Bound here, it
  // works whether or not anything inside has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="field" style={{ marginBottom: 8 }}>
      <label style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</label>
      <div>{value}</div>
    </div>
  );

  // Screen access, spelled out. `is_admin` short-circuits the map on the server, so say so rather
  // than rendering an empty grid.
  const perms = user.permissions ?? {};
  const granted = (catalog?.screens ?? [])
    .map((s) => ({ label: s.label, level: perms[s.key] ?? 'none' }))
    .filter((s) => s.level !== 'none');

  return (
    <div className="overlay open"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      role="dialog" aria-modal="true" aria-labelledby="user-details-heading">
      <div className="modal" style={{ maxWidth: 620 }}>
        <button className="close" type="button" onClick={onClose} aria-label="Close">✕</button>
        <div className="modal-h" id="user-details-heading">User Details</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <UserAvatar userId={user.id} name={user.name} size={56} version={photoVersion} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              {user.name}
              {isMe && <span className="pill ok" style={{ fontSize: 9, marginLeft: 6 }}>You</span>}
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>{user.email}</div>
            <div style={{ marginTop: 4 }}>
              <span className="pill info">{roleLabel(user.role)}</span>
              {user.status && (
                <span className={`pill ${String(user.status).toLowerCase() === 'active' ? 'ok' : 'bad'}`} style={{ marginLeft: 6 }}>
                  {user.status}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="modal-sub">Account</div>
        <div className="g2">
          <Row label="Username" value={dash(user.username)} />
          <Row label="Mobile" value={dash(p.mobile)} />
          <Row label="Department" value={dash(user.department)} />
          <Row label="Designation" value={dash(user.designation)} />
          <Row label="Personal email" value={dash(p.personal_email)} />
          <Row label="Onboarded" value={dash(p.onboard_date)} />
        </div>

        <div className="modal-sub">Modules</div>
        <div style={{ marginBottom: 10 }}>
          {AREAS.filter((a) => (user.modules ?? []).includes(a)).length === 0
            ? <span className="muted">No modules assigned.</span>
            : AREAS.filter((a) => (user.modules ?? []).includes(a as Area))
              .map((a) => <span key={a} className="pill info" style={{ marginRight: 6 }}>{AREA_LABEL[a as Area]}</span>)}
        </div>

        <div className="modal-sub">Screen access</div>
        {user.is_admin ? (
          <p className="help">Full access to every screen.</p>
        ) : granted.length === 0 ? (
          <p className="help">No screens granted.</p>
        ) : (
          <div className="g2">
            {granted.map((s) => (
              <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0' }}>
                <span style={{ fontSize: 12.5 }}>{s.label}</span>
                <span className={`pill ${s.level === 'edit' ? 'ok' : ''}`} style={{ fontSize: 10 }}>{s.level}</span>
              </div>
            ))}
          </div>
        )}

        <div className="actions">
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
          <button className="btn primary" type="button" onClick={onEdit}>Edit User</button>
        </div>
      </div>
    </div>
  );
}

const COMM_PRESETS = ['90-10%', '95-5%', '60-40%', '70-30%'];
const todayStr = () => new Date().toISOString().slice(0, 10);

interface UserForm {
  name: string;
  username: string;
  email: string;
  password: string;
  password_confirmation: string;
  role: string;
  status: string;
  mobile: string;
  gender: string;
  onboard_date: string;
  personal_email: string;
  org_email: string;
  experience: string;
  prev_brokerage: string;
  commission_structure: string;
  agent_comm_pct: number | string;
  brok_comm_pct: number | string;
  lease_comm_pct: number | string;
  department: string;
  designation: string;
  modules: Area[];
  brokerage_lead_structure: string;
  brokerage_lead_pct: number | string;
  brokerage_lead_brok_pct: number | string;
  completed_deals: number | string;
  upgrade_agent_pct: number | string;
  upgrade_brok_pct: number | string;
  commission_history: CommissionHistoryEntry[];
  has_loan: string;
  loan_entries: LoanEntry[];
  address: string;
}

interface UserModalProps {
  catalog: UsersCatalog;
  existing: ManagedUser | null;
  onClose: () => void;
  onSaved: (saved: ManagedUser) => void;
}

function UserModal({ catalog, existing, onClose, onSaved }: UserModalProps) {
  const toast = useToast();
  /**
   * Agent Details, Loan and Previous Commission History are Transaction Desk concerns — commission
   * splits, loan balances and paid-deal history. They are shown on the Desk side only, so the CRM's
   * user form is about the person rather than their compensation.
   *
   * `showAgentFinance` gates the display AND the validation together. Gating only the display would
   * leave the save handler demanding a Date of Onboard that is not on screen — a dead end with no
   * field to fill in.
   */
  const { area } = useArea();
  const { user: actingUser } = useAuth();
  const licence = actingUser?.licence;
  const { screens, roles, levels, role_defaults } = catalog;
  const p: UserProfile = existing?.profile || {};
  const [form, setForm] = useState<UserForm>(() => ({
    name: existing?.name || '', username: existing?.username || '', email: existing?.email || '',
    password: '', password_confirmation: '', role: existing?.role || 'agent',
    status: existing?.status || 'Active',
    // profile fields
    mobile: p.mobile || '', gender: p.gender || '',
    onboard_date: p.onboard_date || '', personal_email: p.personal_email || '', org_email: p.org_email || '',
    experience: (p.experience && p.experience !== 'N/A') ? p.experience : '', prev_brokerage: p.prev_brokerage || '',
    department: (existing?.department as string | null) ?? '', designation: (existing?.designation as string | null) ?? '',
    // Both when the record predates module assignment — the access such a user actually has today.
    modules: Array.isArray(existing?.modules) ? (existing.modules as Area[]) : [...AREAS],
    commission_structure: p.commission_structure || '', agent_comm_pct: p.agent_comm_pct ?? 0, brok_comm_pct: p.brok_comm_pct ?? 0,
    lease_comm_pct: p.lease_comm_pct ?? 95,
    brokerage_lead_structure: p.brokerage_lead_structure || '',
    brokerage_lead_pct: p.brokerage_lead_pct ?? '', brokerage_lead_brok_pct: p.brokerage_lead_brok_pct ?? '',
    completed_deals: p.completed_deals ?? 0,
    upgrade_agent_pct: p.upgrade_agent_pct ?? '', upgrade_brok_pct: p.upgrade_brok_pct ?? '',
    commission_history: p.commission_history || [],
    has_loan: p.has_loan || 'No', loan_entries: p.loan_entries || [], address: p.address || '',
  }));
  const [perms, setPerms] = useState<Permissions>(() => existing?.permissions || role_defaults[existing?.role || 'agent']);
  const [saving, setSaving] = useState(false);
  // Previous Commission History is derived: the agent's paid deals (under the previous split).
  const [dealHistory, setDealHistory] = useState<DealHistoryEntry[]>([]);
  useEffect(() => {
    if (existing?.id) getUserDealHistory(existing.id).then(setDealHistory).catch(() => setDealHistory([]));
  }, [existing?.id]);

  // Amount of this agent's loan already repaid via loan-repayment adjustments on
  // their deals (from the backend), so "Balance Loan Amount" = actual − repaid.
  const [loanRepaid, setLoanRepaid] = useState(0);
  const [loanRepayments, setLoanRepayments] = useState<LoanRepayment[]>([]);
  useEffect(() => {
    if (!existing?.name) { setLoanRepaid(0); setLoanRepayments([]); return; }
    getAgentLoans().then((m) => {
      setLoanRepaid(m[existing.name]?.loan_repaid || 0);
      setLoanRepayments(m[existing.name]?.repayments || []);
    }).catch(() => { setLoanRepaid(0); setLoanRepayments([]); });
  }, [existing?.name]);

  const set = <K extends keyof UserForm>(k: K, v: UserForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const onRole = (r: string) => { set('role', r); setPerms({ ...role_defaults[r] }); };
  const setScreen = (key: string, level: ScreenLevel) => setPerms((p2) => ({ ...p2, [key]: level }));
  const resetToRole = () => setPerms({ ...role_defaults[form.role] });
  const isAdminRole = form.role === 'admin';
  const isAgent = form.role === 'agent';
  // Only for an agent, and only on the Transaction Desk side.
  const showAgentFinance = isAgent && area === 'desk';

  // Selecting a preset split (e.g. "90-10%") auto-fills Agent % / Brokerage %.
  // "Add custom split…" leaves both empty for manual entry.
  const onCommStructure = (v: string) => {
    const m = v.match(/^(\d+)-(\d+)/);
    if (m) setForm((f) => ({ ...f, commission_structure: v, agent_comm_pct: m[1], brok_comm_pct: m[2] }));
    else setForm((f) => ({ ...f, commission_structure: v, agent_comm_pct: '', brok_comm_pct: '' }));
  };
  const setAgentSplit = (v: string) => setForm((f) => ({ ...f, agent_comm_pct: v, brok_comm_pct: v === '' ? '' : Math.max(0, 100 - (parseFloat(v) || 0)) }));

  // The same two handlers for the brokerage-lead split. Deliberately a copy of the pair above rather
  // than a shared helper: they differ only in which three keys they write, and threading field names
  // through a generic version made the call sites harder to read than the duplication.
  const onLeadStructure = (v: string) => {
    const m = v.match(/^(\d+)-(\d+)/);
    if (m) setForm((f) => ({ ...f, brokerage_lead_structure: v, brokerage_lead_pct: m[1], brokerage_lead_brok_pct: m[2] }));
    else setForm((f) => ({ ...f, brokerage_lead_structure: v, brokerage_lead_pct: '', brokerage_lead_brok_pct: '' }));
  };
  const setLeadAgentSplit = (v: string) => setForm((f) => ({ ...f, brokerage_lead_pct: v, brokerage_lead_brok_pct: v === '' ? '' : Math.max(0, 100 - (parseFloat(v) || 0)) }));

  // Loan entries
  const addLoan = () => set('loan_entries', [...form.loan_entries, { amount: '', date: todayStr(), remarks: '' }]);
  const setLoan = (i: number, k: keyof LoanEntry, v: string) => set('loan_entries', form.loan_entries.map((e, idx) => idx === i ? { ...e, [k]: v } : e));
  const rmLoan = (i: number) => set('loan_entries', form.loan_entries.filter((_, idx) => idx !== i));
  const loanTotal = form.loan_entries.reduce((s, e) => s + (parseFloat(String(e.amount)) || 0), 0);
  const loanBalance = Math.max(0, loanTotal - loanRepaid);
  // Already-saved loan entries are locked (amount/date/remarks); only newly added rows are editable.
  const savedLoanCount = (p.loan_entries || []).length;
  const lockedLoan = { background: 'var(--surface-3)', cursor: 'not-allowed' };

  const [onboarding, setOnboarding] = useState<'onboard' | 'contract' | null>(null);

  /*
   * What this person still holds, shown the moment Status is switched to Inactive.
   *
   * The order that matters when somebody leaves is: disconnect their Meta account, transfer their
   * leads, THEN deactivate. Done the other way round the leads become invisible to everybody — a
   * book belongs to one person, and that person can no longer sign in — so this puts the
   * outstanding items in front of the administrator while they can still act on them, rather than
   * after the save when the book has already gone dark.
   *
   * It informs and never blocks. Cutting off access has to stay immediate; an agent who leaves
   * badly is exactly the case where an administrator cannot be made to tidy up first.
   */
  const [offboarding, setOffboarding] = useState<OffboardingChecklist | null>(null);
  /** The field a failed save is about — scrolled to, focused and outlined. */
  const [badField, setBadField] = useState<string | null>(null);
  const deactivating = !!existing && (existing.status ?? 'Active') === 'Active' && form.status === 'Inactive';

  useEffect(() => {
    if (!deactivating || !existing) { setOffboarding(null); return; }
    let live = true;
    // Only a Super Admin may read this; for anyone else it 403s and the block simply stays hidden.
    getOffboarding(existing.id).then((c) => { if (live) setOffboarding(c); }).catch(() => { if (live) setOffboarding(null); });
    return () => { live = false; };
  }, [deactivating, existing]);

  /**
   * Take the user to the field a failed save is about.
   *
   * The toast on its own was not enough. This modal is long, and submitting an empty form left the
   * view down at the Screen Permissions grid while the toast complained about Name and Email at the
   * very top — naming two fields the user could not see, with nothing highlighted. Scrolling to the
   * field and focusing it puts the caret exactly where the fix has to be typed.
   */
  const focusField = (field: string): void => {
    setBadField(field);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>('[data-field="' + field + '"]');
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus?.();
    });
  };
  const fail = (field: string, message: string): void => { focusField(field); toast(message, 'bad'); };

  const save = async () => {
    setBadField(null);
    if (!form.name.trim()) { fail('name', 'Name is required'); return; }
    if (!form.email.trim()) { fail('email', 'Email is required'); return; }
    if (!existing && !form.username.trim()) { fail('username', 'Username is required'); return; }
    if (!existing && !form.password) { fail('password', 'Password is required for a new user'); return; }
    if (form.password && form.password !== form.password_confirmation) { fail('password_confirmation', 'Passwords do not match'); return; }
    // Mandatory Basic Information fields.
    if (!String(form.mobile).trim()) { fail('mobile', 'Mobile Number is required'); return; }
    if (!form.gender) { fail('gender', 'Gender is required'); return; }
    if (!form.status) { fail('status', 'Status is required'); return; }
    // Mandatory Agent Details — only when the section is actually on screen. Required fields that
    // cannot be seen cannot be filled in.
    if (showAgentFinance) {
      if (!form.onboard_date) { toast('Date of Onboard is required', 'bad'); return; }
      if (!form.experience) { toast('Please select Fresher / Experienced', 'bad'); return; }
      if (form.experience === 'Experienced' && !String(form.prev_brokerage).trim()) { toast('Previous Brokerage Name is required for an experienced agent', 'bad'); return; }
      if (!form.commission_structure) { toast('Commission Structure is required', 'bad'); return; }
      if (form.agent_comm_pct === '' || form.agent_comm_pct === null) { toast('Agent % is required', 'bad'); return; }
      if (form.lease_comm_pct === '' || form.lease_comm_pct === null) { toast('Lease % is required', 'bad'); return; }
    }
    const payload: Record<string, unknown> = {
      name: form.name.trim(), username: form.username.trim() || null, email: form.email.trim(), role: form.role,
      department: form.department.trim() || null, designation: form.designation.trim() || null,
      modules: form.modules,
      status: form.status, permissions: isAdminRole ? {} : perms,
      profile: {
        mobile: form.mobile, gender: form.gender,
        onboard_date: form.onboard_date || null, personal_email: form.personal_email, org_email: form.org_email,
        experience: form.experience, prev_brokerage: form.experience === 'Experienced' ? form.prev_brokerage : '',
        commission_structure: form.commission_structure, agent_comm_pct: form.agent_comm_pct, brok_comm_pct: form.brok_comm_pct,
        lease_comm_pct: form.lease_comm_pct,
        brokerage_lead_structure: form.brokerage_lead_structure,
        brokerage_lead_pct: form.brokerage_lead_pct, brokerage_lead_brok_pct: form.brokerage_lead_brok_pct,
        completed_deals: form.completed_deals,
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
      const errs = apiFieldErrors(e);
      const first = errs ? Object.values(errs)[0]?.[0] : null;
      toast(first || apiErrorMessage(e, 'Could not save'), 'bad');
    } finally { setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg" style={{ maxHeight: '92vh', overflowY: 'auto' }}>
        <button className="close" onClick={onClose}><Icon name="close" size={15} /></button>
        <div className="modal-h">{existing ? 'Edit User' : 'Add User'}</div>

        {/* Basic Information */}
        <div className="modal-sub" style={{ marginTop: 0 }}>Basic Information</div>
        <div className="g3">
          <div className="field"><label>Name <span className="req">*</span></label><input data-field="name" className={badField === 'name' ? 'field-bad' : undefined} value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div className="field"><label>Username <span className="req">*</span></label><input data-field="username" className={badField === 'username' ? 'field-bad' : undefined} value={form.username} onChange={(e) => set('username', e.target.value)} /></div>
          <div className="field"><label>Email <span className="req">*</span></label><input data-field="email" className={badField === 'email' ? 'field-bad' : undefined} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
        </div>
        <div className="g3">
          <div className="field"><label>Mobile Number <span className="req">*</span></label><input data-field="mobile" className={badField === 'mobile' ? 'field-bad' : undefined} type="tel" autoComplete="off" value={form.mobile} onChange={(e) => set('mobile', e.target.value)} /></div>
          <div className="field"><label>Gender <span className="req">*</span></label>
            <select data-field="gender" className={badField === 'gender' ? 'field-bad' : undefined} value={form.gender} onChange={(e) => set('gender', e.target.value)}><option value="">Select gender</option><option>Male</option><option>Female</option><option>Other</option></select></div>
          <div className="field"><label>Role <span className="req">*</span></label>
            <select value={form.role} onChange={(e) => onRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></div>
        </div>
        <div className="g3">
          <div className="field"><label>{existing ? 'New Password' : 'Password'} {!existing && <span className="req">*</span>}</label>
            <PasswordInput value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={existing ? 'leave blank to keep' : ''} autoComplete="new-password" /></div>
          <div className="field"><label>Confirm Password</label>
            <PasswordInput value={form.password_confirmation} onChange={(e) => set('password_confirmation', e.target.value)} autoComplete="new-password" /></div>
          <div className="field"><label>Status <span className="req">*</span></label>
            <select data-field="status" className={badField === 'status' ? 'field-bad' : undefined} value={form.status} onChange={(e) => set('status', e.target.value)}><option>Active</option><option>Inactive</option></select>
            <span className="help">Inactive users cannot login to the system.</span></div>
          {offboarding && (
            <div className="field offboarding warn" style={{ gridColumn: '1 / -1' }}>
              <label>Saving will deactivate {offboarding.user.name} and do the following</label>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {offboarding.effects.map((e) => (
                  <li key={e.key} style={{ marginBottom: 4, opacity: e.count === 0 ? 0.55 : 1 }}>
                    <strong>{e.label}</strong>
                    <div className="help" style={{ marginTop: 2 }}>{e.detail}</div>
                  </li>
                ))}
              </ul>
              <span className="help" style={{ marginTop: 6, display: 'block' }}>
                Reactivating them later restores their own leads, but not their Meta connection —
                they sign in to Meta again so a fresh authorisation is granted.
              </span>
            </div>
          )}
          <div className="field"><label>Department</label>
            <input value={form.department} onChange={(e) => set('department', e.target.value)} placeholder="e.g. Sales, Accounts" /></div>
          <div className="field"><label>Designation</label>
            <input value={form.designation} onChange={(e) => set('designation', e.target.value)} placeholder="e.g. Broker of Record" /></div>
        </div>

        {/*
          Which parts of the application this person opens. Separate from the screen permissions
          below: a module decides whether an area exists for them at all, the permissions decide what
          they may do inside it. Both still apply.

          A module the company has not bought is shown but marked, because the assignment is worth
          keeping — resubscribing should restore the arrangement rather than a blank slate.
        */}
        <div className="modal-sub">Module Access</div>
        <div className="g3">
          {AREAS.map((a) => {
            const licensed = licence ? (a === 'crm' ? licence.crm : licence.desk) : true;
            return (
              <label key={a} className="field" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 0 }}>
                <input type="checkbox" style={{ width: 16, height: 16, marginTop: 2 }}
                  checked={form.modules.includes(a)}
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    modules: e.target.checked ? [...AREAS].filter((x) => x === a || f.modules.includes(x)) : f.modules.filter((x) => x !== a),
                  }))} />
                <span>
                  <span style={{ fontWeight: 600 }}>{AREA_LABEL[a]}</span>
                  {!licensed && <span className="pill bad" style={{ marginLeft: 6, fontSize: 10 }}>Not subscribed</span>}
                </span>
              </label>
            );
          })}
        </div>
        <div className="g3" style={{ marginTop: 0 }}>
          <span className="help" style={{ gridColumn: '1 / -1' }}>
            {form.modules.length === 0
              ? 'With no module selected this person can sign in but has nothing to open.'
              : 'Screen permissions below still decide what they can do inside each module.'}
          </span></div>

        {/*
          Said only where it matters: a NEW agent created from the CRM is saved with no commission
          structure, because the section that sets it is not on this side. Editing an existing agent
          keeps whatever is already on file, so there is nothing to warn about there.
        */}
        {isAgent && area === 'crm' && !existing && (
          <p className="help" style={{ margin: '10px 0 0' }}>
            Commission split, loan and deal history are set in <strong>Transaction Management</strong> →
            Users. This agent can be created here and will have no commission structure until that is
            filled in.
          </p>
        )}

        {/* Agent Details, Loan and Previous Commission History — Transaction Desk only. */}
        {showAgentFinance && (<>
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
            <div className="field"><label>Brokerage %</label><input value={form.brok_comm_pct} readOnly style={{ background: 'var(--surface-2)' }} /></div>
          </div>

          {/*
            The split that applies when the BROKERAGE supplies the lead, rather than the agent
            bringing it in. Entered as the agent's share with the brokerage's derived beside it, the
            same shape as the row above — a lone percentage in a money field leaves whose share it is
            to guesswork.

            Left blank means no separate arrangement: nothing here changes any calculation on its own.
          */}
          <div className="g3">
            <div className="field"><label>Brokerage Lead Split (Split %)</label>
              <select value={form.brokerage_lead_structure} onChange={(e) => onLeadStructure(e.target.value)}>
                <option value="">Same as above</option>
                {COMM_PRESETS.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value="custom">Add custom split…</option>
              </select>
              <span className="help">Applies when the brokerage provides the lead.</span></div>
            <div className="field"><label>Agent % (brokerage lead)</label>
              <input type="number" min="0" max="100" value={form.brokerage_lead_pct} onChange={(e) => setLeadAgentSplit(e.target.value)} />
              <span className="help">Agent + Brokerage = 100.</span></div>
            <div className="field"><label>Brokerage % (brokerage lead)</label>
              <input value={form.brokerage_lead_brok_pct} readOnly style={{ background: 'var(--surface-2)' }} /></div>
          </div>

          <div className="g3">
            <div className="field" style={{ marginBottom: 0 }}><label>Existing Split Deals Count</label>
              <input type="number" min="0" value={form.completed_deals} onChange={(e) => set('completed_deals', e.target.value)} />
              <span className="help">After this many deals close with the agent as primary, the split below is applied.</span></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Agent % (new split)</label>
              <input type="number" min="0" max="100" value={form.upgrade_agent_pct} onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, upgrade_agent_pct: v, upgrade_brok_pct: v === '' ? '' : Math.max(0, 100 - (parseFloat(v) || 0)) })); }} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Brokerage % (new split)</label>
              <input value={form.upgrade_brok_pct} readOnly style={{ background: 'var(--surface-2)' }} /></div>
          </div>
          <div className="field"><label>Address</label><textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} /></div>

          {/* Loan */}
          <div className="modal-sub">Loan</div>
          <div className="g2">
            <div className="field" style={{ marginBottom: 0 }}><label>Loan</label>
              <select value={form.has_loan} onChange={(e) => set('has_loan', e.target.value)} disabled={loanBalance > 0} style={loanBalance > 0 ? lockedLoan : undefined} title={loanBalance > 0 ? "Can't be turned off while a loan balance is outstanding." : undefined}><option>No</option><option>Yes</option></select>
              {loanBalance > 0 && <span className="help"><Icon name="lock" size={12} /> Locked — an outstanding balance of {formatCurrency(loanBalance)} is yet to be adjusted.</span>}</div>
          </div>
          {form.has_loan === 'Yes' && (
            <div className="card" style={{ background: 'var(--surface-2)' }}>
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
                    <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}><div className="field" style={{ marginBottom: 0, flex: 1 }}><label>Remarks</label><input value={e.remarks} onChange={(ev) => setLoan(i, 'remarks', ev.target.value)} /></div><button className="row-rm" onClick={() => rmLoan(i)}><Icon name="trash" size={13} /></button></div>
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
                      <div style={{ textAlign: 'right', fontWeight: 700, color: 'var(--warn-700)' }}>{formatCurrency(r.amount)}</div>
                    </div>
                  ))}
                  <div className="g3" style={{ alignItems: 'center', marginTop: 4, paddingTop: 6, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                    <div style={{ fontWeight: 700 }}>Total repaid</div><div />
                    <div style={{ textAlign: 'right', fontWeight: 700, color: 'var(--warn-700)' }}>{formatCurrency(loanRepaid)}</div>
                  </div>
                </>)}
            </div>
          )}

          {/* Previous Commission History — auto-derived: the agent's paid (Closed) deals
              done as primary agent under the previous split (up to Existing Split Deals Count). */}
          <div className="modal-sub">Previous Commission History</div>
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            {dealHistory.length === 0
              ? <div className="help" style={{ margin: 0 }}>No paid deals under the previous split yet. Closed deals where this agent is the primary agent appear here automatically.</div>
              : (<>
                <div className="g4" style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.03em' }}>
                  <div>Brokerage</div><div>Agent %</div><div>Brokerage %</div><div>Deal</div>
                </div>
                {dealHistory.map((e, i) => (
                  <div className="g4" key={i} style={{ alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ fontSize: 13 }}>{e.brokerage}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--bad)' }}>{e.agent_pct ?? '—'}{e.agent_pct != null ? '%' : ''}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--bad)' }}>{e.brok_pct ?? '—'}{e.brok_pct != null ? '%' : ''}</div>
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
          {!isAdminRole && <button className="btn ghost sm" onClick={resetToRole}><Icon name="refresh" size={13} /> Reset to {roleLabel(form.role)} defaults</button>}
        </div>

        {isAdminRole ? (
          <div style={{ padding: 14, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8 }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Administrators have <strong>full edit access to every screen</strong> and manage all users — permissions can't be restricted.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))', gap: 8 }}>
            {screens.map((s) => {
              /*
               * User management is Super Admin only, and no permission level here changes that.
               *
               * The API for this module is guarded by `AdminGuard` — it never consults the screen
               * permission. So granting "Users: edit" here used to produce a page that rendered,
               * showed an enabled "+ Add User" button, and answered 403 to every request. The
               * administrator believed they had delegated something and had not.
               *
               * The control is disabled rather than removed, because the row still governs
               * Settings → Roles & Permissions, which DOES honour it. Saying which part it affects
               * is more useful than hiding it and leaving the difference invisible.
               */
              const superAdminOnly = s.key === 'users';
              return (
                <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px', background: '#fff', opacity: superAdminOnly ? 0.7 : 1 }}>
                  <span style={{ fontSize: 13 }}>
                    {s.label}
                    {superAdminOnly && (
                      <span className="help" style={{ margin: 0, display: 'block', fontSize: 11 }}>
                        Roles &amp; Permissions only — managing users is Super Admin only
                      </span>
                    )}
                  </span>
                  <select value={perms[s.key] || 'none'} onChange={(e) => setScreen(s.key, e.target.value as ScreenLevel)}
                    style={{ width: 'auto', minWidth: 90 }}
                    title={superAdminOnly ? 'This grants access to Roles & Permissions. The Users screen itself stays Super Admin only.' : undefined}>
                    {levels.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        )}

        <div className="actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          {/*
            TRANSACTION MANAGEMENT ONLY, alongside the finance fields above.

            Both send a document about the agent's ENGAGEMENT with the brokerage — the onboarding
            guide and the contract agreement — which is Transaction Management's business, the same
            side that owns their commission split, loan and deal history (`showAgentFinance`). The
            CRM's interest in a user is who owns which leads; it has no part in contracting them.

            Hidden, not removed: the buttons, the modal and the endpoints behind them are unchanged
            and still reachable from Transaction Management. Nothing about who may send them moved.

            Both open a review first: the message as it will arrive for this agent, editable before
            it goes. Only for a saved user — there is nobody to address it to otherwise.
          */}
          {isAgent && area === 'desk' && (
            <button className="btn ghost" disabled={!existing}
              title={existing ? 'Preview and send the onboarding guide' : 'Save the agent first'}
              onClick={() => setOnboarding('onboard')}><Icon name="mail" size={13} /> Send Onboard Email</button>
          )}
          {isAgent && area === 'desk' && (
            <button className="btn ghost" disabled={!existing}
              title={existing ? 'Preview and send the contract agreement' : 'Save the agent first'}
              onClick={() => setOnboarding('contract')}><Icon name="doc" size={13} /> Send Contract Agreement</button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (existing ? 'Save' : 'Create User')}</button>
        </div>
      </div>

      {/* Review-and-send, over the top of the user editor so closing it returns here. */}
      {onboarding && existing && (
        <OnboardingEmailModal userId={existing.id} kind={onboarding} onClose={() => setOnboarding(null)} />
      )}
    </div>
  );
}
