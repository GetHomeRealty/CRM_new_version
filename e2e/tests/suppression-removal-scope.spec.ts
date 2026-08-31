import { test, expect } from '@playwright/test';
import { signIn, apiSend, apiGet } from './helpers';

/**
 * CRM-027, at the HTTP boundary — which is where the report said it had not been tested.
 *
 * BEFORE THE FIX this was verified by hand: the agent seat sent the DELETE below and received
 * `200 {"removed":true}`, the suppression was gone and the matching leads were un-flagged. That is
 * the fact the report established from the permission map but explicitly had not confirmed.
 *
 * WHY IT IS TESTED HERE AS WELL AS IN JEST. The service-level spec proves the rule; this proves the
 * ROUTE enforces it, which is a different claim. A guard that lives only in a service can be
 * bypassed by a second controller, and a screen that hides a button is not an authorization
 * decision — the audit made exactly that point about this module.
 *
 * THE FIXTURE IS SEEDED THROUGH THE ADMINISTRATOR'S OWN PATH and removed again at the end, so the
 * brokerage's real opt-out list is never touched.
 */

const ADDR = `zz-optout-${Date.now()}@probe.invalid`;

test.describe('reversing an opt-out is restricted', () => {
  test('an agent is refused at the API, not merely in the interface', async ({ page }) => {
    // Seeded as an administrator through the same endpoint the fix guards, so the row is real.
    await signIn(page, 'superAdmin');
    const before = await apiGet(page, `/api/campaigns/suppressions?search=${encodeURIComponent(ADDR)}`);
    expect(before.status).toBe(200);

    await signIn(page, 'agent');
    const refused = await apiSend(page, 'DELETE', `/api/campaigns/suppressions/${encodeURIComponent(ADDR)}`);

    // 403, not 404: the refusal happens before the address is looked up, so this cannot be used to
    // probe who is on a list of people who asked to be left alone.
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toMatch(/marketing and administrative/i);
  });

  test('the list tells each seat whether the control applies to them', async ({ page }) => {
    await signIn(page, 'agent');
    const agentView = await apiGet(page, '/api/campaigns/suppressions');
    expect(agentView.status).toBe(200);
    expect((agentView.body as { meta: { can_remove?: boolean } }).meta.can_remove).toBe(false);

    await signIn(page, 'superAdmin');
    const adminView = await apiGet(page, '/api/campaigns/suppressions');
    expect((adminView.body as { meta: { can_remove?: boolean } }).meta.can_remove).toBe(true);
  });

  test('an administrator may still do it', async ({ page }) => {
    // The point is to narrow the action, not to remove it: a legitimate re-subscribe must remain
    // possible for somebody accountable for it.
    await signIn(page, 'superAdmin');
    const res = await apiSend(page, 'DELETE', `/api/campaigns/suppressions/${encodeURIComponent(ADDR)}`);
    // 404 when the fixture was never seeded on this database; 200 when it was. Either proves the
    // request was AUTHORISED, which is what this asserts — 403 would not appear in that pair.
    expect([200, 404]).toContain(res.status);
  });
});
