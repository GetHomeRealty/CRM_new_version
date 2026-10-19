import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/axios';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { apiErrorMessage } from '../lib/apiError';
import BuilderProjectsTab from './BuilderProjectsTab';
import IndiaSettingsTab from './IndiaSettingsTab';

/**
 * INDIA BUILDER DATABASE (stage 3, 17 Oct 2026).
 *
 * Every Indian builder the brokerage works with: the builder, its sales offices and sales persons
 * (as many as needed - "add another"), and the ONE agreement with that builder - signed file, dates,
 * commission % and payment terms. The agreement's expiry is emailed to the Super Admins every two days
 * from 15 days before it runs out; the list shows the same countdown.
 *
 * Super Admin only, and only while working in India (the API refuses anything else).
 */
type ContactKind = 'Sales office' | 'Sales person' | 'Other';
interface Contact { kind: ContactKind; name: string; phone: string; email: string }
interface Agreement {
  start_date: string; expiry_date: string; commission_pct: string; payment_terms: string;
  days_left?: number | null; file_name?: string | null; has_file?: boolean;
}
interface Builder {
  id: number; name: string; company_name: string | null; email: string | null; phone: string | null;
  website: string | null; address: string | null; notes: string | null;
  gstin?: string | null; billing_address?: string | null; state?: string | null;
  contacts: (Contact & { id: number })[];
  agreement: (Agreement & { commission_pct: number | string | null }) | null;
}
interface Form {
  name: string; company_name: string; email: string; phone: string; website: string; address: string; notes: string;
  gstin: string; billing_address: string; state: string;
  contacts: Contact[];
  agreement: Agreement;
}

const KINDS: ContactKind[] = ['Sales office', 'Sales person', 'Other'];
const blankAgreement: Agreement = { start_date: '', expiry_date: '', commission_pct: '', payment_terms: '' };
const blankForm: Form = { name: '', company_name: '', email: '', phone: '', website: '', address: '', notes: '', gstin: '', billing_address: '', state: '', contacts: [], agreement: blankAgreement };
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

const formOf = (b: Builder): Form => ({
  name: b.name, company_name: s(b.company_name), email: s(b.email), phone: s(b.phone), website: s(b.website),
  address: s(b.address), notes: s(b.notes),
  gstin: s(b.gstin), billing_address: s(b.billing_address), state: s(b.state),
  contacts: b.contacts.map((c) => ({ kind: c.kind, name: s(c.name), phone: s(c.phone), email: s(c.email) })),
  agreement: b.agreement
    ? { start_date: s(b.agreement.start_date), expiry_date: s(b.agreement.expiry_date), commission_pct: s(b.agreement.commission_pct), payment_terms: s(b.agreement.payment_terms) }
    : blankAgreement,
});

/** The expiry countdown as a coloured pill: red from 15 days out and after expiry, while the reminders run. */
function ExpiryPill({ a }: { a: Builder['agreement'] }) {
  if (!a?.expiry_date) return <span className="muted">—</span>;
  const d = a.days_left ?? null;
  if (d === null) return <span>{a.expiry_date}</span>;
  if (d < 0) return <span className="pill bad" title="Reminders every day until renewed">Expired {a.expiry_date}</span>;
  if (d <= 15) return <span className="pill bad" title="Reminders are being emailed">{d === 0 ? 'Expires today' : `${d} day${d === 1 ? '' : 's'} left`} · {a.expiry_date}</span>;
  return <span className="pill ok">{a.expiry_date}</span>;
}

