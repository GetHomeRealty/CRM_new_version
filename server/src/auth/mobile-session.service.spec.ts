import { createHash } from 'node:crypto';
import { MobileSessionService } from './mobile-session.service';

function fixture() {
  const rows = new Map<string, { sid: string; sess: object; expire: Date }>();
  const prisma = {
    user_sessions: {
      create: jest.fn(async ({ data }: any) => { rows.set(data.sid, data); return data; }),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.sid) ?? null),
      deleteMany: jest.fn(async ({ where }: any) => ({ count: rows.delete(where.sid) ? 1 : 0 })),
    },
  };
  const config = { get: jest.fn(() => ({ mobileSessionLifetimeDays: 30 })) };
  return { service: new MobileSessionService(prisma as never, config as never), prisma, rows };
}

describe('MobileSessionService', () => {
  it('stores only a hash of the opaque credential and authenticates it', async () => {
    const { service, prisma, rows } = fixture();
    const issued = await service.issue(42);
    expect(issued.accessToken).toMatch(MobileSessionService.TOKEN_PATTERN);
    const sid = `mobile:${createHash('sha256').update(issued.accessToken).digest('hex')}`;
    expect(rows.has(sid)).toBe(true);
    expect(JSON.stringify(prisma.user_sessions.create.mock.calls[0])).not.toContain(issued.accessToken);
    await expect(service.authenticate(`Bearer ${issued.accessToken}`)).resolves.toEqual({ sid, userId: 42 });
  });

  it('rejects expired, malformed, and absent credentials', async () => {
    const { service, rows } = fixture();
    const issued = await service.issue(7);
    const sid = `mobile:${createHash('sha256').update(issued.accessToken).digest('hex')}`;
    rows.get(sid)!.expire = new Date(Date.now() - 1);
    await expect(service.authenticate(`Bearer ${issued.accessToken}`)).resolves.toBeNull();
    await expect(service.authenticate('Bearer not-a-token')).resolves.toBeNull();
    await expect(service.authenticate(undefined)).resolves.toBeNull();
  });

  it('revokes a mobile session without affecting other session rows', async () => {
    const { service, rows } = fixture();
    const issued = await service.issue(7);
    const sid = `mobile:${createHash('sha256').update(issued.accessToken).digest('hex')}`;
    rows.set('browser-session', { sid: 'browser-session', sess: { userId: 7 }, expire: new Date(Date.now() + 60_000) });
    await service.revoke(sid);
    expect(rows.has(sid)).toBe(false);
    expect(rows.has('browser-session')).toBe(true);
  });
});
