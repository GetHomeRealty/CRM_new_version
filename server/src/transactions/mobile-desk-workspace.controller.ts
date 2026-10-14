import { Body,Controller,Get,Param,ParseIntPipe,Post,Put,UseGuards,UnprocessableEntityException } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser,Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { MobileDeskWorkspaceService } from './mobile-desk-workspace.service';
@Controller('transactions/:transaction/mobile-workspace')
@Screen('transactions','view') @UseGuards(AuthGuard,ScreenGuard)
export class MobileDeskWorkspaceController{constructor(private readonly workspace:MobileDeskWorkspaceService){}private section(s:string):'financial'|'team'{if(s!=='financial'&&s!=='team')throw new UnprocessableEntityException();return s;}
 @Get(':section') preview(@CurrentUser() u:AuthUserRecord,@Param('transaction',ParseIntPipe) id:number,@Param('section') section:string){return this.workspace.preview(u,id,this.section(section));}
 @Put(':section') @Screen('transactions','edit') save(@CurrentUser() u:AuthUserRecord,@Param('transaction',ParseIntPipe) id:number,@Param('section') section:string,@Body() body:Record<string,unknown>){return this.workspace.save(u,id,this.section(section),body);}
 @Post('financial/quote') quote(@CurrentUser() u:AuthUserRecord,@Param('transaction',ParseIntPipe) id:number,@Body() body:Record<string,unknown>){return this.workspace.quote(u,id,body);}
 @Post('team/approval') @Screen('transactions','edit') teamApproval(@CurrentUser() u:AuthUserRecord,@Param('transaction',ParseIntPipe) id:number,@Body() body:Record<string,unknown>){return this.workspace.approval(u,id,body,'team');}
 @Post('financial/approval') @Screen('transactions','edit') approval(@CurrentUser() u:AuthUserRecord,@Param('transaction',ParseIntPipe) id:number,@Body() body:Record<string,unknown>){return this.workspace.approval(u,id,body);}
}
