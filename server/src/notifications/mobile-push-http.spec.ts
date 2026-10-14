import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MobilePushController } from './mobile-push.controller';
import { MobilePushService } from './mobile-push.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AuthService } from '../auth/auth.service';
import { MobileSessionService } from '../auth/mobile-session.service';
import { PrismaService } from '../prisma/prisma.service';

describe('native push HTTP authentication boundary',()=>{
 let app:INestApplication;
 const sid='mobile:LOCAL_QA_HTTP';
 const db={user_sessions:{findUnique:jest.fn().mockResolvedValue({sid,sess:{mobile:true,userId:1},expire:new Date(Date.now()+60000)})},mobile_push_devices:{findUnique:jest.fn().mockResolvedValue({expires_at:new Date(0)}),deleteMany:jest.fn(),upsert:jest.fn()},$transaction:jest.fn()};
 const oldFlag=process.env.NATIVE_PUSH_ENABLED,oldSecret=process.env.EXPO_PUSH_ACCESS_TOKEN;
 beforeAll(async()=>{process.env.NATIVE_PUSH_ENABLED='true';process.env.EXPO_PUSH_ACCESS_TOKEN='LOCAL_QA_mock_only';db.$transaction.mockImplementation(fn=>fn(db));const module=await Test.createTestingModule({controllers:[MobilePushController],providers:[MobilePushService,AuthGuard,{provide:PrismaService,useValue:db},{provide:AuthService,useValue:{loadUser:async()=>({id:1})}},{provide:MobileSessionService,useValue:{authenticate:async(header:string)=>header==='Bearer LOCAL_QA_VERIFIED'?{sid,userId:1}:null}}]}).compile();app=module.createNestApplication();app.use((req:any,_res:any,next:()=>void)=>{if(req.headers.cookie==='local=qa')req.session={userId:1};next();});await app.init();});
 afterAll(async()=>{await app.close();if(oldFlag===undefined)delete process.env.NATIVE_PUSH_ENABLED;else process.env.NATIVE_PUSH_ENABLED=oldFlag;if(oldSecret===undefined)delete process.env.EXPO_PUSH_ACCESS_TOKEN;else process.env.EXPO_PUSH_ACCESS_TOKEN=oldSecret;});
 it('rejects missing/invalid bearer and browser-only cookie sessions',async()=>{await request(app.getHttpServer()).get('/api/mobile/push').expect(401);await request(app.getHttpServer()).post('/api/mobile/push').set('Authorization','Bearer invalid').send({token:'ExpoPushToken[LOCAL_QA_HTTP_TOKEN]',platform:'ios'}).expect(401);await request(app.getHttpServer()).get('/api/mobile/push').set('Cookie','local=qa').expect(401);expect(db.mobile_push_devices.upsert).not.toHaveBeenCalled();});
 it('renews an expired opt-in on next foreground refresh rather than silently losing consent',async()=>{const response=await request(app.getHttpServer()).get('/api/mobile/push').set('Authorization','Bearer LOCAL_QA_VERIFIED').expect(200);expect(response.body).toEqual({enabled:true,registered:true});});
 it('uses the authenticated account/session and rejects malformed tokens/platform',async()=>{await request(app.getHttpServer()).post('/api/mobile/push').set('Authorization','Bearer LOCAL_QA_VERIFIED').send({token:'https://example.invalid',platform:'ios'}).expect(400);await request(app.getHttpServer()).post('/api/mobile/push').set('Authorization','Bearer LOCAL_QA_VERIFIED').send({token:'ExpoPushToken[LOCAL_QA_HTTP_TOKEN]',platform:'ios',user_id:99,session_sid:'mobile:other'}).expect(201);expect(db.mobile_push_devices.upsert.mock.calls[0][0].create.user_id).toBe(1);expect(db.mobile_push_devices.upsert.mock.calls[0][0].where.session_sid).toBe(sid);});
 it('removes only this authenticated session',async()=>{await request(app.getHttpServer()).delete('/api/mobile/push').set('Authorization','Bearer LOCAL_QA_VERIFIED').expect(200);expect(db.mobile_push_devices.deleteMany).toHaveBeenLastCalledWith({where:{user_id:1,session_sid:sid}});});
});
