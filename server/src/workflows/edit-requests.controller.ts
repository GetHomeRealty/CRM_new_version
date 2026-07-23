import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { EditRequestsService } from './edit-requests.service';
import { EditRequestDto } from './dto/workflow.dto';

const requireUser = (u: AuthUserRecord | undefined): AuthUserRecord => {
  if (!u) throw new UnauthorizedException({ message: 'Unauthenticated.' });
  return u;
};

@Controller()
export class EditRequestsController {
  constructor(private readonly editRequests: EditRequestsService) {}

  @Post('transactions/:transaction/edit-requests')
  @UseGuards(AuthGuard)
  store(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) txnId: number,
    @Body() dto: EditRequestDto,
  ): Promise<Record<string, unknown>> {
    return this.editRequests.store(requireUser(user), txnId, dto.reason ?? null, dto.scope ?? null);
  }

  @Post('edit-requests/:editRequest/approve')
  @HttpCode(200)
  @UseGuards(AuthGuard, AdminGuard)
  approve(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('editRequest', ParseIntPipe) id: number,
  ): Promise<Record<string, unknown>> {
    return this.editRequests.approve(requireUser(user), id);
  }

  @Post('edit-requests/:editRequest/reject')
  @HttpCode(200)
  @UseGuards(AuthGuard, AdminGuard)
  reject(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('editRequest', ParseIntPipe) id: number,
  ): Promise<Record<string, unknown>> {
    return this.editRequests.reject(requireUser(user), id);
  }
}
