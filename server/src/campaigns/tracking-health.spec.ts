import { isPrivateHost } from './campaigns.controller';

/**
 * Open tracking fails silently: a pixel the recipient's mail client cannot load simply never
 * records anything, and the campaign shows zero opens with no error anywhere. The health check
 * is the only thing standing between that and a green banner, so the address classification it
 * relies on is worth pinning down.
 */
describe('tracking public-URL classification', () => {
  it('rejects loopback addresses', () => {
    for (const url of [
      'http://localhost:8000',
      'https://localhost',
      'http://127.0.0.1:8000',
      'http://127.1.2.3',
      'http://[::1]:8000',
      'http://0.0.0.0:8000',
    ]) {
      expect(isPrivateHost(url)).toBe(true);
    }
  });

  it('rejects private LAN ranges — reachable from the office, not from an inbox', () => {
    for (const url of [
      'http://10.0.0.5:8000',
      'http://192.168.1.20',
      'http://172.16.0.9',
      'http://172.31.255.254',
      'http://169.254.10.1',
      'http://desk.local',
    ]) {
      expect(isPrivateHost(url)).toBe(true);
    }
  });

  it('accepts genuinely public addresses', () => {
    for (const url of [
      'https://desk.gethomerealty.ca',
      'https://gethomehub.ca',
      'https://abc-123.trycloudflare.com',
      'http://203.0.113.10',
      // 172.32 is outside the private 172.16–172.31 block, so it is public.
      'http://172.32.0.1',
      'http://11.0.0.1',
    ]) {
      expect(isPrivateHost(url)).toBe(false);
    }
  });

  it('does not mistake a private-looking path or subdomain for the host', () => {
    expect(isPrivateHost('https://tracking.example.com/127.0.0.1')).toBe(false);
    expect(isPrivateHost('https://localhost.example.com')).toBe(false);
  });

  it('leaves an unparseable value to the live probe rather than guessing', () => {
    for (const bad of ['', 'not a url', '://broken']) {
      expect(isPrivateHost(bad)).toBe(false);
    }
  });
});
