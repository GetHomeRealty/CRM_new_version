import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRole, deleteRole, getRoles, getUsersCatalog, setRolePermissions, updateRole } from '../lib/api';
import type { ManagedRole, UsersCatalog } from '../types/users';
import { useToast } from './toast';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import Icon from '../ui/Icon';

/**
 * Settings → Roles & Permissions.
 *
 * What a role grants is editable here and takes effect on the next request — the server refreshes
 * its permission snapshot on every write, so there is no restart and no deploy in the loop.
 *
 * The screen deliberately shows WHY something cannot be done rather than hiding the control. A
 * built-in role's delete button is present and disabled with the reason on hover, because a
 * missing button reads as a bug while a disabled one with an explanation reads as a rule. The
 * server refuses independently — every rule here is enforced there too, and the message shown on
 * failure is the server's own.
 */

const LEVEL_ORDER = ['none', 'view', 'edit'] as const;

export default function RolesPanel() {
  const toast = useToast();
  const [roles, setRoles] = useState<ManagedRole[]>([]);
  const [catalog, setCatalog] = useState<UsersCatalog | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newRole, setNewRole] = useState({ key: '', label: '', copy_from: '' });
  const { confirm, askDelete, closeConfirm } = useConfirm();

  const load = useCallback(async (keepId?: number | null) => {
    const [r, c] = await Promise.all([getRoles(), catalog ? Promise.resolve(catalog) : getUsersCatalog()]);
    setRoles(r);
    setCatalog(c);
    const pick = r.find((x) => x.id === keepId) ?? r[0] ?? null;
    setSelected(pick ? pick.id : null);
    setDraft(pick ? { ...pick.permissions } : {});
    setLabel(pick ? pick.label : '');
    setLoading(false);
  }, [catalog]);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const current = useMemo(() => roles.find((r) => r.id === selected) ?? null, [roles, selected]);
  const screens = catalog?.screens ?? [];
  const levels = catalog?.levels ?? LEVEL_ORDER;

  const dirty = useMemo(() => {
    if (!current) return false;
    if (label.trim() !== current.label) return true;
    return screens.some((s) => (draft[s.key] ?? 'none') !== (current.permissions[s.key] ?? 'none'));
  }, [current, draft, label, screens]);

  function choose(role: ManagedRole) {
    setSelected(role.id);
    setDraft({ ...role.permissions });
    setLabel(role.label);
  }

  /** The server is the authority on every refusal; its sentence is what the person should read. */
  function explain(err: unknown, fallback: string): string {
    const r = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
    return r || fallback;
  }

  async function save() {
    if (!current) return;
    setBusy(true);
    try {
      if (label.trim() !== current.label) await updateRole(current.id, { label: label.trim() });
      await setRolePermissions(current.id, draft);
      await load(current.id);
      toast(`${label.trim()} saved. The change applies to everyone holding it immediately.`, 'ok');
    } catch (e) {
      toast(explain(e, 'Could not save this role.'), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    setBusy(true);
    try {
      const created = await createRole({
        key: newRole.key.trim().toLowerCase(),
        label: newRole.label.trim(),
        ...(newRole.copy_from ? { copy_from: newRole.copy_from } : {}),
      });
      setAdding(false);
      setNewRole({ key: '', label: '', copy_from: '' });
      await load(created.id);
      toast(`${created.label} created.`, 'ok');
    } catch (e) {
      toast(explain(e, 'Could not create this role.'), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function retire(role: ManagedRole, next: boolean) {
    setBusy(true);
    try {
      await updateRole(role.id, { is_active: next });
      await load(role.id);
      toast(next ? `${role.label} is active again.` : `${role.label} retired.`, 'ok');
    } catch (e) {
      toast(explain(e, 'Could not change this role.'), 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function remove(role: ManagedRole) {
    setBusy(true);
    try {
      await deleteRole(role.id);
      closeConfirm();
      await load(null);
      toast(`${role.label} deleted.`, 'ok');
    } catch (e) {
      toast(explain(e, 'Could not delete this role.'), 'bad');
    } finally {
      setBusy(false);
    }
  }

  /** Why this role cannot be deleted, or null when it can. Mirrors the server's rules. */
  function blockedFromDelete(role: ManagedRole): string | null {
    if (role.is_system) return 'Built-in roles cannot be deleted. Rename it or change what it grants instead.';
    if (role.users > 0) return `${role.users} ${role.users === 1 ? 'person holds' : 'people hold'} this role. Move them to another role first.`;
    return null;
  }

  if (loading) {
    return (
      <div className="card">
        <div className="sk sk-title" />
        <div className="sk sk-line lg" /><div className="sk sk-line md" /><div className="sk sk-line sm" />
      </div>
    );
  }

  const editCount = (m: Record<string, string>) => Object.values(m).filter((v) => v === 'edit').length;
  const viewCount = (m: Record<string, string>) => Object.values(m).filter((v) => v === 'view').length;

  return (
    <>
      <div className="card">
        <div className="card-h">
          <div>
            <h3 style={{ margin: 0 }}>Roles &amp; Permissions</h3>
            <p className="help" style={{ margin: '3px 0 0' }}>
              What each role can open. Changes apply to everyone holding the role on their next action — no sign-out needed.
            </p>
          </div>
          <button className="btn primary sm" onClick={() => setAdding(true)} disabled={busy}>
            <Icon name="plus" size={13} /> New role
          </button>
        </div>

        <div className="roles-layout">
          {/* ---- the roles themselves ---- */}
          <div className="roles-list">
            {roles.map((r) => (
              <button
                key={r.id}
                className={`role-row ${r.id === selected ? 'on' : ''}`}
                onClick={() => choose(r)}
                type="button"
              >
                <span className="role-name">
                  {r.label}
                  {!r.is_active && <span className="pill neutral" style={{ marginLeft: 6 }}>Retired</span>}
                </span>
                <span className="role-meta">
                  <span className="role-key">{r.key}</span>
                  <span>{r.users} {r.users === 1 ? 'user' : 'users'}</span>
                </span>
              </button>
            ))}
          </div>

          {/* ---- what the selected role grants ---- */}
          {current && (
            <div className="roles-detail">
              <div className="roles-detail-h">
                <label className="field" style={{ marginBottom: 0, flex: 1 }}>
                  <span>Name</span>
                  <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy} />
                </label>
                <div className="roles-detail-actions">
                  {current.is_active ? (
                    <button
                      className="btn ghost sm"
                      onClick={() => void retire(current, false)}
                      disabled={busy || current.users > 0}
                      data-tip={current.users > 0 ? 'Move its members to another role first' : undefined}
                    >
                      Retire
                    </button>
                  ) : (
                    <button className="btn ghost sm" onClick={() => void retire(current, true)} disabled={busy}>
                      Reactivate
                    </button>
                  )}
                  <button
                    className="btn ghost sm danger"
                    onClick={() => askDelete({
                      title: `Delete ${current.label}?`,
                      message: 'This removes the role and everything it grants. Nobody holds it, so no account changes.',
                      onConfirm: () => void remove(current),
                    })}
                    disabled={busy || blockedFromDelete(current) !== null}
                    data-tip={blockedFromDelete(current) ?? undefined}
                  >
                    <Icon name="trash" size={13} /> Delete
                  </button>
                </div>
              </div>

              <div className="roles-summary">
                <span className="pill brand">{editCount(draft)} can edit</span>
                <span className="pill info">{viewCount(draft)} can view</span>
                <span className="help" style={{ marginLeft: 'auto' }}>
                  The key <code>{current.key}</code> is fixed — every grant and every account points at it.
                </span>
              </div>

              <div className="roles-grid">
                {screens.map((s) => (
                  <div className="roles-screen" key={s.key}>
                    <span>{s.label}</span>
                    <select
                      value={draft[s.key] ?? 'none'}
                      onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                      disabled={busy}
                    >
                      {levels.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              <div className="actions">
                <button className="btn primary" onClick={() => void save()} disabled={busy || !dirty}>
                  {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
                </button>
                {dirty && (
                  <button className="btn ghost" onClick={() => choose(current)} disabled={busy}>
                    Discard
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {adding && (
        <div className="overlay open" onClick={() => !busy && setAdding(false)}>
          <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">
              New role
              <button className="close" onClick={() => setAdding(false)} disabled={busy}>
                <Icon name="close" size={15} />
              </button>
            </div>
            <div className="modal-b">
              <label className="field">
                <span>Name</span>
                <input
                  value={newRole.label}
                  placeholder="Auditor"
                  onChange={(e) => setNewRole((n) => ({
                    ...n,
                    label: e.target.value,
                    // The key follows the name until someone edits it themselves.
                    key: n.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
                  }))}
                />
              </label>
              <label className="field">
                <span>Key</span>
                <input value={newRole.key} onChange={(e) => setNewRole((n) => ({ ...n, key: e.target.value }))} placeholder="auditor" />
                <span className="help">Lowercase letters, digits and underscores. This is permanent — grants and accounts point at it.</span>
              </label>
              <label className="field">
                <span>Start from</span>
                <select value={newRole.copy_from} onChange={(e) => setNewRole((n) => ({ ...n, copy_from: e.target.value }))}>
                  <option value="">Nothing — grants no access until you choose</option>
                  {roles.map((r) => <option key={r.key} value={r.key}>Copy of {r.label}</option>)}
                </select>
              </label>
            </div>
            <div className="modal-f">
              <button className="btn ghost" onClick={() => setAdding(false)} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={() => void add()} disabled={busy || !newRole.key.trim() || !newRole.label.trim()}>
                {busy ? 'Creating…' : 'Create role'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}
