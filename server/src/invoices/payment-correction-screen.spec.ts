import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-172 - the invoice editor shows the recorded payments, with Edit and Remove, to Accounting and Super
 * Admin only, and asks before removing. The client has no unit runner, so its source is read off disk -
 * the approach TD-048 uses. The server refuses everyone else regardless (payment-correction-access).
 */
describe('the invoice editor shows payment corrections only to Accounting and Super Admin (TD-172)', () => {
  const src = readFileSync(join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'InvoiceEditorModal.tsx'), 'utf8');

  it('shows the list and its buttons only inside the role gate', () => {
    expect(src).toContain("const canCorrectPayments = auth.isSuperAdmin || auth.user?.role === 'accounting';");
    const gate = src.indexOf('{canCorrectPayments && (saved?.payments || []).length > 0 && (');
    expect(gate).toBeGreaterThan(-1);
    const end = src.indexOf("<label style={{ fontSize: 11, color: 'var(--text-3)', display: 'block', marginBottom: 2 }}>Date</label>", gate);
    for (const call of ['startEditPay(p)', 'askRemovePay(p)']) {
      expect(src.indexOf(call)).toBeGreaterThan(gate);
      expect(src.lastIndexOf(call)).toBeLessThan(end);
    }
  });

  it('asks before removing a payment, and says it will show as due', () => {
    expect(src).toContain('payConfirm.askDelete({');
    expect(src).toContain("title: 'Remove this payment?'");
    expect(src).toContain('will show as due again');
  });

  it('renders the confirmation it asks for', () => {
    expect(src).toContain('<ConfirmDialog confirm={payConfirm.confirm} onClose={payConfirm.closeConfirm} />');
  });
});
