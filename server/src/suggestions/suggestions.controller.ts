import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import {
  SuggestionsService,
  type BrokerageSuggestion,
  type LawyerSuggestion,
} from './suggestions.service';

/** Type-ahead suggestions from previously saved records (any authenticated user). */
@Controller('suggestions')
@UseGuards(AuthGuard)
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get('lawyers')
  lawyers(@CurrentUser() user: AuthUserRecord | undefined): Promise<LawyerSuggestion[]> {
    return this.suggestions.lawyers(user?.market ?? null);
  }

  @Get('brokerages')
  brokerages(): Promise<BrokerageSuggestion[]> {
    return this.suggestions.brokerages();
  }
}
