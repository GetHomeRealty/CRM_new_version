import { ForbiddenException } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';

/**
 * TD-172 - only Accounting or a Super Admin may edit or remove a recorded payment: the brokerage's
 * ruling of 2026-09-11. The controller refuses on the role, so a hidden button is not the only guard.
 */
describe('correcting a recorded payment is for Accounting and Super Admin only (TD-172)', () => {
  const invoices = { deletePayment: async () => ({ ok: 'delete' }), updatePayment: async () => ({ ok: 'update' }) };
  const ctrl = new InvoicesController(invoices as never, {} as never);
  const as = (role: string) => ({ id: 1, name: 'QA', role }) as never;

  it.each(['manager', 'manager_ghr', 'agent', 'documentation', 'crm'])('refuses the %s role, to edit and to remove', (role) => {
    expect(() => ctrl.deletePayment(as(role), 1, 2)).toThrow(ForbiddenException);
    expect(() => ctrl.updatePayment(as(role), 1, 2, {})).toThrow(ForbiddenException);
  });

  it('refuses when nobody is signed in, to edit and to remove', () => {
    expect(() => ctrl.deletePayment(undefined, 1, 2)).toThrow(ForbiddenException);
    expect(() => ctrl.updatePayment(undefined, 1, 2, {})).toThrow(ForbiddenException);
  });

  it.each(['admin', 'accounting'])('allows the %s role, to edit and to remove', async (role) => {
    await expect(ctrl.deletePayment(as(role), 1, 2)).resolves.toEqual({ ok: 'delete' });
    await expect(ctrl.updatePayment(as(role), 1, 2, {})).resolves.toEqual({ ok: 'update' });
  });
});
