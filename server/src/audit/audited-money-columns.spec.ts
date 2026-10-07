import { readFileSync } from 'fs';
import * as path from 'path';
import { DEC2, DEC4, SCALAR_MAP } from './audit.service';

/*
 * TD-150 - EVERY MONEY COLUMN ON A DEAL IS IN THE HISTORY, OR IS LEFT OUT ON PURPOSE AND SAYS WHY.
 *
 * The audited fields are an allow-list, so a money column added to `transactions` later is simply
 * not recorded when it changes, and nothing noticed: listing_price and gift_coupon_value had been
 * changing unrecorded. This reads the schema itself, so the next new column fails here instead.
 */
const NOT_AUDITED: Record<string, string> = {
  calc_paid_total: 'a cache recomputed from the payments on every write - the payments themselves are audited',
  calc_agent_comm_total: 'a cache recomputed from the commission engine on every write',
};

const schema = readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
const model = /model transactions \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
const decimals = [...model.matchAll(/^\s+([a-z_0-9]+)\s+Decimal/gm)].map((m) => m[1]);

describe('money columns on a deal and the history', () => {
  it('finds the deal model and its money columns', () => {
    expect(decimals).toContain('price');
    expect(decimals.length).toBeGreaterThan(10);
  });
  it.each(decimals.filter((c) => !(c in NOT_AUDITED)))('%s is recorded when it changes', (col) => {
    expect(DEC2.has(col) || DEC4.has(col)).toBe(true);
    expect(SCALAR_MAP[col]).toBeDefined();
  });
  it('every column left out is still a real column', () => {
    for (const c of Object.keys(NOT_AUDITED)) expect(decimals).toContain(c);
  });
});
