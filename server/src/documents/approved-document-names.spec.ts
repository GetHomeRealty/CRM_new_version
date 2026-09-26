import { readFileSync } from 'fs';
import { join } from 'path';
import { DOC } from './checklist-definitions';

/*
 * TD-159 - NO RULE MAY WRITE A DOCUMENT NAME THE BROKERAGE DID NOT APPROVE.
 *
 * DocumentsService.index() runs four tidying rules on every load of a deal's documents, and three
 * of them carried their OWN copy of a name: 'FINTRACK' where the brokerage's sheet says 'Fintrac',
 * and the short 'Agreement to Lease' and 'Agreement of Purchase and Sale' where the sheet carries
 * the (ATL) and (APS) suffixes.
 *
 * Harmless while nothing else read those names - and a fault the moment the approved checklists
 * arrived, because a row renamed OUT of the checklist's reach is a row the checklist adds again.
 * Opening the deal then renamed the new one too, so every deal would have collected a second
 * Fintrac, one status change at a time.
 *
 * FOUND BY THE BROKERAGE LOOKING AT ONE DEAL ON SCREEN, on 2026-09-26, after every figure in the
 * 890-deal rebuild had already reconciled to the document. The numbers could not see it. A person
 * could. That is the reason this test reads the SOURCE rather than the behaviour: the next rule
 * somebody adds must fail here before it reaches a deal.
 */

const SOURCE = readFileSync(join(__dirname, 'documents.service.ts'), 'utf8');

/** Titles this file writes that are NOT documents, and so are legitimately off the sheet. */
const NOT_A_DOCUMENT = ['Your documents were reviewed'];

const hardCodedTitles = (): string[] => {
  const out = new Set<string>();
  for (const m of SOURCE.matchAll(/title:\s*'([^']+)'/g)) out.add(m[1]);
  for (const m of SOURCE.matchAll(/ensure\(\s*'[^']*'\s*,\s*'([^']+)'\s*\)/g)) out.add(m[1]);
  return [...out].filter((t) => !NOT_A_DOCUMENT.includes(t));
};

describe('every document name this service writes is one the brokerage approved (TD-159)', () => {
  it('hard-codes no document title that is off the approved list', () => {
    const approved = new Set<string>(Object.values(DOC));
    expect(hardCodedTitles().filter((t) => !approved.has(t))).toEqual([]);
  });

  it('spells Fintrac as the sheet does, and never FINTRACK', () => {
    expect(DOC.FINTRAC).toBe('Fintrac');
    expect(SOURCE).not.toMatch(/title:\s*'FINTRACK'/);
  });

  it('uses the suffixed lease and purchase names, not the short forms', () => {
    expect(DOC.ATL).toBe('Agreement to Lease (ATL)');
    expect(DOC.APS).toBe('Agreement of Purchase and Sale (APS)');
    expect(SOURCE).not.toMatch(/'Agreement to Lease'/);
    expect(SOURCE).not.toMatch(/'Agreement of Purchase and Sale'/);
  });

  it('and the extractor really would catch one, so the first case is not vacuous', () => {
    expect(Object.values(DOC).length).toBeGreaterThan(20);
    // The file now hard-codes NO document title at all, which is the point of the fix - so the
    // first case above passes over an empty list. Run the same extraction over a line that does
    // carry one, to prove an empty result means 'none present' and not 'the regex is broken'.
    const sample = "data: { title: 'FINTRACK', updated_at: new Date() }";
    expect([...sample.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1])).toEqual(['FINTRACK']);
  });
});
