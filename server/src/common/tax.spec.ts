/*
 * India desk (19 Oct 2026): GST 18% on India deals, HST 13% on Canadian ones - and Canada unchanged.
 */
import { CommissionService } from '../transactions/commission.service';
import type { CommissionTxn } from '../transactions/commission.types';
import { grossDivisorFor, sqlForMarket, taxLabelFor, taxRateFor } from './tax';
import { G, HST } from '../dashboard/desk-commission.sql';

const svc = new CommissionService({} as never);
const deal = (over: Partial<CommissionTxn>): CommissionTxn => ({
  type: 'Residential Buying', price: 1_000_000, deposit: 0, comm_type: '%', comm_value: 2, comm_pct: null, comm_amt: null,
  comm_adjust_enabled: false, comm_adjust_before: 0, comm_adjust_after: 0,
  ...over,
} as CommissionTxn);

describe('tax by country', () => {
  it('Canada HST 13% exactly as before, India GST 18%', () => {
    expect(taxRateFor('CA')).toBe(0.13); expect(taxRateFor(null)).toBe(0.13); expect(taxRateFor('IN')).toBe(0.18);
    expect(taxLabelFor('IN')).toBe('GST'); expect(grossDivisorFor('CA')).toBe(1.13); expect(grossDivisorFor('IN')).toBe(1.18);
  });

  it('a deal\'s summary uses its own country\'s rate', () => {
    const ca = svc.summarize(deal({}));
    expect(ca).toMatchObject({ amount: 20000, hst: 2600, total: 22600 });
    const ind = svc.summarize(deal({ market: 'IN' }));
    expect(ind).toMatchObject({ amount: 20000, hst: 3600, total: 23600 });
    // ...and a Canadian deal straight after is still 13%.
    expect(svc.summarize(deal({ market: 'CA' })).hst).toBe(2600);
  });

  it('a tax-inclusive pre-construction fee is taken back with 1.18 in India, 1.13 in Canada', () => {
    const base = { type: 'Preconstruction', precon_net_of_hst: true, precon_comm_pct: 3, price: 1_000_000 } as Partial<CommissionTxn>;
    expect(svc.summarize(deal({ ...base })).amount).toBe(26548.67);
    expect(svc.summarize(deal({ ...base, market: 'IN' })).amount).toBe(25423.73);
  });

  it('dashboard SQL keeps Canada\'s text and swaps in India\'s rate', () => {
    const sql = `x * ${G} + y * ${HST} + z / 1.13::float8`;
    expect(sqlForMarket(sql, 'CA')).toBe(sql);
    expect(sqlForMarket(sql, 'IN')).toBe('x * (1::float8 + 0.18::float8) + y * 0.18::float8 + z / 1.18::float8');
  });
});
