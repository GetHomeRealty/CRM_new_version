import { LeadsService } from './leads.service';
import type { AuthUserRecord } from '../auth/auth.types';

const actor = { id: 10, role: 'admin', name: 'Assigning admin' } as AuthUserRecord;
function setup(extra: Record<string, unknown> = {}) {
  const lead = { id: 1, name: 'Test lead', email: 'test@example.com', owner_user_id: null,
    assigned_to: 10, team_id: null, assigned_team_lead_id: null, collaborator_user_ids: [10], ...extra };
  const prisma = {
    leads: { findFirst: jest.fn().mockResolvedValue(lead), update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...lead, ...data })) },
    users: { findFirst: jest.fn().mockResolvedValue({ id: 20 }), findMany: jest.fn().mockResolvedValue([{ id: 20, name: 'Agent' }]) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const history = { record: jest.fn().mockResolvedValue([]) };
  const notify = { leadAssigned: jest.fn() };
  const service = new LeadsService(prisma as never, audit as never, {} as never, notify as never, {} as never, history as never);
  // Exercise the update/authorization/write path independently of unrelated form vocabulary.
  jest.spyOn(service as any, 'validate').mockImplementation(async (input: any) => ({ assigned_to: input.assigned_to }));
  jest.spyOn(service as any, 'present').mockImplementation((row: any) => row);
  return { service, prisma, audit, history, notify };
}
describe('assignment update persistence', () => {
  it('keeps the assigner in My Leads and writes the same record', async () => {
    const { service, prisma } = setup({ collaborator_user_ids: [] });
    await service.update(1, { assigned_to: 20, assignment_mode: 'keep' }, actor);
    expect(prisma.leads.update).toHaveBeenCalledTimes(1);
    expect(prisma.leads.update.mock.calls[0][0]).toMatchObject({ where: { id: 1, assigned_to: 10 }, data: { assigned_to: 20, collaborator_user_ids: [10] } });
  });
  it('removes personal membership but never privatizes a brokerage lead', async () => {
    const { service, prisma, audit } = setup();
    const saved = await service.update(1, { assigned_to: 20, assignment_mode: 'transfer' }, actor);
    const write = prisma.leads.update.mock.calls[0][0];
    expect(write.data.owner_user_id).toBeUndefined();
    expect(write.data.collaborator_user_ids).toEqual([]);
    expect(saved.removed_from_my_leads).toBe(true);
    expect(audit.record).toHaveBeenCalled();
  });
  it('refuses an inactive recipient without writing or notifying', async () => {
    const { service, prisma, notify } = setup();
    prisma.users.findFirst.mockResolvedValue(null);
    await expect(service.update(1, { assigned_to: 20, assignment_mode: 'transfer' }, actor)).rejects.toThrow();
    expect(prisma.leads.update).not.toHaveBeenCalled();
    expect(notify.leadAssigned).not.toHaveBeenCalled();
  });
  it('fails cleanly if another assignment wins the race', async () => {
    const { service, prisma, audit } = setup();
    prisma.leads.update.mockRejectedValue({ code: 'P2025' });
    await expect(service.update(1, { assigned_to: 20, assignment_mode: 'transfer' }, actor)).rejects.toThrow(/assignment changed/);
    expect(audit.record).not.toHaveBeenCalled();
  });
  it('does not disclose the recipient’s duplicate contact on private transfer', async () => {
    const { service, prisma } = setup({ owner_user_id: 10 });
    prisma.leads.update.mockRejectedValue({ code: 'P2002' });
    await expect(service.update(1, { assigned_to: 20, assignment_mode: 'transfer' }, actor)).rejects.toThrow();
  });
  it('does not mutate a lead the caller cannot see', async () => {
    const { service, prisma } = setup();
    prisma.leads.findFirst.mockResolvedValue(null);
    await expect(service.update(1, { assigned_to: 20, assignment_mode: 'keep' }, actor)).rejects.toThrow('Lead not found.');
    expect(prisma.leads.update).not.toHaveBeenCalled();
  });
});
