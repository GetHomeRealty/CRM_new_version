import { TRANSACTION_TYPES, statusSetProblem, isTerminalStatus, isNotifiableStatus, statusOptionsFor } from './transaction.constants';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const client: Record<string, (...args: string[]) => unknown> = {};
runInNewContext(transpileModule(readFileSync(resolve(__dirname, '../../../client/src/desk/format.ts'), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
}).outputText, { exports: client });

describe('Unified choices with legacy compatibility', () => {
 const choices = ['Conditional', 'Firm', 'Closed', 'DFT', 'Void', 'Mutual Release'];
 it.each(TRANSACTION_TYPES)('accepts the new choices for %s', type => {
   expect(client.pickableStatusesFor(type)).toEqual(choices);
   for (const status of choices) expect(statusSetProblem(type, [status])).toBeNull();
 });
 it('keeps legacy statuses valid and filterable, but not pickable', () => {
   expect(statusOptionsFor('Residential Buying')).toContain('Secured Firm');
   expect(statusOptionsFor('Residential Sale Listing')).toContain('Active');
   expect(statusOptionsFor('Preconstruction')).toContain('Open');
   expect(client.statusOptionsFor('Preconstruction')).toContain('Open');
   expect(client.pickableStatusesFor('Preconstruction')).not.toContain('Open');
 });
 it('treats Firm as nonterminal and notifies its milestone', () => {
   expect(isTerminalStatus('Firm')).toBe(false);
   expect(isNotifiableStatus('Firm')).toBe(true);
 });
 it('continues to reject incompatible endings and open conditional endings', () => {
   expect(statusSetProblem('Preconstruction', ['Closed', 'DFT'])).not.toBeNull();
   expect(statusSetProblem('Preconstruction', ['Conditional', 'Closed'])).not.toBeNull();
 });
 it('describes Void without renaming its stored value', () => {
   expect(client.dealStatusLabel('Void')).toBe('Void (conditions failed)');
 });
});
