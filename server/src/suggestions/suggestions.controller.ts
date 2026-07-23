import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
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
  lawyers(): Promise<LawyerSuggestion[]> {
    return this.suggestions.lawyers();
  }

  @Get('brokerages')
  brokerages(): Promise<BrokerageSuggestion[]> {
    return this.suggestions.brokerages();
  }
}
