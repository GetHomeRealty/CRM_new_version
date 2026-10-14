import 'reflect-metadata';
import { ClientReviewsService, reviewInput } from './client-reviews.service';
import { ClientReviewsController, ClientReviewResponseController } from './client-reviews.controller';
import { SCREEN_META } from '../auth/decorators';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
const token = 'a'.repeat(64), owner: any = { id: 7, name: 'QA', role: 'agent' };
function setup() {
  const store: any[] = [];
  const matches = (row: any, where: any): boolean => Object.entries(where).every(([key, value]: [string, any]) => value?.in ? value.in.includes(row[key]) : value?.gt ? row[key] > value.gt : value?.lt ? row[key] < value.lt : row[key] === value);
  const pick = (row: any, select: any) => row ? Object.fromEntries(Object.keys(select).map(key => [key, row[key] ?? null])) : null;
  const db: any = { client_review_requests: {
    findUnique: jest.fn(async ({ where, select }) => pick(store.find(row => row.owner_user_id === where.owner_user_id_submission_id.owner_user_id && row.submission_id === where.owner_user_id_submission_id.submission_id), select)),
    create: jest.fn(async ({ data, select }) => { const row = { ...data, id: store.length + 1, created_at: new Date() }; store.push(row); return pick(row, select); }),
    findFirst: jest.fn(async ({ where, select }) => pick(store.find(row => matches(row, where)), select)),
    findMany: jest.fn(async ({ where, select, take }) => store.filter(row => matches(row, where)).sort((a,b) => b.id-a.id).slice(0,take).map(row => pick(row,select))),
    updateMany: jest.fn(async ({ where, data }) => { let count=0; for(const row of store) if(matches(row,where)) {Object.assign(row,data);count++;} return {count}; }),
  }, transactions: { findFirst: jest.fn(async () => ({clients:[{id:2,name:'Client QA',email:'client@example.invalid'}]})), findMany: jest.fn(async () => []) }, mail_accounts: { findFirst: jest.fn(async () => ({id:3})), findMany: jest.fn(async () => []) } };
  const mailer: any = { sendOwnedReplyOnce: jest.fn(async () => {}) };
  return { store, db, mailer, service: new ClientReviewsService(db, mailer) };
}
const input = { transaction_id: 4, client_id: 2, submission_id:'11111111-1111-4111-8111-111111111111', send_email:false };
describe('Private client review workflow', () => {
  const oldEnv = { ...process.env };
  beforeEach(() => { process.env.APP_KEY = 'base64:' + Buffer.alloc(32, 7).toString('base64'); process.env.NODE_ENV='test'; process.env.CLIENT_REVIEWS_PUBLIC_URL='http://127.0.0.1:8000'; process.env.CLIENT_REVIEWS_EMAIL_ENABLED='false'; });
  afterAll(() => { process.env = oldEnv; });
  it('rejects invalid ratings/comments/tokens and hashes valid capabilities', () => {
    for(const rating of [0,6,1.5,'5',null]) expect(() => reviewInput({token,rating,comment:'QA'})).toThrow();
    for(const comment of ['', ' '.repeat(4), 'x'.repeat(5001), null]) expect(() => reviewInput({token,rating:5,comment})).toThrow();
    expect(() => reviewInput({token:'bad',rating:5,comment:'QA'})).toThrow();
    expect(reviewInput({token,rating:5,comment:' QA '})).toEqual({hash:createHash('sha256').update(token).digest('hex'),rating:5,comment:'QA'});
  });
  it('stores no cleartext capability; response-loss retry recovers the same encrypted link without creating/sending again', async () => {
    const {service,store,db,mailer}=setup(); const first=await service.request(owner,input), second=await service.request(owner,input);
    expect(second.link).toBe(first.link); expect(db.client_review_requests.create).toHaveBeenCalledTimes(1); expect(mailer.sendOwnedReplyOnce).not.toHaveBeenCalled();
    expect(store[0].link_ciphertext).not.toContain(first.link!.split('#')[1]); expect(first.request).not.toHaveProperty('token_hash'); expect(first.request).not.toHaveProperty('link_ciphertext');
    await expect(service.link({...owner,id:8},1)).rejects.toThrow();
    await service.cancel(owner,1); await expect(service.submit({token:first.link!.split('#')[1],rating:5,comment:'QA'})).rejects.toThrow();
  });
  it('closed-deal/client scope is checked and default-off/foreign/Desk mailbox/config failures never create or send', async () => {
    const {service,db}=setup();
    await expect(service.request(owner,{...input,send_email:true,account_id:3})).rejects.toThrow();
    db.transactions.findFirst.mockResolvedValue(null); await expect(service.request(owner,input)).rejects.toThrow();
    expect(db.transactions.findFirst.mock.calls[0][0].where.AND).toContainEqual({transaction_statuses:{some:{status:{in:['Closed','Sold','Leased']}}}});
    db.transactions.findFirst.mockResolvedValue({clients:[{id:2,name:'QA',email:'qa@example.invalid'}]});
    process.env.CLIENT_REVIEWS_EMAIL_ENABLED='true'; db.mail_accounts.findFirst.mockResolvedValue(null); await expect(service.request(owner,{...input,send_email:true,account_id:3})).rejects.toThrow();
    expect(db.mail_accounts.findFirst.mock.calls[0][0].where).toEqual({id:3,user_id:7,is_active:true,OR:[{scope:'crm'},{scope:null}]});
    for(const origin of ['http://example.invalid','https://u:p@example.invalid','https://example.invalid/path','ftp://localhost']) {process.env.CLIENT_REVIEWS_PUBLIC_URL=origin; await expect(service.request(owner,input)).rejects.toThrow();}
    expect(db.client_review_requests.create).not.toHaveBeenCalled();
  });
  it('SMTP failure is uncertain, retry never sends again, and submitted feedback is single-use inert text', async () => {
    const {service,store,mailer}=setup();process.env.CLIENT_REVIEWS_EMAIL_ENABLED='true';mailer.sendOwnedReplyOnce.mockRejectedValue(new Error('SMTP result lost'));
    const result=await service.request(owner,{...input,send_email:true,account_id:3});expect(result.request!.status).toBe('uncertain');await service.request(owner,{...input,send_email:true,account_id:3});expect(mailer.sendOwnedReplyOnce).toHaveBeenCalledTimes(1);
    const capability=result.link!.split('#')[1];await service.submit({token:capability,rating:4,comment:'<script>inert</script>'});expect(store[0].comment).toBe('<script>inert</script>');await expect(service.submit({token:capability,rating:1,comment:'overwrite'})).rejects.toThrow();await expect(service.link(owner,1)).rejects.toThrow();
  });
  it('expired links and foreign cancellation fail; bounded list hides hashes/links and selects owner', async () => {
    const {service,store}=setup();const result=await service.request(owner,input);store[0].expires_at=new Date(0);await expect(service.submit({token:result.link!.split('#')[1],rating:5,comment:'QA'})).rejects.toThrow();await expect(service.cancel({...owner,id:8},1)).rejects.toThrow();expect((await service.list({...owner,id:8})).data).toEqual([]);expect((await service.list(owner)).data[0]).not.toHaveProperty('link_ciphertext');await expect(service.list(owner,-1)).rejects.toThrow();
  });
  it('actual route metadata separates read/edit and response page has token-free URL, CSP/no-store/referrer protections', () => {
    const reflector=new Reflector();for(const method of ['request','choices','mailboxes','link','cancel'])expect(reflector.get(SCREEN_META,(ClientReviewsController.prototype as any)[method])).toEqual({screen:'reviews',level:'edit',area:undefined});expect(reflector.get(SCREEN_META,ClientReviewsController.prototype.list)).toMatchObject({screen:'reviews',level:'view'});
    const response:any={setHeader:jest.fn(),type:jest.fn().mockReturnThis(),send:jest.fn()};new ClientReviewResponseController({} as any).form(response);expect(response.setHeader).toHaveBeenCalledWith('Referrer-Policy','no-referrer');expect(response.send.mock.calls[0][0]).toContain("history.replaceState(null,'',location.pathname)");expect(response.send.mock.calls[0][0]).toContain("credentials:'omit'");
  });
  it('revokes an in-flight SMTP request without a late delivery result reviving its link', async () => {
    const { service, store, mailer } = setup(); process.env.CLIENT_REVIEWS_EMAIL_ENABLED='true';
    let finish!: () => void; mailer.sendOwnedReplyOnce.mockImplementation(() => new Promise<void>(resolve => {finish=resolve;}));
    const creation=service.request(owner,{...input,send_email:true,account_id:3});
    for(let i=0;i<10 && !finish;i++) await Promise.resolve();
    expect(store[0].status).toBe('sending'); await service.cancel(owner,1); finish(); await creation;
    expect(store[0].status).toBe('cancelled'); await expect(service.link(owner,1)).rejects.toThrow(); expect(mailer.sendOwnedReplyOnce).toHaveBeenCalledTimes(1);
  });


});
