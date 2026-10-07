import { UnprocessableEntityException } from '@nestjs/common';
import { TransactionsWriteService, teamChangeAfterNoticeProblem } from './transactions-write.service';

/*
 * TD-058 - THE TEAM SPLIT LOCK AFTER THE NOTICE OF SALE IS ENFORCED BY THE SERVER, NOT ONLY THE SCREEN.
 *
 * The screen locks the team - members, names, Split % - once the Notice of Sale has been sent for
 * signing, for everyone below manager, until the agent is paid. The server accepted any team, so an
 * agent calling the save address could change a split the Notice of Sale already states.
 */
const SENT = JSON.stringify({ sent_at: '2026-10-01T10:00:00+00:00', agents: {} });
const deal = (over: Record<string, unknown> = {}) => ({
  id: 41, agent: 'Owner Agent', agent_user_id: 77, notice_of_sale: SENT, comm_paid_status: 'No', activity_tracker: '{}',
  version: 3, updated_at: new Date(), type: 'Residential Buying', deleted_at: null, ...over,
});
const TEAM = [{ name: 'Owner Agent', split: '60.0000' }, { name: 'Co Agent', split: '40.0000' }];

describe('the rule', () => {
  it('refuses a changed Split % once the Notice of Sale is out', () => {
    expect(teamChangeAfterNoticeProblem(false, deal() as never, TEAM, [{ name: 'Owner Agent', split: 70 }, { name: 'Co Agent', split: 30 }]))
      .toMatch(/Notice of Sale has been sent/);
  });
  it('refuses an added, removed or renamed member', () => {
    expect(teamChangeAfterNoticeProblem(false, deal() as never, TEAM, [{ name: 'Owner Agent', split: 100 }])).not.toBeNull();
    expect(teamChangeAfterNoticeProblem(false, deal() as never, TEAM, [...TEAM, { name: 'Third', split: 0 }])).not.toBeNull();
    expect(teamChangeAfterNoticeProblem(false, deal() as never, TEAM, [{ name: 'Owner Agent', split: 60 }, { name: 'Someone Else', split: 40 }])).not.toBeNull();
  });
  it('lets the unchanged team through - the screen sends the whole deal on every save', () => {
    expect(teamChangeAfterNoticeProblem(false, deal() as never, TEAM, [{ name: 'Co Agent', split: 40 }, { name: ' owner agent ', split: '60' }])).toBeNull();
  });
  it('does not apply before the Notice of Sale is sent', () => {
    expect(teamChangeAfterNoticeProblem(false, deal({ notice_of_sale: null }) as never, TEAM, [{ name: 'Owner Agent', split: 100 }])).toBeNull();
    expect(teamChangeAfterNoticeProblem(false, deal({ notice_of_sale: '{"agents":{}}' }) as never, TEAM, [{ name: 'Owner Agent', split: 100 }])).toBeNull();
  });
  it('does not apply to a manager or above', () => {
    expect(teamChangeAfterNoticeProblem(true, deal() as never, TEAM, [{ name: 'Owner Agent', split: 100 }])).toBeNull();
  });
  it('does not apply once the agent has been paid, either way it is recorded', () => {
    expect(teamChangeAfterNoticeProblem(false, deal({ comm_paid_status: 'Yes' }) as never, TEAM, [{ name: 'Owner Agent', split: 100 }])).toBeNull();
    expect(teamChangeAfterNoticeProblem(false, deal({ activity_tracker: '{"agent_commission_paid_status":"Yes"}' }) as never, TEAM, [{ name: 'Owner Agent', split: 100 }])).toBeNull();
  });
});

describe('the save', () => {
  function serviceFor(t: Record<string, unknown>, writes: string[]) {
    const prisma = {
      transactions: {
        findFirst: async () => t,
        update: async () => { writes.push('transactions.update'); return t; },
        updateMany: async () => { writes.push('transactions.updateMany'); return { count: 1 }; },
      },
      team_members: {
        findFirst: async () => ({ id: 1 }),
        findMany: async () => TEAM,
      },
      $transaction: async () => { writes.push('$transaction'); throw new Error('reached the write'); },
    };
    return new TransactionsWriteService(
      ...([prisma, {}, { snapshot: async () => ({}), record: async () => undefined, recordChanges: async () => [] }, ...Array.from({ length: 7 }, () => ({}))] as unknown as ConstructorParameters<typeof TransactionsWriteService>),
    );
  }
  const agent = { id: 77, name: 'Owner Agent', role: 'agent' } as never;

  it('refuses an agent\'s changed split before anything is written', async () => {
    const writes: string[] = [];
    const err = await serviceFor(deal(), writes).update(agent, 41, { team: [{ name: 'Owner Agent', split: 90 }, { name: 'Co Agent', split: 10 }] }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(writes).toEqual([]);
  });

  it('lets the same agent save the deal with the team unchanged', async () => {
    const writes: string[] = [];
    const err = await serviceFor(deal(), writes).update(agent, 41, { team: TEAM }).then(() => null, (e) => e);
    expect(err).not.toBeInstanceOf(UnprocessableEntityException);
  });
});
