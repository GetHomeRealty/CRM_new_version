import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdminGuard } from '../auth/guards/admin.guard';
import { TransactionImportController } from './transaction-import.controller';

/**
 * TD-057 — bulk import is Super Admin work, on the server AND in the browser.
 *
 * WHAT WAS REPORTED. An agent was offered the whole tool: the toolbar button, the Bulk Import
 * page, the drop zone and both template downloads. The refusal arrived only after a file had been
 * chosen — so somebody prepared a spreadsheet for a screen they were never allowed to use.
 *
 * TWO OF THE THREE HALVES WERE ALREADY CLOSED. The API is `AdminGuard`-ed on every route (TD-103),
 * including `template` and `sample`, which take no user and could therefore never have refused
 * anybody themselves; and the toolbar button is behind `isSuperAdmin` (TD-103 again).
 *
 * THE ROUTE WAS NOT, and that is the half QA re-confirmed on 2026-09-02: every sub-path of
 * `transactions` was gated on `transactions: view`, which an agent holds, so typing
 * `/desk/transactions/import` rendered the full screen with both working download buttons. Hiding
 * a button is the weaker protection; it was the only one the browser had.
 *
 * The client has no unit runner, so the route table is read off disk. That is worth doing rather
 * than skipping: the fix is one `superAdmin: true` on one entry, and merging the entries back
 * together — the tidy-looking change — silently reopens the defect with nothing else to notice.
 */

describe('the bulk import API is Super Admin only (TD-057)', () => {
  it('guards the whole controller, including the two routes that take no user', () => {
    const guards = (Reflect.getMetadata('__guards__', TransactionImportController) ?? []) as unknown[];
    expect(guards).toContain(AdminGuard);
  });
});

describe('the bulk import ROUTE is Super Admin only (TD-057)', () => {
  const appSource = readFileSync(
    join(__dirname, '..', '..', '..', 'client', 'src', 'App.tsx'),
    'utf8',
  );

  /** The one SCREENS entry whose paths include 'import'. */
  const importEntry = (): string => {
    const at = appSource.indexOf("paths: ['import']");
    if (at < 0) return '';
    const start = appSource.lastIndexOf('{', at);
    const end = appSource.indexOf('\n', at);
    return appSource.slice(start, end);
  };

  it('routes transactions/import through its own entry, gated on the tier', () => {
    const entry = importEntry();
    expect(entry).toContain("screen: 'transactions'");
    expect(entry).toContain('BulkImportPage');
    expect(entry).toContain('superAdmin: true');
  });

  it('does not let the general transactions entry serve it as well', () => {
    // The general entry keeps `transactions: view` — an agent must still reach their own deals —
    // so `import` appearing in ITS path list would open the screen again through the wider gate.
    const at = appSource.indexOf("paths: ['', 'downloads', ':id']");
    expect(at).toBeGreaterThan(-1);
    const general = appSource.slice(at, appSource.indexOf('},', at));
    expect(general).not.toContain("'import'");
    expect(general).not.toContain('BulkImportPage');
  });
});
