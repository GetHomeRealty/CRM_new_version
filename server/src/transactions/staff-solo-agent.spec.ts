import { UnprocessableEntityException } from '@nestjs/common';
import { TransactionsWriteService } from './transactions-write.service';

/**
 * EVERY NEW DEAL HAS AN AGENT (Sai, 28 Oct 2026). Staff working Solo had no Agent box and their deals
 * were saved with no agent. Reached with stub dependencies, like transaction-create-validation.spec:
 * each body below leaves `property` out, so every call is refused before Prisma, and the question is
 * only whether the agent rule is among the reasons.
 */
const service = new TransactionsWriteService(
  ...(Array.from({ length: 10 }, () => ({})) as unknown as ConstructorParameters<typeof TransactionsWriteService>),
);
const BASE = { type: 'Residential Sale Listing', status: 'Active' };

const errorsFor = async (user: unknown, body: Record<string, unknown>, opts: { quiet?: boolean } = {}): Promise<Record<string, string[]>> => {
  try {
    await service.store(user as never, body, opts);
    throw new Error('expected the create to be refused');
  } catch (e) {
    if (!(e instanceof UnprocessableEntityException)) throw e;
    return (e.getResponse() as { errors: Record<string, string[]> }).errors;
  }
};

describe('the agent on a new deal', () => {
  it.each(['admin', 'manager', 'documentation', 'accounting'])('is required of %s working Solo', async (role) => {
    const errors = await errorsFor({ id: 1, name: 'QA', role }, BASE);
    expect(errors.agent).toEqual(['Choose the agent for this deal.']);
  });

  it('is satisfied by the Solo Agent box or the Team box', async () => {
    const staff = { id: 1, name: 'QA', role: 'documentation' };
    expect((await errorsFor(staff, { ...BASE, agent: 'Some Agent' })).agent).toBeUndefined();
    expect((await errorsFor(staff, { ...BASE, primary_agent: 'Some Agent' })).agent).toBeUndefined();
  });

  it('is never asked of an agent - their own deal is theirs', async () => {
    expect((await errorsFor({ id: 7, name: 'An Agent', role: 'agent' }, BASE)).agent).toBeUndefined();
  });

  it('is not asked of the bulk importer, whose rows carry their own agent column', async () => {
    expect((await errorsFor({ id: 1, name: 'QA', role: 'admin' }, BASE, { quiet: true })).agent).toBeUndefined();
  });
});
