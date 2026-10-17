import { useCallback, useEffect, useState } from 'react';
import api from '../lib/axios';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';
import { formatPrice } from './format';

/**
 * BUILDER OFFERS (stage 4, 17 Oct 2026).
 *
 * Builders give offers in meetings and no two look alike, so an offer is typed in when it is given -
 * plain words first, with optional structure and the proof. The app counts our units in the project
 * and SUGGESTS where an offer may apply; a Super Admin CONFIRMS it on the deal with what was actually
 * agreed. Nothing here changes a commission.
 *
 * Two pieces: `ProjectOffersSection` (inside a project) and `DealOffersPanel` (on an India deal).
 */
export interface OfferView {
  id: number; title: string; details: string | null; kind: string; value: number | null; from_unit: number | null;
  starts_on: string | null; ends_on: string | null; has_proof: boolean; proof_name: string | null;
  applications: { id: number; transaction_id: number; trade_no: string; property: string | null; unit_number: number | null; agreed: string; applied_by: string | null; applied_at: string }[];
}
const KIND_LABEL: Record<string, string> = { extra_percent: 'Extra %', fixed_bonus: 'Fixed bonus', discount: 'Discount', other: 'Other' };

/** "1% extra · from unit 3 · 1 Oct - 15 Nov 2026" */
export function offerSummary(o: Pick<OfferView, 'kind' | 'value' | 'from_unit' | 'starts_on' | 'ends_on'>): string {
  const parts: string[] = [];
  if (o.value !== null) parts.push(o.kind === 'extra_percent' ? `${o.value}% extra` : o.kind === 'fixed_bonus' ? `${formatPrice(o.value)} bonus` : o.kind === 'discount' ? `discount ${o.value}` : String(o.value));
  else parts.push(KIND_LABEL[o.kind] ?? o.kind);
  parts.push(o.from_unit ? `from our unit ${o.from_unit}` : 'every unit');
  if (o.starts_on || o.ends_on) parts.push(`${o.starts_on ?? '…'} to ${o.ends_on ?? 'open'}`);
  return parts.join(' · ');
}

