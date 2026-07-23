import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AgentsService, type AgentCommission, type AgentLoan } from './agents.service';

/** Reference data for name datalists / autocomplete (any authenticated user). */
@Controller()
@UseGuards(AuthGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get('agents')
  index(): Promise<string[]> {
    return this.agents.listNames();
  }

  @Get('agent-commissions')
  commissions(): Promise<Record<string, AgentCommission>> {
    return this.agents.commissions();
  }

  @Get('agent-emails')
  emails(): Promise<Record<string, string>> {
    return this.agents.emails();
  }

  @Get('agent-loans')
  loans(): Promise<Record<string, AgentLoan>> {
    return this.agents.loans();
  }
}
