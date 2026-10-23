import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UsersAccessGuard, hasUsersFullAccess } from './team-lead';
import { UserPhotoService } from './user-photo.service';
import { isSuperAdmin } from '../core/authz';

/**
 * ACCOUNTING HAS THE USERS MODULE AS A SUPER ADMIN HAS IT (brokerage request, 2026-10-21) — and
 * only that module: it is still not a Super Admin anywhere else, and the roles that were refused
 * before are refused still.
 */

const ctx = (role: string, extra: Record<string, unknown> = {}): ExecutionContext => ({
  switchToHttp: () => ({ getRequest: () => ({ authUser: { id: 7, role, status: 'Active', ...extra } }) }),
  getHandler: () => () => undefined,
  getClass: () => class {},
}) as unknown as ExecutionContext;

describe('Users module access', () => {
  const guard = new UsersAccessGuard(new Reflector());

  it('lets a Super Admin and Accounting through every Users endpoint', () => {
    expect(guard.canActivate(ctx('admin'))).toBe(true);
    expect(guard.canActivate(ctx('accounting'))).toBe(true);
  });

  it('still refuses the roles it refused before', () => {
    for (const role of ['manager', 'documentation', 'crm', 'agent', 'recruiter']) {
      expect(() => guard.canActivate(ctx(role))).toThrow(ForbiddenException);
    }
  });

  it('is the Users module only: Accounting is not made a Super Admin', () => {
    expect(hasUsersFullAccess({ role: 'accounting' })).toBe(true);
    expect(isSuperAdmin({ role: 'accounting' })).toBe(false);
    expect(hasUsersFullAccess({ role: 'manager' })).toBe(false);
  });

  it("lets Accounting change somebody else's profile picture, as a Super Admin may", () => {
    const photos = new UserPhotoService(null as never, null as never);
    expect(() => photos.assertMayManage({ id: 1, role: 'accounting' } as never, 99)).not.toThrow();
    expect(() => photos.assertMayManage({ id: 1, role: 'documentation' } as never, 99)).toThrow(ForbiddenException);
  });
});
