import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { InboxReplyController } from './inbox-reply.controller';
import { InboxReplyService } from './inbox-reply.service';
import { InboxService } from './inbox.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AuthService } from '../auth/auth.service';
import { MobileSessionService } from '../auth/mobile-session.service';
import { AreaGuard } from '../core/area.guard';
import { ModuleAccessService } from '../core/module-access.service';

describe('inbox send HTTP authentication and area boundary', () => {
  let app: INestApplication;
  const replies = { submit: jest.fn().mockResolvedValue({ status: 'accepted' }), recover: jest.fn().mockResolvedValue({ status: 'pending' }) };
  const mailbox = { composeContext: jest.fn().mockResolvedValue({ account_id: 11, from: 'test@example.invalid', sending_enabled: false }) };
  const modules = { canOpen: jest.fn().mockResolvedValue(true), licence: async () => ({ crm: true, desk: true }) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [InboxReplyController], providers: [
      AuthGuard, AreaGuard,
      { provide: InboxReplyService, useValue: replies }, { provide: InboxService, useValue: mailbox },
      { provide: AuthService, useValue: { loadUser: async (id: number) => ({ id }) } },
      { provide: MobileSessionService, useValue: { authenticate: async (header: string) => header === 'Bearer synthetic' ? { userId: 7, sid: 'test' } : null } },
      { provide: ModuleAccessService, useValue: modules },
    ] }).compile();
    app = module.createNestApplication(); await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { jest.clearAllMocks(); modules.canOpen.mockResolvedValue(true); });
  it('rejects unauthenticated send and recovery without calling services', async () => {
    await request(app.getHttpServer()).post('/account/inbox-replies/23?area=crm').send({}).expect(401);
    await request(app.getHttpServer()).get('/account/inbox-replies/submissions/key?area=crm').expect(401);
    expect(replies.submit).not.toHaveBeenCalled(); expect(replies.recover).not.toHaveBeenCalled();
  });
  it('rejects absent/invalid area and inaccessible module', async () => {
    for (const suffix of ['', '?area=unknown']) await request(app.getHttpServer()).post(`/account/inbox-replies/23${suffix}`).set('Authorization', 'Bearer synthetic').send({}).expect(400);
    modules.canOpen.mockResolvedValue(false);
    await request(app.getHttpServer()).post('/account/inbox-replies/23?area=crm').set('Authorization', 'Bearer synthetic').send({}).expect(403);
    expect(replies.submit).not.toHaveBeenCalled();
  });
  it('passes only authenticated identity and hides internal mailbox identifiers', async () => {
    await request(app.getHttpServer()).post('/account/inbox-replies/0?area=crm').set('Authorization', 'Bearer synthetic').send({ body_text: 'test' }).expect(201);
    expect(replies.submit).toHaveBeenCalledWith(7, 'crm', 0, { body_text: 'test' });
    const result = await request(app.getHttpServer()).get('/account/inbox-replies/compose-context?area=crm').set('Authorization', 'Bearer synthetic').expect(200);
    expect(result.body.account_id).toBeUndefined();
    expect(result.body.from).toBe('test@example.invalid');
  });
});
