import { useRef } from 'react';
import { printDoc } from './printDoc';
import InvoiceDoc from './InvoiceDoc';

export default function InvoicePreviewModal({ open, onClose, invoice }) {
  const ref = useRef(null);
  if (!open || !invoice) return null;

  return (
    <div className="overlay open" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal lg">
        <button className="close" onClick={onClose}>✕</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="modal-h" style={{ margin: 0, border: 0, padding: 0 }}>{invoice.invoice_no}</div>
          <button className="btn primary sm" onClick={() => printDoc(invoice.invoice_no, ref.current.innerHTML)}>🖨 Print / Save PDF</button>
        </div>

        <div ref={ref}>
          <InvoiceDoc invoice={invoice} />
        </div>

        <div className="actions"><button className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
