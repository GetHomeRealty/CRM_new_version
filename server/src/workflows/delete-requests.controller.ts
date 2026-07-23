import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { DeleteRequestsService } from './delete-requests.service';
import { DeleteRequestForwardDto, DeleteRequestStoreDto } from './dto/workflow.dto';

const requireUser = (u: AuthUserRecord | undefined): AuthUserRecord => {
  if (!u) throw new UnauthorizedException({ message: 'Unauthenticated.' });
  return u;
};

@Controller()
@UseGuards(AuthGuard)
export class DeleteRequestsController {
  constructor(private readonly deleteRequests: DeleteRequestsService) {}

  @Post('transactions/:transaction/delete-requests')
  store(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('transaction', ParseIntPipe) txnId: number,
    @Body() dto: DeleteRequestStoreDto,
  ): Promise<Record<string, unknown>> {
    return this.deleteRequests.store(requireUser(user), txnId, dto.reason);
  }

  @Post('delete-requests/:deleteRequest/forward')
  @HttpCode(200)
  forward(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('deleteRequest', ParseIntPipe) id: number,
    @Body() dto: DeleteRequestForwardDto,
  ): Promise<Record<string, unknown>> {
    return this.deleteRequests.forward(requireUser(user), id, dto.reason ?? null);
  }

  @Post('delete-requests/:deleteRequest/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('deleteRequest', ParseIntPipe) id: number,
  ): Promise<{ message: string; deleted: boolean }> {
    return this.deleteRequests.approve(requireUser(user), id);
  }

  @Post('delete-requests/:deleteRequest/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthUserRecord | undefined,
    @Param('deleteRequest', ParseIntPipe) id: number,
  ): Promise<Record<string, unknown>> {
    return this.deleteRequests.reject(requireUser(user), id);
  }
}
