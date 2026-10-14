import {Body,ConflictException,UnprocessableEntityException,Controller,Get,Param,ParseIntPipe,Post,Put,Query,Res,UseGuards} from '@nestjs/common';
import type {Response} from 'express';
import {AuthGuard} from '../auth/guards/auth.guard';
import {ScreenGuard} from '../auth/guards/screen.guard';
import {CurrentUser,Screen} from '../auth/decorators';
import type {AuthUserRecord} from '../auth/auth.types';
import {MobileInvoicesService} from './mobile-invoices.service';
import {MobileInvoiceMailService} from './mobile-invoice-mail.service';
import {invoicePdf} from './mobile-invoice-pdf';
@Controller('mobile-invoices') @Screen('invoice','view') @UseGuards(AuthGuard,ScreenGuard)
export class MobileInvoicesController {
 constructor(private readonly invoices:MobileInvoicesService,private readonly mail:MobileInvoiceMailService){}
 @Get() list(@CurrentUser()u:AuthUserRecord,@Query('transaction')id:string,@Query('removed')removed:string,@Query('page')page:string,@Query('search')search:string,@Query('status')status:string){return this.invoices.list(u,id?Number(id):undefined,removed==='true',page?Number(page):0,search??'',status??'');}
 @Get('new') createPreview(@CurrentUser()u:AuthUserRecord,@Query('transaction')id:string){return this.invoices.preview(u,null,id?Number(id):undefined);}
 @Get('requests/:request') receipt(@CurrentUser()u:AuthUserRecord,@Param('request')request:string){return this.invoices.createReceipt(u,request);}
 @Post('quote') @Screen('invoice','edit') quote(@CurrentUser()u:AuthUserRecord,@Body()body:Record<string,unknown>){return this.invoices.quote(u,body);}
 @Post() @Screen('invoice','edit') create(@CurrentUser()u:AuthUserRecord,@Body()body:Record<string,unknown>){return this.invoices.save(u,null,body);}
 @Post('transactions/:transaction/generate') @Screen('invoice','edit') generate(@CurrentUser()u:AuthUserRecord,@Param('transaction',ParseIntPipe)id:number){return this.invoices.generate(u,id);}
 @Get(':invoice') preview(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number){return this.invoices.preview(u,id);}
 @Put(':invoice') @Screen('invoice','edit') save(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number,@Body()body:Record<string,unknown>){return this.invoices.save(u,id,body);}
 @Get(':invoice/removed') removed(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number){return this.invoices.removedPreview(u,id);}
 @Post(':invoice/lifecycle') @Screen('invoice','edit') lifecycle(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number,@Body()body:Record<string,unknown>){return this.invoices.lifecycle(u,id,body);}
 @Post(':invoice/payments') @Screen('invoice','edit') payment(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number,@Body()body:Record<string,unknown>){return this.invoices.payment(u,id,body);}
 @Get(':invoice/payments/requests/:request') paymentReceipt(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number,@Param('request')request:string){return this.invoices.paymentReceipt(u,id,request);}
 @Get(':invoice/pdf') async pdf(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number,@Query('version')version:string,@Res()res:Response){const s=await this.invoices.snapshot(u,id);if(s.version!==version)throw new ConflictException();const bytes=await invoicePdf(s.invoice as unknown as Record<string,unknown>,s.company as unknown as Record<string,unknown>);res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="Invoice.pdf"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.send(bytes);}
 @Get(':invoice/mail/:event') mailPreview(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number,@Param('event')event:string){if(event!=='send'&&event!=='reminder')throw new UnprocessableEntityException();return this.mail.preview(u,id,event);}
 @Post(':invoice/mail') @Screen('invoice','edit') send(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number,@Body()body:Record<string,unknown>){return this.mail.send(u,id,body);}
 @Get(':invoice/mail/receipts/:request') mailReceipt(@CurrentUser()u:AuthUserRecord,@Param('invoice',ParseIntPipe)id:number,@Param('request')request:string){return this.mail.recover(u,id,request);}
}
