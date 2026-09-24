import { mandatoryMoves, mandatoryRefusal, requireMandatoryApproval } from './document-mandatory-approval';
import type { MandatoryMove } from './document-mandatory-approval';
import { can } from '../core/authz';

/**
 * TD-159 - changing whether a document is Mandatory needs Super Admin approval.
 *
 * The brokerage's ruling of 2026-09-24. These tests are written around the two ways this could fail
 * QUIETLY rather than loudly: refusing saves that changed nothing (which would stop the office
 * working and be blamed on the checklists), and letting one approval authorise every later change
 * to that deal.
 */

const stored = [
  { id: 1, title: 'Waiver', mandatory: true },
  { id: 2, title: 'Amendment', mandatory: false },
  { id: 3, title: 'Schedule A', mandatory: false },
];

const sent = (over: Record<number, boolean> = {}) =>
  stored.map((s) => ({ id: s.id, title: s.title, mandatory: over[s.id] ?? s.mandatory }));

const superAdmin = { id: 1, role: 'admin', name: 'Super' };
const admin = { id: 2, role: 'manager', name: 'Admin' };
const documentation = { id: 3, role: 'documentation', name: 'Docs' };

const fakeDb = (approved: { id: number } | null) => {
  const spent: number[] = [];
  const db = {
    transaction_edit_requests: {
      findFirst: async () => approved,
      update: async (a: { where: { id: number } }) => { spent.push(a.where.id); return {}; },
    },
  };
  return { db: db as never, spent };
};

describe('which rows a save would move', () => {
  it('finds nothing when the screen sends back what it was given', () => {
    // THE SCREEN SENDS EVERY ROW ON EVERY SAVE. If this returned them all, the office could never
    // save a document panel again - and it would be blamed on the checklists.
    expect(mandatoryMoves(sent(), stored)).toEqual([]);
  });

  it('finds an untick, and names the document', () => {
    const moves = mandatoryMoves(sent({ 1: false }), stored);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual({ id: 1, title: 'Waiver', from: true, to: false });
  });

  it('finds a tick as well as an untick', () => {
    const moves = mandatoryMoves(sent({ 1: false, 2: true }), stored);
    expect(moves.map((m) => m.title).sort()).toEqual(['Amendment', 'Waiver']);
  });

  it('ignores a row that is not on the deal, and a new row with no id', () => {
    // A new row has no previous value to differ from; the seeded checklist decides what it starts
    // as, and that is not somebody overriding anything.
    const moves = mandatoryMoves(
      [{ id: 999, title: 'Ghost', mandatory: true }, { id: null, title: 'Brand new', mandatory: true }],
      stored,
    );
    expect(moves).toEqual([]);
  });
});

describe('who may make that change', () => {
  const move: MandatoryMove[] = [{ id: 1, title: 'Waiver', from: true, to: false }];

  it('gives the capability to Super Admin alone', () => {
    expect(can(superAdmin, 'documents.set-mandatory')).toBe(true);
    for (const u of [admin, documentation, { id: 4, role: 'accounting' }, { id: 5, role: 'crm' }, { id: 6, role: 'agent' }]) {
      expect(can(u, 'documents.set-mandatory')).toBe(false);
    }
  });

  it('lets a Super Admin through without touching the approval queue', async () => {
    const { db, spent } = fakeDb(null);
    await expect(requireMandatoryApproval(db, superAdmin, 7, move)).resolves.toBeUndefined();
    expect(spent).toEqual([]);
  });

  it('refuses anybody else when no approval exists, and says which document', async () => {
    const { db } = fakeDb(null);
    await expect(requireMandatoryApproval(db, admin, 7, move)).rejects.toThrow(/Waiver/);
    await expect(requireMandatoryApproval(db, admin, 7, move)).rejects.toThrow(/Super Admin approval/);
  });

  it('lets an approved change through, and SPENDS the approval', async () => {
    // An approval is permission for the change that was asked about, not a standing licence. The
    // DFT lock already works this way; the financial path does not, and one "yes" there authorises
    // every later change to that deal's money.
    const { db, spent } = fakeDb({ id: 55 });
    await expect(requireMandatoryApproval(db, admin, 7, move)).resolves.toBeUndefined();
    expect(spent).toEqual([55]);
  });

  it('does nothing at all when nothing moved, whoever is saving', async () => {
    const { db, spent } = fakeDb(null);
    await expect(requireMandatoryApproval(db, documentation, 7, [])).resolves.toBeUndefined();
    expect(spent).toEqual([]);
  });

  it('treats an unknown or missing role as the least privileged', async () => {
    const { db } = fakeDb(null);
    await expect(requireMandatoryApproval(db, { role: 'something-new' }, 7, move)).rejects.toThrow();
    await expect(requireMandatoryApproval(db, null, 7, move)).rejects.toThrow();
  });
});

describe('what the person is told', () => {
  it('names one document in the singular', () => {
    const m = mandatoryRefusal([{ id: 1, title: 'Waiver', from: true, to: false }]);
    expect(m).toContain('Waiver is Mandatory');
    expect(m).toContain('Request Edit');
  });

  it('names several in the plural', () => {
    const m = mandatoryRefusal([
      { id: 1, title: 'Waiver', from: true, to: false },
      { id: 2, title: 'Amendment', from: false, to: true },
    ]);
    expect(m).toContain('Waiver, Amendment are Mandatory');
  });
});
