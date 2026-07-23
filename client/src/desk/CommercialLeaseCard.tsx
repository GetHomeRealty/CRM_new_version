import type { CSSProperties, InputHTMLAttributes, ReactNode } from 'react';
import { formatCurrency } from './format';

// Commercial Lease calculator — Lease Structure, Rent & Escalation, Rent Schedule,
// and Multi-Year Commission Calculator. Inputs persist in the transaction's
// `commercial_lease` JSON column; the schedule & commission tables are derived here.
// Shown only for commercial lease types (additive — no other type is affected).

export const CL_DEFAULTS = {
  lease_start_date: '2026-06-01',
  lease_term_years: 5,
  lease_type: 'Triple Net (NNN)',
  leasable_area: 2500,
  possession_date: '',
  free_rent_months: 0,
  base_annual_rent: 60000,
  escalation_type: 'Fixed % per Year',
  escalation_rate: 3,
  tmi_cam: 12,
  commission_method: 'Tiered Fixed (Yr1/Yr2-5/Yr6+)',
  primary_rate: 5,
  tier_rates: '6/3/2',
  payment_trigger: 'Lump sum at lease execution',
};

const lbl: CSSProperties = { fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600, marginBottom: 5, display: 'block' };
const num = (v: unknown, d = 0) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : d; };
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const parseDate = (s: unknown): Date | null => (s ? new Date(String(s) + 'T00:00:00') : null);
const fmtDate = (d: Date | null): string => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '—');
const addYears = (d: Date, y: number) => { const x = new Date(d); x.setFullYear(x.getFullYear() + y); return x; };
const minusDay = (d: Date) => { const x = new Date(d); x.setDate(x.getDate() - 1); return x; };

// Per-year escalated base rent (contractual), before any free-rent reduction.
function escalatedRent(base: number, rate: number, type: unknown, year: number): number {
  const y = year - 1;
  switch (type) {
    case 'Fixed $ Increase per Year': return base + rate * y;
    case 'CPI-Based (~2.5%)': return base * Math.pow(1.025, y);
    case 'No Escalation': return base;
    case 'Stepped (Custom)': // best-effort: treat as fixed % steps
    case 'Fixed % per Year':
    default: return base * Math.pow(1 + rate / 100, y);
  }
}

// Tier rate (%) applied to a given year for the chosen commission method.
function tierForYear(method: unknown, year: number, primary: number, tiers: number[]): number {
  if (method === '% of Aggregate Base Rent' || method === '% of Year-1 Rent only') return primary;
  if (method === 'Tiered Fixed (Yr1/Yr2-5/Yr6+)') {
    const [t1 = primary, t2 = primary, t3 = primary] = tiers;
    if (year === 1) return t1;
    if (year <= 5) return t2;
    return t3;
  }
  if (method === 'Custom % Per Year') return tiers[year - 1] ?? tiers[tiers.length - 1] ?? primary;
  return primary;
}

interface RentRow { y: number; period: string; base: number; contractRent: number; escalation: number; tmi: number; total: number; monthly: number; }
interface CommRow { y: number | string; base: number; rate: string; earned: number; cum: number; }

interface CommercialLeaseCardProps {
  cl: Record<string, unknown>;
  setCl: (k: string, v: unknown) => void;
  ro: boolean;
}

