import { formatCurrency } from './format';
import type { CompanySettings, Invoice } from '../types';

const BRAND = '#c8102e';

// The printable / emailable invoice document body. Rendered inside the preview
// modal and also offscreen when generating the PDF attachment.
export default function InvoiceDoc({ invoice }: { invoice: Invoice }) {
  const co: CompanySettings = invoice.company || {};
  const items = invoice.line_items || [];

  const dCell = { border: '1px solid #e6e8ef', padding: '7px 10px', fontSize: 12 };
  const dLabel = { ...dCell, background: '#fafbfd', color: '#64748b', textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
  const dVal = { ...dCell, textAlign: 'right' as const };
  const lblBlock = { fontSize: 11, fontWeight: 700, color: '#334155', textTransform: 'uppercase' as const, letterSpacing: '.03em', marginTop: 12 };
  const cust = [invoice.customer_address, invoice.customer_city, [invoice.customer_postal_code, invoice.customer_province].filter(Boolean).join(' '), invoice.customer_country].filter(Boolean);

  return (
    <div style={{ fontSize: 13, color: '#0f172a' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: BRAND, letterSpacing: '-0.5px' }}>
          GET<span style={{ color: '#0f172a' }}>&#9730;</span>HOME REALTY
          <div style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic', fontWeight: 400 }}>"A Tradition of Trust" — Brokerage</div>
        </div>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '1px' }}>INVOICE</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 14 }}>
        <div style={{ fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700 }}>{co.name}</div>
          <div style={{ color: '#475569' }}>{co.address}</div>
          <div style={{ color: '#475569' }}>Phone: {co.phone}</div>
          <div style={{ color: '#475569' }}>Email: {co.email}</div>
          <div style={{ display: 'inline-block', marginTop: 10, border: `1px solid ${BRAND}`, color: BRAND, fontWeight: 700, padding: '5px 10px', borderRadius: 6 }}>
            Balance Due : {formatCurrency(invoice.balance_due)}
          </div>
        </div>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}><tbody>
          <tr><td style={dLabel}>Invoice Number:</td><td style={{ ...dVal, fontWeight: 700 }}>{invoice.invoice_no}</td></tr>
          <tr><td style={dLabel}>Invoice Date:</td><td style={dVal}>{invoice.invoice_date}</td></tr>
          <tr><td style={dLabel}>Terms:</td><td style={dVal}>{invoice.terms}</td></tr>
          <tr><td style={dLabel}>Due Date:</td><td style={dVal}>{invoice.due_date || '—'}</td></tr>
          <tr><td style={dLabel}>Trade No.:</td><td style={dVal}>{invoice.trade_number || '—'}</td></tr>
          <tr><td style={dLabel}>Property:</td><td style={dVal}>{invoice.property_reference || '—'}</td></tr>
        </tbody></table>
      </div>

      <div style={{ borderTop: '1px solid #eef0f5', paddingTop: 10, marginBottom: 6 }}>
        <strong>Subject: </strong>{invoice.subject || `Co-op Commission for ${invoice.property_reference || ''}`}
      </div>

      <div style={lblBlock}>Bill To:</div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{invoice.customer_name || '-'}</div>
      <div style={{ color: '#475569', lineHeight: 1.6 }}>{cust.length ? cust.map((l, i) => <div key={i}>{l}</div>) : <div>-</div>}</div>

      <div style={lblBlock}>Agent Details</div>
      <div style={{ color: '#64748b', fontSize: 11.5 }}>Listing Agent / Sales Person:</div>
      <div style={{ marginBottom: 6 }}>{invoice.listing_agent || '-'}</div>
      <div style={{ color: '#64748b', fontSize: 11.5 }}>Co-op Salesperson:</div>
      <div>{invoice.coop_salesperson || '-'}</div>

      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 16 }}>
        <thead><tr>
          <th style={{ border: '1px solid #e6e8ef', background: '#f3f5f9', padding: '8px 10px', textAlign: 'left', width: 30 }}>#</th>
          <th style={{ border: '1px solid #e6e8ef', background: '#f3f5f9', padding: '8px 10px', textAlign: 'left' }}>Item &amp; Description</th>
          <th style={{ border: '1px solid #e6e8ef', background: '#f3f5f9', padding: '8px 10px', textAlign: 'right', width: 180 }}>Amount (CAD)</th>
        </tr></thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={it.id || i}>
              <td style={{ border: '1px solid #e6e8ef', padding: '8px 10px' }}>{i + 1}</td>
              <td style={{ border: '1px solid #e6e8ef', padding: '8px 10px' }}>
                <div style={{ fontWeight: 600 }}>{it.description}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>{Number(it.qty).toFixed(2)} × {formatCurrency(it.rate)}</div>
              </td>
              <td style={{ border: '1px solid #e6e8ef', padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{formatCurrency(it.amount)}</td>
            </tr>
          ))}
          {Number(invoice.tax_total) > 0 && (
            <tr>
              <td style={{ border: '1px solid #e6e8ef', padding: '8px 10px' }}>{items.length + 1}</td>
              <td style={{ border: '1px solid #e6e8ef', padding: '8px 10px' }}>
                <div style={{ fontWeight: 600 }}>HST{co.hst_number ? <span style={{ fontWeight: 400, color: '#64748b' }}> (Number : {co.hst_number})</span> : null}</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>1.00 × {formatCurrency(invoice.tax_total)}</div>
              </td>
              <td style={{ border: '1px solid #e6e8ef', padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{formatCurrency(invoice.tax_total)}</td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <table style={{ borderCollapse: 'collapse', minWidth: 300 }}><tbody>
          <tr><td style={{ padding: '4px 10px', color: '#475569' }}>Sub Total</td><td style={{ padding: '4px 10px', textAlign: 'right' }}>{formatCurrency(Number(invoice.sub_total || 0) + Number(invoice.tax_total || 0))}</td></tr>
          <tr><td style={{ padding: '4px 10px', color: '#475569' }}>Discount</td><td style={{ padding: '4px 10px', textAlign: 'right' }}>{formatCurrency(invoice.discount)}</td></tr>
          <tr><td style={{ padding: '6px 10px', fontWeight: 800, borderTop: '2px solid #0f172a' }}>Total</td><td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 800, borderTop: '2px solid #0f172a' }}>{formatCurrency(invoice.total)}</td></tr>
          <tr><td style={{ padding: '4px 10px', color: '#166534' }}>Paid</td><td style={{ padding: '4px 10px', textAlign: 'right', color: '#166534' }}>{formatCurrency(invoice.amount_paid)}</td></tr>
          <tr><td style={{ padding: '6px 10px', fontWeight: 800, color: BRAND }}>Balance Due</td><td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 800, color: BRAND }}>{formatCurrency(invoice.balance_due)}</td></tr>
        </tbody></table>
      </div>

      {co.thank_you_note && <div style={{ marginTop: 12, fontStyle: 'italic', color: '#475569', fontSize: 12 }}>{co.thank_you_note}</div>}

      <div style={{ marginTop: 16, borderTop: '1px solid #eef0f5', paddingTop: 12, fontSize: 11.5, color: '#475569', lineHeight: 1.7 }}>
        <div style={{ fontWeight: 700, color: '#334155' }}>{co.deposit_heading || 'Beneficiary Bank Account Detail:'}</div>
        <div>Beneficiary Name : {co.bank_beneficiary}</div>
        <div>Bank Name: {co.bank_name}</div>
        <div>Bank Transit Number: {co.transit_no}</div>
        <div>Account Number: {co.account_no}</div>
        <div>Institution Number: {co.institution_no}</div>
      </div>
      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ textAlign: 'center', minWidth: 220 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: '#334155', marginBottom: 4 }}>Acknowledged by:</div>
          {invoice.signature_path
            ? <img src={invoice.signature_path} alt="signature" style={{ maxHeight: 60 }} />
            : <div style={{ height: 60 }} />}
          <div style={{ borderTop: '1px dashed #94a3b8', paddingTop: 4, fontSize: 11, color: '#475569' }}>
            {invoice.broker_name || 'Broker Manager / Broker of Record'}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 10, textAlign: 'center', fontStyle: 'italic', fontSize: 11, color: '#94a3b8' }}>This is a system-generated invoice from {co.name}.</div>
    </div>
  );
}
