import { encodeLeadTypes, parseLeadTypes } from './lead.constants';

describe('multi-value lead types', () => {
  it('keeps historical single-value rows readable', () => {
    expect(parseLeadTypes('resale')).toEqual(['resale']);
  });

  it('round-trips several selected types without duplicates', () => {
    const stored = encodeLeadTypes(['Pre construction', 'buyer', 'buyer']);
    expect(stored).toBe('["Pre construction","buyer"]');
    expect(parseLeadTypes(stored)).toEqual(['Pre construction', 'buyer']);
  });

  it('uses null for no selection', () => {
    expect(encodeLeadTypes([])).toBeNull();
    expect(parseLeadTypes(null)).toEqual([]);
  });
});