export default function CommercialLeaseCard({ cl, setCl, ro }: CommercialLeaseCardProps) {
  const term = Math.max(1, Math.min(25, parseInt(String(cl.lease_term_years), 10) || 1));
  const start = parseDate(cl.lease_start_date);
  const area = num(cl.leasable_area);
  const baseAnnual = num(cl.base_annual_rent);
  const escRate = num(cl.escalation_rate);
  const escType = cl.escalation_type;
  const tmiPerSqft = num(cl.tmi_cam);
  const freeMonths = num(cl.free_rent_months);
  const method = cl.commission_method;
  const primary = num(cl.primary_rate);
  const tiers = String(cl.tier_rates || '').split(/[\/,]/).map((s) => num(s)).filter((n) => !Number.isNaN(n));

  const endDate = start ? fmtDate(minusDay(addYears(start, term))) : '—';
  const baseMonthly = baseAnnual / 12;
  const rentPerSqft = area > 0 ? baseAnnual / area : 0;
  const tmiAnnual = tmiPerSqft * area;

  // Year-by-year rent schedule
  const rows: RentRow[] = [];
  let prevRent = 0, aggBase = 0, aggTmi = 0, aggTotal = 0;
  for (let y = 1; y <= term; y++) {
    let rent = escalatedRent(baseAnnual, escRate, escType, y);
    const contractRent = rent;
    const escalation = y === 1 ? 0 : rent - prevRent;
    prevRent = rent;
    // Free rent reduces Year-1 collected base rent.
    if (y === 1 && freeMonths > 0) rent = rent * Math.max(0, 12 - freeMonths) / 12;
    const totalAnnual = rent + tmiAnnual;
    const pStart = addYears(start || new Date(), y - 1);
    const pEnd = minusDay(addYears(start || new Date(), y));
    rows.push({
      y,
      period: start ? `${fmtDate(pStart)} → ${fmtDate(pEnd)}` : `Year ${y}`,
      base: rent, contractRent, escalation, tmi: tmiAnnual, total: totalAnnual, monthly: totalAnnual / 12,
    });
    aggBase += rent; aggTmi += tmiAnnual; aggTotal += totalAnnual;
  }

  // Multi-year commission calculator
  const commRows: CommRow[] = [];
  let cumulative = 0, netComm = 0;
  if (method === '$ per Sq Ft') {
    netComm = primary * area;
    commRows.push({ y: '—', base: 0, rate: `$${primary}/sqft × ${area}`, earned: netComm, cum: netComm });
  } else if (method === 'Flat Fee ($)') {
    netComm = primary;
    commRows.push({ y: '—', base: 0, rate: 'Flat', earned: netComm, cum: netComm });
  } else {
    for (let y = 1; y <= term; y++) {
      const yearBase = rows[y - 1].contractRent;
      let rate = tierForYear(method, y, primary, tiers);
      let earned = yearBase * rate / 100;
      if (method === '% of Year-1 Rent only' && y > 1) { rate = 0; earned = 0; }
      cumulative += earned;
      commRows.push({ y, base: yearBase, rate: `${rate}%`, earned, cum: cumulative });
    }
    netComm = cumulative;
  }

  const field = (label: ReactNode, key: string, props: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="field" style={{ marginBottom: 0 }}>
      <label style={lbl}>{label}</label>
      <input value={String(cl[key] ?? '')} disabled={ro} onChange={(e) => setCl(key, e.target.value)} {...props} />
    </div>
  );
  const select = (label: ReactNode, key: string, options: string[]) => (
    <div className="field" style={{ marginBottom: 0 }}>
      <label style={lbl}>{label}</label>
      <select value={String(cl[key] ?? '')} disabled={ro} onChange={(e) => setCl(key, e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
  const ros = { readOnly: true, style: { background: '#f9fafb' } };

  return (
    <div className="card">
      <div className="modal-h" style={{ fontSize: 14 }}>Commercial Lease — Structure, Rent &amp; Commission</div>
      <div className="help" style={{ marginBottom: 12 }}>
        Lease structure, rent &amp; escalation, the year-by-year schedule and the commission calculator are shown for this transaction type.
      </div>

      {/* 6.1 Lease Term & Structure */}
      <div className="modal-sub" style={{ marginTop: 0 }}>Lease Term &amp; Structure</div>
      <div className="g3">
        {field('Lease Start Date', 'lease_start_date', { type: 'date' })}
        {field('Lease Term (years)', 'lease_term_years', { type: 'number', min: 1, max: 25 })}
        <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Lease End Date (auto)</label><input value={endDate} {...ros} /></div>
      </div>
      <div className="g3" style={{ marginTop: 8 }}>
        {select('Lease Type', 'lease_type', ['Gross', 'Net', 'Double Net (NN)', 'Triple Net (NNN)', 'Modified Gross', 'Percentage Lease'])}
        {field('Leasable Area (sq ft)', 'leasable_area', { type: 'number', min: 0 })}
        {field('Possession Date', 'possession_date', { type: 'date' })}
      </div>
      <div className="g3" style={{ marginTop: 8 }}>
        {field('Fixturing / Free Rent (months)', 'free_rent_months', { type: 'number', min: 0 })}
      </div>

      {/* 6.2 Rent & Annual Escalation */}
      <div className="modal-sub">Rent &amp; Annual Escalation</div>
      <div className="g3">
        {field('Base Year Annual Rent ($)', 'base_annual_rent', { type: 'number', min: 0 })}
        <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Base Monthly Rent (auto)</label><input value={formatCurrency(r2(baseMonthly))} {...ros} /></div>
        <div className="field" style={{ marginBottom: 0 }}><label style={lbl}>Rent / Sq Ft / Year (auto)</label><input value={formatCurrency(r2(rentPerSqft))} {...ros} /></div>
      </div>
      <div className="g3" style={{ marginTop: 8 }}>
        {select('Escalation Type', 'escalation_type', ['Fixed % per Year', 'Fixed $ Increase per Year', 'Stepped (Custom)', 'CPI-Based (~2.5%)', 'No Escalation'])}
        {field('Escalation Rate (%/yr or $/yr)', 'escalation_rate', { type: 'number', step: 0.1 })}
        {field('TMI / CAM ($/sqft/yr)', 'tmi_cam', { type: 'number', step: 0.1 })}
      </div>

      {/* Commission Inputs */}
      <div className="modal-sub">Commission Inputs</div>
      <div className="g3">
        {select('Commission Calculation Method', 'commission_method', ['% of Aggregate Base Rent', '% of Year-1 Rent only', 'Tiered Fixed (Yr1/Yr2-5/Yr6+)', 'Custom % Per Year', '$ per Sq Ft', 'Flat Fee ($)'])}
        {field('Primary Rate (%)', 'primary_rate', { type: 'number', step: 0.1 })}
        {field('Tier Rates (slash-separated)', 'tier_rates', { placeholder: '6/3/2' })}
      </div>
      <div className="g3" style={{ marginTop: 8 }}>
        {select('Payment Trigger', 'payment_trigger', ['Lump sum at lease execution', '50% at signing / 50% at occupancy', 'Annual installments'])}
      </div>

      {/* 6.3 Year-by-Year Rent Schedule */}
      <div className="modal-sub modal-sub-ok">Year-by-Year Rent Schedule</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="doc-table" style={{ minWidth: 720 }}>
          <thead><tr><th>Year</th><th>Period</th><th>Annual Base Rent</th><th>Escalation</th><th>TMI/CAM</th><th>Total Annual</th><th>Monthly</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.y}>
                <td>{r.y}</td><td style={{ fontSize: 11.5 }}>{r.period}</td>
                <td>{formatCurrency(r2(r.base))}</td>
                <td>{r.escalation ? formatCurrency(r2(r.escalation)) : '—'}</td>
                <td>{formatCurrency(r2(r.tmi))}</td>
                <td>{formatCurrency(r2(r.total))}</td>
                <td>{formatCurrency(r2(r.monthly))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr style={{ fontWeight: 700 }}>
            <td colSpan={2}>Totals</td>
            <td>{formatCurrency(r2(aggBase))}</td><td>—</td>
            <td>{formatCurrency(r2(aggTmi))}</td>
            <td colSpan={2}>{formatCurrency(r2(aggTotal))}</td>
          </tr></tfoot>
        </table>
      </div>

      {/* 6.4 Multi-Year Commission Calculator */}
      <div className="modal-sub" style={{ color: 'var(--brand)' }}>Multi-Year Commission Calculator</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="doc-table" style={{ minWidth: 560 }}>
          <thead><tr><th>Year</th><th>Year Base Rent</th><th>Tier %</th><th>Commission Earned</th><th>Cumulative</th></tr></thead>
          <tbody>
            {commRows.map((c, i) => (
              <tr key={i}>
                <td>{c.y}</td>
                <td>{c.base ? formatCurrency(r2(c.base)) : '—'}</td>
                <td>{c.rate}</td>
                <td>{formatCurrency(r2(c.earned))}</td>
                <td>{formatCurrency(r2(c.cum))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr style={{ fontWeight: 700 }}>
            <td colSpan={4}>Net Commission Payable</td>
            <td>{formatCurrency(r2(netComm))}</td>
          </tr></tfoot>
        </table>
      </div>
    </div>
  );
}
