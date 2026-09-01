import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SsoAuthorizationService } from './sso-authorization.service';

const CLIENT = {
  clientId: 'precon',
  clientSecret: 's'.repeat(48),
  redirectUris: ['https://precon.gethomerealty.ca/api/auth/crm/callback'],
  codeLifetimeSeconds: 60,
};
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const user = (status = 'Active') => ({
  id: 7,
  name: 'Prudhvi',
  username: 'prudhvi',
  email: 'prudhvi@example.com',
  role: 'agent',
  status,
});

function fixture() {
  const rows = new Map<string, Record<string, any>>();
  const prisma = {
    sso_authorization_codes: {
      create: jest.fn(async ({ data }: any) => { rows.set(data.code_hash, { ...data, consumed_at: null, users: user() }); }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.code_hash);
        if (!row || row.client_id !== where.client_id || row.redirect_uri !== where.redirect_uri
          || row.code_challenge !== where.code_challenge || row.consumed_at
          || row.expires_at <= where.expires_at.gt) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.code_hash) ?? null),
    },
  };
  const config = { get: jest.fn((key: string) => key === 'sso' ? CLIENT : undefined) };
  return { service: new SsoAuthorizationService(prisma as never, config as never), prisma, rows };
}

describe('SsoAuthorizationService', () => {
  it('stores only a hash and issues a short-lived code for an active CRM user', async () => {
    const { service, prisma } = fixture();
    const issued = await service.issue(user() as never, {
      clientId: CLIENT.clientId,
      redirectUri: CLIENT.redirectUris[0],
      codeChallenge: CHALLENGE,
    });

    expect(issued.code).toHaveLength(43);
    expect(issued.expiresIn).toBe(60);
    const stored = prisma.sso_authorization_codes.create.mock.calls[0][0].data;
    expect(stored.code_hash).toBe(createHash('sha256').update(issued.code).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(issued.code);
  });

  it('rejects an unregistered callback instead of becoming an open redirect', async () => {
    const { service } = fixture();
    await expect(service.issue(user() as never, {
      clientId: CLIENT.clientId,
      redirectUri: 'https://evil.example/callback',
      codeChallenge: CHALLENGE,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not issue a code to an inactive CRM user', async () => {
    const { service } = fixture();
    await expect(service.issue(user('Inactive') as never, {
      clientId: CLIENT.clientId,
      redirectUri: CLIENT.redirectUris[0],
      codeChallenge: CHALLENGE,
    })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('exchanges a code once when the client secret and PKCE verifier are correct', async () => {
    const { service } = fixture();
    const issued = await service.issue(user() as never, {
      clientId: CLIENT.clientId,
      redirectUri: CLIENT.redirectUris[0],
      codeChallenge: CHALLENGE,
    });
    const exchange = {
      clientId: CLIENT.clientId,
      clientSecret: CLIENT.clientSecret,
      redirectUri: CLIENT.redirectUris[0],
      code: issued.code,
      codeVerifier: VERIFIER,
    };

    await expect(service.exchange(exchange)).resolves.toEqual({
      sub: '7', name: 'Prudhvi', email: 'prudhvi@example.com', username: 'prudhvi', role: 'agent',
    });
    await expect(service.exchange(exchange)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong PKCE verifier without consuming the code', async () => {
    const { service } = fixture();
    const issued = await service.issue(user() as never, {
      clientId: CLIENT.clientId,
      redirectUri: CLIENT.redirectUris[0],
      codeChallenge: CHALLENGE,
    });

    await expect(service.exchange({
      clientId: CLIENT.clientId,
      clientSecret: CLIENT.clientSecret,
      redirectUri: CLIENT.redirectUris[0],
      code: issued.code,
      codeVerifier: 'x'.repeat(43),
    })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