async function downloadProof(o: Pick<OfferView, 'id' | 'proof_name'>, onError: (m: string) => void) {
  try {
    const r = await api.get(`/api/builder-offers/${o.id}/proof`, { responseType: 'blob' });
    const url = URL.createObjectURL(r.data as Blob);
    const a = document.createElement('a'); a.href = url; a.download = o.proof_name || 'proof'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (e) { onError(apiErrorMessage(e, 'Could not download the proof')); }
}

const blankOffer = { title: '', details: '', kind: 'extra_percent', value: '', from_unit: '', starts_on: '', ends_on: '' };

/** The Offers section of a project: what the builder offered, and where each was confirmed. */
export function ProjectOffersSection({ projectId }: { projectId: number }) {
  const toast = useToast();
  const [offers, setOffers] = useState<OfferView[]>([]);
  const [units, setUnits] = useState(0);
  const [form, setForm] = useState(blankOffer);
  const [proof, setProof] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);

  const take = (d: { data: OfferView[]; units_sold: number }) => { setOffers(d.data); setUnits(d.units_sold); };
  const load = useCallback(() => {
    api.get<{ data: OfferView[]; units_sold: number }>(`/api/builder-projects/${projectId}/offers`)
      .then((r) => take(r.data)).catch((e) => toast(apiErrorMessage(e, 'Could not load offers'), 'bad'));
  }, [projectId, toast]);
  useEffect(load, [load]);

  const add = async () => {
    if (!form.title.trim()) { toast('Write what the builder offered', 'bad'); return; }
    setAdding(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      if (proof) fd.append('file', proof);
      take((await api.post<{ data: OfferView[]; units_sold: number }>(`/api/builder-projects/${projectId}/offers`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data);
      setForm(blankOffer); setProof(null);
      toast('Offer recorded', 'ok');
    } catch (e) { toast(apiErrorMessage(e, 'Could not record the offer'), 'bad'); } finally { setAdding(false); }
  };
  const end = async (o: OfferView) => {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const fd = new FormData();
      Object.entries({ title: o.title, details: o.details ?? '', kind: o.kind, value: o.value ?? '', from_unit: o.from_unit ?? '', starts_on: o.starts_on ?? '', ends_on: today })
        .forEach(([k, v]) => fd.append(k, String(v)));
      take((await api.put<{ data: OfferView[]; units_sold: number }>(`/api/builder-offers/${o.id}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })).data);
      toast('Offer ended today', 'ok');
    } catch (e) { toast(apiErrorMessage(e, 'Could not end the offer'), 'bad'); }
  };
  const remove = async (o: OfferView) => {
    try { take((await api.delete<{ data: OfferView[]; units_sold: number }>(`/api/builder-offers/${o.id}`)).data); toast('Offer removed', 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Could not remove the offer'), 'bad'); }
  };

  return (
    <>
      <div className="modal-sub">Builder offers <span className="muted" style={{ fontWeight: 400 }}>· we have {units} live unit{units === 1 ? '' : 's'} in this project</span></div>
      {offers.length === 0 && <div className="help" style={{ marginBottom: 8 }}>No offers recorded. When the builder offers something, write it here - the app will point out the deals it may apply to.</div>}
      {offers.map((o) => (
        <div key={o.id} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div><strong>{o.title}</strong><div className="muted" style={{ fontSize: 12 }}>{offerSummary(o)}</div></div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'start' }}>
              {o.has_proof && <button className="btn ghost sm" onClick={() => downloadProof(o, (m) => toast(m, 'bad'))}>⬇ Proof</button>}
              {!o.ends_on && <button className="btn ghost sm" onClick={() => end(o)} title="Set today as its end date">End offer</button>}
              {o.applications.length === 0 && <button className="btn ghost sm" onClick={() => remove(o)}>Remove</button>}
            </div>
          </div>
          {o.details && <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap' }}>{o.details}</div>}
          {o.applications.length > 0 && (
            <div style={{ fontSize: 12, marginTop: 6 }}>
              <strong>Confirmed on:</strong>
              {o.applications.map((a) => <div key={a.id}>#{a.trade_no} (unit {a.unit_number ?? '?'}) — {a.agreed} <span className="muted">· {a.applied_by}, {String(a.applied_at).slice(0, 10)}</span></div>)}
            </div>
          )}
        </div>
      ))}
      <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 10 }}>
        <div className="field"><label>What did the builder offer?</label>
          <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. 1% extra on every unit after our 3rd" /></div>
        <div className="field"><label>Details (as agreed in the meeting)</label>
          <textarea rows={2} value={form.details} onChange={(e) => setForm((f) => ({ ...f, details: e.target.value }))} placeholder="Who offered it, when, any conditions" /></div>
        <div className="g3">
          <div className="field"><label>Kind</label>
            <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label>{form.kind === 'extra_percent' ? 'Extra %' : form.kind === 'fixed_bonus' ? 'Bonus (₹)' : 'Value (optional)'}</label>
            <input inputMode="decimal" value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} /></div>
          <div className="field"><label>From our unit no.</label>
            <input inputMode="numeric" value={form.from_unit} onChange={(e) => setForm((f) => ({ ...f, from_unit: e.target.value }))} placeholder="Empty = every unit" /></div>
          <div className="field"><label>Starts</label><input type="date" value={form.starts_on} onChange={(e) => setForm((f) => ({ ...f, starts_on: e.target.value }))} /></div>
          <div className="field"><label>Ends</label><input type="date" value={form.ends_on} onChange={(e) => setForm((f) => ({ ...f, ends_on: e.target.value }))} /></div>
          <div className="field"><label>Proof (letter, email, notes)</label><input type="file" onChange={(e) => setProof(e.target.files?.[0] ?? null)} /></div>
        </div>
        <button className="btn ghost sm" onClick={add} disabled={adding}>{adding ? 'Saving…' : '+ Record offer'}</button>
      </div>
    </>
  );
}

interface DealOffers {
  project: { id: number; name: string } | null; unit_number: number | null; units_sold: number;
  offers: (OfferView & { may_apply: boolean; why_not: string | null; applied: { agreed: string; applied_by: string | null; applied_at: string; unit_number: number | null } | null })[];
}

/** On an India deal: which unit it is in its project, and the builder's offers - suggested, confirmed or not applicable. */
export function DealOffersPanel({ txnId }: { txnId: number | string }) {
  const toast = useToast();
  const [info, setInfo] = useState<DealOffers | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [agreed, setAgreed] = useState('');
  const [value, setValue] = useState('');

  const load = useCallback(() => {
    api.get<DealOffers>(`/api/transactions/${txnId}/builder-offers`).then((r) => setInfo(r.data)).catch(() => setInfo(null));
  }, [txnId]);
  useEffect(load, [load]);

  if (!info?.project) return null;
  const confirm = async (offerId: number) => {
    if (!agreed.trim()) { toast('Write what was actually agreed', 'bad'); return; }
    try {
      setInfo((await api.post<DealOffers>(`/api/transactions/${txnId}/builder-offers/${offerId}/apply`, { agreed, agreed_value: value })).data);
      setConfirming(null); setAgreed(''); setValue('');
      toast('Offer confirmed on this deal', 'ok');
    } catch (e) { toast(apiErrorMessage(e, 'Could not confirm the offer'), 'bad'); }
  };
  const unconfirm = async (offerId: number) => {
    try { setInfo((await api.delete<DealOffers>(`/api/transactions/${txnId}/builder-offers/${offerId}/apply`)).data); toast('Confirmation removed', 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Could not remove the confirmation'), 'bad'); }
  };
  const suggested = info.offers.filter((o) => o.may_apply).length;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="modal-sub" style={{ marginTop: 0 }}>Builder offers
        <span className="muted" style={{ fontWeight: 400 }}> · this deal is unit {info.unit_number ?? '?'} of {info.units_sold} in {info.project.name}</span>
        {suggested > 0 && <span className="pill bad" style={{ marginLeft: 8 }}>{suggested} may apply</span>}
      </div>
      {info.offers.length === 0 && <div className="help">No offers recorded on this project.</div>}
      {info.offers.map((o) => (
        <div key={o.id} style={{ borderTop: '1px solid var(--line)', padding: '8px 0', fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div><strong>{o.title}</strong> <span className="muted">· {offerSummary(o)}</span></div>
            <div>
              {o.applied ? <span className="pill ok">Confirmed</span> : o.may_apply ? <span className="pill bad">May apply</span> : <span className="pill" title={o.why_not ?? ''}>Not for this deal</span>}
            </div>
          </div>
          {o.applied && <div style={{ marginTop: 4 }}>Agreed: {o.applied.agreed} <span className="muted">· {o.applied.applied_by}, {String(o.applied.applied_at).slice(0, 10)}</span>
            {' '}<button className="btn ghost sm" onClick={() => unconfirm(o.id)}>Undo</button></div>}
          {!o.applied && !o.may_apply && o.why_not && <div className="muted" style={{ fontSize: 12 }}>{o.why_not}</div>}
          {o.may_apply && (confirming === o.id ? (
            <div className="g3" style={{ alignItems: 'end', marginTop: 6 }}>
              <div className="field" style={{ marginBottom: 0 }}><label>What was agreed for this deal?</label><input value={agreed} onChange={(e) => setAgreed(e.target.value)} placeholder="e.g. 1% extra confirmed by the builder's sales head" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Amount / % (optional)</label><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></div>
              <div style={{ display: 'flex', gap: 6 }}><button className="btn primary sm" onClick={() => confirm(o.id)}>Confirm</button><button className="btn ghost sm" onClick={() => setConfirming(null)}>Cancel</button></div>
            </div>
          ) : <button className="btn ghost sm" style={{ marginTop: 4 }} onClick={() => { setConfirming(o.id); setAgreed(''); setValue(''); }}>Confirm on this deal…</button>)}
        </div>
      ))}
      <div className="help" style={{ marginTop: 6 }}>The app only suggests. Confirming records what was agreed; it does not change the commission.</div>
    </div>
  );
}
