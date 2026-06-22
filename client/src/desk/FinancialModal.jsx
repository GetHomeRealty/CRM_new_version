import { useState } from 'react';
import { updateTransaction } from '../lib/api';
import { formatCurrency, parseNumber, isListingType, isPreconType } from './format';
import { useToast } from './toast';

export default function FinancialModal({ open, onClose, transactionId, txn, onSaved }) {
  const toast = useToast();
  const listing = isListingType(txn.type);
  const precon = isPreconType(txn.type);
  const termCount = txn.precon_term_count || 0;

  // shared
  const [price, setPrice] = useState(txn.price ?? 0);
  const [fin, setFin] = useState(txn.financial || null);
  const [saving, setSaving] = useState(false);

  // standard
  const [commPct, setCommPct] = useState(txn.comm_pct ?? (txn.comm_type === '%' ? txn.comm_value : '') ?? '');
  const [commAmt, setCommAmt] = useState(txn.comm_amt ?? '');
  const [adjEnabled, setAdjEnabled] = useState(!!txn.comm_adjust_enabled);
  const [adjBefore, setAdjBefore] = useState(txn.comm_adjust_before ?? 0);
  const [adjAfter, setAdjAfter] = useState(txn.comm_adjust_after ?? 0);

  // listing
  const [listPct, setListPct] = useState(txn.listing_comm_pct ?? '');
  const [coopPct, setCoopPct] = useState(txn.coop_comm_pct ?? '');
  const [lAdjEn, setLAdjEn] = useState(!!txn.listing_adj_enabled);
  const [lBefore, setLBefore] = useState(txn.listing_adj_before ?? 0);
  const [lAfter, setLAfter] = useState(txn.listing_adj_after ?? 0);
  const [cAdjEn, setCAdjEn] = useState(!!txn.coop_adj_enabled);
  const [cBefore, setCBefore] = useState(txn.coop_adj_before ?? 0);
  const [cAfter, setCAfter] = useState(txn.coop_adj_after ?? 0);

  // precon
  const [netHst, setNetHst] = useState(!!txn.precon_net_of_hst);
  const [masterPct, setMasterPct] = useState(txn.precon_comm_pct ?? '');
  const [pTerms, setPTerms] = useState(() => {
    const existing = {};
    (txn.precon_terms || []).forEach((t) => { existing[t.term_no] = t; });
    return Array.from({ length: termCount }, (_, k) => {
      const e = existing[k + 1] || {};
      return { term_no: k + 1, pct: e.pct ?? '', closing_date: e.closing_date || '' };
    });
  });
  const setTerm = (i, k, v) => setPTerms((ts) => ts.map((t, idx) => idx === i ? { ...t, [k]: v } : t));

  if (!open) return null;

  const onPct = (v) => { setCommPct(v); if (v) setCommAmt(''); };
  const onAmt = (v) => { setCommAmt(v); if (v) setCommPct(''); };
  const excl = (v, setThis, other, setOther) => { setThis(v); if (parseNumber(v) !== 0) setOther(0); };

  const save = async () => {
    const payload = precon
      ? {
          price: parseNumber(price),
          precon_net_of_hst: netHst,
          precon_comm_pct: masterPct === '' ? null : parseNumber(masterPct),
          precon_terms: pTerms.map((t) => ({ term_no: t.term_no, pct: t.pct === '' ? null : parseNumber(t.pct), closing_date: t.closing_date || null })),
        }
      : listing
      ? {
          price: parseNumber(price),
          listing_comm_pct: listPct === '' ? null : parseNumber(listPct),
          coop_comm_pct: coopPct === '' ? null : parseNumber(coopPct),
          listing_adj_enabled: lAdjEn, listing_adj_before: lAdjEn ? parseNumber(lBefore) : 0, listing_adj_after: lAdjEn ? parseNumber(lAfter) : 0,
          coop_adj_enabled: cAdjEn, coop_adj_before: cAdjEn ? parseNumber(cBefore) : 0, coop_adj_after: cAdjEn ? parseNumber(cAfter) : 0,
        }
      : {
          price: parseNumber(price),
          comm_pct: commPct === '' ? null : parseNumber(commPct),
          comm_amt: commAmt === '' ? null : parseNumber(commAmt),
          comm_adjust_enabled: adjEnabled,
          comm_adjust_before: adjEnabled ? parseNumber(adjBefore) : 0,
          comm_adjust_after: adjEnabled ? parseNumber(adjAfter) : 0,
        };
    setSaving(true);
    try {
      const updated = await updateTransaction(transactionId, payload);
      setFin(updated.financial);
      toast('Financial saved', 'ok');
      onSaved?.(updated);
    } catch (err) {
      toast(err.response?.data?.message || 'Could not save', 'bad');
    } finally { setSaving(false); }
  };

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal xl">
        <button className="close" onClick={onClose}>✕</button>
        <div className="modal-h">Financial Information {listing && <span className="pill type-res-sell" style={{ fontSize: 10 }}>Listing</span>}</div>

        <div className="g2">
          <div className="field"><label>Price</label><input value={price} onChange={(e) => setPrice(e.target.value)} /></div>
          <div className="field"><label>Deposit</label><input value={txn.deposit ?? 0} readOnly style={{ background: '#f9fafb' }} /></div>
        </div>

        {precon ? (
          <>
            <div className="g2">
              <div className="field"><label>NET of HST</label>
                <select value={netHst ? 'Yes' : 'No'} onChange={(e) => setNetHst(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select></div>
              <div className="field"><label>Master Commission %</label>
                <input value={masterPct} onChange={(e) => setMasterPct(e.target.value)} placeholder="e.g. 4" /></div>
            </div>
            {termCount === 0 && <span className="help">Set "Commission Receivable in Terms" in Preconstruction Details first, then reopen Financial.</span>}
            {pTerms.map((t, i) => (
              <div className="g3" key={t.term_no} style={{ alignItems: 'end', marginBottom: 6 }}>
                <div className="field" style={{ marginBottom: 0 }}><label>Term {t.term_no} %</label>
                  <input value={t.pct} onChange={(e) => setTerm(i, 'pct', e.target.value)} placeholder="e.g. 3" /></div>
                <div className="field" style={{ marginBottom: 0 }}><label>Term {t.term_no} Closing Date</label>
                  <input type="date" value={t.closing_date} onChange={(e) => setTerm(i, 'closing_date', e.target.value)} /></div>
                <div />
              </div>
            ))}
          </>
        ) : listing ? (
          <>
            <div className="g2">
              <AdjSide title="Listing Commission" pct={listPct} setPct={setListPct}
                en={lAdjEn} setEn={setLAdjEn} before={lBefore} after={lAfter}
                setBefore={(v) => excl(v, setLBefore, lAfter, setLAfter)} setAfter={(v) => excl(v, setLAfter, lBefore, setLBefore)} />
              <AdjSide title="Co-op Commission" pct={coopPct} setPct={setCoopPct}
                en={cAdjEn} setEn={setCAdjEn} before={cBefore} after={cAfter}
                setBefore={(v) => excl(v, setCBefore, cAfter, setCAfter)} setAfter={(v) => excl(v, setCAfter, cBefore, setCBefore)} />
            </div>
          </>
        ) : (
          <>
            <div className="g2">
              <div className="field"><label>Commission %</label><input value={commPct} onChange={(e) => onPct(e.target.value)} placeholder="e.g. 5" /></div>
              <div className="field"><label>Commission Amount</label><input value={commAmt} onChange={(e) => onAmt(e.target.value)} placeholder="0.00" /></div>
            </div>
            <div className="field" style={{ maxWidth: 220 }}>
              <label>Commission Adjustment</label>
              <select value={adjEnabled ? 'Yes' : 'No'} onChange={(e) => setAdjEnabled(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select>
            </div>
            {adjEnabled && (
              <div className="g2">
                <div className="field"><label>Adjustment (Before HST)</label><input value={adjBefore} onChange={(e) => excl(e.target.value, setAdjBefore, adjAfter, setAdjAfter)} /></div>
                <div className="field"><label>Adjustment (After HST)</label><input value={adjAfter} onChange={(e) => excl(e.target.value, setAdjAfter, adjBefore, setAdjBefore)} /></div>
              </div>
            )}
          </>
        )}

        <div style={{ textAlign: 'right', marginBottom: 8 }}>
          <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save & Recalculate'}</button>
        </div>

        {fin && fin.variant === 'precon' && (<>
          <div className="modal-sub">Master Commission {fin.net_of_hst && <span className="pill info" style={{ fontSize: 10 }}>NET of HST</span>}</div>
          <div className="g3"><Box label="Commission" value={formatCurrency(fin.master.commission)} /><Box label="HST" value={formatCurrency(fin.master.hst)} /><Box label="Total" value={formatCurrency(fin.master.total)} brand /></div>
          {!fin.terms_pct_valid && <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6, fontWeight: 600 }}>⚠ Sum of term % exceeds the master commission %.</div>}
          {fin.terms.map((t) => (
            <div key={t.term_no} style={{ background: '#f9fafb', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <strong>Term {t.term_no} — {t.pct}%</strong>
                <span className="help" style={{ margin: 0 }}>{t.closing_date || 'no closing date'} · {formatCurrency(t.total)}</span>
              </div>
              <div className="g3"><Box label="Commission" value={formatCurrency(t.commission)} /><Box label="HST" value={formatCurrency(t.hst)} /><Box label="Total" value={formatCurrency(t.total)} brand /></div>
              {t.agents.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  {t.agents.map((a, i) => (
                    <div className="team-card" key={i}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <strong>{a.name?.toUpperCase()}</strong>
                        <span className="pill info" style={{ fontSize: 10 }}>{a.split}% · agent {a.agent_pct}%</span>
                      </div>
                      <div className="g3"><Mini label="Agent" line={a.agent} brand /><Mini label="Brokerage" line={a.brokerage} /><Mini label="T4A" line={a.t4a} /></div>
                    </div>
                  ))}
                </div>
              ) : <div className="help" style={{ marginTop: 8 }}>No agents scoped to this term.</div>}
            </div>
          ))}
          <MinBrok mb={fin.min_brokerage} />
        </>)}

        {fin && fin.variant === 'listing' && (<>
          <div className="modal-sub">Listing Commission</div>
          <div className="g3"><Box label="Commission" value={formatCurrency(fin.listing.commission)} /><Box label="HST" value={formatCurrency(fin.listing.hst)} /><Box label="Total" value={formatCurrency(fin.listing.total)} brand /></div>
          <div className="modal-sub">Co-op Commission</div>
          <div className="g3"><Box label="Commission" value={formatCurrency(fin.coop.commission)} /><Box label="HST" value={formatCurrency(fin.coop.hst)} /><Box label="Total" value={formatCurrency(fin.coop.total)} brand /></div>
          <div className="modal-sub">Total Commissions (Listing + Co-op)</div>
          <div className="g3"><Box label="Commission" value={formatCurrency(fin.totals.commission)} /><Box label="HST" value={formatCurrency(fin.totals.hst)} /><Box label="Total" value={formatCurrency(fin.totals.total)} brand /></div>
          <AgentCards agents={fin.agents} />
          <MinBrok mb={fin.min_brokerage} />
        </>)}

        {fin && fin.variant === 'standard' && (<>
          <div className="modal-sub">Commission Summary</div>
          <div className="g3" style={{ marginBottom: 6 }}>
            <Box label="Commission" value={formatCurrency(fin.commission)} />
            <Box label="HST (13%)" value={formatCurrency(fin.hst)} />
            <Box label="Total" value={formatCurrency(fin.total)} brand />
          </div>
          {fin.adjust?.enabled && <span className="help">Gross {formatCurrency(fin.base_commission)} · adjustment before HST {formatCurrency(fin.adjust.before)} / after HST {formatCurrency(fin.adjust.after)}</span>}
          <AgentCards agents={fin.agents} />
          <MinBrok mb={fin.min_brokerage} />
        </>)}

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function AdjSide({ title, pct, setPct, en, setEn, before, after, setBefore, setAfter }) {
  return (
    <div style={{ background: '#f9fafb', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
      <div className="field"><label>{title} %</label><input value={pct} onChange={(e) => setPct(e.target.value)} placeholder="e.g. 2.5" /></div>
      <div className="field" style={{ marginBottom: en ? 13 : 0 }}>
        <label>Adjustment?</label>
        <select value={en ? 'Yes' : 'No'} onChange={(e) => setEn(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select>
      </div>
      {en && (
        <div className="g2">
          <div className="field" style={{ marginBottom: 0 }}><label>Before HST</label><input value={before} onChange={(e) => setBefore(e.target.value)} /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>After HST</label><input value={after} onChange={(e) => setAfter(e.target.value)} /></div>
        </div>
      )}
    </div>
  );
}

function AgentCards({ agents }) {
  return (
    <>
      <div className="modal-sub">Agent Commission</div>
      {(!agents || agents.length === 0) && <div className="help">No agents assigned — set the agent in Basic Info or use Team Split.</div>}
      {agents && agents.map((a, i) => (
        <div className="team-card" key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong>{a.name?.toUpperCase()}</strong>
            <span className="pill info" style={{ fontSize: 10 }}>{a.split}% split · agent {a.agent_pct}% · brok {a.brok_pct}%</span>
          </div>
          <div className="g3">
            <Mini label="Agent" line={a.agent} brand />
            <Mini label="Brokerage" line={a.brokerage} />
            <Mini label="T4A" line={a.t4a} />
          </div>
        </div>
      ))}
    </>
  );
}

function MinBrok({ mb }) {
  return (
    <>
      <div className="modal-sub" style={{ borderLeftColor: '#7c3aed', color: '#5b21b6' }}>Minimum Brokerage Commission</div>
      <div className="g3"><Box label="Commission" value={formatCurrency(mb.commission)} /><Box label="HST" value={formatCurrency(mb.hst)} /><Box label="Total" value={formatCurrency(mb.total)} /></div>
    </>
  );
}

function Box({ label, value, brand }) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      <input value={value} readOnly className="numeric" style={brand ? { fontWeight: 700, color: 'var(--brand)', background: 'var(--brand-soft)', borderColor: '#fecaca' } : { fontWeight: 600 }} />
    </div>
  );
}

function Mini({ label, line, brand }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, background: '#fff' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: brand ? 'var(--brand)' : 'var(--text)', marginTop: 2 }}>{formatCurrency(line.total)}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{formatCurrency(line.commission)} + {formatCurrency(line.hst)} HST</div>
    </div>
  );
}
