import { TRANSACTION_TYPES, statusOptionsFor, importStatusOptionsFor, defaultStatusFor } from './transaction.constants';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind } from 'typescript';

// The browser uses ESM while the server uses CJS. Execute the pure client helpers
// in isolation so the parity regression runs under the existing server test config.
const clientExports: Record<string, (...args: string[]) => unknown> = {};
runInNewContext(transpileModule(readFileSync(resolve(__dirname, '../../../client/src/desk/format.ts'), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS },
}).outputText, { exports: clientExports });
const { statusOptionsFor: clientOptions, normalizeStatus, defaultStatusFor: clientDefault, dealStatusLabel } = clientExports;

describe('Unified deal status choices', () => {
  const expected = ['Conditional', 'Firm', 'Closed', 'DFT', 'Void', 'Mutual Release'];
  it.each(TRANSACTION_TYPES)('offers the same choices for %s', type => {
    expect(statusOptionsFor(type)).toEqual(expected);
    expect(clientOptions(type)).toEqual(expected);
    expect(defaultStatusFor(type)).toBe('');
    expect(clientDefault(type)).toBe('');
  });
  it('does not relabel saved legacy statuses during display or autosave', () => {
    for (const type of TRANSACTION_TYPES) {
      for (const status of ['Open', 'Hold', 'Active', 'Sold', 'Leased', 'Secured Firm', 'Secured Conditional', 'Suspended', 'Terminated', 'Expired', 'Mutual release']) {
        expect(normalizeStatus(type, status)).toBe(status);
      }
    }
  });
  it('retains legacy import compatibility without offering legacy choices', () => {
    expect(importStatusOptionsFor('Residential Buying')).toContain('Secured Firm');
    expect(importStatusOptionsFor('Residential Sale Listing')).toContain('Sold');
    expect(importStatusOptionsFor('Preconstruction')).toContain('Open');
    expect(statusOptionsFor('Preconstruction')).not.toContain('Open');
  });
  it('clarifies Void without changing the stored value', () => {
    expect(dealStatusLabel('Void')).toBe('Void (conditions failed)');
    expect(dealStatusLabel('Firm')).toBe('Firm');
  });
});
