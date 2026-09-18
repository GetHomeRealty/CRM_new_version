import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';

/** A-1 - fetching one user, without loading the whole table to find them. */
describe('one user by id', () => {
  const build = (found: unknown) => {
    const svc = Object.create(UsersService.prototype) as Record<string, unknown> & {
      show: (id: number) => Promise<Record<string, unknown>>;
    };
    const calls: unknown[] = [];
    svc.prisma = { users: { findUnique: async (args: unknown) => { calls.push(args); return found; } } };
    svc.payload = (u: { id: number }) => ({ id: u.id, shaped: true });
    return { svc, calls };
  };

  it('returns the same shape the list emits per row', async () => {
    const { svc } = build({ id: 2903 });
    await expect(svc.show(2903)).resolves.toEqual({ id: 2903, shaped: true });
  });

  it('asks for the permissions and modules the row carries', async () => {
    const { svc, calls } = build({ id: 7 });
    await svc.show(7);
    expect(JSON.stringify(calls[0])).toContain('user_permissions');
    expect(JSON.stringify(calls[0])).toContain('user_modules');
  });

  it('says not found rather than returning nothing', async () => {
    const { svc } = build(null);
    await expect(svc.show(999999)).rejects.toBeInstanceOf(NotFoundException);
  });
});
