import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../lib/axios';
import { useToast } from './toast';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { apiErrorMessage } from '../lib/apiError';
import { formatPrice } from './format';

/**
 * INDIA BUILDER PROJECTS (stage 3b, 17 Oct 2026) - the Projects tab of the Builders screen.
 *
 * A project is described with the precon website's building blocks (status, home types, location,
 * starting price, occupancy, bedrooms, overview, files by kind) so it can be shown there later, plus
 * RERA, the price history, the available-units PDFs and how many deals are linked to it.
 */
const STATUSES = ['Coming Soon', 'Registration', 'Now Selling', 'Sold Out'];
const HOME_TYPES = ['Apartment/Flat', 'Villa', 'Independent House', 'Row House', 'Plot', 'Commercial'];
const KIND_LABEL: Record<string, string> = {
  available_units: 'Available units', price_list: 'Price list', rera_certificate: 'RERA certificate',
  floor_plan: 'Floor plans', brochure: 'Brochure', site_plan: 'Site plan', photo: 'Photos', other: 'Other',
};
const UPLOAD_KINDS = ['available_units', 'price_list', 'floor_plan', 'brochure', 'site_plan', 'photo', 'other'];

interface FileRow { id: number; kind: string; file_name: string; note: string | null; uploaded_at: string }
interface PriceRow { id: number; changed_on: string; starting_price: number | null; note: string | null; file_id: number | null }
interface Project {
  id: number; builder_id: number; builder_name: string; name: string; status: string; home_types: string[];
  state: string | null; city: string | null; locality: string | null; address: string | null; overview: string | null;
  starting_price: number | null; max_price: number | null; bedrooms: string | null; occupancy: string | null;
  commission_pct: number | null; effective_commission_pct: number | null; builder_commission_pct: number | null;
  rera: { number: string | null; approved_on: string | null; valid_until: string | null; days_left: number | null };
  files: FileRow[]; prices: PriceRow[]; deals: number;
}
interface BuilderOpt { id: number; name: string }
interface Form {
  builder_id: string; name: string; status: string; home_types: string[]; state: string; city: string; locality: string;
  address: string; overview: string; starting_price: string; max_price: string; bedrooms: string; occupancy: string;
  commission_pct: string; rera: { number: string; approved_on: string; valid_until: string };
}
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const blank: Form = {
  builder_id: '', name: '', status: 'Coming Soon', home_types: [], state: 'Telangana', city: '', locality: '', address: '', overview: '',
  starting_price: '', max_price: '', bedrooms: '', occupancy: '', commission_pct: '', rera: { number: '', approved_on: '', valid_until: '' },
};
const formOf = (p: Project): Form => ({
  builder_id: String(p.builder_id), name: p.name, status: p.status, home_types: p.home_types, state: s(p.state), city: s(p.city),
  locality: s(p.locality), address: s(p.address), overview: s(p.overview), starting_price: s(p.starting_price), max_price: s(p.max_price),
  bedrooms: s(p.bedrooms), occupancy: s(p.occupancy), commission_pct: s(p.commission_pct),
  rera: { number: s(p.rera.number), approved_on: s(p.rera.approved_on), valid_until: s(p.rera.valid_until) },
});

function ReraPill({ r }: { r: Project['rera'] }) {
  if (!r.valid_until) return r.number ? <span>{r.number}</span> : <span className="muted">—</span>;
  const d = r.days_left;
  const tag = d === null ? '' : d < 0 ? ' · expired' : d <= 15 ? ` · ${d === 0 ? 'expires today' : `${d} day${d === 1 ? '' : 's'} left`}` : '';
  const cls = d !== null && d < 0 ? '' : d !== null && d <= 15 ? 'bad' : 'ok';
  return <span title={`RERA ${r.number ?? ''} valid until ${r.valid_until}`}>{r.number && <div style={{ fontSize: 12 }}>{r.number}</div>}<span className={`pill ${cls}`}>till {r.valid_until}{tag}</span></span>;
}

