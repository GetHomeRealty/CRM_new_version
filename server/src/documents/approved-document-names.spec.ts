import { readFileSync, readdirSync, statSync } from 'fs';
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

/*
 * TD-159 - THE SAME RULE FOR THE WEBSITE, which is where the costly copy was hiding.
 *
 * On 2026-09-26 the client held three stale copies of the brokerage's names. The expensive one was
 * docRestrict: it asked for 'mls data sheet' after the approved name became 'MLS Data Information
 * Form', so THREE of the six required documents were invisible and unuploadable on 17 Active and 77
 * Terminated sale listings. Nothing failed. Nothing was logged. Every figure reconciled.
 *
 * WHAT THIS GUARDS AND WHAT IT DOES NOT, stated plainly because a guard nobody understands is a
 * guard nobody trusts. It reads every website source file, STRIPS COMMENTS so the notes recording
 * those faults do not trip it, and looks for lines comparing a DOCUMENT's title - d.title,
 * doc.title or document.title - against a quoted phrase. Each phrase must match one of the
 * brokerage's approved names. It cannot see a phrase held in a variable several lines away, and it
 * ignores headings and labels, which are matched against nothing. A net with a known mesh, not a
 * proof - but the mesh is exactly the size of the three faults it was built from.
 */

const CLIENT_SRC = join(__dirname, '..', '..', '..', 'client', 'src');

const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

/** Comments carry the history of these faults; they must not be mistaken for the faults. */
const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

/** Phrases compared against a DOCUMENT's title, file by file. */
const titleComparisons = (): { file: string; phrase: string }[] => {
  const found: { file: string; phrase: string }[] = [];
  for (const file of sourceFiles(CLIENT_SRC)) {
    for (const line of withoutComments(readFileSync(file, 'utf8')).split('\n')) {
      if (!/\b(d|doc|document)\.title\b/.test(line)) continue;
      if (!/includes\(|===|startsWith\(|\.match\(/.test(line)) continue;
      /*
       * EMPTY STRINGS MUST BE MATCHED, NOT SKIPPED, or the pairing walks off by one. The first
       * draft required 2-60 characters between the quotes, which cannot match '' - so on
       * `(d.title || '').toLowerCase().includes('fintrac')` it paired the SECOND quote of the
       * empty string with the opening quote of 'fintrac', captured the code between them, and
       * missed the only phrase on the line. The guard reported a fault that was not there and
       * missed the one thing it was built to see.
       */
      for (const m of line.matchAll(/'([^']*)'/g)) {
        if (m[1].trim().length >= 3) found.push({ file, phrase: m[1] });
      }
    }
  }
  return found;
};

describe('the website matches document titles only against approved names (TD-159)', () => {
  const matchesAnApproved = (phrase: string): boolean => {
    const p = phrase.trim().toLowerCase();
    if (!p) return false;
    return Object.values(DOC).some((n) => {
      const name = n.toLowerCase();
      return name.includes(p) || p.includes(name);
    });
  };

  it('finds the website source at all, so this cannot pass by looking at nothing', () => {
    // If the repository is ever rearranged, this fails LOUDLY rather than quietly guarding air.
    const files = sourceFiles(CLIENT_SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('DocsModal.tsx'))).toBe(true);
  });

  it('compares a document title against no phrase the sheet lacks', () => {
    const strays = titleComparisons().filter((c) => !matchesAnApproved(c.phrase));
    expect(strays.map((c) => c.phrase + '   in ' + c.file.replace(CLIENT_SRC, ''))).toEqual([]);
  });

  it('does find the one legitimate comparison, so the case above is not vacuous', () => {
    // FINTRACK Form 630 is opened per client off this check, and 'fintrac' is inside 'Fintrac'.
    const found = titleComparisons();
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((c) => c.phrase === 'fintrac')).toBe(true);
  });

  it('ignores a stale name that appears only in a comment', () => {
    // The comments left on 2026-09-26 quote 'mls data sheet' deliberately, to record what was wrong.
    // If comment stripping ever broke, this suite would fail for the wrong reason and the next
    // person would weaken it to get a deploy through. This case makes that impossible to mistake.
    const sample = "// if (doc.title.includes('mls data sheet')) {}\nconst x = 1;";
    expect(withoutComments(sample)).not.toContain('mls data sheet');
  });
});
