import {Injectable,OnModuleInit,OnModuleDestroy} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import type {AuthUserRecord} from '../auth/auth.types';
import {parseJsonObject} from '../common/serialize';
import {MobileInvoiceMailService} from './mobile-invoice-mail.service';
import {invoiceHash} from './mobile-invoices.service';
import {invoiceReminderDue,torontoDate} from './invoice-reminder-calendar';
@Injectable()
export class MobileInvoiceReminderScheduler implements OnModuleInit,OnModuleDestroy {
 private timer:ReturnType<typeof setInterval>|null=null;
 onModuleInit(){if(process.env.RUN_SCHEDULERS!=='true'||process.env.NODE_ENV==='test'||process.env.DESK_INVOICE_EMAIL_ENABLED!=='true')return;this.timer=setInterval(()=>{const now=new Date();const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);if(parts.find(p=>p.type==='hour')?.value==='09'&&parts.find(p=>p.type==='minute')?.value==='15')void this.tick(now).catch(()=>{});},60000);this.timer.unref();}
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);this.timer=null;}
 private running=false;
 constructor(private readonly prisma:PrismaService,private readonly mail:MobileInvoiceMailService){}
 async tick(now=new Date()){
  if(this.running||process.env.RUN_SCHEDULERS!=='true'||process.env.NODE_ENV==='test'||process.env.DESK_INVOICE_EMAIL_ENABLED!=='true')return;this.running=true;
  try{let cursor=0;for(;;){const rows=await this.prisma.invoices.findMany({where:{id:{gt:cursor},deleted_at:null,balance_due:{gt:0},status:{notIn:['Paid','Void']},auto_reminder:{not:null}},orderBy:{id:'asc'},take:100});if(!rows.length)break;cursor=rows[rows.length-1].id;for(const invoice of rows){const config=parseJsonObject(invoice.auto_reminder);if(!invoiceReminderDue(config,now)||!Number.isSafeInteger(config.mobile_owner_id))continue;const user=await this.prisma.users.findFirst({where:{id:Number(config.mobile_owner_id),status:'Active'},include:{user_permissions:true,user_modules:true}});if(!user)continue;try{const raw=invoiceHash([user.id,invoice.id,'reminder',torontoDate(now)]),requestId=`${raw.slice(0,8)}-${raw.slice(8,12)}-4${raw.slice(13,16)}-8${raw.slice(17,20)}-${raw.slice(20,32)}`;try{await this.mail.recover(user as AuthUserRecord,invoice.id,requestId);continue;}catch{}const plan=await this.mail.preview(user as AuthUserRecord,invoice.id,'reminder');if(!plan.can_send||!('version'in plan))continue;await this.mail.send(user as AuthUserRecord,invoice.id,{confirmed:true,event:'reminder',version:plan.version,request_id:requestId});}catch{/* No provider error/recipient details in logs; unresolved receipts block future retries. */}}if(rows.length<100)break;}}finally{this.running=false;}
 }
}
