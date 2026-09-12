import { SCREEN_META, type ScreenMeta } from '../auth/decorators';
import { DashboardController } from './dashboard.controller';

/**
 * THE THREE DESK DASHBOARD ROUTES MUST NAME THEIR AREA. (TD-179)
 *
 * ================================================================================================
 * THE DEFECT THIS PINS DOWN. `/dashboard/commissions`, `/dashboard/reviews` and
 * `/dashboard/review-errors` carried `@Screen('dashboard', 'view')` with no area. `SCREEN_DOMAIN`
 * classifies `dashboard` as `common`, and `common` is a marking rather than an area, so `isArea`
 * returns false for it and ScreenGuard SKIPS THE MODULE CHECK ENTIRELY. A login holding the CRM
 * alone - an ordinary thing to set up for an office or marketing hire - could therefore read the
 * brokerage's upcoming commission totals and the Desk review figures, while being correctly
 * refused every deal, every invoice and the Desk dashboard itself.
 * ================================================================================================
 *
 * WHY THIS IS A METADATA TEST RATHER THAN A SIGN-IN TEST. The only login on the system holding the
 * CRM alone is the brokerage's own Facebook test account, which is in use; a test that signs in as
 * it would be a test nobody could safely run. Reading what the route DECLARES proves the same
 * thing, costs nothing, and - the part that matters - fails the build if the third argument is
 * ever dropped again, which is exactly how the gap appeared.
 *
 * ALL THREE ROUTES BELONG TO THE DESK, and establishing that mattered more than it looks: the two
 * reviews routes call `TransactionReviewService`, the Transaction Desk deal-review workflow, NOT
 * the CRM Client Reviews module, even though `SCREEN_DOMAIN` classifies a screen called `reviews`
 * as `crm`. Two different things share the word.
 */
function screenMetaFor(handler: string): ScreenMeta | undefined {
  const proto = DashboardController.prototype as unknown as Record<string, unknown>;
  const fn = proto[handler];
  if (typeof fn !== 'function') {
    throw new Error(`DashboardController has no handler named ${handler}`);
  }
  return Reflect.getMetadata(SCREEN_META, fn as object) as ScreenMeta | undefined;
}

describe('Transaction Desk dashboard routes declare their area', () => {
  it.each(['commissions', 'reviews', 'reviewErrors'])(
    '%s names the desk area, so ScreenGuard runs the module check',
    (handler) => {
      expect(screenMetaFor(handler)).toEqual({ screen: 'dashboard', level: 'view', area: 'desk' });
    },
  );
});
