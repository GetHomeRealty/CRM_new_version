import { useEffect, useState } from 'react';
import { updateTransaction } from '../lib/api';
import { formatCurrency, parseNumber, isListingType, isPreconType } from './format';
import { useToast } from './toast';

const HST = 0.13;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const lineOf = (wo) => ({ commission: r2(wo), hst: r2(wo * HST), total: r2(wo * (1 + HST)) });

export default function FinancialModal({ open, onClose, transactionId, txn, termCount: termCountProp, onSaved }) {
  const toast = useToast();
  const listing = isListingType(txn.type);
  const precon = isPreconType(txn.type);
  // Live term count from the detail form (so typing it divides immediately), falling back to the saved value.
  const termCount = (termCountProp != null && termCountProp !== '') ? Number(termCountProp) : (txn.precon_term_count || 0);

  const [price, setPrice] = useState(txn.price ?? 0);
  const [fin, setFin] = useState(txn.financial || null);
  const [saving, setSaving] = useState(false);

  // standard
  const [commPct, setCommPct] = useState(txn.comm_pct ?? (txn.comm_type === '%' ? txn.comm_value : '') ?? '');
  const [commAmt, setCommAmt] = useState(txn.comm_amt ?? '');
  const [adjEnabled, setAdjEnabled] = useState(!!txn.comm_adjust_enabled);
  const [adjBefore, setAdjBefore] = useState(txn.comm_adjust_before ?? 0);
  const [adjAfter, setAdjAfter] = useState(txn.comm_adjust_after ?? 0);
  const [members, setMembers] = useState(() => {
    const t = (txn.team && txn.team.length) ? txn.team : (txn.agent ? [{ name: txn.agent, split: 100, agent_pct: 90, brok_pct: 10 }] : []);
    return t.map((m) => ({ name: m.name, split: m.split ?? 100, agent_pct: m.agent_pct ?? 90, brok_pct: m.brok_pct ?? 10, scope: m.scope || 'Entire', terms: m.terms || [] }));
  });
  const setMember = (i, k, v) => setMembers((ms) => ms.map((m, idx) => idx === i ? { ...m, [k]: v } : m));

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

  // Auto-divide: resize the term list whenever the term count changes (preserving entered values).
  useEffect(() => {
    setPTerms((prev) => Array.from({ length: termCount }, (_, k) => prev[k] || { term_no: k + 1, pct: '', closing_date: '' }));
  }, [termCount]);

  const [masterAmtManual, setMasterAmtManual] = useState(txn.precon_comm_amt_manual ?? '');
  const [detailsOfTerms, setDetailsOfTerms] = useState(txn.precon_details_of_terms || 'Entire');
  const [termLocks, setTermLocks] = useState({});
  const isLocked = (k) => (termLocks[k] === undefined ? true : termLocks[k]);
  const toggleLock = (k) => setTermLocks((l) => ({ ...l, [k]: !isLocked(k) }));

  if (!open) return null;

  const onPct = (v) => { setCommPct(v); if (v) setCommAmt(''); };
  const onAmt = (v) => { setCommAmt(v); if (v) setCommPct(''); };
  const excl = (v, setThis, other, setOther) => { setThis(v); if (parseNumber(v) !== 0) setOther(0); };

  // ---- live standard computation ----
  const gross = parseNumber(commAmt) > 0 ? parseNumber(commAmt) : (parseNumber(commPct) > 0 ? parseNumber(price) * parseNumber(commPct) / 100 : 0);
  const adjB = adjEnabled ? parseNumber(adjBefore) : 0;
  const adjA = adjEnabled ? parseNumber(adjAfter) : 0;
  const commWoHst = r2(gross - adjB);
  const stdHst = r2(commWoHst * HST);
  const stdTotal = r2(commWoHst + stdHst - adjA);
  const memberRows = members.map((m) => {
    const base = r2(commWoHst * (parseNumber(m.split) / 100));
    const agentWo = r2(base * (parseNumber(m.agent_pct) / 100));
    const brokWo = r2(base * (parseNumber(m.brok_pct) / 100));
    return { m, agent: lineOf(agentWo), brok: lineOf(brokWo), t4a: lineOf(agentWo) };
  });

  // ---- live preconstruction master computation ----
  const pMasterAmt = parseNumber(masterAmtManual) > 0 ? parseNumber(masterAmtManual) : (parseNumber(masterPct) > 0 ? parseNumber(price) * parseNumber(masterPct) / 100 : 0);
  let mComm, mHst, mTotal;
  if (netHst) { mComm = r2(pMasterAmt / 1.13); mHst = r2(pMasterAmt - mComm); mTotal = pMasterAmt; }
  else { mComm = pMasterAmt; mHst = r2(pMasterAmt * HST); mTotal = r2(pMasterAmt + mHst); }
  if (adjEnabled) {
    if (adjB !== 0) { mComm = r2(mComm - adjB); mHst = r2(mComm * HST); mTotal = r2(mComm + mHst); }
    if (adjA !== 0) { mTotal = r2(mTotal - adjA); }
  }
  const preconSumPct = pTerms.reduce((s, t) => s + parseNumber(t.pct), 0);
  const preconTermsValid = parseNumber(masterPct) <= 0 ? true : preconSumPct <= parseNumber(masterPct) + 1e-9;
  const visibleAtTerm = (k) => members.map((m, i) => ({ m, i })).filter(({ m }) => (m.scope || 'Entire') === 'Entire' || (m.terms || []).map(Number).includes(k));

  const save = async () => {
    const payload = precon
      ? {
          price: parseNumber(price), precon_net_of_hst: netHst,
          precon_term_count: termCount || null,
          precon_comm_pct: masterPct === '' ? null : parseNumber(masterPct),
          precon_comm_amt_manual: masterAmtManual === '' ? null : parseNumber(masterAmtManual),
          precon_details_of_terms: detailsOfTerms,
          comm_adjust_enabled: adjEnabled, comm_adjust_before: adjEnabled ? parseNumber(adjBefore) : 0, comm_adjust_after: adjEnabled ? parseNumber(adjAfter) : 0,
          precon_terms: pTerms.map((t) => ({ term_no: t.term_no, pct: t.pct === '' ? null : parseNumber(t.pct), closing_date: t.closing_date || null })),
          team: members.map((m, i) => ({ name: m.name, split: parseNumber(m.split), agent_pct: parseNumber(m.agent_pct), brok_pct: parseNumber(m.brok_pct), is_primary: i === 0, scope: m.scope, terms: m.terms })),
        }
      : listing
      ? {
          price: parseNumber(price),
          listing_comm_pct: listPct === '' ? null : parseNumber(listPct), coop_comm_pct: coopPct === '' ? null : parseNumber(coopPct),
          listing_adj_enabled: lAdjEn, listing_adj_before: lAdjEn ? parseNumber(lBefore) : 0, listing_adj_after: lAdjEn ? parseNumber(lAfter) : 0,
          coop_adj_enabled: cAdjEn, coop_adj_before: cAdjEn ? parseNumber(cBefore) : 0, coop_adj_after: cAdjEn ? parseNumber(cAfter) : 0,
        }
      : {
          price: parseNumber(price),
          comm_pct: commPct === '' ? null : parseNumber(commPct), comm_amt: commAmt === '' ? null : parseNumber(commAmt),
          comm_adjust_enabled: adjEnabled, comm_adjust_before: adjEnabled ? parseNumber(adjBefore) : 0, comm_adjust_after: adjEnabled ? parseNumber(adjAfter) : 0,
          team: members.map((m, i) => ({ name: m.name, split: parseNumber(m.split), agent_pct: parseNumber(m.agent_pct), brok_pct: parseNumber(m.brok_pct), is_primary: i === 0, scope: m.scope, terms: m.terms })),
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
        <div className="modal-h">Financial Information {listing && <span className="pill type-res-sell" style={{ fontSize: 10 }}>Listing</span>}{precon && <span className="pill type-pre" style={{ fontSize: 10 }}>Preconstruction</span>}</div>

        {precon ? (
          <div className="g3">
            <div className="field"><label>Price</label><input value={price} onChange={(e) => setPrice(e.target.value)} onBlur={(e) => setPrice(parseNumber(e.target.value))} /></div>
            <div className="field"><label>NET of HST</label><select value={netHst ? 'Yes' : 'No'} onChange={(e) => setNetHst(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select></div>
            <div className="field"><label>Deposit</label><input value={txn.deposit ?? 0} readOnly style={{ background: '#f9fafb' }} /></div>
          </div>
        ) : (
          <div className="g2">
            <div className="field"><label>Price</label><input value={price} onChange={(e) => setPrice(e.target.value)} onBlur={(e) => setPrice(parseNumber(e.target.value))} /></div>
            <div className="field"><label>Deposit</label><input value={txn.deposit ?? 0} readOnly style={{ background: '#f9fafb' }} /></div>
          </div>
        )}

        {precon ? (
          <>
            <div className="modal-sub">Commission</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10, marginBottom: 14 }}>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission %</label><input type="number" value={masterPct} onChange={(e) => setMasterPct(e.target.value)} placeholder="e.g. 4" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission Amount</label><input value={masterAmtManual} onChange={(e) => setMasterAmtManual(e.target.value)} placeholder="0.00" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(mComm)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(mHst)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly className="brand" value={formatCurrency(mTotal)} /></div>
            </div>

            <div className="modal-sub">Commission Structure</div>
            <div className="field" style={{ maxWidth: 240 }}><label>Show</label>
              <select value={detailsOfTerms} onChange={(e) => setDetailsOfTerms(e.target.value)}>
                <option value="Entire">Entire</option>
                {Array.from({ length: termCount }, (_, k) => <option key={k} value={`Term ${k + 1}`}>Term {k + 1}</option>)}
              </select>
            </div>
            {termCount === 0 && <div className="help">Set "Commission Receivable in Terms" in Preconstruction Details first, then reopen Financial.</div>}

            {pTerms.map((t, idx) => {
              const k = idx + 1;
              if (detailsOfTerms !== 'Entire' && detailsOfTerms !== `Term ${k}`) return null;
              const tAmt = r2(parseNumber(price) * parseNumber(t.pct) / 100);
              const tHst = r2(tAmt * HST);
              const tTotal = netHst ? tAmt : r2(tAmt + tHst);
              const visible = visibleAtTerm(k);
              const locked = isLocked(k);
              return (
                <div key={k} style={{ background: '#f9fafb', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <strong>Term {k}</strong>
                    <button type="button" className="btn ghost sm" style={{ padding: '4px 8px', lineHeight: 1 }} title={locked ? 'Unlock to edit Commission %' : 'Lock Commission %'} onClick={() => toggleLock(k)}>{locked ? '✏' : '🔒'}</button>
                  </div>
                  <div className="g4">
                    <div className="field" style={{ marginBottom: 0 }}><label>Commission %</label><input type="number" value={t.pct} readOnly={locked} style={locked ? { background: '#f3f4f6', cursor: 'not-allowed' } : undefined} onChange={(e) => setTerm(idx, 'pct', e.target.value)} /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(tAmt)} /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(tHst)} /></div>
                    <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly className="brand" value={formatCurrency(tTotal)} /></div>
                  </div>

                  <div className="modal-sub" style={{ marginTop: 14 }}>Agent Commission — Term {k}</div>
                  {visible.length === 0 ? <div className="help">No agents assigned to Term {k} (per Team Split scope).</div> : visible.map(({ m, i }) => {
                    const base = r2(tAmt * (parseNumber(m.split) / 100));
                    const a = lineOf(r2(base * parseNumber(m.agent_pct) / 100));
                    return (
                      <div className="agent-comm-card" key={i}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>{(m.name || '').toUpperCase()}</strong><span className="pill info" style={{ fontSize: 10 }}>{m.split}% Split</span></div>
                          <strong style={{ color: 'var(--brand)' }}>{formatCurrency(a.total)}</strong>
                        </div>
                        <div className="g4">
                          <div className="field" style={{ marginBottom: 0 }}><label>Agent Comm (%)</label><input type="number" value={m.agent_pct} onChange={(e) => setMember(i, 'agent_pct', e.target.value)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(a.commission)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(a.hst)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: 'var(--brand)' }} value={formatCurrency(a.total)} /></div>
                        </div>
                      </div>
                    );
                  })}

                  <div className="modal-sub">Agent (T4A) — Term {k}</div>
                  {visible.length === 0 ? <div className="help">No agents assigned to Term {k}.</div> : visible.map(({ m, i }) => {
                    const base = r2(tAmt * (parseNumber(m.split) / 100));
                    const a = lineOf(r2(base * parseNumber(m.agent_pct) / 100));
                    return (
                      <div className="t4a-card" key={i}>
                        <strong style={{ fontSize: 13 }}>{(m.name || '').toUpperCase()}</strong>
                        <div className="g3" style={{ marginTop: 10 }}>
                          <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(a.commission)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(a.hst)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700 }} value={formatCurrency(a.total)} /></div>
                        </div>
                      </div>
                    );
                  })}

                  <div className="modal-sub" style={{ borderLeftColor: '#7c3aed', color: '#5b21b6' }}>Brokerage Commission — Term {k}</div>
                  {visible.length === 0 ? <div className="help">No agents assigned to Term {k}.</div> : visible.map(({ m, i }) => {
                    const base = r2(tAmt * (parseNumber(m.split) / 100));
                    const b = lineOf(r2(base * parseNumber(m.brok_pct) / 100));
                    return (
                      <div className="brok-card" key={i}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><strong style={{ fontSize: 13 }}>{(m.name || '').toUpperCase()}</strong><span className="pill" style={{ background: '#f3e8ff', color: '#6b21a8', border: '1px solid #d8b4fe', fontSize: 10 }}>Split: {m.split}%</span></div>
                        <div className="g4">
                          <div className="field" style={{ marginBottom: 0 }}><label>Brok Comm (%)</label><input type="number" value={m.brok_pct} onChange={(e) => setMember(i, 'brok_pct', e.target.value)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(b.commission)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(b.hst)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: '#5b21b6' }} value={formatCurrency(b.total)} /></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {!preconTermsValid && <div style={{ color: 'var(--bad)', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>⚠ Sum of term % exceeds the master Commission %.</div>}

            <div className="modal-sub">Commission Adjustment</div>
            <div className="field" style={{ maxWidth: 220 }}><label>Commission Adjustment</label><select value={adjEnabled ? 'Yes' : 'No'} onChange={(e) => setAdjEnabled(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select></div>
            {adjEnabled && (
              <div className="g2">
                <div className="field"><label>Adjustment (Before HST)</label><input value={adjBefore} onChange={(e) => excl(e.target.value, setAdjBefore, adjAfter, setAdjAfter)} /></div>
                <div className="field"><label>Adjustment (After HST)</label><input value={adjAfter} onChange={(e) => excl(e.target.value, setAdjAfter, adjBefore, setAdjBefore)} /></div>
              </div>
            )}
          </>
        ) : listing ? (
          <>
            <div className="g2">
              <AdjSide title="Listing Commission" pct={listPct} setPct={setListPct} en={lAdjEn} setEn={setLAdjEn} before={lBefore} after={lAfter} setBefore={(v) => excl(v, setLBefore, lAfter, setLAfter)} setAfter={(v) => excl(v, setLAfter, lBefore, setLBefore)} />
              <AdjSide title="Co-op Commission" pct={coopPct} setPct={setCoopPct} en={cAdjEn} setEn={setCAdjEn} before={cBefore} after={cAfter} setBefore={(v) => excl(v, setCBefore, cAfter, setCAfter)} setAfter={(v) => excl(v, setCAfter, cBefore, setCBefore)} />
            </div>
            <div style={{ textAlign: 'right', marginBottom: 8 }}><button className="btn primary sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save & Recalculate'}</button></div>
            {fin && fin.variant === 'listing' && (<>
              <div className="modal-sub">Listing Commission</div>
              <div className="fin-sum"><Box label="Commission" value={formatCurrency(fin.listing.commission)} /><Box label="HST" value={formatCurrency(fin.listing.hst)} /><Box label="Total" value={formatCurrency(fin.listing.total)} brand /></div>
              <div className="modal-sub">Co-op Commission</div>
              <div className="fin-sum"><Box label="Commission" value={formatCurrency(fin.coop.commission)} /><Box label="HST" value={formatCurrency(fin.coop.hst)} /><Box label="Total" value={formatCurrency(fin.coop.total)} brand /></div>
              <div className="modal-sub">Total Commissions (Listing + Co-op)</div>
              <div className="fin-sum"><Box label="Commission" value={formatCurrency(fin.totals.commission)} /><Box label="HST" value={formatCurrency(fin.totals.hst)} /><Box label="Total" value={formatCurrency(fin.totals.total)} brand /></div>
              <AgentCards agents={fin.agents} />
              <MinBrok mb={fin.min_brokerage} />
            </>)}
          </>
        ) : (
          /* ---- STANDARD (live, like the original) ---- */
          <>
            <div className="g2">
              <div className="field"><label>Commission %</label><input value={commPct} onChange={(e) => onPct(e.target.value)} placeholder="e.g. 5" /></div>
              <div className="field"><label>Commission Amount</label><input value={commAmt} onChange={(e) => onAmt(e.target.value)} placeholder="0.00" /></div>
            </div>
            <div className="fin-sum">
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input value={formatCurrency(commWoHst)} readOnly /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input value={formatCurrency(stdHst)} readOnly /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input className="brand" value={formatCurrency(stdTotal)} readOnly /></div>
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

            <div className="modal-sub">Agent Commission</div>
            {memberRows.length === 0 && <div className="help">No agents assigned — set the agent in Basic Info or use Team Split.</div>}
            {memberRows.map((r, i) => (
              <div className="agent-comm-card" key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>{(r.m.name || '').toUpperCase()}</strong><span className="pill info" style={{ fontSize: 10 }}>{r.m.split}% Split</span></div>
                  <strong style={{ color: 'var(--brand)' }}>{formatCurrency(r.agent.total)}</strong>
                </div>
                <div className="g4">
                  <div className="field" style={{ marginBottom: 0 }}><label>Agent Comm (%)</label><input type="number" value={r.m.agent_pct} onChange={(e) => setMember(i, 'agent_pct', e.target.value)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(r.agent.commission)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(r.agent.hst)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: 'var(--brand)' }} value={formatCurrency(r.agent.total)} /></div>
                </div>
              </div>
            ))}

            {memberRows.length > 0 && <><div className="modal-sub">Agent (T4A)</div>
            {memberRows.map((r, i) => (
              <div className="t4a-card" key={i}>
                <strong style={{ fontSize: 13 }}>{(r.m.name || '').toUpperCase()}</strong>
                <div className="g3" style={{ marginTop: 10 }}>
                  <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(r.t4a.commission)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(r.t4a.hst)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700 }} value={formatCurrency(r.t4a.total)} /></div>
                </div>
              </div>
            ))}</>}

            <div className="modal-sub" style={{ borderLeftColor: '#7c3aed', color: '#5b21b6' }}>Brokerage Commission</div>
            <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <strong style={{ fontSize: 12, color: '#5b21b6' }}>Minimum Brokerage Commission</strong>
              <div className="fin-sum" style={{ marginTop: 10, marginBottom: 0 }}>
                <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input value="$200.00" readOnly /></div>
                <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input value="$26.00" readOnly /></div>
                <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input value="$226.00" readOnly style={{ fontWeight: 700, color: '#5b21b6' }} /></div>
              </div>
            </div>
            {memberRows.map((r, i) => (
              <div className="brok-card" key={i}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><strong style={{ fontSize: 13 }}>{(r.m.name || '').toUpperCase()}</strong><span className="pill" style={{ background: '#f3e8ff', color: '#6b21a8', border: '1px solid #d8b4fe', fontSize: 10 }}>Split: {r.m.split}%</span></div>
                <div className="g4">
                  <div className="field" style={{ marginBottom: 0 }}><label>Brok Comm (%)</label><input type="number" value={r.m.brok_pct} onChange={(e) => setMember(i, 'brok_pct', e.target.value)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(r.brok.commission)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(r.brok.hst)} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: '#5b21b6' }} value={formatCurrency(r.brok.total)} /></div>
                </div>
              </div>
            ))}
          </>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
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
        <div className="agent-comm-card" key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong>{a.name?.toUpperCase()}</strong>
            <span className="pill info" style={{ fontSize: 10 }}>{a.split}% split · agent {a.agent_pct}% · brok {a.brok_pct}%</span>
          </div>
          <div className="g3"><Mini label="Agent" line={a.agent} brand /><Mini label="Brokerage" line={a.brokerage} /><Mini label="T4A" line={a.t4a} /></div>
        </div>
      ))}
    </>
  );
}

function MinBrok({ mb }) {
  return (
    <>
      <div className="modal-sub" style={{ borderLeftColor: '#7c3aed', color: '#5b21b6' }}>Minimum Brokerage Commission</div>
      <div className="fin-sum"><Box label="Commission" value={formatCurrency(mb.commission)} /><Box label="HST" value={formatCurrency(mb.hst)} /><Box label="Total" value={formatCurrency(mb.total)} /></div>
    </>
  );
}

function Box({ label, value, brand }) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      <input value={value} readOnly className={brand ? 'brand' : ''} />
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
