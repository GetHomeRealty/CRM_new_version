import { useEffect, useState } from 'react';
import { updateTransaction, getAgentCommissions } from '../lib/api';
import { formatCurrency, parseNumber, isListingFinancialType, isPreconType } from './format';
import { agentAdjustments, referralSections, agentCommissionsAfterClient, agentCommissionLine, listingBreakdown } from './commissionCalc';
import { useToast } from './toast';

const HST = 0.13;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const clampPct = (n) => Math.max(0, Math.min(100, n));
const lineOf = (wo) => ({ commission: r2(wo), hst: r2(wo * HST), total: r2(wo * (1 + HST)) });
// Like lineOf, but the adjustment is subtracted from the Total only — Commission
// and HST stay at their gross values.
const lineLessTotal = (wo, deduct = 0) => ({ commission: r2(wo), hst: r2(wo * HST), total: r2(wo * (1 + HST) - deduct) });

// Itemize an agent's deduction breakdown (from agentAdjustments) into a label,
// e.g. "adjustment $300.00 + advance $200.00". Only non-zero parts are shown.
const ADJ_PARTS = [['agentAdjust', 'adjustment'], ['advance', 'advance']];
const adjLabel = (d) => ADJ_PARTS.filter(([k]) => d[k] > 0).map(([k, name]) => `${name} ${formatCurrency(d[k])}`).join(' + ');

// Commission-adjustment note (under Commission / Total). Positive = reduces (Less),
// negative = increases (Plus). `amt` is the signed value from a 'sub'-convention field.
const adjNote = (amt, when) => (amt === 0 ? null : `${amt > 0 ? 'Less' : 'Plus'} adjustment ${formatCurrency(Math.abs(amt))} (${when})`);

