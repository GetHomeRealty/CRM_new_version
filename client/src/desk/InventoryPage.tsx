import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { apiErrorMessage } from '../lib/apiError';
import {
  listInventory, inventoryOptions, createInventory, updateInventory, deleteInventory, restoreInventory,
  type InventoryOptions, type SaveInventoryPayload,
} from '../lib/marketingInventoryApi';
import {
  MARKETING_ITEM_TYPES, balanceFor, countAsOnDateFor, deriveStatusFor, displayType,
  hasBeenReturned, isReturnScheduled, normalizeAssignments, outstandingQty, todayKey, totalAssignedQty,
  type MarketingInventoryItem,
} from './marketingInventory';

type AssignmentRow = { assignedTo: string; qty: string; assignedDate: string; returnedDate: string };
const EMPTY_ASSIGNMENT: AssignmentRow = { assignedTo: '', qty: '', assignedDate: '', returnedDate: '' };

const emptyForm = () => ({
  // TD-043 — the local calendar day, not the UTC one. `toISOString()` is a UTC clock: west of
  // Greenwich after 20:00 it names TOMORROW, so the field that says "today" pre-filled a date the
  // user had not reached yet. `todayKey` is the same local-day rule the return-date logic already
  // uses, so the form's idea of today and the list's cannot disagree.
  asOnDate: todayKey(),
  type: MARKETING_ITEM_TYPES[0] as string,
  customType: '',
  count: '1',
  remarks: '',
  assignments: [] as AssignmentRow[],
});
type Form = ReturnType<typeof emptyForm>;

const stPill = (s: string) => (s === 'Returned' ? 'ok' : s === 'Not Returned' ? 'warn' : 'info');

/*
 * TD-043 — A DATE-ONLY VALUE IS NEVER PARSED AS A TIMESTAMP.
 *
 * `as_on_date`, `assigned_date` and `returned_date` are stored as `VARCHAR(10)` — the calendar day
 * somebody typed, with no time and no zone. `new Date('2026-09-01')` reads that as UTC MIDNIGHT,
 * and `toLocaleDateString` then prints it in the browser's zone: Toronto is UTC-4 in September, so
 * the cell rendered 2026-08-31 for a row saved as 2026-09-01. Every date in the list was a day
 * early, while the edit modal showed the right one — it slices the string instead of parsing it.
 *
 * So this reads the day out of the value rather than converting it. There is nothing to convert:
 * the stored string IS the answer, and `en-CA` was already printing it in that same YYYY-MM-DD
 * shape, so the column looks exactly as before and is now a day later — i.e. correct.
 *
 * A `2026-09-01T00:00:00.000Z` — what an API sends if these columns ever become dates rather than
 * strings — takes the same path and reads the same day, which is the point: these three fields are
 * calendar days on every surface. This helper renders only those three. The parse fallback is left
 * for anything else that reaches it, and nothing here has a time of day worth showing.
 *
 * WORTH KNOWING WHEN RE-TESTING: this defect is invisible at UTC or east of it, where UTC midnight
 * and the local day agree. It is not intermittent — it is a function of the tester's timezone.
 */
const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/;
const fmtDate = (value?: string) => {
  if (!value) return '—';
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) return dateOnly[1];
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toLocaleDateString('en-CA');
};

