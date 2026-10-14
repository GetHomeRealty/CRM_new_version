import { environment } from '@/config/environment';
import type { MobileUser } from '@/auth/auth-api';
import { canAreaScreen } from '@/auth/access-policy';
export const identityFields = ['full_legal_name','address','dob','occupation','id_type','id_number','issuing_jurisdiction','country','expiry_date'] as const;
export type Form630Values = Record<typeof identityFields[number],string>;
export interface Form630Record { client_id:number; client_name:string; version:string; values:Form630Values; verified:boolean; source:string|null; context:{property:string;agent:string;date_verified:string} }
export function canForm630(user:MobileUser|null,level:'view'|'edit'='view'){return ['admin','manager','accounting','documentation','crm','agent'].includes(user?.role??'')&&canAreaScreen(user,'desk','transactions',level);}
export function form630Path(txn:number,client:number){if(![txn,client].every(id=>Number.isSafeInteger(id)&&id>0))throw new Error('Invalid transaction/client.');return `/api/transactions/${txn}/clients/${client}/form630`;}
export class UnconfirmedForm630SaveError extends Error {}
function decode(value:unknown):Form630Record {const s=value as Form630Record;if(!s||!Number.isSafeInteger(s.client_id)||s.client_id<=0||typeof s.client_name!=='string'||!/^[a-f0-9]{64}$/.test(s.version)||!s.values||identityFields.some(key=>typeof s.values[key]!=='string')||typeof s.verified!=='boolean'||!s.context||['property','agent','date_verified'].some(key=>typeof s.context[key as keyof typeof s.context]!=='string'))throw new Error('Invalid identity response. Reload the form.');return s;}
export async function fetchForm630(token:string,txn:number,client:number,signal?:AbortSignal){const response=await fetch(`${environment.apiUrl}${form630Path(txn,client)}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal});if(!response.ok)throw new Error('Could not load this client identity. Check access and refresh the checklist.');const result=decode(await response.json());if(result.client_id!==client)throw new Error('Client identity changed. Reload the form.');return result;}
export async function saveForm630(token:string,user:MobileUser|null,txn:number,client:number,version:string,values:Form630Values,signal?:AbortSignal){
 if(!token||signal?.aborted||!canForm630(user,'edit')||!/^[a-f0-9]{64}$/.test(version))throw new Error('You do not have permission to save this identity.');
 let response:Response;try{response=await fetch(`${environment.apiUrl}${form630Path(txn,client)}`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({version,values,confirmed:true}),signal});}catch{throw new UnconfirmedForm630SaveError('Save outcome is unknown. Reload before another save or export.');}
 if([400,401,403,404,422].includes(response.status))throw new Error('Identity save rejected. Check your access and values.');if(!response.ok)throw new UnconfirmedForm630SaveError('Identity changed or save outcome is unknown. Reload before another save or export.');
 try{const result=decode(await response.json());if(result.client_id!==client)throw new Error();return result;}catch{throw new UnconfirmedForm630SaveError('Save response is invalid. Reload before another save or export.');}
}
