import { useEffect, useState } from 'react';
import api from '../lib/axios';
import { useToast } from './toast';
import { apiErrorMessage } from '../lib/apiError';

/**
 * INDIA INVOICE SETTINGS (19 Oct 2026) - what every India invoice prints that is not on the deal:
 * the company, our two offices (address, state, GSTIN), the bank details box, the SAC code, the
 * invoice prefix and terms. Starts from the brokerage's two templates; the bank details are typed
 * in once by a Super Admin.
 */
interface Office { key: string; name: string; address: string; state: string; gstin: string }
interface Settings {
  company_name: string; cin: string; phone: string; email: string; sac_code: string; invoice_prefix: string; terms: string;
  bank: { beneficiary: string; bank_name: string; account_number: string; ifsc: string };
  offices: Office[]; default_office: string;
}

export default function IndiaSettingsTab() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<Settings>('/api/india-settings').then((r) => setS(r.data)).catch((e) => toast(apiErrorMessage(e, 'Could not load the India settings'), 'bad'));
  }, [toast]);

  if (!s) return <div className="muted">Loading…</div>;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => (x ? { ...x, [k]: v } : x));
  const setBank = (k: keyof Settings['bank'], v: string) => setS((x) => (x ? { ...x, bank: { ...x.bank, [k]: v } } : x));
  const setOffice = (i: number, k: keyof Office, v: string) => setS((x) => (x ? { ...x, offices: x.offices.map((o, j) => (j === i ? { ...o, [k]: v } : o)) } : x));

  const save = async () => {
    setSaving(true);
    try { setS((await api.put<Settings>('/api/india-settings', s)).data); toast('India invoice settings saved', 'ok'); }
    catch (e) { toast(apiErrorMessage(e, 'Could not save the India settings'), 'bad'); } finally { setSaving(false); }
  };

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="modal-sub" style={{ marginTop: 0 }}>Company</div>
      <div className="g3">
        <div className="field"><label>Company name</label><input value={s.company_name} onChange={(e) => set('company_name', e.target.value)} /></div>
        <div className="field"><label>CIN</label><input value={s.cin} onChange={(e) => set('cin', e.target.value)} /></div>
        <div className="field"><label>Phone</label><input value={s.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="field"><label>Email</label><input value={s.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div className="field"><label>HSN/SAC code</label><input value={s.sac_code} onChange={(e) => set('sac_code', e.target.value)} />
          <span className="help">997222 = building sales on a fee/commission basis (channel partners, brokerages). Confirmed by Sai, 19 Oct 2026.</span></div>
        <div className="field"><label>Invoice prefix</label><input value={s.invoice_prefix} onChange={(e) => set('invoice_prefix', e.target.value)} />
          <span className="help">Numbers read {s.invoice_prefix || 'GHR'}/2026-27/0001, restarting each April.</span></div>
        <div className="field"><label>Terms</label><input value={s.terms} onChange={(e) => set('terms', e.target.value)} /></div>
      </div>

      <div className="modal-sub">Our offices <span className="muted" style={{ fontWeight: 400 }}>· each India deal chooses one; the state decides CGST + SGST or IGST</span></div>
      {s.offices.map((o, i) => (
        <div key={o.key} className="g3" style={{ alignItems: 'end', marginBottom: 6 }}>
          <div className="field"><label>Office {s.default_office === o.key && <span className="muted">(default)</span>}</label><input value={o.name} onChange={(e) => setOffice(i, 'name', e.target.value)} /></div>
          <div className="field"><label>State</label><input value={o.state} onChange={(e) => setOffice(i, 'state', e.target.value)} /></div>
          <div className="field"><label>GSTIN</label><input value={o.gstin} onChange={(e) => setOffice(i, 'gstin', e.target.value.toUpperCase())} placeholder="Not given yet" /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Address (printed at the foot of the invoice)</label><input value={o.address} onChange={(e) => setOffice(i, 'address', e.target.value)} /></div>
        </div>
      ))}

      <div className="modal-sub">Beneficiary bank account details</div>
      <div className="g3">
        <div className="field"><label>Beneficiary name</label><input value={s.bank.beneficiary} onChange={(e) => setBank('beneficiary', e.target.value)} /></div>
        <div className="field"><label>Bank name</label><input value={s.bank.bank_name} onChange={(e) => setBank('bank_name', e.target.value)} /></div>
        <div className="field"><label>Account number</label><input value={s.bank.account_number} onChange={(e) => setBank('account_number', e.target.value)} /></div>
        <div className="field"><label>IFSC</label><input value={s.bank.ifsc} onChange={(e) => setBank('ifsc', e.target.value.toUpperCase())} /></div>
      </div>

      <div className="actions"><button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></div>
    </div>
  );
}