export default function BuildersPage() {
  const { user } = useAuth();
  const toast = useToast();
  const { confirm, askDelete, closeConfirm } = useConfirm();
  const [rows, setRows] = useState<Builder[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Builder | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(blankForm);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const inIndia = user?.market === 'IN';
  const [tab, setTab] = useState<'builders' | 'projects' | 'settings'>('builders');

  const load = useCallback(() => {
    if (!inIndia) { setLoading(false); return; }
    setLoading(true);
    api.get<{ data: Builder[] }>('/api/builders')
      .then((r) => setRows(r.data.data))
      .catch((e) => toast(apiErrorMessage(e, 'Could not load builders'), 'bad'))
      .finally(() => setLoading(false));
  }, [inIndia, toast]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((b) => [b.name, b.company_name, ...b.contacts.map((c) => `${c.name} ${c.phone}`)].join(' ').toLowerCase().includes(q));
  }, [rows, search]);

  const openAdd = () => { setEditing(null); setForm(blankForm); setFile(null); setOpen(true); };
  const openEdit = (b: Builder) => { setEditing(b); setForm(formOf(b)); setFile(null); setOpen(true); };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setA = (k: keyof Agreement, v: string) => setForm((f) => ({ ...f, agreement: { ...f.agreement, [k]: v } }));
  const setC = (i: number, k: keyof Contact, v: string) =>
    setForm((f) => ({ ...f, contacts: f.contacts.map((c, j) => (j === i ? { ...c, [k]: v } : c)) }));

  const save = async () => {
    if (!form.name.trim()) { toast('The builder name is required', 'bad'); return; }
    setSaving(true);
    try {
      const body = { ...form, agreement: form.agreement };
      const r = editing
        ? await api.put<{ data: Builder }>(`/api/builders/${editing.id}`, body)
        : await api.post<{ data: Builder }>('/api/builders', body);
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        await api.post(`/api/builders/${r.data.data.id}/agreement/file`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      toast(editing ? 'Builder saved' : 'Builder added', 'ok');
      setOpen(false);
      load();
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save the builder'), 'bad');
    } finally {
      setSaving(false);
    }
  };

  const remove = (b: Builder) => askDelete({
    title: 'Remove builder?',
    message: `Remove "${b.name}" from the builder list? Its agreement file is kept on record.`,
    onConfirm: async () => {
      try { await api.delete(`/api/builders/${b.id}`); toast('Builder removed', 'ok'); load(); }
      catch (e) { toast(apiErrorMessage(e, 'Could not remove the builder'), 'bad'); }
    },
  });

  const download = async (b: Builder) => {
    try {
      const r = await api.get(`/api/builders/${b.id}/agreement/file`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = b.agreement?.file_name || 'agreement';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) { toast(apiErrorMessage(e, 'Could not download the agreement'), 'bad'); }
  };

  if (!inIndia) {
    return (
      <div className="card centered" style={{ padding: 40 }}>
        <h3 style={{ margin: 0 }}>Builders are kept in India</h3>
        <p className="muted" style={{ marginTop: 6 }}>Switch to India in the top bar to open the builder database.</p>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>Builders</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>India builders, their contacts, our agreement with each, and their projects</div>
        </div>
        {tab === 'builders' && <button className="btn primary" onClick={openAdd}>+ Add Builder</button>}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <button className={`btn ${tab === 'builders' ? 'primary' : 'ghost'} sm`} onClick={() => setTab('builders')}>Builders ({rows.length})</button>
        <button className={`btn ${tab === 'projects' ? 'primary' : 'ghost'} sm`} onClick={() => setTab('projects')}>Projects</button>
        <button className={`btn ${tab === 'settings' ? 'primary' : 'ghost'} sm`} onClick={() => setTab('settings')}>Invoice settings</button>
      </div>

      {tab === 'settings' && <IndiaSettingsTab />}

      {tab === 'settings' ? null : tab === 'projects' ? <BuilderProjectsTab builders={rows.map((b) => ({ id: b.id, name: b.name }))} /> : (<>

      <input className="search" style={{ marginBottom: 12, width: '100%' }} placeholder="Search by builder, company, contact name or number…"
        value={search} onChange={(e) => setSearch(e.target.value)} />

      {loading ? <div className="muted">Loading…</div> : shown.length === 0 ? (
        <div className="card centered" style={{ padding: 40 }}>
          <h3 style={{ margin: 0 }}>{search ? 'No matching builders' : 'No builders yet'}</h3>
          <p className="muted" style={{ marginTop: 6 }}>{search ? 'Try a different search.' : 'Click “Add Builder” to record the first one.'}</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="list-table">
            <thead>
              <tr><th>Builder</th><th>Contacts</th><th>Commission %</th><th>Agreement expiry</th><th>Agreement file</th><th></th></tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id}>
                  <td>
                    <button className="link" style={{ background: 'none', border: 0, padding: 0, color: 'var(--brand)', fontWeight: 700, cursor: 'pointer' }} onClick={() => openEdit(b)}>{b.name}</button>
                    {b.company_name && <div className="muted" style={{ fontSize: 12 }}>{b.company_name}</div>}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {b.contacts.length === 0 ? <span className="muted">—</span> : b.contacts.slice(0, 3).map((c, i) => (
                      <div key={i}><span className="muted">{c.kind}:</span> {[c.name, c.phone].filter(Boolean).join(' · ')}</div>
                    ))}
                    {b.contacts.length > 3 && <div className="muted">+{b.contacts.length - 3} more</div>}
                  </td>
                  <td>{b.agreement?.commission_pct !== null && b.agreement?.commission_pct !== undefined && b.agreement.commission_pct !== '' ? `${b.agreement.commission_pct}%` : <span className="muted">—</span>}</td>
                  <td><ExpiryPill a={b.agreement} /></td>
                  <td>{b.agreement?.has_file
                    ? <button className="btn ghost sm" onClick={() => download(b)}>⬇ {b.agreement.file_name}</button>
                    : <span className="muted">Not uploaded</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" onClick={() => openEdit(b)}>Edit</button>{' '}
                    <button className="btn ghost sm" onClick={() => remove(b)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>)}

      {open && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) setOpen(false); }}>
          <div className="modal" style={{ maxWidth: 760, maxHeight: '90vh', overflowY: 'auto' }}>
            <button className="close" onClick={() => setOpen(false)} disabled={saving}>✕</button>
            <div className="modal-h">{editing ? `Edit Builder — ${editing.name}` : 'Add Builder'}</div>

            <div className="modal-sub">Builder</div>
            <div className="g3">
              <div className="field"><label>Builder name <span className="req">*</span></label><input value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
              <div className="field"><label>Company name</label><input value={form.company_name} onChange={(e) => set('company_name', e.target.value)} /></div>
              <div className="field"><label>Website</label><input value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" /></div>
              <div className="field"><label>Email</label><input value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
              <div className="field"><label>Phone</label><input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+91" /></div>
              <div className="field"><label>Address</label><input value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
            </div>

            <div className="modal-sub">For invoices <span className="muted" style={{ fontWeight: 400 }}>· optional</span></div>
            <div className="g3">
              <div className="field"><label>GSTIN</label><input value={form.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} placeholder="e.g. 36AAAAA0000A1Z5" /></div>
              <div className="field"><label>State</label><input value={form.state} onChange={(e) => set('state', e.target.value)} placeholder="e.g. Telangana" />
                <span className="help">Same state as our office: CGST + SGST. Another state: IGST.</span></div>
              <div className="field"><label>Billing address</label><input value={form.billing_address} onChange={(e) => set('billing_address', e.target.value)} placeholder="Empty = the address above" /></div>
            </div>

            <div className="modal-sub">Sales offices &amp; sales persons</div>
            {form.contacts.length === 0 && <div className="help" style={{ marginBottom: 8 }}>No contacts yet. Add the sales office numbers and the sales persons you deal with.</div>}
            {form.contacts.map((c, i) => (
              <div key={i} className="g4" style={{ alignItems: 'end', marginBottom: 6 }}>
                <div className="field" style={{ marginBottom: 0 }}><label>Type</label>
                  <select value={c.kind} onChange={(e) => setC(i, 'kind', e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></div>
                <div className="field" style={{ marginBottom: 0 }}><label>{c.kind === 'Sales office' ? 'Office / location' : 'Name'}</label><input value={c.name} onChange={(e) => setC(i, 'name', e.target.value)} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label>Phone</label><input value={c.phone} onChange={(e) => setC(i, 'phone', e.target.value)} placeholder="+91" /></div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'end' }}>
                  <div className="field" style={{ marginBottom: 0, flex: 1 }}><label>Email</label><input value={c.email} onChange={(e) => setC(i, 'email', e.target.value)} /></div>
                  <button className="row-rm" title="Remove this contact" onClick={() => set('contacts', form.contacts.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button className="btn ghost sm" onClick={() => set('contacts', [...form.contacts, { kind: 'Sales office', name: '', phone: '', email: '' }])}>+ Add sales office</button>
              <button className="btn ghost sm" onClick={() => set('contacts', [...form.contacts, { kind: 'Sales person', name: '', phone: '', email: '' }])}>+ Add sales person</button>
            </div>

            <div className="modal-sub">Agreement with this builder</div>
            <div className="g3">
              <div className="field"><label>Start date</label><input type="date" value={form.agreement.start_date} onChange={(e) => setA('start_date', e.target.value)} /></div>
              <div className="field"><label>Expiry date</label><input type="date" value={form.agreement.expiry_date} onChange={(e) => setA('expiry_date', e.target.value)} />
                <span className="help">Reminders at 9:00 AM: from 15 days before every 2 days, the day before, the day itself, then every day until renewed.</span></div>
              <div className="field"><label>Commission %</label><input inputMode="decimal" value={form.agreement.commission_pct} onChange={(e) => setA('commission_pct', e.target.value)} placeholder="e.g. 3" /></div>
            </div>
            <div className="field"><label>Payment terms</label>
              <textarea rows={3} value={form.agreement.payment_terms} onChange={(e) => setA('payment_terms', e.target.value)} placeholder="e.g. 50% on booking, 50% on agreement registration" /></div>
            <div className="field"><label>Signed agreement file</label>
              {editing?.agreement?.has_file && !file && <div className="help" style={{ marginBottom: 4 }}>On file: {editing.agreement.file_name} — choose a new file only to replace it.</div>}
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>

            <div className="modal-sub">Notes</div>
            <div className="field"><textarea rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>

            <div className="actions">
              <button className="btn ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</button>
              <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Builder'}</button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}
