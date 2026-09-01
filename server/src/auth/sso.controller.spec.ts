import { SsoController } from './sso.controller';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SsoAuthorizeDto } from './dto/sso.dto';

describe('SsoController', () => {
  it('returns an allowlisted callback carrying only code and state', async () => {
    const sso = {
      issue: jest.fn(async () => ({ code: 'c'.repeat(43), expiresIn: 60 })),
      exchange: jest.fn(),
    };
    const controller = new SsoController(sso as never);
    const result = await controller.authorize({ id: 7 } as never, {
      client_id: 'precon',
      redirect_uri: 'https://precon.gethomerealty.ca/api/auth/crm/callback',
      code_challenge: 'p'.repeat(43),
      code_challenge_method: 'S256',
      state: 'state-value-12345',
    });

    const callback = new URL(result.redirect_url);
    expect(callback.origin + callback.pathname).toBe('https://precon.gethomerealty.ca/api/auth/crm/callback');
    expect(callback.searchParams.get('code')).toBe('c'.repeat(43));
    expect(callback.searchParams.get('state')).toBe('state-value-12345');
    expect(result.expires_in).toBe(60);
  });

  it('maps the private exchange request without returning the client secret', async () => {
    const identity = { sub: '7', name: 'Prudhvi', email: 'p@example.com', username: 'prudhvi', role: 'agent' };
    const sso = { issue: jest.fn(), exchange: jest.fn(async () => identity) };
    const controller = new SsoController(sso as never);
    const result = await controller.token({
      client_id: 'precon',
      client_secret: 's'.repeat(48),
      redirect_uri: 'https://precon.gethomerealty.ca/api/auth/crm/callback',
      code: 'c'.repeat(43),
      code_verifier: 'v'.repeat(43),
    });

    expect(result).toEqual(identity);
    expect(JSON.stringify(result)).not.toContain('s'.repeat(48));
  });

  it('accepts an absolute localhost callback for local testing', async () => {
    const dto = plainToInstance(SsoAuthorizeDto, {
      client_id: 'precon',
      redirect_uri: 'http://localhost:3000/api/auth/crm/callback',
      code_challenge: 'p'.repeat(43),
      code_challenge_method: 'S256',
      state: 'state-value-12345',
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});
