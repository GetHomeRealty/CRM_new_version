import { useCallback, useEffect, useState } from 'react';
import api from '../lib/axios';
import { useAuth } from '../context/AuthContext';
import { useToast } from './toast';
import ConfirmDialog, { useConfirm } from './ConfirmDialog';
import { apiErrorMessage } from '../lib/apiError';
import { Flag, MARKET_NAME } from './MarketSwitch';
import type { Market } from '../types/auth';

/**
 * SETTINGS -> COMPANY DOCUMENTS (19 Oct 2026).
 *
 * The company's own papers for the country being worked in - Canada's or India's, never both - and
 * its stakeholders / partners. Each document keeps every file ever uploaded (newest first, the older
 * ones as previous versions) and its expiry is emailed to the Super Admins (15 days before, every 2
 * days, the day before, the day itself, and after expiry until renewed). "+ Add document" takes any
 * other paper by its own name. Each stakeholder carries as many files as needed. Super Admin only.
 */
interface FileRow { id: number; file_name: string; note: string | null; uploaded_at: string }
interface Doc {
  id: number; kind: string; title: string; number: string | null; issued_by: string | null; holder: string | null;
  contact_name: string | null; contact_phone: string | null; contact_email: string | null;
  issue_date: string | null; expiry_date: string | null; notes: string | null;
  days_left: number | null; expiry_status: 'none' | 'ok' | 'soon' | 'expired'; files: FileRow[];
}
interface IdRow { type: string; number: string }
interface Person {
  id: number; name: string; role: string; share_pct: number | null; phone: string | null; email: string | null; address: string | null;
  id_details: IdRow[]; joined_on: string | null; left_on: string | null; notes: string | null; files: FileRow[];
}
interface Page { market: Market; kinds: string[]; other_kind: string; roles: string[]; id_types: string[]; documents: Doc[]; stakeholders: Person[] }

type DocForm = Record<'kind' | 'title' | 'number' | 'issued_by' | 'holder' | 'contact_name' | 'contact_phone' | 'contact_email' | 'issue_date' | 'expiry_date' | 'notes', string>;
type PersonForm = { name: string; role: string; share_pct: string; phone: string; email: string; address: string; joined_on: string; left_on: string; notes: string; id_details: IdRow[] };

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const blankDoc = (kind: string): DocForm => ({ kind, title: '', number: '', issued_by: '', holder: '', contact_name: '', contact_phone: '', contact_email: '', issue_date: '', expiry_date: '', notes: '' });
const docForm = (d: Doc, other: string): DocForm => ({
  kind: d.kind, title: d.kind === other || d.title !== d.kind ? d.title : '', number: s(d.number), issued_by: s(d.issued_by), holder: s(d.holder),
  contact_name: s(d.contact_name), contact_phone: s(d.contact_phone), contact_email: s(d.contact_email),
  issue_date: s(d.issue_date), expiry_date: s(d.expiry_date), notes: s(d.notes),
});
const blankPerson = (): PersonForm => ({ name: '', role: 'Director', share_pct: '', phone: '', email: '', address: '', joined_on: '', left_on: '', notes: '', id_details: [] });
const personForm = (p: Person): PersonForm => ({
  name: p.name, role: p.role, share_pct: s(p.share_pct), phone: s(p.phone), email: s(p.email), address: s(p.address),
  joined_on: s(p.joined_on), left_on: s(p.left_on), notes: s(p.notes), id_details: p.id_details.map((x) => ({ type: s(x.type), number: s(x.number) })),
});
const when = (iso: string) => iso.slice(0, 10);

function ExpiryPill({ d }: { d: Doc }) {
  if (d.days_left === null) return <span className="muted">No expiry</span>;
  if (d.days_left < 0) return <span className="pill bad" title="Reminders every 2 days until renewed">Expired {d.expiry_date}</span>;
  if (d.days_left <= 15) return <span className="pill bad" title="Reminders are being emailed">{d.days_left === 0 ? 'Expires today' : `${d.days_left} day${d.days_left === 1 ? '' : 's'} left`} · {d.expiry_date}</span>;
  return <span className="pill ok">{d.expiry_date}</span>;
}

