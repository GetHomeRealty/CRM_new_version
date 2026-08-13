import { GoogleService } from './google.service';

/**
 * `GoogleService.getEvent`, which `scripts/relabel-legacy-google-events.cjs` leans on entirely.
 *
 * That script decides which area an old event belongs to from whether each connected calendar
 * returns it. So the ONE distinction that matters is between "this calendar does not have it" and
 * "the question could not be answered": a 404 means absent, and a 401/403/500 means unknown. If a
 * failure were reported as an absence, an expired token on one side would look like proof the event
 * lived on the other, and the script would relabel a few hundred events on the strength of an auth
 * error.
 *
 * `fetch` is stubbed, so nothing here reaches Google.
 */

const svc = new GoogleService();
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const respond = (status: number, body: unknown = {}) => {
  global.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
};

describe('getEvent tells absence apart from failure', () => {
  it('returns the event when the calendar has it', async () => {
    respond(200, { id: 'abc', summary: 'Showing at 12 Elm St' });
    const ev = await svc.getEvent('token', 'primary', 'abc');
    expect(ev?.id).toBe('abc');
    expect(ev?.summary).toBe('Showing at 12 Elm St');
  });

  it('returns null on 404 — a real answer, not an error', async () => {
    respond(404, { error: { message: 'Not Found' } });
    await expect(svc.getEvent('token', 'primary', 'abc')).resolves.toBeNull();
  });

  it('returns null on 410, which is how Google reports a deleted event', async () => {
    respond(410, { error: { message: 'Gone' } });
    await expect(svc.getEvent('token', 'primary', 'abc')).resolves.toBeNull();
  });

  it.each([401, 403, 429, 500, 503])('THROWS on %i rather than reporting absence', async (status) => {
    respond(status, { error: { message: 'nope' } });
    // The script treats a throw as "conclude nothing and leave the row alone". Returning null here
    // would instead be read as "not in this calendar", which is how a token problem turns into a
    // few hundred events being relabelled to the wrong area.
    await expect(svc.getEvent('token', 'primary', 'abc')).rejects.toThrow(/HTTP (401|403|429|500|503)/);
  });

  it('does not send the id or calendar unencoded', async () => {
    let seen = '';
    global.fetch = (async (url: string) => {
      seen = String(url);
      return { ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '{}' };
    }) as unknown as typeof fetch;

    await svc.getEvent('token', 'user@example.com', 'id/with slash');
    expect(seen).toContain(encodeURIComponent('user@example.com'));
    expect(seen).toContain(encodeURIComponent('id/with slash'));
    expect(seen).not.toContain('id/with slash');
  });
});
