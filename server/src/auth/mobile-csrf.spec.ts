import { CsrfGuard } from './guards/csrf.guard';

describe('Mobile/browser CSRF identity boundary', () => {
  const context = (req: object) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as never;
  it('requires browser CSRF even when a valid mobile bearer is present', async () => {
    const mobile = { authenticate: jest.fn().mockResolvedValue({ userId: 2, sid: 'mobile:test' }) };
    const guard = new CsrfGuard(mobile as never);
    const req = { method: 'POST', path: '/api/leads', headers: { authorization: 'Bearer synthetic' }, session: { userId: 1, csrfToken: 'browser-csrf' } };
    await expect(guard.canActivate(context(req))).rejects.toThrow();
    expect(mobile.authenticate).not.toHaveBeenCalled();
  });
  it('allows browser requests with matching CSRF without adopting the mobile identity', async () => {
    const mobile = { authenticate: jest.fn() };
    const req = { method: 'POST', path: '/api/leads', headers: { authorization: 'Bearer synthetic', 'x-xsrf-token': 'browser-csrf' }, session: { userId: 1, csrfToken: 'browser-csrf' } };
    await expect(new CsrfGuard(mobile as never).canActivate(context(req))).resolves.toBe(true);
    expect(mobile.authenticate).not.toHaveBeenCalled();
  });
  it('permits validated bearer-only requests and attaches their identity', async () => {
    const mobile = { authenticate: jest.fn().mockResolvedValue({ userId: 2, sid: 'mobile:test' }) };
    const req = { method: 'POST', path: '/api/leads', headers: { authorization: 'Bearer synthetic' } };
    await expect(new CsrfGuard(mobile as never).canActivate(context(req))).resolves.toBe(true);
    expect(req).toMatchObject({ mobileUserId: 2, mobileSessionSid: 'mobile:test' });
  });
});