export default function BuilderProjectsTab({ builders }: { builders: BuilderOpt[] }) {
  const toast = useToast();
  const { confirm, askDelete, closeConfirm } = useConfirm();
  const [rows, setRows] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [saving, setSaving] = useState(false);
  const [upKind, setUpKind] = useState('available_units');
  const [upFile, setUpFile] = useState<File | null>(null);
  const [reraFile, setReraFile] = useState<File | null>(null);
  const [price, setPrice] = useState({ changed_on: '', starting_price: '', note: '' });
  const [priceFile, setPriceFile] = useState<File | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get<{ data: Project[] }>('/api/builder-projects')
      .then((r) => setRows(r.data.data))
      .catch((e) => toast(apiErrorMessage(e, 'Could not load projects'), 'bad'))
      .finally(() => setLoading(false));
  }, [toast]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter((p) => [p.name, p.builder_name, p.city, p.locality, p.rera.number].join(' ').toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const refreshEditing = (p: Project) => { setEditing(p); setRows((r) => r.map((x) => (x.id === p.id ? p : x))); };
  const openAdd = () => { setEditing(null); setForm({ ...blank, builder_id: builders.length === 1 ? String(builders[0].id) : '' }); setReraFile(null); setOpen(true); };
  const openEdit = (p: Project) => { setEditing(p); setForm(formOf(p)); setReraFile(null); setUpFile(null); setPriceFile(null); setPrice({ changed_on: '', starting_price: '', note: '' }); setOpen(true); };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setR = (k: keyof Form['rera'], v: string) => setForm((f) => ({ ...f, rera: { ...f.rera, [k]: v } }));

  const uploadTo = async (id: number, kind: string, file: File, note?: string) => {
    const fd = new FormData();
    fd.append('kind', kind); fd.append('file', file);
    if (note) fd.append('note', note);
    return api.post<{ data: Project }>(`/api/builder-projects/${id}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  };

  const save = async () => {
    if (!form.builder_id) { toast('Choose the builder', 'bad'); return; }
    if (!form.name.trim()) { toast('The project name is required', 'bad'); return; }
    setSaving(true);
    try {
      const r = editing
        ? await api.put<{ data: Project }>(`/api/builder-projects/${editing.id}`, form)
        : await api.post<{ data: Project }>('/api/builder-projects', form);
      let p = r.data.data;
      if (reraFile) p = (await uploadTo(p.id, 'rera_certificate', reraFile)).data.data;
      toast(editing ? 'Project saved' : 'Project added - you can now add its files and price changes', 'ok');
      setReraFile(null);
      if (editing) { setOpen(false); load(); } else { load(); openEdit(p); }
    } catch (e) {
      toast(apiErrorMessage(e, 'Could not save the project'), 'bad');
    } finally { setSaving(false); }
  };

  const addFile = async () => {
    if (!editing || !upFile) return;
    try { refreshEditing((await uploadTo(editing.id, upKind, upFile)).data.data); setUpFile(null); toast('File added', 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Could not upload the file'), 'bad'); }
  };
  const removeFile = (f: FileRow) => askDelete({
    title: 'Remove file?', message: `Remove "${f.file_name}" from this project?`,
    onConfirm: async () => {
      if (!editing) return;
      try { refreshEditing((await api.delete<{ data: Project }>(`/api/builder-projects/${editing.id}/files/${f.id}`)).data.data); }
      catch (e) { toast(apiErrorMessage(e, 'Could not remove the file'), 'bad'); }
    },
  });
  const download = async (id: number, f: { id: number; file_name: string }) => {
    try {
      const r = await api.get(`/api/builder-projects/${id}/files/${f.id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement('a'); a.href = url; a.download = f.file_name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) { toast(apiErrorMessage(e, 'Could not download the file'), 'bad'); }
  };
  const addPrice = async () => {
    if (!editing) return;
    if (!price.changed_on) { toast('Enter the date of the price change', 'bad'); return; }
    try {
      const fd = new FormData();
      fd.append('changed_on', price.changed_on); fd.append('starting_price', price.starting_price); fd.append('note', price.note);
      if (priceFile) fd.append('file', priceFile);
      const r = await api.post<{ data: Project }>(`/api/builder-projects/${editing.id}/prices`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      refreshEditing(r.data.data);
      setForm((f) => ({ ...f, starting_price: s(r.data.data.starting_price) }));
      setPrice({ changed_on: '', starting_price: '', note: '' }); setPriceFile(null);
      toast('Price change recorded', 'ok');
    } catch (e) { toast(apiErrorMessage(e, 'Could not record the price change'), 'bad'); }
  };
  const remove = (p: Project) => askDelete({
    title: 'Remove project?', message: `Remove "${p.name}"? A project with linked deals cannot be removed.`,
    onConfirm: async () => {
      try { await api.delete(`/api/builder-projects/${p.id}`); toast('Project removed', 'ok'); load(); }
      catch (e) { toast(apiErrorMessage(e, 'Could not remove the project'), 'bad'); }
    },
  });

  const byKind = (kind: string) => (editing?.files ?? []).filter((f) => f.kind === kind);

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input className="search" style={{ flex: 1, minWidth: 220 }} placeholder="Search by project, builder, city, locality or RERA number…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn primary" onClick={openAdd} disabled={builders.length === 0} title={builders.length === 0 ? 'Add a builder first' : undefined}>+ Add Project</button>
      </div>

      {loading ? <div className="muted">Loading…</div> : shown.length === 0 ? (
        <div className="card centered" style={{ padding: 40 }}>
          <h3 style={{ margin: 0 }}>{search ? 'No matching projects' : 'No projects yet'}</h3>
          <p className="muted" style={{ marginTop: 6 }}>{builders.length === 0 ? 'Add a builder first, then its projects.' : search ? 'Try a different search.' : 'Click “Add Project” to record the first one.'}</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="list-table">
            <thead><tr><th>Project</th><th>Builder</th><th>Status</th><th>Location</th><th>Starting price</th><th>Commission</th><th>RERA</th><th>Deals</th><th></th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td><button style={{ background: 'none', border: 0, padding: 0, color: 'var(--brand)', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }} onClick={() => openEdit(p)}>{p.name}</button>
                    {p.home_types.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{p.home_types.join(', ')}</div>}</td>
                  <td>{p.builder_name}</td>
                  <td><span className={`pill ${p.status === 'Now Selling' ? 'ok' : p.status === 'Sold Out' ? '' : 'info'}`}>{p.status}</span></td>
                  <td style={{ fontSize: 12 }}>{[p.locality, p.city, p.state].filter(Boolean).join(', ') || <span className="muted">—</span>}</td>
                  <td>{p.starting_price !== null ? formatPrice(p.starting_price) : <span className="muted">—</span>}</td>
                  <td>{p.effective_commission_pct !== null ? `${p.effective_commission_pct}%` : <span className="muted">—</span>}
                    {p.commission_pct === null && p.effective_commission_pct !== null && <div className="muted" style={{ fontSize: 11 }}>builder's</div>}</td>
                  <td><ReraPill r={p.rera} /></td>
                  <td>{p.deals}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><button className="btn ghost sm" onClick={() => openEdit(p)}>Edit</button>{' '}
                    <button className="btn ghost sm" onClick={() => remove(p)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) setOpen(false); }}>
          <div className="modal" style={{ maxWidth: 820, maxHeight: '90vh', overflowY: 'auto' }}>
            <button className="close" onClick={() => setOpen(false)} disabled={saving}>✕</button>
            <div className="modal-h">{editing ? `Project — ${editing.name}` : 'Add Project'}</div>

            <div className="modal-sub">Project</div>
            <div className="g3">
              <div className="field"><label>Builder <span className="req">*</span></label>
                <select value={form.builder_id} onChange={(e) => set('builder_id', e.target.value)} disabled={!!editing}>
                  <option value="">Choose…</option>{builders.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select></div>
              <div className="field"><label>Project name <span className="req">*</span></label><input value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
              <div className="field"><label>Status</label><select value={form.status} onChange={(e) => set('status', e.target.value)}>{STATUSES.map((x) => <option key={x}>{x}</option>)}</select></div>
              <div className="field"><label>Bedrooms</label><input value={form.bedrooms} onChange={(e) => set('bedrooms', e.target.value)} placeholder="e.g. 2-3 BHK" /></div>
              <div className="field"><label>Occupancy / possession</label><input value={form.occupancy} onChange={(e) => set('occupancy', e.target.value)} placeholder="e.g. Dec 2028" /></div>
            </div>
            <div className="field"><label>Home types</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {HOME_TYPES.map((t) => (
                  <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
                    <input type="checkbox" style={{ width: 15, height: 15 }} checked={form.home_types.includes(t)}
                      onChange={(e) => set('home_types', e.target.checked ? [...form.home_types, t] : form.home_types.filter((x) => x !== t))} />{t}
                  </label>
                ))}
              </div></div>
            <div className="field"><label>Overview</label><textarea rows={3} value={form.overview} onChange={(e) => set('overview', e.target.value)} placeholder="A short description, as buyers would read it" /></div>

            <div className="modal-sub">Location</div>
            <div className="g3">
              <div className="field"><label>State</label><input value={form.state} onChange={(e) => set('state', e.target.value)} /></div>
              <div className="field"><label>City</label><input value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
              <div className="field"><label>Area / locality</label><input value={form.locality} onChange={(e) => set('locality', e.target.value)} /></div>
            </div>
            <div className="field"><label>Full address</label><input value={form.address} onChange={(e) => set('address', e.target.value)} /></div>

            <div className="modal-sub">Price &amp; commission</div>
            <div className="g3">
              <div className="field"><label>Starting price (₹)</label><input inputMode="decimal" value={form.starting_price} onChange={(e) => set('starting_price', e.target.value)} placeholder="e.g. 7500000" />
                {editing && <span className="help">Changes are best recorded under Price changes below, so the history is kept.</span>}</div>
              <div className="field"><label>Highest price (₹)</label><input inputMode="decimal" value={form.max_price} onChange={(e) => set('max_price', e.target.value)} /></div>
              <div className="field"><label>Commission % (this project)</label><input inputMode="decimal" value={form.commission_pct} onChange={(e) => set('commission_pct', e.target.value)}
                placeholder={editing?.builder_commission_pct !== null && editing?.builder_commission_pct !== undefined ? `Builder's: ${editing.builder_commission_pct}%` : 'Empty = builder\'s %'} />
                <span className="help">Leave empty to use the builder's agreement %.</span></div>
            </div>

            <div className="modal-sub">RERA</div>
            <div className="g3">
              <div className="field"><label>RERA number</label><input value={form.rera.number} onChange={(e) => setR('number', e.target.value)} /></div>
              <div className="field"><label>Approved on</label><input type="date" value={form.rera.approved_on} onChange={(e) => setR('approved_on', e.target.value)} /></div>
              <div className="field"><label>Valid until</label><input type="date" value={form.rera.valid_until} onChange={(e) => setR('valid_until', e.target.value)} />
                <span className="help">Reminder emails every 2 days from 15 days before.</span></div>
            </div>
            <div className="field"><label>RERA certificate</label>
              {byKind('rera_certificate').map((f) => (
                <div key={f.id} style={{ fontSize: 13, marginBottom: 4 }}>
                  <button className="btn ghost sm" onClick={() => editing && download(editing.id, f)}>⬇ {f.file_name}</button>{' '}
                  <span className="muted">{String(f.uploaded_at).slice(0, 10)}</span>{' '}
                  <button className="row-rm" title="Remove" onClick={() => removeFile(f)}>✕</button>
                </div>
              ))}
              <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setReraFile(e.target.files?.[0] ?? null)} />
              <span className="help">Saved with the project.</span></div>

            {editing ? (<>
              <div className="modal-sub">Price changes</div>
              {editing.prices.length === 0 ? <div className="help" style={{ marginBottom: 8 }}>No price changes recorded yet.</div> : (
                <table className="list-table" style={{ marginBottom: 8 }}>
                  <thead><tr><th>Date</th><th>New starting price</th><th>Note</th><th>Price list</th></tr></thead>
                  <tbody>{editing.prices.map((r) => {
                    const f = editing.files.find((x) => x.id === r.file_id);
                    return (<tr key={r.id}><td>{r.changed_on}</td><td>{r.starting_price !== null ? formatPrice(r.starting_price) : '—'}</td><td>{r.note || '—'}</td>
                      <td>{f ? <button className="btn ghost sm" onClick={() => download(editing.id, f)}>⬇ {f.file_name}</button> : '—'}</td></tr>);
                  })}</tbody>
                </table>
              )}
              <div className="g4" style={{ alignItems: 'end' }}>
                <div className="field" style={{ marginBottom: 0 }}><label>Date</label><input type="date" value={price.changed_on} onChange={(e) => setPrice((p) => ({ ...p, changed_on: e.target.value }))} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label>New starting price (₹)</label><input inputMode="decimal" value={price.starting_price} onChange={(e) => setPrice((p) => ({ ...p, starting_price: e.target.value }))} /></div>
                <div className="field" style={{ marginBottom: 0 }}><label>Note</label><input value={price.note} onChange={(e) => setPrice((p) => ({ ...p, note: e.target.value }))} placeholder="e.g. Phase 2 launch" /></div>
                <div className="field" style={{ marginBottom: 0 }}><label>New price list (optional)</label><input type="file" onChange={(e) => setPriceFile(e.target.files?.[0] ?? null)} /></div>
              </div>
              <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={addPrice}>+ Record price change</button>

              <div className="modal-sub">Files</div>
              {UPLOAD_KINDS.map((k) => {
                const list = byKind(k);
                if (list.length === 0) return null;
                return (
                  <div key={k} style={{ marginBottom: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{KIND_LABEL[k]}{k === 'available_units' && <span className="muted" style={{ fontWeight: 400 }}> — newest first</span>}</div>
                    {list.map((f, i) => (
                      <div key={f.id} style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button className="btn ghost sm" onClick={() => download(editing.id, f)}>⬇ {f.file_name}</button>
                        <span className="muted">{String(f.uploaded_at).slice(0, 10)}{i === 0 && list.length > 1 ? ' · latest' : ''}</span>
                        <button className="row-rm" title="Remove" onClick={() => removeFile(f)}>✕</button>
                      </div>
                    ))}
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
                <div className="field" style={{ marginBottom: 0 }}><label>Kind</label>
                  <select value={upKind} onChange={(e) => setUpKind(e.target.value)}>{UPLOAD_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></div>
                <div className="field" style={{ marginBottom: 0 }}><label>File</label><input type="file" onChange={(e) => setUpFile(e.target.files?.[0] ?? null)} /></div>
                <button className="btn ghost sm" onClick={addFile} disabled={!upFile}>+ Upload</button>
              </div>
              <div className="help" style={{ marginTop: 8 }}>{editing.deals} India deal{editing.deals === 1 ? ' is' : 's are'} linked to this project.</div>
            </>) : <div className="help" style={{ marginTop: 8 }}>Save the project first; then you can add its files, available units and price changes.</div>}

            <div className="actions">
              <button className="btn ghost" onClick={() => setOpen(false)} disabled={saving}>Close</button>
              <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Project'}</button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}