export default function FinancialModal({ open, onClose, transactionId, txn, termCount: termCountProp, onSaved }) {
  const toast = useToast();
  const listing = isListingFinancialType(txn.type);
  const precon = isPreconType(txn.type);
  const referral = txn.type === 'Referral';
  // Live term count from the detail form (so typing it divides immediately), falling back to the saved value.
  const termCount = (termCountProp != null && termCountProp !== '') ? Number(termCountProp) : (txn.precon_term_count || 0);

  const [price, setPrice] = useState(txn.price ?? 0);
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
  // Agent Comm (%) and Brok Comm (%) are complementary: editing one fills the
  // other with the remaining percentage (e.g. Agent 80 → Brokerage 20).
  const setMember = (i, k, v) => setMembers((ms) => ms.map((m, idx) => {
    if (idx !== i) return m;
    if (k === 'agent_pct') return { ...m, agent_pct: v, brok_pct: r2(clampPct(100 - parseNumber(v))) };
    if (k === 'brok_pct') return { ...m, brok_pct: v, agent_pct: r2(clampPct(100 - parseNumber(v))) };
    return { ...m, [k]: v };
  }));
  // Agent Comm (%) is locked by default per member (pencil unlocks); Brok Comm (%) stays locked.
  const [agentUnlock, setAgentUnlock] = useState({});
  const lockField = { background: '#f3f4f6', cursor: 'not-allowed' };

  // Each agent's registered default commission split (from their user profile).
  // Used to pre-fill Agent Comm (%) and to flag transaction-specific overrides.
  const leaseType = /lease/i.test(txn.type);
  const [agentDefaults, setAgentDefaults] = useState({});
  useEffect(() => { if (open) getAgentCommissions().then(setAgentDefaults).catch(() => {}); }, [open]);
  const defaultPctFor = (name) => {
    const d = agentDefaults[name];
    if (!d) return null;
    const v = leaseType ? (d.lease_pct ?? d.agent_pct) : d.agent_pct;
    return (v === null || v === undefined || v === '') ? null : parseNumber(v);
  };
  // For transactions not yet customised via Team Split, seed Agent Comm (%) from
  // the agent's registered default once it loads.
  const hadSavedTeam = !!(txn.team && txn.team.length);
  useEffect(() => {
    if (hadSavedTeam) return;
    setMembers((ms) => ms.map((m) => {
      const def = defaultPctFor(m.name);
      if (def === null) return m;
      return { ...m, agent_pct: def, brok_pct: r2(clampPct(100 - def)) };
    }));
  }, [agentDefaults]); // eslint-disable-line react-hooks/exhaustive-deps
  // Pre-HST per-agent deductions (Agent Adjust / Advance / referrals), aligned to members.
  const memberDeduct = agentAdjustments(txn.adjustments, members);

  // listing
  const [listPct, setListPct] = useState(txn.listing_comm_pct ?? '');
  const [coopPct, setCoopPct] = useState(txn.coop_comm_pct ?? '');
  const [commAdjMaster, setCommAdjMaster] = useState(!!(txn.listing_adj_enabled || txn.coop_adj_enabled));
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
  // Deal-level referrals: sections are computed from the full (pre-adjustment)
  // commission; broker referral still reduces the team-split base (which keeps the
  // commission adjustment), client referral comes off the deal Total only.
  const stdRef = referralSections(gross, txn.adjustments, HST);
  const stdSplitBase = r2(commWoHst - stdRef.brokerAmount);
  // "Agent Commissions after client referral" (off the standard commission), then
  // the per-member Agent Commission is capped against that section's Total.
  const stdAfterClient = agentCommissionsAfterClient(commWoHst, members, { minBrokComm: 200, adjBefore: adjB, adjAfter: adjA, clientReferral: stdRef.clientAmount }, HST);
  const stdRefView = { ...stdRef, afterClient: stdAfterClient };
  const stdAgentCtx = { acTotal: stdAfterClient.total, acComm: stdAfterClient.commission, minBrokComm: 200, adjBefore: adjB, adjAfter: adjA };
  const memberRows = members.map((m, i) => {
    const base = r2(stdSplitBase * (parseNumber(m.split) / 100));
    const brokWo = r2(base * (parseNumber(m.brok_pct) / 100));
    // Agent + T4A take Split % of the after-client-referral section Total; T4A is gross (no per-agent deduction).
    return { m, agent: agentCommissionLine(m, stdAgentCtx, memberDeduct[i].total, HST), brok: lineOf(brokWo), t4a: agentCommissionLine(m, stdAgentCtx, 0, HST), adj: memberDeduct[i] };
  });

  // ---- live listing computation (full client spec — mirrors CommissionService::breakdownListing) ----
  const lAdjEff = commAdjMaster && lAdjEn;
  const cAdjEff = commAdjMaster && cAdjEn;
  const listIsLease = /lease/i.test(txn.type);
  const listClientReferral = (txn.adjustments?.client_referral === 'Yes') ? (txn.adjustments.client_rows || []).reduce((s, r) => s + parseNumber(r.amount), 0) : 0;
  const listExtAmt = (txn.adjustments?.ext_referral === 'Yes') ? parseNumber(txn.adjustments.ext?.amount) : 0;
  const lb = listingBreakdown({
    price: parseNumber(price), deposit: txn.deposit,
    listPct, coopPct, listFlat: 0, coopFlat: 0,
    lAdjBefore: lAdjEff ? parseNumber(lBefore) : 0, lAdjAfter: lAdjEff ? parseNumber(lAfter) : 0,
    cAdjBefore: cAdjEff ? parseNumber(cBefore) : 0, cAdjAfter: cAdjEff ? parseNumber(cAfter) : 0,
    extAmt: listExtAmt, clientReferral: listClientReferral,
    members: members.map((m) => ({ name: m.name, split: m.split, agent_pct: m.agent_pct, brok_pct: m.brok_pct })),
    deductions: memberDeduct.map((d) => d.total), isLease: listIsLease, // Agent Adjust + Advance per member
  }, HST);
  // Deal-level agent split (spec uses one split for the listing pool); shown in the help line.
  const listAgentSplitPct = members[0]?.agent_pct ?? (listIsLease ? 95 : 90);
  // Referral sections are based on the (fixed) Listing Commission — the broker referral
  // only changes "Commissions after broker referral", never the Listing Commission itself.
  const listRef = referralSections(lb.listing.commission, txn.adjustments, HST);
  const listAfterClient = agentCommissionsAfterClient(lb.listing.commission, members, {
    minBrokComm: 499,
    adjBefore: lAdjEff ? parseNumber(lBefore) : 0,
    adjAfter: lAdjEff ? parseNumber(lAfter) : 0,
    clientReferral: listRef.clientAmount,
  }, HST);
  const listRefView = { ...listRef, afterClient: listAfterClient };
  // Reuse the Residential-Buying card design (AgentCommissionBlocks): Agent Commission =
  // payable (cash after advance), Agent (T4A) = gross earned, Brokerage = per-member keep.
  const listingRows = lb.members.map((mr, i) => ({
    m: members[i],
    agent: { commission: r2(mr.cashToPay / (1 + HST)), hst: r2(mr.cashToPay - mr.cashToPay / (1 + HST)), total: mr.cashToPay },
    t4a: { commission: mr.commission, hst: mr.hst, total: mr.earned },
    brok: { commission: r2(mr.brokerageFromMember / (1 + HST)), hst: r2(mr.brokerageFromMember - mr.brokerageFromMember / (1 + HST)), total: mr.brokerageFromMember },
    adj: memberDeduct[i], // { agentAdjust, advance, total } → "Less adjustment + advance" note
  }));
  // Agent/Brokerage % is a single deal-level split for listings — editing any card updates all members.
  const setListMember = (i, k, v) => {
    if (k === 'agent_pct') return setMembers((ms) => ms.map((m) => ({ ...m, agent_pct: v, brok_pct: r2(clampPct(100 - parseNumber(v))) })));
    if (k === 'brok_pct') return setMembers((ms) => ms.map((m) => ({ ...m, brok_pct: v, agent_pct: r2(clampPct(100 - parseNumber(v))) })));
    return setMember(i, k, v);
  };

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
          listing_adj_enabled: lAdjEff, listing_adj_before: lAdjEff ? parseNumber(lBefore) : 0, listing_adj_after: lAdjEff ? parseNumber(lAfter) : 0,
          coop_adj_enabled: cAdjEff, coop_adj_before: cAdjEff ? parseNumber(cBefore) : 0, coop_adj_after: cAdjEff ? parseNumber(cAfter) : 0,
          team: members.map((m, i) => ({ name: m.name, split: parseNumber(m.split), agent_pct: parseNumber(m.agent_pct), brok_pct: parseNumber(m.brok_pct), is_primary: i === 0, scope: m.scope, terms: m.terms })),
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
          <div className={referral ? '' : 'g2'}>
            <div className="field"><label>Price</label><input value={price} onChange={(e) => setPrice(e.target.value)} onBlur={(e) => setPrice(parseNumber(e.target.value))} /></div>
            {!referral && <div className="field"><label>Deposit</label><input value={txn.deposit ?? 0} readOnly style={{ background: '#f9fafb' }} /></div>}
          </div>
        )}

        {precon ? (
          <>
            <div className="modal-sub">Commission</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10, marginBottom: 14 }}>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission %</label><input type="number" value={masterPct} onChange={(e) => setMasterPct(e.target.value)} placeholder="e.g. 4" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission Amount</label><input value={masterAmtManual} onChange={(e) => setMasterAmtManual(e.target.value)} placeholder="0.00" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(mComm)} />{adjEnabled && adjB !== 0 && <div className="help" style={{ margin: '4px 0 0' }}>{adjNote(adjB, 'before HST')}</div>}</div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(mHst)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly className="brand" value={formatCurrency(mTotal)} />{adjEnabled && adjA !== 0 && <div className="help" style={{ margin: '4px 0 0' }}>{adjNote(adjA, 'after HST')}</div>}</div>
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
              const termDeduct = agentAdjustments(txn.adjustments, members, k); // term-scoped, aligned to members
              const locked = isLocked(k);
              const agentTermTotal = visible.reduce((s, { m, i }) => {
                const base = r2(tAmt * (parseNumber(m.split) / 100));
                return s + lineLessTotal(r2(base * parseNumber(m.agent_pct) / 100), termDeduct[i].total).total;
              }, 0);
              const brokTermTotal = visible.reduce((s, { m }) => {
                const base = r2(tAmt * (parseNumber(m.split) / 100));
                return s + lineOf(r2(base * parseNumber(m.brok_pct) / 100)).total;
              }, 0);
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

                  <div className="modal-sub" style={{ marginTop: 14 }}>Agent Commission — Term {k} <span style={{ color: 'var(--brand)' }}>({formatCurrency(agentTermTotal)})</span></div>
                  {visible.length === 0 ? <div className="help">No agents assigned to Term {k} (per Team Split scope).</div> : visible.map(({ m, i }) => {
                    const base = r2(tAmt * (parseNumber(m.split) / 100));
                    const a = lineLessTotal(r2(base * parseNumber(m.agent_pct) / 100), termDeduct[i].total);
                    return (
                      <div className="agent-comm-card" key={i}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>{(m.name || '').toUpperCase()}</strong><span className="pill info" style={{ fontSize: 10 }}>{m.split}% Split</span></div>
                          <strong style={{ color: 'var(--brand)' }}>{formatCurrency(a.total)}</strong>
                        </div>
                        <div className="g4">
                          <div className="field" style={{ marginBottom: 0 }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Agent Comm (%)
                              <button type="button" className="row-rm" style={{ color: 'var(--brand)', lineHeight: 1 }} title={agentUnlock[i] ? 'Lock Agent Comm %' : 'Unlock to edit Agent Comm %'} onClick={() => setAgentUnlock((u) => ({ ...u, [i]: !u[i] }))}>{agentUnlock[i] ? '🔓' : '✏'}</button>
                            </label>
                            <input type="number" value={m.agent_pct} readOnly={!agentUnlock[i]} style={!agentUnlock[i] ? lockField : undefined} onChange={(e) => setMember(i, 'agent_pct', e.target.value)} />
                          </div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(a.commission)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(a.hst)} /></div>
                          <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: 'var(--brand)' }} value={formatCurrency(a.total)} /></div>
                        </div>
                        {defaultPctFor(m.name) !== null && parseNumber(m.agent_pct) !== defaultPctFor(m.name) && (
                          <div className="help" style={{ margin: '6px 0 0', color: 'var(--brand)' }}>
                            This commission split applies only to this transaction; the agent’s main/default commission split is {defaultPctFor(m.name)}%.
                          </div>
                        )}
                        {termDeduct[i].total > 0 && <div className="help" style={{ margin: '6px 0 0' }}>Less {adjLabel(termDeduct[i])} = −{formatCurrency(termDeduct[i].total)} off total</div>}
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

                  <div className="modal-sub" style={{ borderLeftColor: '#7c3aed', color: '#5b21b6' }}>Brokerage Commission — Term {k} <span>({formatCurrency(brokTermTotal)})</span></div>
                  {visible.length === 0 ? <div className="help">No agents assigned to Term {k}.</div> : visible.map(({ m, i }) => {
                    const base = r2(tAmt * (parseNumber(m.split) / 100));
                    const b = lineOf(r2(base * parseNumber(m.brok_pct) / 100));
                    return (
                      <div className="brok-card" key={i}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><strong style={{ fontSize: 13 }}>{(m.name || '').toUpperCase()}</strong><span className="pill" style={{ background: '#f3e8ff', color: '#6b21a8', border: '1px solid #d8b4fe', fontSize: 10 }}>Split: {m.split}%</span></div>
                        <div className="g4">
                          <div className="field" style={{ marginBottom: 0 }}><label>Brok Comm (%) 🔒</label><input type="number" value={m.brok_pct} readOnly style={lockField} /></div>
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
                <SignedAdjField label="Adjustment (Before HST)" value={adjBefore} onChange={(nv) => excl(nv, setAdjBefore, adjAfter, setAdjAfter)} convention="sub" />
                <SignedAdjField label="Adjustment (After HST)" value={adjAfter} onChange={(nv) => excl(nv, setAdjAfter, adjBefore, setAdjBefore)} convention="sub" />
              </div>
            )}
          </>
        ) : listing ? (
          <>
            <div className="modal-sub">Listing Commission {lb.dealType === 'Lease' && <span className="pill type-pre" style={{ fontSize: 10 }}>Lease</span>}</div>
            <div className="g4">
              <div className="field" style={{ marginBottom: 0 }}><label>Listing Commission %</label><input value={listPct} onChange={(e) => setListPct(e.target.value)} placeholder="e.g. 2.5" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(lb.listing.commission)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(lb.listing.hst)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly className="brand" value={formatCurrency(lb.listing.total)} /></div>
            </div>
            <div className="modal-sub">Co-op Commission</div>
            <div className="g4">
              <div className="field" style={{ marginBottom: 0 }}><label>Co-op Commission %</label><input value={coopPct} onChange={(e) => setCoopPct(e.target.value)} placeholder="e.g. 2.5" /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(lb.coop.commission)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(lb.coop.hst)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly className="brand" value={formatCurrency(lb.coop.total)} /></div>
            </div>
            <div className="modal-sub">Total Commissions (Listing + Co-Op)</div>
            <div className="fin-sum"><Box label="Commission" value={formatCurrency(lb.totals.commission)} /><Box label="HST" value={formatCurrency(lb.totals.hst)} /><Box label="Total" value={formatCurrency(lb.totals.total)} brand /></div>

            <div className="modal-sub">Commission Adjustment</div>
            <div className="field" style={{ maxWidth: 220 }}>
              <label>Commission Adjustment</label>
              <select value={commAdjMaster ? 'Yes' : 'No'} onChange={(e) => setCommAdjMaster(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select>
            </div>
            {commAdjMaster && (
              <div className="g2">
                <div style={{ background: '#f9fafb', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                  <strong style={{ fontSize: 13 }}>Listing Commission Adjustment</strong>
                  <div className="field" style={{ marginTop: 10, marginBottom: lAdjEn ? 13 : 0 }}><label>Listing Comm Adjustment</label><select value={lAdjEn ? 'Yes' : 'No'} onChange={(e) => setLAdjEn(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select></div>
                  {lAdjEn && (
                    <div className="g2">
                      <SignedAdjField label="Adjustment (Before HST)" value={lBefore} onChange={(nv) => excl(nv, setLBefore, lAfter, setLAfter)} convention="add" />
                      <SignedAdjField label="Adjustment (After HST)" value={lAfter} onChange={(nv) => excl(nv, setLAfter, lBefore, setLBefore)} convention="add" />
                    </div>
                  )}
                </div>
                <div style={{ background: '#f9fafb', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                  <strong style={{ fontSize: 13 }}>Co-op Commission Adjustment</strong>
                  <div className="field" style={{ marginTop: 10, marginBottom: cAdjEn ? 13 : 0 }}><label>Co-op Comm Adjustment</label><select value={cAdjEn ? 'Yes' : 'No'} onChange={(e) => setCAdjEn(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select></div>
                  {cAdjEn && (
                    <div className="g2">
                      <SignedAdjField label="Adjustment (Before HST)" value={cBefore} onChange={(nv) => excl(nv, setCBefore, cAfter, setCAfter)} convention="add" />
                      <SignedAdjField label="Adjustment (After HST)" value={cAfter} onChange={(nv) => excl(nv, setCAfter, cBefore, setCBefore)} convention="add" />
                    </div>
                  )}
                </div>
              </div>
            )}

            <ReferralSections data={listRefView} />

            {/* Trust reconciliation */}
            <div className="modal-sub">Trust Reconciliation</div>
            <div className="fin-sum">
              <Box label="Deposit Held" value={formatCurrency(lb.trust.deposit)} />
              <Box label="Payable to Client" value={formatCurrency(lb.trust.payableToClient)} />
              <Box label="Receivable from Lawyer" value={formatCurrency(Math.abs(lb.trust.receivableFromLawyer))} brand />
            </div>

            {/* Co-op payout (external) */}
            <div className="modal-sub">Co-op Payout — External Brokerage</div>
            <div className="fin-sum">
              <Box label="Commission" value={formatCurrency(lb.coop.commission)} />
              <Box label="HST" value={formatCurrency(lb.coop.hst)} />
              <Box label="Total Paid Out" value={formatCurrency(lb.coopPayout)} brand />
            </div>

            {/* Listing Split / Members / Brokerage — Residential-Buying card design */}
            <AgentCommissionBlocks rows={listingRows} setMember={setListMember} minBrok={lb.minBrok} agentDefaults={agentDefaults} isLease={leaseType} />

            {/* Deal summary + balance check */}
            <div className="modal-sub">Listing Split Summary</div>
            <div className="fin-sum">
              <Box label="Agent Pool (with HST)" value={formatCurrency(lb.split.agentPool)} />
              <Box label="Brokerage Keep (with HST)" value={formatCurrency(lb.split.brokerageKeep)} brand />
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Balance Check</label>
                <input readOnly value={`${lb.balanceCheck.pass ? 'PASS' : 'FAIL'} — ${formatCurrency(lb.balanceCheck.reconcile)}`} style={{ fontWeight: 700, color: lb.balanceCheck.pass ? 'var(--ok)' : 'var(--bad)' }} />
              </div>
            </div>
            <span className="help">
              Agent split {listAgentSplitPct}% / brokerage {r2(100 - parseNumber(listAgentSplitPct))}% (edit via Agent Comm % above). Min brokerage floor {formatCurrency(lb.minBrok.total)}.
              {lb.clientReferral > 0 ? ` Client referral −${formatCurrency(lb.clientReferral)} shared across members.` : ''}
              {lb.extReferral.amount > 0 ? ` External broker referral −${formatCurrency(lb.extReferral.amount)} off listing side.` : ''}
              {' '}Referrals & advances are entered in the Adjustment modal.
            </span>
          </>
        ) : (
          /* ---- STANDARD (live, like the original) ---- */
          <>
            <div className="g2">
              <div className="field"><label>Commission %</label><input value={commPct} onChange={(e) => onPct(e.target.value)} placeholder="e.g. 5" /></div>
              <div className="field"><label>Commission Amount</label><input value={commAmt} onChange={(e) => onAmt(e.target.value)} placeholder="0.00" /></div>
            </div>
            <div className="fin-sum">
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input value={formatCurrency(commWoHst)} readOnly />{adjB !== 0 && <div className="help" style={{ margin: '4px 0 0' }}>{adjNote(adjB, 'before HST')}</div>}</div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input value={formatCurrency(stdHst)} readOnly /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input className="brand" value={formatCurrency(stdTotal)} readOnly />{adjA !== 0 && <div className="help" style={{ margin: '4px 0 0' }}>{adjNote(adjA, 'after HST')}</div>}</div>
            </div>

            <div className="field" style={{ maxWidth: 220 }}>
              <label>Commission Adjustment</label>
              <select value={adjEnabled ? 'Yes' : 'No'} onChange={(e) => setAdjEnabled(e.target.value === 'Yes')}><option>No</option><option>Yes</option></select>
            </div>
            {adjEnabled && (
              <div className="g2">
                <SignedAdjField label="Adjustment (Before HST)" value={adjBefore} onChange={(nv) => excl(nv, setAdjBefore, adjAfter, setAdjAfter)} convention="sub" />
                <SignedAdjField label="Adjustment (After HST)" value={adjAfter} onChange={(nv) => excl(nv, setAdjAfter, adjBefore, setAdjBefore)} convention="sub" />
              </div>
            )}

            <ReferralSections data={stdRefView} />
            <AgentCommissionBlocks rows={memberRows} setMember={setMember} minBrok={{ commission: 200, hst: 26, total: 226 }} agentDefaults={agentDefaults} isLease={leaseType} />
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

// Shared per-agent commission cards (Agent Commission / Agent T4A / Brokerage
// Commission + min-brokerage floor). Used by both the standard and listing
// variants so they render identically. `minBrok` carries the type-specific floor.
function AgentCommissionBlocks({ rows, setMember, minBrok, agentDefaults = {}, isLease = false }) {
  // Agent Comm (%) is locked by default (click the pencil to edit); Brok Comm (%)
  // is always locked — it auto-fills as the complement of Agent Comm.
  const [unlocked, setUnlocked] = useState({});
  const lockField = { background: '#f3f4f6', cursor: 'not-allowed' };
  const defOf = (name) => {
    const d = agentDefaults[name];
    if (!d) return null;
    const v = isLease ? (d.lease_pct ?? d.agent_pct) : d.agent_pct;
    return (v === null || v === undefined || v === '') ? null : Number(v);
  };
  const agentTotal = rows.reduce((s, r) => s + (r.agent?.total || 0), 0);
  const brokTotal = rows.reduce((s, r) => s + (r.brok?.total || 0), 0);
  return (
    <>
      <div className="modal-sub">Agent Commission <span style={{ color: 'var(--brand)' }}>({formatCurrency(agentTotal)})</span></div>
      {rows.length === 0 && <div className="help">No agents assigned — set the agent in Basic Info or use Team Split.</div>}
      {rows.map((r, i) => (
        <div className="agent-comm-card" key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>{(r.m.name || '').toUpperCase()}</strong><span className="pill info" style={{ fontSize: 10 }}>{r.m.split}% Split</span></div>
            <strong style={{ color: 'var(--brand)' }}>{formatCurrency(r.agent.total)}</strong>
          </div>
          <div className="g4">
            <div className="field" style={{ marginBottom: 0 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Agent Comm (%)
                <button type="button" className="row-rm" style={{ color: 'var(--brand)', lineHeight: 1 }} title={unlocked[i] ? 'Lock Agent Comm %' : 'Unlock to edit Agent Comm %'} onClick={() => setUnlocked((u) => ({ ...u, [i]: !u[i] }))}>{unlocked[i] ? '🔓' : '✏'}</button>
              </label>
              <input type="number" value={r.m.agent_pct} readOnly={!unlocked[i]} style={!unlocked[i] ? lockField : undefined} onChange={(e) => setMember(i, 'agent_pct', e.target.value)} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(r.agent.commission)} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(r.agent.hst)} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: 'var(--brand)' }} value={formatCurrency(r.agent.total)} /></div>
          </div>
          {defOf(r.m.name) !== null && parseNumber(r.m.agent_pct) !== defOf(r.m.name) && (
            <div className="help" style={{ margin: '6px 0 0', color: 'var(--brand)' }}>
              This commission split applies only to this transaction; the agent’s main/default commission split is {defOf(r.m.name)}%.
            </div>
          )}
          {r.adj.total > 0 && <div className="help" style={{ margin: '6px 0 0' }}>Less {adjLabel(r.adj)} = −{formatCurrency(r.adj.total)} off total</div>}
        </div>
      ))}

      {rows.length > 0 && (<>
        <div className="modal-sub">Agent (T4A)</div>
        {rows.map((r, i) => (
          <div className="t4a-card" key={i}>
            <strong style={{ fontSize: 13 }}>{(r.m.name || '').toUpperCase()}</strong>
            <div className="g3" style={{ marginTop: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(r.t4a.commission)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(r.t4a.hst)} /></div>
              <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700 }} value={formatCurrency(r.t4a.total)} /></div>
            </div>
          </div>
        ))}
      </>)}

      <div className="modal-sub" style={{ borderLeftColor: '#7c3aed', color: '#5b21b6' }}>Brokerage Commission <span>({formatCurrency(brokTotal)})</span></div>
      <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <strong style={{ fontSize: 12, color: '#5b21b6' }}>Minimum Brokerage Commission</strong>
        <div className="fin-sum" style={{ marginTop: 10, marginBottom: 0 }}>
          <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input value={formatCurrency(minBrok.commission)} readOnly /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input value={formatCurrency(minBrok.hst)} readOnly /></div>
          <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input value={formatCurrency(minBrok.total)} readOnly style={{ fontWeight: 700, color: '#5b21b6' }} /></div>
        </div>
      </div>
      {rows.map((r, i) => (
        <div className="brok-card" key={i}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><strong style={{ fontSize: 13 }}>{(r.m.name || '').toUpperCase()}</strong><span className="pill" style={{ background: '#f3e8ff', color: '#6b21a8', border: '1px solid #d8b4fe', fontSize: 10 }}>Split: {r.m.split}%</span></div>
          <div className="g4">
            <div className="field" style={{ marginBottom: 0 }}><label>Brok Comm (%) 🔒</label><input type="number" value={r.m.brok_pct} readOnly style={lockField} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Commission</label><input readOnly value={formatCurrency(r.brok.commission)} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>HST</label><input readOnly value={formatCurrency(r.brok.hst)} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Total</label><input readOnly style={{ fontWeight: 700, color: '#5b21b6' }} value={formatCurrency(r.brok.total)} /></div>
          </div>
        </div>
      ))}
    </>
  );
}

// Deal-level referral summary — "Commissions after broker referral" (external
// brokerage referral, off commission) and "Agent Commissions after client
// referral" (off Total). Shown only for the categories set to Yes in Adjustment.
function ReferralSections({ data }) {
  if (!data || (!data.showBroker && !data.showClient)) return null;
  return (
    <>
      <div className="modal-sub">Commissions</div>
      {data.showBroker && (
        <>
          <span className="pill info" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>Commissions after broker referral</span>
          <div className="fin-sum">
            <Box label="Commission without HST" value={formatCurrency(data.afterBroker.commission)} />
            <Box label="HST (13%)" value={formatCurrency(data.afterBroker.hst)} />
            <Box label="Total Commission (With HST)" value={formatCurrency(data.afterBroker.total)} brand />
          </div>
        </>
      )}
      {data.showClient && (
        <>
          <span className="pill ok" style={{ fontSize: 11, marginBottom: 8, display: 'inline-block' }}>Agent Commissions after client referral</span>
          <div className="fin-sum">
            <Box label="Commission Without HST" value={formatCurrency(data.afterClient.commission)} />
            <Box label="HST (13%)" value={formatCurrency(data.afterClient.hst)} />
            <Box label="Total Commission (With HST)" value={formatCurrency(data.afterClient.total)} brand />
          </div>
        </>
      )}
    </>
  );
}

// Adjustment input with a +/− sign toggle. "+" increases the commission, "−"
// decreases it. The stored value is signed to match the formula convention:
//   'sub'  → commission − value  (so "−" stores +mag, "+" stores −mag)
//   'add'  → commission + value  (so "+" stores +mag, "−" stores −mag)
function SignedAdjField({ label, value, onChange, convention = 'sub' }) {
  const signOf = (n) => (n === 0 ? null : (convention === 'sub' ? (n > 0 ? '-' : '+') : (n < 0 ? '-' : '+')));
  const [sign, setSign] = useState(signOf(parseNumber(value)) || '-');
  const [mag, setMag] = useState(() => { const n = parseNumber(value); return n === 0 ? '' : String(Math.abs(n)); });

  // Re-sync from the parent when the magnitude actually changes elsewhere (e.g. the
  // mutually-exclusive sibling field clears this one) — but don't fight live typing.
  useEffect(() => {
    const n = parseNumber(value);
    if (Math.abs(n) !== Math.abs(parseNumber(mag))) setMag(n === 0 ? '' : String(Math.abs(n)));
    const s = signOf(n);
    if (s) setSign(s);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const stored = (s, m) => { const mm = Math.abs(parseNumber(m)); return convention === 'sub' ? (s === '-' ? mm : -mm) : (s === '-' ? -mm : mm); };
  const pickSign = (s) => { setSign(s); onChange(stored(s, mag)); };
  const onMag = (m) => { setMag(m); onChange(stored(sign, m)); };

  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <div className="seg-toggle" style={{ flex: '0 0 auto' }}>
          <button type="button" className={`seg-btn ${sign === '+' ? 'active' : ''}`} onClick={() => pickSign('+')} title="Increase commission">+</button>
          <button type="button" className={`seg-btn ${sign === '-' ? 'active' : ''}`} onClick={() => pickSign('-')} title="Decrease commission">−</button>
        </div>
        <input value={mag} onChange={(e) => onMag(e.target.value)} placeholder="0.00" style={{ flex: 1 }} />
      </div>
    </div>
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
