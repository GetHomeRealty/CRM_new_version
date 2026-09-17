import { TransactionsWriteService } from './transactions-write.service';

/**
 * TD-194 - a number followed by an underscore is still a street or lot number.
 *
 * Measured 2026-09-17: reviewing an import of 'Lot 134_Pending' and 'Lot 230_Pending' marked the
 * second a duplicate of the first. The street-number test used /\b\d+\b/, and in a regex an
 * underscore is a WORD character - so '134_' has no boundary and neither number was seen. The text
 * fallback then scored the two 87% alike. The brokerage's sheet writes outcomes this way throughout
 * ('_Mutual Release', '_Term 1', '_DFT'), so any two such deals could be refused.
 */
const svc = Object.create(TransactionsWriteService.prototype) as TransactionsWriteService;
const same = (a: string, b: string): boolean => svc.sameProperty(a, b);

describe('street and lot numbers are read through an underscore (TD-194)', () => {
  it.each([
    ['Lot 134_Pending', 'Lot 230_Pending'],
    ['Lot 24_Term 1', 'Lot 25_Term 1'],
    ['12 Birch Road_DFT', '14 Birch Road_DFT'],
  ])('%s and %s are different properties', (a, b) => {
    expect(same(a, b)).toBe(false);
    expect(same(b, a)).toBe(false);
  });

  it.each([
    ['Lot 134_Pending', 'Lot 134_Pending'],
    ['262 Oakwood Crescent_Mutual Release', '262 Oakwood Crescent'],
    ['12 Main St, Toronto M4B 2B2', '12 Main St'],
  ])('%s and %s are still the same property', (a, b) => {
    expect(same(a, b)).toBe(true);
    expect(same(b, a)).toBe(true);
  });
});
