import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MobilePushService } from './mobile-push.service';
import { MobileSessionService } from '../auth/mobile-session.service';
import type { PrismaService } from '../prisma/prisma.service';
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/invalid');
if (url.hostname !== '127.0.0.1' || url.port !== '5432' || url.pathname !== '/gh_mobile_test' || process.env.NODE_ENV !== 'test') throw new Error('Requires isolated local mobile database.');
const db = new PrismaClient();
const rollback = new Error('LOCAL QA rollback');
async function fixture(work: (push: MobilePushService, sessions: MobileSessionService, tx: any, userId: number) => Promise<void>) {
  try {
    await db.$transaction(async tx => {
      const facade = new Proxy(tx, { get(target, key) { if (key === '$transaction') return async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx); return Reflect.get(target,key); } }) as unknown as PrismaService;
      const user = await tx.users.create({data:{name:'LOCAL QA native push',email:`native-push-${randomUUID()}@example.invalid`,password:'LOCAL_QA_no_login',status:'Active'}});
      const push = new MobilePushService(facade);
      jest.spyOn(push as unknown as {postExpo: (action:string, body:object)=>Promise<unknown>}, 'postExpo').mockResolvedValue({data:{status:'ok',id:randomUUID()}});
      const sessions = new MobileSessionService(facade, {get:()=>({mobileSessionLifetimeDays:30})} as unknown as ConfigService);
      await work(push,sessions,tx,user.id);
      throw rollback;
    }, {timeout:15000});
  } catch(error) { if(error!==rollback) throw error; }
}
describe('local native push session/registration integration', () => {
  const previous = {flag:process.env.NATIVE_PUSH_ENABLED,token:process.env.EXPO_PUSH_ACCESS_TOKEN};
  beforeAll(()=>{process.env.NATIVE_PUSH_ENABLED='true';process.env.EXPO_PUSH_ACCESS_TOKEN='LOCAL_QA_mock_only';});
  afterAll(async()=>{if(previous.flag===undefined)delete process.env.NATIVE_PUSH_ENABLED;else process.env.NATIVE_PUSH_ENABLED=previous.flag;if(previous.token===undefined)delete process.env.EXPO_PUSH_ACCESS_TOKEN;else process.env.EXPO_PUSH_ACCESS_TOKEN=previous.token;await db.$disconnect();});
  it('registers through real opaque mobile-session authentication and cascades on logout', async()=>fixture(async(push,sessions,tx,userId)=>{
    const credential=await sessions.issue(userId);const auth=await sessions.authenticate(`Bearer ${credential.accessToken}`);expect(auth?.userId).toBe(userId);
    await push.register(userId,auth!.sid,{token:'ExpoPushToken[LOCAL_QA_CASCADE_TOKEN]',platform:'ios'});
    expect(await push.status(userId,auth!.sid)).toEqual({enabled:true,registered:true});
    expect(await push.sendToUser(userId)).toEqual({accepted:1,failed:0});
    expect(await tx.mobile_push_receipts.count({where:{device:{user_id:userId}}})).toBe(1);
    await sessions.revoke(auth!.sid);
    expect(await tx.mobile_push_devices.count({where:{user_id:userId}})).toBe(0);
    expect(await tx.mobile_push_receipts.count({where:{push_token:'ExpoPushToken[LOCAL_QA_CASCADE_TOKEN]'}})).toBe(0);
    expect(await push.sendToUser(userId)).toEqual({accepted:0,failed:0});
  }));
  it('rejects a different account even with a valid session SID',async()=>fixture(async(push,sessions,_tx,userId)=>{
    const credential=await sessions.issue(userId);const auth=await sessions.authenticate(`Bearer ${credential.accessToken}`);
    await expect(push.register(userId+99999,auth!.sid,{token:'ExpoPushToken[LOCAL_QA_PRIVATE_TOKEN]',platform:'ios'})).rejects.toThrow();
  }));
  it('moves one device token to the newer session without duplicate bindings',async()=>fixture(async(push,sessions,tx,userId)=>{
    const first=await sessions.authenticate(`Bearer ${(await sessions.issue(userId)).accessToken}`);const next=await sessions.authenticate(`Bearer ${(await sessions.issue(userId)).accessToken}`);
    for(const sid of [first!.sid,next!.sid])await push.register(userId,sid,{token:'ExpoPushToken[LOCAL_QA_SINGLE_TOKEN]',platform:'android'});
    expect(await tx.mobile_push_devices.count({where:{user_id:userId}})).toBe(1);expect((await tx.mobile_push_devices.findFirst({where:{user_id:userId}})).session_sid).toBe(next!.sid);
  }));
  it('expired leases and sessions are excluded from delivery',async()=>fixture(async(push,sessions,tx,userId)=>{
    const auth=await sessions.authenticate(`Bearer ${(await sessions.issue(userId)).accessToken}`);await push.register(userId,auth!.sid,{token:'ExpoPushToken[LOCAL_QA_EXPIRED_TOKEN]',platform:'ios'});
    await tx.mobile_push_devices.update({where:{session_sid:auth!.sid},data:{expires_at:new Date(0)}});expect(await push.sendToUser(userId)).toEqual({accepted:0,failed:0});
    await tx.mobile_push_devices.update({where:{session_sid:auth!.sid},data:{expires_at:new Date(Date.now()+60000)}});await tx.user_sessions.update({where:{sid:auth!.sid},data:{expire:new Date(0)}});expect(await push.sendToUser(userId)).toEqual({accepted:0,failed:0});
  }));
});
