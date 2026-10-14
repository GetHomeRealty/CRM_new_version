import { Body, Controller, Get, Param, ParseIntPipe, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { MobileForm630Service } from './mobile-form630.service';
@Controller('transactions/:transaction/clients/:client/form630')
@Screen('transactions','view')
@UseGuards(AuthGuard,ScreenGuard)
export class MobileForm630Controller {
 constructor(private readonly forms:MobileForm630Service){}
 @Get() preview(@CurrentUser() user:AuthUserRecord,@Param('transaction',ParseIntPipe) txn:number,@Param('client',ParseIntPipe) client:number){return this.forms.preview(user,txn,client);}
 @Put() @Screen('transactions','edit') save(@CurrentUser() user:AuthUserRecord,@Param('transaction',ParseIntPipe) txn:number,@Param('client',ParseIntPipe) client:number,@Body() body:Record<string,unknown>){return this.forms.save(user,txn,client,body);}
 @Get('pdf') async pdf(@CurrentUser() user:AuthUserRecord,@Param('transaction',ParseIntPipe) txn:number,@Param('client',ParseIntPipe) client:number,@Query('version') version:string,@Res() res:Response){const bytes=await this.forms.pdf(user,txn,client,version);res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="OREA-Form-630.pdf"','Cache-Control':'private, no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff'});res.send(bytes);}
}
