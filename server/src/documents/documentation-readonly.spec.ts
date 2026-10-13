import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { DocumentationReadOnlyGuard } from './documentation-readonly.guard';

/**
 * DOCUMENTS ARE READ-ONLY FOR THE DOCUMENTATION ROLE, ON THE SERVER.
 *
 * WHY THE SERVER HALF MATTERS MORE THAN THE SCREEN. The screen passing `readOnly` is what the
 * person sees; it is not a restriction. The document write routes are gated on
 * `transactions: 'edit'`, which this role HOLDS and genuinely needs for conditions, clients and
 * the co-op brokerage — so until this guard existed, every one of the eleven write routes was
 * reachable by this role with a hand-made request, a stale tab, or a `?mode=edit` URL.
 *
 * WHAT THIS COSTS, STATED PLAINLY. This is a REDUCTION in what the Documentation role can do.
 * Uploading, replacing, submitting and deleting document drafts were all previously allowed and
 * are now refused. The brokerage asked for it on 2026-10-13; it is recorded here so that whoever
 * finds this role unable to attach a file knows it was deliberate and when.
 *
 * WHAT IT DOES NOT TOUCH, and these are asserted rather than assumed: reading and downloading
 * every document on the deal, and every other role's access.
 */

/** A request as the guard sees it. */
function ctx(method: string, role?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, authUser: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext;
}

const guard = new DocumentationReadOnlyGuard();

describe('a documentation user may read documents', () => {
  it('ALLOWS EVERY READ, so the role can still see and download the paperwork', () => {
    // The point of the role is the paperwork. Taking away reading would not be a restriction,
    // it would be removing the job.
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(guard.canActivate(ctx(method, 'documentation'))).toBe(true);
    }
  });
});

describe('a documentation user may not change documents', () => {
  it('REFUSES EVERY WRITE METHOD, whatever the route is called', () => {
    /*
     * By METHOD rather than by path. The controller has eleven write routes today and the twelfth
     * is the one somebody adds without remembering this rule; a check on method covers the routes
     * that exist and the ones that do not exist yet.
     */
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      expect(() => guard.canActivate(ctx(method, 'documentation'))).toThrow(ForbiddenException);
    }
  });

  it('says what happened and what to do instead, rather than failing blankly', () => {
    try {
      guard.canActivate(ctx('PUT', 'documentation'));
      throw new Error('should have refused');
    } catch (e) {
      const body = (e as ForbiddenException).getResponse() as { message?: string };
      expect(body.message).toMatch(/view-only/i);
      expect(body.message).toMatch(/Admin/i);
    }
  });
});

describe('no other role is affected', () => {
  it('LEAVES EVERY OTHER ROLE ALONE, on reads and on writes', () => {
    /*
     * The requirement that matters most alongside the restriction: "other roles must continue
     * working exactly as before". A guard that over-reaches here would stop the brokerage
     * uploading documents at all, which is a far worse outcome than the gap it was closing.
     */
    for (const role of ['admin', 'super_admin', 'manager', 'agent', 'accounting', 'crm', undefined]) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(guard.canActivate(ctx(method, role))).toBe(true);
      }
    }
  });

  it('a role whose name merely contains "documentation" is not caught by accident', () => {
    // Exact match, not a substring: `documentation_admin` would be a different role.
    expect(guard.canActivate(ctx('POST', 'documentation_admin'))).toBe(true);
    expect(guard.canActivate(ctx('POST', 'Documentation'))).toBe(true);
  });
});

/*
 * WHETHER THE GUARD IS ACTUALLY WIRED UP is asserted in
 * `e2e/tests/documentation-quick-actions-view-only.spec.ts`, not here.
 *
 * It was tried here first, by reading `__guards__` off the controller class, and the controller
 * cannot be imported into Jest at all: it pulls in `src/common/archive.ts`, which imports
 * `archiver`, which is ESM-only and not transformed by this project's Jest config. That is a
 * fixable thing, but mocking a zip library to find out whether a guard is attached is a poor
 * trade when a browser test can send a real PUT as a real Documentation session and read the 403.
 * The e2e version also proves the guard is EFFECTIVE rather than merely present, which is the
 * property that matters.
 */
