import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, type client_identifications } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccessService } from '../core/resource-access.service';
import { LaravelCryptService } from '../common/laravel-crypt.service';
import type { AuthUserRecord } from '../auth/auth.types';
import { checklistVisibility } from '../documents/checklist-visibility';
import { FORM630_FIELDS, makeForm630, type Form630Identity } from './form630-pdf';
@Injectable()
export class MobileForm630Service {
 constructor(private readonly prisma: PrismaService,private readonly access: ResourceAccessService,private readonly crypt: LaravelCryptService) {}
 private async snapshot(user: AuthUserRecord,txnId:number,clientId:number,db:Prisma.TransactionClient=this.prisma) {
  if(!user||!['admin','manager','accounting','documentation','crm','agent'].includes(user.role))throw new ForbiddenException();await this.access.assertTransaction(user,txnId);
  const txn=await db.transactions.findFirst({where:{id:txnId,deleted_at:null}});if(!txn)throw new NotFoundException();
  const client=await db.clients.findFirst({where:{id:clientId,transaction_id:txnId}});if(!client?.name)throw new NotFoundException();
  if(await db.clients.count({where:{transaction_id:txnId,name:client.name}})!==1)throw new UnprocessableEntityException({message:'Duplicate client names must be resolved before using per-client identification.'});
  const statuses=await db.transaction_statuses.findMany({where:{transaction_id:txnId},select:{status:true}});
  const documents=await db.documents.findMany({where:{transaction_id:txnId,deleted_at:null,pending_delete:false,title:{contains:'fintrac',mode:'insensitive'}}});
  if(!documents.some(checklistVisibility(txn.type,statuses.map(row=>row.status))))throw new ConflictException({message:'FINTRAC is not available on this transaction checklist. Refresh the transaction.'});
  const rec=await db.client_identifications.findUnique({where:{transaction_id_client_name:{transaction_id:txnId,client_name:client.name}}});
  const version=createHash('sha256').update(JSON.stringify([txnId,client.id,client.name,txn.type,txn.property,txn.agent,txn.offer_date,statuses.map(row=>row.status).sort(),rec])).digest('hex');
  return {txn,client,rec,version};
 }
 private decodeField(value:string|null):string {if(!value)return '';const decoded=this.crypt.decryptString(value);if(decoded===null)throw new UnprocessableEntityException({message:'Saved identity could not be decrypted. Contact an administrator before editing it.'});return decoded;}
 private present(s:Awaited<ReturnType<MobileForm630Service['snapshot']>>) {
  const values={} as Form630Identity;for(const field of FORM630_FIELDS)values[field]=s.rec?this.decodeField(s.rec[field]):field==='full_legal_name'?s.client.name!:field==='id_type'?"Driver's Licence":field==='issuing_jurisdiction'?'Ontario':field==='country'?'Canada':'';
  return {client_id:s.client.id,client_name:s.client.name,version:s.version,values,verified:!!s.rec?.verified,source:s.rec?.source??null,context:{property:s.txn.property??'',agent:s.txn.agent??'',date_verified:s.txn.offer_date?.toISOString().slice(0,10)??new Date().toISOString().slice(0,10)}};
 }
 async preview(user:AuthUserRecord,txnId:number,clientId:number){return this.present(await this.snapshot(user,txnId,clientId));}
 async save(user:AuthUserRecord,txnId:number,clientId:number,body:Record<string,unknown>){
  if(!body||typeof body.version!=='string'||!/^[a-f0-9]{64}$/.test(body.version)||body.confirmed!==true||!body.values||typeof body.values!=='object'||Array.isArray(body.values)||Object.keys(body).some(key=>!['version','values','confirmed'].includes(key)))throw new UnprocessableEntityException();
  const values=body.values as Record<string,unknown>;if(Object.keys(values).length!==FORM630_FIELDS.length||Object.keys(values).some(key=>!(FORM630_FIELDS as readonly string[]).includes(key)))throw new UnprocessableEntityException();
  for(const field of FORM630_FIELDS)if(typeof values[field]!=='string'||(values[field] as string).length>1000||/[\x00-\x1f\x7f]/.test(values[field] as string))throw new UnprocessableEntityException({message:'Enter valid identity values of at most 1000 characters.'});
  if(!(values.full_legal_name as string).trim()||!["Driver's Licence",'Passport','Other'].includes(values.id_type as string))throw new UnprocessableEntityException({message:'Enter the full legal name and select the identification type.'});
  for(const field of ['dob','expiry_date']) {const value=values[field] as string;if(value&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))throw new UnprocessableEntityException({message:'Enter valid dates in YYYY-MM-DD format.'});}
  await this.prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${txnId} FOR UPDATE`;await tx.$queryRaw`SELECT id FROM clients WHERE id = ${clientId} FOR UPDATE`;await tx.$queryRaw`SELECT id FROM client_identifications WHERE transaction_id = ${txnId} FOR UPDATE`;
   const s=await this.snapshot(user,txnId,clientId,tx);if(s.version!==body.version)throw new ConflictException({message:'Client identity or transaction changed. Reload before saving.'});
   const encrypted={} as Pick<client_identifications,typeof FORM630_FIELDS[number]>;for(const field of FORM630_FIELDS)encrypted[field]=values[field]?this.crypt.encryptString(values[field] as string):null;
   const now=new Date();await tx.client_identifications.upsert({where:{transaction_id_client_name:{transaction_id:txnId,client_name:s.client.name!}},create:{transaction_id:txnId,client_name:s.client.name!,...encrypted,source:'manual',verified:true,created_at:now,updated_at:now},update:{...encrypted,source:'manual',verified:true,updated_at:now}});
  });return this.preview(user,txnId,clientId);
 }
 async pdf(user:AuthUserRecord,txnId:number,clientId:number,version:string){const s=await this.snapshot(user,txnId,clientId);if(s.version!==version)throw new ConflictException({message:'Client identity changed. Reload before exporting.'});const result=this.present(s);return makeForm630(result.values,result.context);}
}
