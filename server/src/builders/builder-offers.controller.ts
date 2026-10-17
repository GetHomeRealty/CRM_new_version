import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { BuilderOffersService } from './builder-offers.service';

const MB25 = 25 * 1024 * 1024;

/**
 * Builder offers (stage 4, 17 Oct 2026). Offers live on a project; their confirmation lives on a deal.
 * The deal routes sit under /transactions/:id so the country check in MarketInterceptor covers them too.
 * Access (Super Admin, working in India) is checked in the service.
 */
@Controller()
@UseGuards(AuthGuard)
export class BuilderOffersController {
  constructor(private readonly offers: BuilderOffersService) {}

  @Get('builder-projects/:id/offers')
  list(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number) {
    return this.offers.listForProject(user, id);
  }

  @Post('builder-projects/:id/offers')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MB25 } }))
  create(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>, @UploadedFile() file?: Express.Multer.File) {
    return this.offers.create(user, id, body ?? {}, file);
  }

  @Put('builder-offers/:offerId')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MB25 } }))
  update(@CurrentUser() user: AuthUserRecord | undefined, @Param('offerId', ParseIntPipe) offerId: number, @Body() body: Record<string, unknown>, @UploadedFile() file?: Express.Multer.File) {
    return this.offers.update(user, offerId, body ?? {}, file);
  }

  @Delete('builder-offers/:offerId')
  destroy(@CurrentUser() user: AuthUserRecord | undefined, @Param('offerId', ParseIntPipe) offerId: number) {
    return this.offers.destroy(user, offerId);
  }

  @Get('builder-offers/:offerId/proof')
  async proof(@CurrentUser() user: AuthUserRecord | undefined, @Param('offerId', ParseIntPipe) offerId: number, @Res() res: Response) {
    const f = await this.offers.proof(user, offerId);
    res.download(f.abs, f.name);
  }

  @Get('transactions/:id/builder-offers')
  forDeal(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number) {
    return this.offers.forDeal(user, id);
  }

  @Post('transactions/:id/builder-offers/:offerId/apply')
  apply(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @Param('offerId', ParseIntPipe) offerId: number, @Body() body: Record<string, unknown>) {
    return this.offers.apply(user, id, offerId, body ?? {});
  }

  @Delete('transactions/:id/builder-offers/:offerId/apply')
  unapply(@CurrentUser() user: AuthUserRecord | undefined, @Param('id', ParseIntPipe) id: number, @Param('offerId', ParseIntPipe) offerId: number) {
    return this.offers.unapply(user, id, offerId);
  }
}
