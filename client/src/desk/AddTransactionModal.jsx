import { useState, useEffect, useRef } from 'react';
import { createTransaction, listAgents } from '../lib/api';
import { TRANSACTION_TYPES, typeLabel, isListingType, parseNumber, statusOptionsFor } from './format';
import { useToast } from './toast';
import { useAuth } from '../context/AuthContext';

const EMPTY = {
  type: '', property: '', status: '',
  comm_type: '%', comm_value: '', price: '', deposit: '',
  offer_date: '', closing_date: '',
  listing_contract_date: '', listing_expiry_date: '',
};

export default function AddTransactionModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const { user } = useAuth();
  const isAgent = user?.role === 'agent';
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Team option (bottom of the modal). Agent 1 (primary) defaults to the creator.
  const [teamMode, setTeamMode] = useState('solo'); // 'solo' | 'team'
  const [agents, setAgents] = useState([]);
  const [primaryAgent, setPrimaryAgent] = useState('');
  const [teamMembers, setTeamMembers] = useState([]);

  // Load the agent list once the modal opens (for the team member picker).
  useEffect(() => {
    if (!open) return;
    listAgents().then(setAgents).catch(() => setAgents([]));
    setPrimaryAgent(isAgent ? (user?.name || '') : '');
  }, [open, isAgent, user]);

  // Property Address: "search" (OpenStreetMap autocomplete, default) or "manual".
  const [addrMode, setAddrMode] = useState('search');
  const [addrSug, setAddrSug] = useState([]);
  const [addrOpen, setAddrOpen] = useState(false);
  const [addrLoading, setAddrLoading] = useState(false);
  const [leadNo, setLeadNo] = useState(''); // house number typed by the user (e.g. "83")
  const suppressSearch = useRef(false); // skip the fetch triggered by picking a suggestion

  // Prefer full civic addresses (house number + street) at the top of the list.
  const rank = (p = {}) => (p.housenumber ? 3 : 0) + (p.street ? 2 : 0) + (p.postcode ? 1 : 0);

  // Build a clean "83 Parity Road, Brampton, Ontario, L6X 5M8, Canada" string from
  // Photon's structured properties, dropping region noise (county, district, etc.).
  // Falls back to the number the user typed when the result lacks a house number.
  const fmtAddress = (s) => {
    const p = s.properties || {};
    const road = p.street || p.name || '';
    const houseNo = p.housenumber || (road ? leadNo : ''); // only prepend a number if we have a street
    const city = p.city || p.town || p.village || p.locality || p.county || p.district || '';
    const line1 = [houseNo, road].filter(Boolean).join(' ');
    const parts = [line1, city, p.state, p.postcode, p.country].filter(Boolean);
    return parts.length ? parts.join(', ') : (p.name || '');
  };

  // Debounced address lookup while typing in search mode.
  useEffect(() => {
    if (addrMode !== 'search') return;
    if (suppressSearch.current) { suppressSearch.current = false; return; }
    const q = form.property.trim();
    setLeadNo((q.match(/^\s*(\d+[a-z]?)\b/i) || [])[1] || '');
    if (q.length < 3) { setAddrSug([]); setAddrOpen(false); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setAddrLoading(true);
      try {
        // Photon (komoot) — free OSM type-ahead geocoder, biased to Canada via bbox.
        const res = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en&bbox=-141.0,41.7,-52.6,83.1`,
          { signal: ctrl.signal, headers: { Accept: 'application/json' } },
        );
        const data = await res.json();
        const feats = (Array.isArray(data.features) ? data.features : [])
          .filter((f) => (f.properties || {}).countrycode === 'CA')
          // House-level matches first, then streets, then the rest.
          .sort((a, b) => rank(b.properties) - rank(a.properties));
        setAddrSug(feats);
        setAddrOpen(true);
      } catch { /* aborted or offline — leave manual entry available */ }
      finally { setAddrLoading(false); }
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [form.property, addrMode]);

  if (!open) return null;

  const pickAddr = (s) => {
    suppressSearch.current = true;
    set('property', fmtAddress(s));
    setAddrOpen(false);
    setAddrSug([]);
  };

  const listing = isListingType(form.type);
  const isLease = form.type === 'Residential Lease';
  const referral = form.type === 'Referral';
  // "Closed" can't be chosen at creation (only Expired is otherwise excluded — it's auto).
  const statusOpts = form.type ? statusOptionsFor(form.type).filter((s) => s !== 'Expired' && s !== 'Closed') : [];
  const today = new Date().toISOString().slice(0, 10);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const reset = () => { setForm(EMPTY); setError(''); setTeamMode('solo'); setTeamMembers([]); setPrimaryAgent(isAgent ? (user?.name || '') : ''); };
  const close = () => { reset(); onClose(); };

  const addMember = (name) => { if (name && !teamMembers.includes(name)) setTeamMembers((m) => [...m, name]); };
  const removeMember = (name) => setTeamMembers((m) => m.filter((n) => n !== name));

  const submit = async () => {
    setError('');
    if (!form.type || !form.property.trim()) { toast('Please fill all required fields', 'bad'); return; }
    if (!form.status) { toast('Please select a Status', 'bad'); return; }
    const payload = { type: form.type, property: form.property.trim(), status: form.status };

    if (listing) {
      payload.listing_contract_date = form.listing_contract_date || null;
      payload.listing_expiry_date = form.listing_expiry_date || null;
    } else {
      const commValue = parseNumber(form.comm_value);
      const price = parseNumber(form.price);
      if (!commValue || !price || !form.offer_date || !form.closing_date) {
        toast('Please fill all required fields', 'bad'); return;
      }
      if (form.comm_type === '%' && commValue > 100) { toast('Commission % cannot exceed 100', 'bad'); return; }
      if (form.offer_date > today) { toast('Offer date cannot be a future date', 'bad'); return; }
      if (form.closing_date < form.offer_date) { toast('Closing date cannot be before the offer date', 'bad'); return; }
      Object.assign(payload, {
        comm_type: form.comm_type,
        comm_value: commValue,
        price,
        deposit: parseNumber(form.deposit),
        offer_date: form.offer_date,
        closing_date: form.closing_date,
      });
    }

    // Team option — Agent 1 (primary) + involved members. Split % is entered later.
    if (teamMode === 'team') {
      if (!primaryAgent) { toast('Please select Agent 1 (Primary)', 'bad'); return; }
      payload.primary_agent = primaryAgent;
      payload.team_members = teamMembers;
    }

    setSaving(true);
    try {
      const created = await createTransaction(payload);
      toast('Transaction saved successfully', 'ok');
      close();
      onCreated?.(created);
    } catch (err) {
      const msg = err.response?.data?.message || 'Could not save transaction';
      setError(msg);
      toast(msg, 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal">
        <button className="close" onClick={close}>{'✕'}</button>
        <div className="modal-h">Add Transaction</div>

        <div className="field">
          <label>Transaction Type <span className="req">*</span></label>
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            <option value="">Select type</option>
            {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
          </select>
        </div>

        {form.type && (
          <>
            <div className="field" style={{ position: 'relative' }}>
              <label>Property Address <span className="req">*</span></label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <button type="button" className={`btn sm ${addrMode === 'search' ? 'primary' : 'ghost'}`}
                  onClick={() => setAddrMode('search')}>🔍 Search</button>
                <button type="button" className={`btn sm ${addrMode === 'manual' ? 'primary' : 'ghost'}`}
                  onClick={() => { setAddrMode('manual'); setAddrOpen(false); }}>✎ Manual</button>
              </div>
              <input
                value={form.property}
                onChange={(e) => set('property', e.target.value)}
                onFocus={() => { if (addrMode === 'search' && addrSug.length) setAddrOpen(true); }}
                onBlur={() => setTimeout(() => setAddrOpen(false), 150)}
                autoComplete="off"
                placeholder={addrMode === 'search' ? 'Start typing to search the address…' : 'Enter the full street address'}
              />
              {addrMode === 'search' && addrOpen && form.property.trim().length >= 3 && (
                <div style={{ position: 'absolute', zIndex: 30, left: 0, right: 0, top: '100%', marginTop: 2, background: '#fff', border: '1px solid var(--line)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.12)', maxHeight: 240, overflowY: 'auto' }}>
                  {addrLoading && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>Searching…</div>}
                  {!addrLoading && addrSug.length === 0 && <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>No matches — switch to Manual to type it in.</div>}
                  {addrSug.map((s, idx) => (
                    <div key={`${s.properties?.osm_type || ''}${s.properties?.osm_id || ''}-${idx}`}
                      onMouseDown={(e) => { e.preventDefault(); pickAddr(s); }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                      style={{ padding: '8px 12px', fontSize: 12.5, cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}>
                      📍 {fmtAddress(s)}
                    </div>
                  ))}
                </div>
              )}
              {addrMode === 'search' && <span className="help">Pick a suggestion, or switch to Manual to type the address yourself.</span>}
            </div>

            {listing ? (
              <div className="g3">
                <div className="field"><label>Listing Contract Date</label>
                  <input type="date" value={form.listing_contract_date} onChange={(e) => set('listing_contract_date', e.target.value)} /></div>
                <div className="field"><label>Listing Expiry Date</label>
                  <input type="date" value={form.listing_expiry_date} onChange={(e) => set('listing_expiry_date', e.target.value)} /></div>
                <div className="field"><label>Status <span className="req">*</span></label>
                  <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                    <option value="">Select status</option>
                    {statusOpts.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select></div>
              </div>
            ) : (
              <>
                <div className="g2">
                  <div className="field"><label>Commission Input Type <span className="req">*</span></label>
                    <select value={form.comm_type} onChange={(e) => {
                      const t = e.target.value;
                      // Switching to % clamps any existing value to 100.
                      setForm((f) => ({ ...f, comm_type: t, comm_value: (t === '%' && parseNumber(f.comm_value) > 100) ? '100' : f.comm_value }));
                    }}>
                      <option value="%">% (Percentage)</option>
                      <option value="Fixed">Fixed Amount</option>
                    </select>
                  </div>
                  <div className="field"><label>Commission Value <span className="req">*</span></label>
                    <input type="number" min="0" max={form.comm_type === '%' ? 100 : undefined} value={form.comm_value}
                      onChange={(e) => { const v = e.target.value; set('comm_value', (form.comm_type === '%' && parseNumber(v) > 100) ? '100' : v); }}
                      placeholder="0.00" />
                    {form.comm_type === '%' && <span className="help">Percentage cannot exceed 100.</span>}</div>
                </div>
                <div className="g3">
                  <div className="field"><label>{isLease ? 'Total lease price' : 'Total Purchase Price'} <span className="req">*</span></label>
                    <input value={form.price} onChange={(e) => set('price', e.target.value)} placeholder="0.00" /></div>
                  {!referral && <div className="field"><label>Deposit</label>
                    <input value={form.deposit} onChange={(e) => set('deposit', e.target.value)} placeholder="0.00" /></div>}
                  <div className="field"><label>Status <span className="req">*</span></label>
                    <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                      <option value="">Select status</option>
                      {statusOpts.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select></div>
                </div>
                <div className="g2">
                  <div className="field"><label>Offer Date <span className="req">*</span></label>
                    <input type="date" max={today} value={form.offer_date} onChange={(e) => set('offer_date', e.target.value)} />
                    <span className="help">Cannot be a future date.</span></div>
                  <div className="field"><label>Closing Date <span className="req">*</span></label>
                    <input type="date" min={form.offer_date || undefined} value={form.closing_date} onChange={(e) => set('closing_date', e.target.value)} />
                    <span className="help">Cannot be before the offer date.</span></div>
                </div>
              </>
            )}

            {/* Team option — Agent 1 (primary) defaults to the creator; add involved members. */}
            <div className="field" style={{ marginTop: 4 }}>
              <label>Working As</label>
              <select value={teamMode} onChange={(e) => setTeamMode(e.target.value)}>
                <option value="solo">Solo (single agent)</option>
                <option value="team">Team</option>
              </select>
            </div>
            {teamMode === 'team' && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 8, background: 'var(--surface)' }}>
                <div className="field">
                  <label>Agent 1 (Primary)</label>
                  {isAgent ? (
                    <input value={primaryAgent} disabled />
                  ) : (
                    <select value={primaryAgent} onChange={(e) => setPrimaryAgent(e.target.value)}>
                      <option value="">Select primary agent</option>
                      {agents.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  )}
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Select Team Members</label>
                  <select value="" onChange={(e) => { addMember(e.target.value); e.target.value = ''; }}>
                    <option value="">Add team member…</option>
                    {agents.filter((a) => a !== primaryAgent && !teamMembers.includes(a)).map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                  {teamMembers.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {teamMembers.map((n) => (
                        <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#eef2ff', color: '#3730a3', borderRadius: 999, padding: '3px 10px', fontSize: 12 }}>
                          {n}
                          <button type="button" onClick={() => removeMember(n)} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: '#3730a3', fontSize: 13, lineHeight: 1 }}>✕</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="help">Selected agents are added to Team Split automatically — enter each split % later under Financial Information.</span>
                </div>
              </div>
            )}
          </>
        )}

        {error && (
          <div className="alert bad" style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 13 }}>
            ⚠ {error}
          </div>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={close}>Close</button>
          <button className="btn primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
