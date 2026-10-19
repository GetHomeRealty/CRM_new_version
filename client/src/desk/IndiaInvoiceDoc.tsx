import BrandMark from './BrandMark';
import type { Invoice } from '../types';

/**
 * THE INDIA INVOICE (19 Oct 2026) - laid out like the brokerage's Get Home Realty Pvt Ltd templates
 * (Hyderabad / Vizianagaram): company block with CIN, phone, email and GSTIN; BALANCE DUE; the
 * builder's billing box with its GSTIN; invoice details (Invoice#, dates, terms, sales person,
 * project); the line table with HSN/SAC and the tax columns; totals with CGST + SGST (same state) or
 * IGST (different states); the bank details box; the office address at the foot.
 *
 * Amounts are in rupees with Indian grouping (the screens are in India when this prints).
 */
export interface IndiaBlock {
  company: { name: string; cin: string; phone: string; email: string };
  office: { key: string; name: string; address: string; state: string; gstin: string };
  sac_code: string;
  bank: { beneficiary: string; bank_name: string; account_number: string; ifsc: string };
  builder: { name: string; gstin: string | null; state: string | null; address: string | null } | null;
  project_name: string | null;
  sales_person: string | null;
  tax: { kind: 'CGST_SGST'; cgst_rate: number; cgst: number; sgst_rate: number; sgst: number } | { kind: 'IGST'; igst_rate: number; igst: number };
}

const RED = '#c8102e';
const inr = (v: unknown): string => Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (v: unknown): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v ?? '—');
};

