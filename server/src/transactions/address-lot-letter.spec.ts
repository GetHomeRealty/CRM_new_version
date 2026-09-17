import { TransactionsWriteService } from './transactions-write.service';

/**
 * TD-193 - two lots told apart only by a letter are two properties.
 *
 * Measured 2026-09-17: the 2026-09-13 import refused 300170 'Lot 85 L' as a duplicate of 300169
 * 'Lot 85 R', and 300172 'Lot 86 L' as a duplicate of 300171 'Lot 86 R' - different buyers, same
 * price and offer date. The letter was read neither as a unit nor as a street number, so the two
 * compared 87.5% similar and the second deal silently never arrived.
 *
 * sameProperty() uses no injected service, so it is called on a bare instance.
 */
const svc = Object.create(TransactionsWriteService.prototype) as TransactionsWriteService;
const same = (a: string, b: string): boolean => svc.sameProperty(a, b);

describe('duplicate matching keeps lot and unit letters apart (TD-193)', () => {
  it.each([
    ['Lot 85 R', 'Lot 85 L'],
    ['Lot 86 R', 'Lot 86 L'],
    ['Lot 122A', 'Lot 122B'],
    ['Lot 00122A_846 Eileen Vollick Crescent', 'Lot 00122B_846 Eileen Vollick Crescent'],
  ])('%s and %s are different properties', (a, b) => {
    expect(same(a, b)).toBe(false);
    expect(same(b, a)).toBe(false);
  });

  it.each([
    ['Lot 85 R', 'Lot 85 R'],
    ['Lot 85 R', 'lot 85 r'],
    ['Lot 122A', 'Lot 122A, Woodland'],
    ['5126 Des Jardines Drive', '5126 Des Jardines Drive_Mutual Release'],
  ])('%s and %s are still the same property', (a, b) => {
    expect(same(a, b)).toBe(true);
    expect(same(b, a)).toBe(true);
  });

  it('keeps the distinctions it already made', () => {
    expect(same('300 Beta Rd', '301 Beta Rd')).toBe(false);
    expect(same('10 King St E', '10 King St W')).toBe(false);
    expect(same('12 Main St Unit A', '12 Main St Unit B')).toBe(false);
  });
});
