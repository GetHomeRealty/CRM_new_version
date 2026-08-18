import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScreenGuard } from '../auth/guards/screen.guard';
import { CurrentUser, Screen } from '../auth/decorators';
import type { AuthUserRecord } from '../auth/auth.types';
import { AgentsService, type AgentCommission, type AgentLoan } from './agents.service';

/**
 * Reference data the Transaction Desk screens fill their pickers from.
 *
 * WHAT THIS USED TO BE: `@UseGuards(AuthGuard)` and nothing else, on all four routes. Three of them
 * return money. `GET /api/agent-commissions` handed back every agent's commission split and
 * `GET /api/agent-loans` every agent's outstanding loan balance and repayment history — to anybody
 * with a session, including an agent asking about their colleagues, and including the `crm` role
 * whose permission map is `transactions: 'none'`. Nothing in the interface offers that, which is
 * exactly why it went unnoticed: the screens that call these endpoints are administrator screens.
 *
 * TWO CHANGES, because either alone leaves a hole:
 *
 *   1. The `transactions` screen permission now gates all four, so a role that cannot open the
 *      Transactions screen cannot read its reference data either. `ScreenGuard` enforces module
 *      access at the same time.
 *   2. The three money endpoints are SCOPED TO THE CALLER for agents — an agent receives their own
 *      row and no one else's. The screens that need them for an agent (Team Split, Financial) only
 *      ever read the caller's own default split, so nothing on screen changes; what changes is that
 *      the answer no longer contains the rest of the brokerage.
 *
 * `GET /api/agents` stays a full list on purpose: it is names only, and an agent building a team
 * split has to be able to pick a colleague. It is behind the screen permission like the rest.
 */
@Controller()
@UseGuards(AuthGuard, ScreenGuard)
@Screen('transactions', 'view')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get('agents')
  index(): Promise<string[]> {
    return this.agents.listNames();
  }

  @Get('agent-commissions')
  commissions(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, AgentCommission>> {
    return this.agents.commissions(user ?? null);
  }

  @Get('agent-emails')
  emails(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, string>> {
    return this.agents.emails(user ?? null);
  }

  @Get('agent-loans')
  loans(@CurrentUser() user: AuthUserRecord | undefined): Promise<Record<string, AgentLoan>> {
    return this.agents.loans(user ?? null);
  }
}