export default function CompanyDocumentsTab() {
  const { user } = useAuth();
  const toast = useToast();
  const { confirm, askDelete, closeConfirm } = useConfirm();
  const [page, setPage] = useState<Page | null>(null);
  const [docOpen, setDocOpen] = useState<Doc | 'new' | null>(null);
  const [df, setDf] = useState<DocForm>(blankDoc(''));
  const [personOpen, setPersonOpen] = useState<Person | 'new' | null>(null);
  const [pf, setPf] = useState<PersonForm>(blankPerson());
  const [files, setFiles] = useState<File[]>([]);
  const [fileNote, setFileNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get<Page>('/api/company-documents').then((r) => setPage(r.data))
      .catch((e) => toast(apiErrorMessage(e, 'Could not load the company documents'), 'bad'));
  }, [toast]);
  useEffect(load, [load, user?.market]);

  const download = async (url: string, name: string) => {
    try {
      const r = await api.get(url, { responseType: 'blob' });
      const u = URL.createObjectURL(r.data as Blob);
      const a = document.createElement('a');
      a.href = u; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(u), 30_000);
    } catch (e) { toast(apiErrorMessage(e, 'Could not download the file'), 'bad'); }
  };

  const upload = async (base: string, list: File[], note: string) => {
    for (const f of list) {
      const fd = new FormData();
      fd.append('file', f);
      if (note.trim()) fd.append('note', note.trim());
      await api.post(`${base}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    }
  };

  // ---- documents ----
  const openDoc = (d: Doc | 'new') => {
    setDocOpen(d); setFiles([]); setFileNote('');
    setDf(d === 'new' ? blankDoc(page?.kinds[0] ?? '') : docForm(d, page?.other_kind ?? ''));
  };
  const setD = (k: keyof DocForm, v: string) => setDf((f) => ({ ...f, [k]: v }));
  const saveDoc = async () => {
    if (df.kind === page?.other_kind && !df.title.trim()) { toast('Write the document\'s name', 'bad'); return; }
    setSaving(true);
    try {
      const r = docOpen === 'new' || docOpen === null
        ? await api.post<{ data: { id: number } }>('/api/company-documents/documents', df)
        : await api.put<{ data: { id: number } }>(`/api/company-documents/documents/${docOpen.id}`, df);
      if (files.length) await upload(`/api/company-documents/documents/${r.data.data.id}`, files, fileNote);
      toast(docOpen === 'new' ? 'Document added' : 'Document saved', 'ok');
      setDocOpen(null); load();
    } catch (e) { toast(apiErrorMessage(e, 'Could not save the document'), 'bad'); } finally { setSaving(false); }
  };
  const removeDoc = (d: Doc) => askDelete({
    title: 'Remove document?', message: `Remove "${d.title}" from the list? Its files are kept on record.`,
    onConfirm: async () => {
      try { await api.delete(`/api/company-documents/documents/${d.id}`); toast('Document removed', 'ok'); load(); }
      catch (e) { toast(apiErrorMessage(e, 'Could not remove the document'), 'bad'); }
    },
  });

  // ---- stakeholders ----
  const openPerson = (p: Person | 'new') => { setPersonOpen(p); setFiles([]); setFileNote(''); setPf(p === 'new' ? blankPerson() : personForm(p)); };
  const setP = <K extends keyof PersonForm>(k: K, v: PersonForm[K]) => setPf((f) => ({ ...f, [k]: v }));
  const setId = (i: number, k: keyof IdRow, v: string) => setPf((f) => ({ ...f, id_details: f.id_details.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  const savePerson = async () => {
    if (!pf.name.trim()) { toast('The name is required', 'bad'); return; }
    setSaving(true);
    try {
      const r = personOpen === 'new' || personOpen === null
        ? await api.post<{ data: { id: number } }>('/api/company-documents/stakeholders', pf)
        : await api.put<{ data: { id: number } }>(`/api/company-documents/stakeholders/${personOpen.id}`, pf);
      if (files.length) await upload(`/api/company-documents/stakeholders/${r.data.data.id}`, files, fileNote);
      toast(personOpen === 'new' ? 'Stakeholder added' : 'Stakeholder saved', 'ok');
      setPersonOpen(null); load();
    } catch (e) { toast(apiErrorMessage(e, 'Could not save the stakeholder'), 'bad'); } finally { setSaving(false); }
  };
  const removePerson = (p: Person) => askDelete({
    title: 'Remove stakeholder?', message: `Remove "${p.name}" from the list? Their files are kept on record.`,
    onConfirm: async () => {
      try { await api.delete(`/api/company-documents/stakeholders/${p.id}`); toast('Stakeholder removed', 'ok'); load(); }
      catch (e) { toast(apiErrorMessage(e, 'Could not remove the stakeholder'), 'bad'); }
    },
  });

  /** A wrongly uploaded file comes off the list (kept on record). */
  const removeFile = (base: string, f: FileRow, after: () => void) => askDelete({
    title: 'Remove file?', message: `Take "${f.file_name}" off the list? It is kept on record.`,
    onConfirm: async () => {
      try { await api.delete(`${base}/files/${f.id}`); toast('File removed', 'ok'); after(); }
      catch (e) { toast(apiErrorMessage(e, 'Could not remove the file'), 'bad'); }
    },
  });

  if (!page) return <div className="muted">Loading…</div>;
  const country = MARKET_NAME[page.market];
  const editingDoc = docOpen && docOpen !== 'new' ? page.documents.find((d) => d.id === docOpen.id) ?? docOpen : null;
  const editingPerson = personOpen && personOpen !== 'new' ? page.stakeholders.find((p) => p.id === personOpen.id) ?? personOpen : null;

  const fileList = (base: string, list: FileRow[], newestLabel: string) => list.length === 0 ? <div className="help">No files yet.</div> : (
    <div style={{ display: 'grid', gap: 4 }}>
      {list.map((f, i) => (
        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <button className="btn ghost sm" onClick={() => download(`${base}/files/${f.id}`, f.file_name)}>⬇ {f.file_name}</button>
          <span className="muted" style={{ fontSize: 12 }}>{i === 0 ? newestLabel : 'previous version'} · {when(f.uploaded_at)}{f.note ? ` · ${f.note}` : ''}</span>
          <button className="row-rm" title="Remove this file" onClick={() => removeFile(base, f, load)}>✕</button>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="modal-sub" style={{ marginTop: 0 }}>Certificates &amp; documents · <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Flag market={page.market} /> {country}</span></div>
            <div className="muted" style={{ fontSize: 12 }}>Only the {country} company&apos;s papers. Switch country in the top bar for the other. Expiry reminders go to the Super Admins at 9:00 AM {page.market === 'IN' ? 'India' : 'Toronto'} time.</div>
          </div>
          <button className="btn primary" onClick={() => openDoc('new')}>+ Add document</button>
        </div>
        {page.documents.length === 0 ? <div className="muted" style={{ marginTop: 12 }}>No documents yet.</div> : (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="list-table">
              <thead><tr><th>Document</th><th>Number</th><th>Issued by</th><th>Expiry</th><th>Latest file</th><th></th></tr></thead>
              <tbody>
                {page.documents.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button className="link" style={{ background: 'none', border: 0, padding: 0, color: 'var(--brand)', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }} onClick={() => openDoc(d)}>{d.title}</button>
                      {d.title !== d.kind && <div className="muted" style={{ fontSize: 12 }}>{d.kind}</div>}
                    </td>
                    <td>{d.number || <span className="muted">—</span>}</td>
                    <td>{d.issued_by || <span className="muted">—</span>}</td>
                    <td><ExpiryPill d={d} /></td>
                    <td>{d.files[0]
                      ? <><button className="btn ghost sm" onClick={() => download(`/api/company-documents/documents/${d.id}/files/${d.files[0].id}`, d.files[0].file_name)}>⬇ {d.files[0].file_name}</button>
                        {d.files.length > 1 && <div className="muted" style={{ fontSize: 12 }}>+{d.files.length - 1} previous version{d.files.length > 2 ? 's' : ''}</div>}</>
                      : <span className="muted">Not uploaded</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn ghost sm" onClick={() => openDoc(d)}>Edit</button>{' '}
                      <button className="btn ghost sm" onClick={() => removeDoc(d)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div className="modal-sub" style={{ marginTop: 0 }}>Stakeholders / Partners · {country}</div>
          <button className="btn primary" onClick={() => openPerson('new')}>+ Add stakeholder</button>
        </div>
        {page.stakeholders.length === 0 ? <div className="muted" style={{ marginTop: 12 }}>No stakeholders yet.</div> : (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="list-table">
              <thead><tr><th>Name</th><th>Role</th><th>Share %</th><th>Contact</th><th>Files</th><th></th></tr></thead>
              <tbody>
                {page.stakeholders.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <button className="link" style={{ background: 'none', border: 0, padding: 0, color: 'var(--brand)', fontWeight: 700, cursor: 'pointer' }} onClick={() => openPerson(p)}>{p.name}</button>
                      {p.left_on && <div className="muted" style={{ fontSize: 12 }}>Left {p.left_on}</div>}
                    </td>
                    <td>{p.role}</td>
                    <td>{p.share_pct === null ? <span className="muted">—</span> : `${p.share_pct}%`}</td>
                    <td style={{ fontSize: 12 }}>{[p.phone, p.email].filter(Boolean).join(' · ') || <span className="muted">—</span>}</td>
                    <td>{p.files.length ? `${p.files.length} file${p.files.length === 1 ? '' : 's'}` : <span className="muted">—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn ghost sm" onClick={() => openPerson(p)}>Edit</button>{' '}
                      <button className="btn ghost sm" onClick={() => removePerson(p)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {docOpen && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) setDocOpen(null); }}>
          <div className="modal" style={{ maxWidth: 760, maxHeight: '90vh', overflowY: 'auto' }}>
            <button className="close" onClick={() => setDocOpen(null)} disabled={saving}>✕</button>
            <div className="modal-h">{editingDoc ? `Edit — ${editingDoc.title}` : 'Add document'} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>· {country}</span></div>
            <div className="g3">
              <div className="field"><label>Kind <span className="req">*</span></label>
                <select value={df.kind} onChange={(e) => setD('kind', e.target.value)}>{page.kinds.map((k) => <option key={k}>{k}</option>)}</select></div>
              <div className="field"><label>Name {df.kind === page.other_kind && <span className="req">*</span>}</label>
                <input value={df.title} onChange={(e) => setD('title', e.target.value)} placeholder={df.kind === page.other_kind ? 'What the document is called' : `Empty = "${df.kind}"`} /></div>
              <div className="field"><label>Number</label><input value={df.number} onChange={(e) => setD('number', e.target.value)} placeholder="Certificate / registration no." /></div>
              <div className="field"><label>Issued by</label><input value={df.issued_by} onChange={(e) => setD('issued_by', e.target.value)} placeholder={page.market === 'IN' ? 'e.g. Registrar of Companies' : 'e.g. RECO'} /></div>
              <div className="field"><label>Holder</label><input value={df.holder} onChange={(e) => setD('holder', e.target.value)} placeholder="The company, or a person" /></div>
              <div />
              <div className="field"><label>Issue date</label><input type="date" value={df.issue_date} onChange={(e) => setD('issue_date', e.target.value)} /></div>
              <div className="field"><label>Expiry date</label><input type="date" value={df.expiry_date} onChange={(e) => setD('expiry_date', e.target.value)} />
                <span className="help">Reminders: from 15 days before, every 2 days, the day before, the day itself, and after expiry until renewed.</span></div>
            </div>
            <div className="modal-sub">Contact at the issuing office <span className="muted" style={{ fontWeight: 400 }}>· optional</span></div>
            <div className="g3">
              <div className="field"><label>Contact person</label><input value={df.contact_name} onChange={(e) => setD('contact_name', e.target.value)} /></div>
              <div className="field"><label>Phone</label><input value={df.contact_phone} onChange={(e) => setD('contact_phone', e.target.value)} /></div>
              <div className="field"><label>Email</label><input value={df.contact_email} onChange={(e) => setD('contact_email', e.target.value)} /></div>
            </div>
            <div className="modal-sub">Files</div>
            {editingDoc && fileList(`/api/company-documents/documents/${editingDoc.id}`, editingDoc.files, 'current')}
            <div className="g3" style={{ marginTop: 8 }}>
              <div className="field" style={{ gridColumn: 'span 2' }}><label>{editingDoc?.files.length ? 'Upload a new version' : 'Upload file'}</label>
                <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
                {editingDoc?.files.length ? <span className="help">The earlier files stay as previous versions. A new file after the reminders began counts as the renewal - enter the new expiry date too.</span> : null}</div>
              <div className="field"><label>File note</label><input value={fileNote} onChange={(e) => setFileNote(e.target.value)} placeholder="e.g. renewed 2027" /></div>
            </div>
            <div className="modal-sub">Notes</div>
            <div className="field"><textarea rows={3} value={df.notes} onChange={(e) => setD('notes', e.target.value)} /></div>
            <div className="actions">
              <button className="btn ghost" onClick={() => setDocOpen(null)} disabled={saving}>Cancel</button>
              <button className="btn primary" onClick={saveDoc} disabled={saving}>{saving ? 'Saving…' : editingDoc ? 'Save Changes' : 'Add document'}</button>
            </div>
          </div>
        </div>
      )}

      {personOpen && (
        <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) setPersonOpen(null); }}>
          <div className="modal" style={{ maxWidth: 760, maxHeight: '90vh', overflowY: 'auto' }}>
            <button className="close" onClick={() => setPersonOpen(null)} disabled={saving}>✕</button>
            <div className="modal-h">{editingPerson ? `Edit — ${editingPerson.name}` : 'Add stakeholder'} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>· {country}</span></div>
            <div className="g3">
              <div className="field"><label>Name <span className="req">*</span></label><input value={pf.name} onChange={(e) => setP('name', e.target.value)} /></div>
              <div className="field"><label>Role</label><select value={pf.role} onChange={(e) => setP('role', e.target.value)}>{page.roles.map((r) => <option key={r}>{r}</option>)}</select></div>
              <div className="field"><label>Share %</label><input inputMode="decimal" value={pf.share_pct} onChange={(e) => setP('share_pct', e.target.value)} placeholder="optional" /></div>
              <div className="field"><label>Phone</label><input value={pf.phone} onChange={(e) => setP('phone', e.target.value)} /></div>
              <div className="field"><label>Email</label><input value={pf.email} onChange={(e) => setP('email', e.target.value)} /></div>
              <div className="field"><label>Address</label><input value={pf.address} onChange={(e) => setP('address', e.target.value)} /></div>
              <div className="field"><label>Date joined</label><input type="date" value={pf.joined_on} onChange={(e) => setP('joined_on', e.target.value)} /></div>
              <div className="field"><label>Date left</label><input type="date" value={pf.left_on} onChange={(e) => setP('left_on', e.target.value)} /></div>
            </div>
            <div className="modal-sub">ID details <span className="muted" style={{ fontWeight: 400 }}>· optional</span></div>
            <datalist id="company-id-types">{page.id_types.map((t) => <option key={t} value={t} />)}</datalist>
            {pf.id_details.map((x, i) => (
              <div key={i} className="g3" style={{ alignItems: 'end', marginBottom: 6 }}>
                <div className="field" style={{ marginBottom: 0 }}><label>Type</label><input list="company-id-types" value={x.type} onChange={(e) => setId(i, 'type', e.target.value)} placeholder={page.id_types[0]} /></div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'end', gridColumn: 'span 2' }}>
                  <div className="field" style={{ marginBottom: 0, flex: 1 }}><label>Number</label><input value={x.number} onChange={(e) => setId(i, 'number', e.target.value)} /></div>
                  <button className="row-rm" title="Remove this ID" onClick={() => setP('id_details', pf.id_details.filter((_, j) => j !== i))}>✕</button>
                </div>
              </div>
            ))}
            <button className="btn ghost sm" onClick={() => setP('id_details', [...pf.id_details, { type: '', number: '' }])}>+ Add ID</button>
            <div className="modal-sub">Files</div>
            {editingPerson && fileList(`/api/company-documents/stakeholders/${editingPerson.id}`, editingPerson.files, 'latest')}
            <div className="g3" style={{ marginTop: 8 }}>
              <div className="field" style={{ gridColumn: 'span 2' }}><label>Add files</label>
                <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
                <span className="help">ID proofs, appointment letters... as many as needed.</span></div>
              <div className="field"><label>File note</label><input value={fileNote} onChange={(e) => setFileNote(e.target.value)} placeholder="e.g. PAN card" /></div>
            </div>
            <div className="modal-sub">Notes</div>
            <div className="field"><textarea rows={3} value={pf.notes} onChange={(e) => setP('notes', e.target.value)} /></div>
            <div className="actions">
              <button className="btn ghost" onClick={() => setPersonOpen(null)} disabled={saving}>Cancel</button>
              <button className="btn primary" onClick={savePerson} disabled={saving}>{saving ? 'Saving…' : editingPerson ? 'Save Changes' : 'Add stakeholder'}</button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog confirm={confirm} onClose={closeConfirm} />
    </>
  );
}