export default function InventoryPage() {
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('inventory', 'edit');
  const { confirm, askDelete, closeConfirm } = useConfirm();

  const [items, setItems] = useState<MarketingInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedCount, setDeletedCount] = useState(0);
  const [lastDeleted, setLastDeleted] = useState<MarketingInventoryItem | null>(null);

  const [options, setOptions] = useState<InventoryOptions | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm());
  const [saving, setSaving] = useState(false);

  const loadedOnce = useRef(false);

  const load = useCallback(() => {
    if (!loadedOnce.current) setLoading(true);
    listInventory(showDeleted)
      .then((d) => { setItems(d.items); if (showDeleted) setDeletedCount(d.total); })
      .catch((e) => toast(apiErrorMessage(e, 'Failed to load inventory'), 'bad'))
      .finally(() => { loadedOnce.current = true; setLoading(false); });
  }, [showDeleted, toast]);

  useEffect(() => { load(); }, [load]);

  // Keep the "Deleted (n)" badge accurate while viewing the live list (admins only).
  const refreshDeletedCount = useCallback(() => {
    if (!canManage) return;
    listInventory(true).then((d) => setDeletedCount(d.total)).catch(() => {});
  }, [canManage]);
  useEffect(() => { refreshDeletedCount(); }, [refreshDeletedCount]);

  // Assignable names + vocab for the form — loaded once for managers.
  useEffect(() => {
    if (!canManage) return;
    inventoryOptions().then(setOptions).catch(() => {});
  }, [canManage]);

  const typeSummaries = useMemo(() => {
    const map = new Map<string, { label: string; total: number; out: number; onHand: number }>();
    // Managers see a card for every catalogue type, even ones with nothing in stock yet. 'Custom'
    // is a placeholder — custom items surface under their own name via displayType, so skip it here.
    // Agents only see the types actually assigned to them, so no empty cards are seeded for them.
    if (canManage) {
      for (const t of MARKETING_ITEM_TYPES) {
        if (t === 'Custom') continue;
        map.set(t, { label: t, total: 0, out: 0, onHand: 0 });
      }
    }
    for (const item of items) {
      const label = displayType(item);
      const e = map.get(label) || { label, total: 0, out: 0, onHand: 0 };
      e.total += Number(item.count) || 0;
      e.out += outstandingQty(item);
      e.onHand += countAsOnDateFor(item);
      map.set(label, e);
    }
    // Catalogue types first, in their defined order; any custom types after, alphabetically.
    const order = (label: string) => {
      const i = (MARKETING_ITEM_TYPES as readonly string[]).indexOf(label);
      return i === -1 ? MARKETING_ITEM_TYPES.length : i;
    };
    return Array.from(map.values()).sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label));
  }, [items, canManage]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (typeFilter && displayType(i) !== typeFilter) return false;
      if (!q) return true;
      return [displayType(i), ...normalizeAssignments(i).map((a) => a.assignedTo), i.remarks, deriveStatusFor(i)]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(q));
    });
  }, [items, search, typeFilter]);

  const openAdd = () => { setEditingId(null); setForm(emptyForm()); setDialogOpen(true); };
  const openEdit = (item: MarketingInventoryItem) => {
    setEditingId(item._id!);
    setForm({
      asOnDate: item.asOnDate?.slice(0, 10) || '',
      type: item.type,
      customType: item.customType || '',
      count: String(item.count ?? 0),
      remarks: item.remarks || '',
      assignments: normalizeAssignments(item).map((a) => ({
        assignedTo: a.assignedTo, qty: String(a.qty),
        assignedDate: a.assignedDate?.slice(0, 10) || '', returnedDate: a.returnedDate?.slice(0, 10) || '',
      })),
    });
    setDialogOpen(true);
  };

  const addAssignment = () => setForm((f) => ({ ...f, assignments: [...f.assignments, { ...EMPTY_ASSIGNMENT }] }));
  const removeAssignment = (idx: number) => setForm((f) => ({ ...f, assignments: f.assignments.filter((_, i) => i !== idx) }));
  const updateAssignment = (idx: number, patch: Partial<AssignmentRow>) =>
    setForm((f) => ({ ...f, assignments: f.assignments.map((a, i) => (i === idx ? { ...a, ...patch } : a)) }));

  const handleSave = async () => {
    const count = Number(form.count);
    if (!Number.isFinite(count) || count < 0) return toast('Count must be 0 or more', 'bad');
    if (form.type === 'Custom' && !form.customType.trim()) return toast('Enter a name for the custom item type', 'bad');

    const rows = form.assignments.filter((a) => a.assignedTo.trim() !== '' || a.qty.trim() !== '');
    if (rows.some((a) => a.assignedTo.trim() === '')) return toast('Every assigned person needs a name, or remove the row.', 'bad');
    const badQty = rows.find((a) => !(Number(a.qty) > 0));
    if (badQty) return toast(`Enter how many items ${badQty.assignedTo} has (at least 1).`, 'bad');
    const assignedQty = rows.reduce((s, a) => s + Number(a.qty), 0);
    if (assignedQty > count) return toast(`${assignedQty} assigned exceeds the count of ${count}.`, 'bad');

    const payload: SaveInventoryPayload = {
      asOnDate: form.asOnDate, type: form.type, customType: form.customType, count, remarks: form.remarks,
      assignments: rows.map((a) => ({ assignedTo: a.assignedTo.trim(), qty: Number(a.qty), assignedDate: a.assignedDate, returnedDate: a.returnedDate })),
    };
    try {
      setSaving(true);
      if (editingId) {
        await updateInventory(editingId, payload);
        toast('Inventory item updated', 'ok');
      } else {
        const res = await createInventory(payload);
        toast(res.merged ? `Added ${res.addedCount} to the existing ${form.type === 'Custom' ? form.customType : form.type} row (now ${res.item.count}).` : 'Inventory item added', 'ok');
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast(apiErrorMessage(e, 'Failed to save item'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (item: MarketingInventoryItem, permanent: boolean) => {
    try {
      await deleteInventory(item._id!, permanent);
      toast(permanent ? 'Permanently deleted.' : 'Moved to Deleted — you can restore it.', 'ok');
      setItems((prev) => prev.filter((i) => i._id !== item._id));
      setLastDeleted(permanent ? null : item);
      refreshDeletedCount();
    } catch (e) {
      toast(apiErrorMessage(e, 'Failed to delete item'), 'bad');
    }
  };
  const askRemove = (item: MarketingInventoryItem) => askDelete({
    title: showDeleted ? 'Delete permanently?' : 'Delete this item?',
    message: showDeleted
      ? `"${displayType(item)}" will be erased for good. This cannot be undone.`
      : `"${displayType(item)}" will be moved to Deleted. You can restore it from there at any time.`,
    onConfirm: () => doDelete(item, showDeleted),
  });

  const handleRestore = async (item: MarketingInventoryItem) => {
    try {
      await restoreInventory(item._id!);
      toast(`"${displayType(item)}" is back in the list`, 'ok');
      setLastDeleted((prev) => (prev?._id === item._id ? null : prev));
      load();
      refreshDeletedCount();
    } catch (e) {
      toast(apiErrorMessage(e, 'Failed to restore item'), 'bad');
    }
  };

  // Live preview of derived fields while the form is open.
  const preview = {
    count: Number(form.count) || 0,
    assignedQty: 0,
    assignments: form.assignments.map((a) => ({ assignedTo: a.assignedTo, qty: Number(a.qty) || 0, assignedDate: a.assignedDate, returnedDate: a.returnedDate })),
  };
  const previewAssigned = totalAssignedQty(preview);
  const previewOut = outstandingQty(preview);
  const previewBalance = balanceFor(preview);
  const previewStatus = deriveStatusFor(preview);
  const previewOnHand = countAsOnDateFor(preview);

  if (loading) return <div className="centered">Loading inventory…</div>;

  return (
    <>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>Inventory</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            {canManage ? 'Signboards, lock boxes, banners and other marketing material' : 'Marketing material currently assigned to you'}
          </div>
        </div>
        {canManage && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={`btn ${showDeleted ? 'primary' : 'ghost'}`} onClick={() => { setTypeFilter(null); setShowDeleted((v) => !v); }}>
              🗑 {showDeleted ? 'Back to Inventory' : 'Deleted'}
              {!showDeleted && deletedCount > 0 && <span className="sec-count" style={{ marginLeft: 6 }}>{deletedCount}</span>}
            </button>
            {!showDeleted && <button className="btn primary" onClick={openAdd}>+ Add Inventory</button>}
          </div>
        )}
      </div>

      {/* Undo the delete just performed */}
      {lastDeleted && !showDeleted && (
        <div className="reminder-warn" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <span>Deleted <strong>“{displayType(lastDeleted)}”</strong>. It can still be restored.</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn ghost sm" onClick={() => handleRestore(lastDeleted)}>↶ Undo</button>
            <button className="btn ghost sm" onClick={() => setLastDeleted(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {/* Type cards — every type in a single row (wrapping at most 10 per row); click to narrow
          the table to one item type. */}
      {!showDeleted && typeSummaries.length > 0 && (
        <div className="inv-type-grid" style={{ gridTemplateColumns: `repeat(${Math.min(10, typeSummaries.length + 1)}, minmax(0, 1fr))`, marginBottom: 12 }}>
          <button className="stat-card" onClick={() => setTypeFilter(null)}
            style={{ textAlign: 'left', cursor: 'pointer', outline: typeFilter === null ? '2px solid var(--brand)' : 'none' }}>
            <div className="lbl">📦 All Types</div>
            <div className="val">{typeSummaries.reduce((s, t) => s + t.total, 0)}</div>
            <div className="muted" style={{ fontSize: 11 }}>{items.length} {items.length === 1 ? 'entry' : 'entries'} · {canManage ? 'total units' : 'assigned to you'}</div>
          </button>
          {typeSummaries.map((t) => {
            const active = typeFilter === t.label;
            return (
              <button key={t.label} className="stat-card" onClick={() => setTypeFilter(active ? null : t.label)}
                title={canManage ? `${t.label} — ${t.total} total, ${t.out} still out, ${t.onHand} on hand` : `${t.label} — ${t.total} assigned to you, ${t.out} not yet returned`}
                style={{ textAlign: 'left', cursor: 'pointer', outline: active ? '2px solid var(--brand)' : 'none' }}>
                <div className="lbl" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>📦 {t.label}</div>
                <div className="val">{canManage ? t.onHand : t.out}<span className="muted" style={{ fontSize: 12, fontWeight: 400 }}> / {t.total}</span></div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {canManage ? <>on hand{t.out > 0 && <span style={{ color: 'var(--warn, #b45309)' }}> · {t.out} out</span>}</>
                    : <>still with you{t.total - t.out > 0 && <span style={{ color: 'var(--ok, #15803d)' }}> · {t.total - t.out} returned</span>}</>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Search */}
      <input className="search" style={{ marginBottom: 12, width: '100%' }} placeholder="Search by type, assigned to, status or remarks…"
        value={search} onChange={(e) => setSearch(e.target.value)} />

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="card centered" style={{ padding: 40 }}>
          <h3 style={{ margin: 0 }}>{search || typeFilter ? 'No matching items' : showDeleted ? 'Nothing deleted' : canManage ? 'No inventory yet' : 'Nothing assigned to you'}</h3>
          <p className="muted" style={{ marginTop: 6 }}>
            {search || typeFilter ? 'Try a different search or type.' : showDeleted ? 'Deleted items appear here and can be restored.'
              : canManage ? 'Click “Add Inventory” to record your first item.' : 'Marketing material assigned to you will appear here.'}
          </p>
          {typeFilter && <button className="btn ghost sm" onClick={() => setTypeFilter(null)}>Show all types</button>}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="list-table">
            <thead>
              <tr>
                <th>S.No</th><th>As on Date</th><th>Type</th>
                {canManage && <th style={{ textAlign: 'right' }}>Count</th>}
                <th style={{ textAlign: 'right' }}>{canManage ? 'Assigned' : 'Qty With You'}</th>
                <th>Assigned To</th>
                {canManage && <th style={{ textAlign: 'right' }}>Balance</th>}
                <th>Assigned Date</th><th>Returned Date</th><th>Status</th>
                {canManage && <th style={{ textAlign: 'right' }}>Count as on Date</th>}
                <th>Remarks</th>
                {canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item, idx) => {
                const rows = normalizeAssignments(item);
                const liveStatus = deriveStatusFor(item);
                return (
                  <tr key={item._id}>
                    <td className="muted">{idx + 1}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(item.asOnDate)}</td>
                    <td style={{ fontWeight: 600 }}>{displayType(item)}</td>
                    {canManage && <td style={{ textAlign: 'right' }}>{item.count}</td>}
                    <td style={{ textAlign: 'right' }}>{totalAssignedQty(item)}</td>
                    <td>
                      {rows.length === 0 ? '—' : rows.map((a, i) => (
                        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                          <span>{a.assignedTo || '—'}</span><span className="muted">×{a.qty}</span>
                          {hasBeenReturned(a.returnedDate) && <span style={{ fontSize: 11, color: 'var(--ok, #15803d)' }}>back</span>}
                          {isReturnScheduled(a.returnedDate) && <span style={{ fontSize: 11, color: 'var(--warn, #b45309)' }}>due</span>}
                        </div>
                      ))}
                    </td>
                    {canManage && <td style={{ textAlign: 'right', fontWeight: 600 }}>{balanceFor(item)}</td>}
                    <td style={{ whiteSpace: 'nowrap' }}>{rows.length === 0 ? '—' : rows.map((a, i) => <div key={i} style={{ fontSize: 13 }}>{fmtDate(a.assignedDate)}</div>)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{rows.length === 0 ? '—' : rows.map((a, i) => (
                      <div key={i} style={{ fontSize: 13 }}>{fmtDate(a.returnedDate)}{isReturnScheduled(a.returnedDate) && <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--warn, #b45309)' }}>(due)</span>}</div>
                    ))}</td>
                    <td><span className={`pill ${stPill(liveStatus)}`}>{liveStatus}</span></td>
                    {canManage && <td style={{ textAlign: 'right', fontWeight: 600 }} title={`${item.count} total − ${outstandingQty(item)} still out`}>{countAsOnDateFor(item)}</td>}
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.remarks}>{item.remarks || '—'}</td>
                    {canManage && (
                      <td>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          {showDeleted
                            ? <button className="btn ghost sm" title="Restore" onClick={() => handleRestore(item)}>↺</button>
                            : <button className="btn ghost sm" title="Edit" onClick={() => openEdit(item)}>✎</button>}
                          <button className="btn ghost sm" title={showDeleted ? 'Delete permanently' : 'Delete'} style={{ color: 'var(--bad)' }} onClick={() => askRemove(item)}>🗑</button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit modal */}
      {dialogOpen && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) setDialogOpen(false); }}>
          <div className="modal" style={{ maxWidth: 620, maxHeight: '90vh', overflowY: 'auto' }}>
            <button className="close" onClick={() => setDialogOpen(false)} disabled={saving}>✕</button>
            <div className="modal-h">{editingId ? 'Edit Inventory Item' : 'Add Inventory'}</div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field"><label>As on Date</label>
                <input type="date" value={form.asOnDate} onChange={(e) => setForm({ ...form, asOnDate: e.target.value })} /></div>
              <div className="field"><label>Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {(options?.types ?? MARKETING_ITEM_TYPES).map((t) => <option key={t} value={t}>{t}</option>)}
                </select></div>

              {!editingId && items.some((i) => i.type === form.type && (form.type !== 'Custom' || (i.customType || '').toLowerCase() === form.customType.trim().toLowerCase())) && (
                <div style={{ gridColumn: '1 / -1' }} className="reminder-ok">
                  A <strong>{form.type === 'Custom' ? form.customType || 'custom' : form.type}</strong> entry already exists — this will be added to it rather than creating a second row.
                </div>
              )}

              {form.type === 'Custom' && (
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Custom Type Name</label>
                  <input placeholder="e.g. Feather Flags" value={form.customType} onChange={(e) => setForm({ ...form, customType: e.target.value })} /></div>
              )}

              <div className="field"><label>Count</label>
                <input type="number" min={0} value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} /></div>

              {/* Per-person assignments */}
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ fontWeight: 600, fontSize: 13 }}>Assigned To</label>
                  <span className="muted" style={{ fontSize: 12 }}>{previewAssigned} of {form.count || 0} assigned{previewOut !== previewAssigned && ` · ${previewOut} still out`}</span>
                </div>
                <datalist id="inv-names">{(options?.names ?? []).map((n) => <option key={n} value={n} />)}</datalist>
                {form.assignments.length === 0 ? (
                  <div className="muted" style={{ border: '1px dashed var(--line)', borderRadius: 8, padding: '12px', textAlign: 'center', fontSize: 13 }}>
                    Nobody assigned yet — the full count stays in stock.
                  </div>
                ) : form.assignments.map((a, idx) => {
                  const returned = hasBeenReturned(a.returnedDate);
                  const scheduled = isReturnScheduled(a.returnedDate);
                  return (
                    <div key={idx} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 8, background: 'var(--surface-2, var(--surface-2))' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input list="inv-names" placeholder="Select or type a person" style={{ flex: 1 }} value={a.assignedTo} onChange={(e) => updateAssignment(idx, { assignedTo: e.target.value })} />
                        <input type="number" min={1} placeholder="Qty" style={{ width: 76 }} value={a.qty} onChange={(e) => updateAssignment(idx, { qty: e.target.value })} />
                        <button className="btn ghost sm" style={{ color: 'var(--bad)' }} title="Remove" onClick={() => removeAssignment(idx)}>✕</button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                        <div><div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>Assigned date</div>
                          <input type="date" value={a.assignedDate} onChange={(e) => updateAssignment(idx, { assignedDate: e.target.value })} /></div>
                        <div><div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>Returned date
                          {returned && <span style={{ marginLeft: 4, color: 'var(--ok, #15803d)' }}>· back</span>}
                          {scheduled && <span style={{ marginLeft: 4, color: 'var(--warn, #b45309)' }}>· due</span>}</div>
                          <input type="date" value={a.returnedDate} onChange={(e) => updateAssignment(idx, { returnedDate: e.target.value })} /></div>
                      </div>
                    </div>
                  );
                })}
                <button className="btn ghost sm" onClick={addAssignment}>+ Add person</button>
              </div>

              <div className="field" style={{ gridColumn: '1 / -1' }}><label>Remarks</label>
                <textarea rows={2} placeholder="Optional notes" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} /></div>

              {/* Derived, read-only */}
              <div style={{ gridColumn: '1 / -1', background: 'var(--surface-2, var(--surface-2))', borderRadius: 8, padding: 12 }}>
                <Row label="Balance Count (count − assigned)" value={previewBalance} />
                <Row label="Still Out (not yet returned)" value={previewOut} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 8 }}>
                  <span className="muted">Status (auto)</span><span className={`pill ${stPill(previewStatus)}`}>{previewStatus}</span>
                </div>
                <Row label="Count as on Date (count − still out)" value={previewOnHand} />
              </div>
            </div>

            <div className="actions">
              <button className="btn ghost" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</button>
              <button className="btn primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add Item'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 8 }}>
      <span className="muted">{label}</span><strong>{value}</strong>
    </div>
  );
}