export default function IndiaInvoiceDoc({ invoice, india }: { invoice: Invoice; india: IndiaBlock }) {
  const items = invoice.line_items || [];
  const t = india.tax;
  const sub = Number(invoice.sub_total || 0);
  const th = { padding: '10px 8px', color: RED, fontWeight: 500, fontSize: 13, borderBottom: '1px solid #0f172a', textAlign: 'left' as const };
  const cell = { padding: '12px 8px', fontSize: 12.5, verticalAlign: 'top' as const, borderBottom: '1px solid #0f172a' };
  const sumRow = (label: string, value: string, strong = false) => (
    <tr>
      <td style={{ padding: '6px 10px', textAlign: 'right', color: strong ? RED : '#334155', fontWeight: strong ? 700 : 400, fontSize: strong ? 15 : 13 }}>{label}</td>
      <td style={{ padding: '6px 10px', textAlign: 'right', color: strong ? RED : '#0f172a', fontWeight: strong ? 700 : 400, fontSize: strong ? 15 : 13, minWidth: 120 }}>{value}</td>
    </tr>
  );

  return (
    <div style={{ fontSize: 13, color: '#0f172a', fontFamily: 'inherit' }}>
      {/* Head: logo, INVOICE, company block */}
      <div style={{ background: '#f9e3e5', padding: '16px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <BrandMark color={RED} />
        <div style={{ fontSize: 30, letterSpacing: 1 }}>INVOICE</div>
        <div style={{ textAlign: 'right', fontSize: 11.5, lineHeight: 1.6 }}>
          <div>CIN : {india.company.cin}</div>
          <div>Phone : {india.company.phone}</div>
          <div>{india.company.email}</div>
          <div>GSTIN : {india.office.gstin || ''}</div>
        </div>
      </div>
      <div style={{ background: '#fdf6f6', padding: '8px 18px', textAlign: 'right', color: RED, fontSize: 15 }}>
        BALANCE DUE <strong>{inr(invoice.balance_due)}</strong>
      </div>

      {/* Bill to (the builder) + invoice details */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, padding: '18px 18px 8px' }}>
        <div style={{ lineHeight: 1.6, fontSize: 12.5 }}>
          <div style={{ fontWeight: 700 }}>{invoice.customer_name || india.builder?.name || '—'}</div>
          {(invoice.customer_address || india.builder?.address) && <div style={{ whiteSpace: 'pre-line' }}>{invoice.customer_address || india.builder?.address}</div>}
          {india.builder?.state && <div>{india.builder.state}</div>}
          <div>India</div>
          {india.builder?.gstin && <div>GSTIN {india.builder.gstin}</div>}
        </div>
        <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}><tbody>
          {[
            ['Invoice#', invoice.invoice_no],
            ['Invoice Date', dmy(invoice.invoice_date)],
            ['Terms', invoice.terms || 'Due on Receipt'],
            ['Due Date', dmy(invoice.due_date || invoice.invoice_date)],
            ['Sales person', india.sales_person || '—'],
            ['Project Name', india.project_name || '—'],
          ].map(([k, v]) => (
            <tr key={k}><td style={{ padding: '4px 14px', textAlign: 'right', color: '#334155' }}>{k}</td><td style={{ padding: '4px 0', textAlign: 'right' }}>{v}</td></tr>
          ))}
        </tbody></table>
      </div>

      <div style={{ padding: '6px 18px' }}>
        <div>Subject : {invoice.subject || ''}</div>
      </div>

      {/* Lines */}
      <div style={{ padding: '6px 18px' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>
            <th style={{ ...th, width: 30, textAlign: 'center' }}>#</th>
            <th style={th}>ITEM &amp; DESCRIPTION</th>
            <th style={{ ...th, width: 80 }}>HSN/SAC</th>
            {t.kind === 'IGST'
              ? <th style={{ ...th, width: 80, textAlign: 'center' }}>IGST</th>
              : <><th style={{ ...th, width: 70, textAlign: 'center' }}>CGST</th><th style={{ ...th, width: 70, textAlign: 'center' }}>SGST</th></>}
            <th style={{ ...th, width: 110, textAlign: 'right' }}>AMOUNT</th>
          </tr></thead>
          <tbody>
            {items.map((it, i) => {
              const amt = Number(it.amount || 0);
              const share = sub > 0 ? amt / sub : 0;
              return (
                <tr key={it.id || i}>
                  <td style={{ ...cell, textAlign: 'center' }}>{i + 1}</td>
                  <td style={cell}>{it.description}</td>
                  <td style={cell}>{india.sac_code}</td>
                  {t.kind === 'IGST'
                    ? <td style={{ ...cell, textAlign: 'center' }}>{inr(t.igst * share)}<div style={{ fontSize: 11, color: '#64748b' }}>{t.igst_rate}%</div></td>
                    : <>
                      <td style={{ ...cell, textAlign: 'center' }}>{inr(t.cgst * share)}<div style={{ fontSize: 11, color: '#64748b' }}>{t.cgst_rate}%</div></td>
                      <td style={{ ...cell, textAlign: 'center' }}>{inr(t.sgst * share)}<div style={{ fontSize: 11, color: '#64748b' }}>{t.sgst_rate}%</div></td>
                    </>}
                  <td style={{ ...cell, textAlign: 'right' }}>{inr(amt)}<div style={{ fontSize: 11, color: '#64748b' }}>{Number(it.qty || 1).toFixed(2)} x {inr(it.rate)}</div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Totals */}
      <div style={{ margin: '0 18px', background: '#fdf6f6', padding: '10px 0', display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ padding: '6px 18px', fontSize: 12 }}>Thanks for your business.</div>
        <table style={{ borderCollapse: 'collapse' }}><tbody>
          {sumRow('Sub Total', inr(invoice.sub_total))}
          {t.kind === 'IGST'
            ? sumRow(`IGST (${t.igst_rate.toFixed(2)}%)`, inr(t.igst))
            : <>{sumRow(`CGST (${t.cgst_rate.toFixed(2)}%)`, inr(t.cgst))}{sumRow(`SGST (${t.sgst_rate.toFixed(2)}%)`, inr(t.sgst))}</>}
          {sumRow('Total', inr(invoice.total), true)}
          {Number(invoice.amount_paid || 0) > 0 && sumRow('Payment Made', `(-) ${inr(invoice.amount_paid)}`)}
          {sumRow('Balance Due', inr(invoice.balance_due), true)}
        </tbody></table>
      </div>

      {/* Bank */}
      <div style={{ padding: '20px 18px 8px', fontSize: 12.5, lineHeight: 1.7 }}>
        <div style={{ fontWeight: 700, fontSize: 15, textDecoration: 'underline' }}>Beneficiary Bank Account Details:</div>
        <div><strong>Beneficiary Name :</strong> <span style={{ color: RED, fontWeight: 700 }}>{india.bank.beneficiary}</span></div>
        <div><strong>Bank Name:</strong> <span style={{ color: RED, fontWeight: 700 }}>{india.bank.bank_name}</span></div>
        <div><strong>Account Number:</strong> <span style={{ color: RED, fontWeight: 700 }}>{india.bank.account_number}</span></div>
        <div><strong>IFSC :</strong> <span style={{ color: RED, fontWeight: 700 }}>{india.bank.ifsc}</span></div>
        <div><strong>GSTIN :</strong> {india.office.gstin}</div>
      </div>

      {/* Office address */}
      <div style={{ margin: '18px 18px 0', borderTop: '1px solid #0f172a', paddingTop: 8, textAlign: 'center', color: '#7f1d1d', fontWeight: 700, fontSize: 12 }}>
        Address : {india.office.address}
      </div>
    </div>
  );
}
