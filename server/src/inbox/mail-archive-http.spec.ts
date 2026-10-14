import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { MailArchiveController } from './mail-archive.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AuthService } from '../auth/auth.service';
import { MobileSessionService } from '../auth/mobile-session.service';
import { AreaGuard } from '../core/area.guard';
import { ModuleAccessService } from '../core/module-access.service';

describe('mail archive HTTP authorization and cache policy', () => {
  let app: INestApplication;
  const previous = process.env.INBOX_ARCHIVE_ENABLED;
  const db = { $queryRaw: jest.fn().mockResolvedValue([]) };
  const modules = { canOpen: jest.fn().mockResolvedValue(true), licence: async () => ({ crm: true, desk: true }) };
  beforeAll(async () => {
    process.env.INBOX_ARCHIVE_ENABLED = 'true';
    const module = await Test.createTestingModule({ controllers: [MailArchiveController], providers: [
      AuthGuard, AreaGuard, { provide: PrismaService, useValue: db },
      { provide: AuthService, useValue: { loadUser: async (id: number) => ({ id }) } },
      { provide: MobileSessionService, useValue: { authenticate: async (header: string) => header === 'Bearer synthetic' ? { userId: 7, sid: 'test' } : null } },
      { provide: ModuleAccessService, useValue: modules },
    ] }).compile();
    app = module.createNestApplication(); await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => { await app.close(); if (previous === undefined) delete process.env.INBOX_ARCHIVE_ENABLED; else process.env.INBOX_ARCHIVE_ENABLED = previous; });
  beforeEach(() => { jest.clearAllMocks(); modules.canOpen.mockResolvedValue(true); });
  it('denies unauthenticated, invalid-area and unlicensed requests before database access', async () => {
    await request(app.getHttpServer()).get('/account/mail-archive/sent?area=crm').expect(401);
    await request(app.getHttpServer()).get('/account/mail-archive/sent?area=invalid').set('Authorization', 'Bearer synthetic').expect(400);
    modules.canOpen.mockResolvedValue(false);
    await request(app.getHttpServer()).get('/account/mail-archive/sent?area=crm').set('Authorization', 'Bearer synthetic').expect(403);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('uses authenticated user, not query impersonation, and disables caching', async () => {
    await request(app.getHttpServer()).get('/account/mail-archive/sent?area=crm&user_id=999').set('Authorization', 'Bearer synthetic').expect(200).expect('Cache-Control', 'no-store');
    expect(db.$queryRaw.mock.calls[0].slice(1)).toEqual([7, 0]);
  });
});
