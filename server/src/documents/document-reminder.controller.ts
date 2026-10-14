import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { DocumentReminderService } from './document-reminder.service';
@Controller('transactions/:transaction/document-reminders')
@Screen('transactions', 'view')
@UseGuards(AuthGuard, ScreenGuard)
export class DocumentReminderController {
 constructor(private readonly reminders: DocumentReminderService) {}
 @Get() preview(@CurrentUser() user: AuthUserRecord, @Param('transaction', ParseIntPipe) id: number) { return this.reminders.preview(user, id); }
 @Put('flags') @Screen('transactions', 'edit') flags(@CurrentUser() user: AuthUserRecord, @Param('transaction', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) { return this.reminders.flags(user, id, body); }
 @Post('send') @Screen('transactions', 'edit') send(@CurrentUser() user: AuthUserRecord, @Param('transaction', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) { return this.reminders.send(user, id, body); }
 @Get('receipts/:request') receipt(@CurrentUser() user: AuthUserRecord, @Param('transaction', ParseIntPipe) id: number, @Param('request') request: string) { return this.reminders.recover(user, id, request); }
}
