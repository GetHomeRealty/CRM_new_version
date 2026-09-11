import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TD-173 - an invoice that is not Paid does not save a commission-received date from the editor.
 * The client has no unit runner, so its editor is read off disk - the approach TD-048 uses.
 */
describe('the invoice editor keeps a received date only on a Paid invoice (TD-173)', () => {
  const src = readFileSync(join(__dirname, '..', '..', '..', 'client', 'src', 'desk', 'InvoiceEditorModal.tsx'), 'utf8');
  const save = src.slice(src.indexOf('const save = async'), src.indexOf('const saveClick'));

  it('leaves the received date and method out of a save unless the invoice is Paid', () => {
    expect(save).toContain("if (payload.status !== 'Paid')");
    expect(save).toContain("Reflect.deleteProperty(payload, 'commission_received_date')");
    expect(save).toContain("Reflect.deleteProperty(payload, 'commission_received_via')");
  });

  it('does so before the Paid rule fills in today, so a Paid save still gets its date', () => {
    const drop = save.indexOf("if (payload.status !== 'Paid')");
    const fill = save.indexOf("payload.status === 'Paid' && !payload.commission_received_date");
    expect(drop).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(drop);
  });
});
